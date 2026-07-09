import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { RecoveryStatus, ServiceState, SessionHistoryEntry } from "./types.js";

export const SESSION_HISTORY_LIMIT = 10;

const sessionHistoryEntrySchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  preview: z.string().min(1),
  createdAt: z.string(),
  lastUsedAt: z.string()
});

const serviceStateSchema = z.object({
  threadId: z.string().nullable(),
  currentCwd: z.string().min(1),
  currentModel: z.string().min(1).optional(),
  recoveryStatus: z.enum([
    "fresh",
    "resume-pending",
    "resumed",
    "recreated-after-missing-thread",
    "recreated-after-invalid-cwd"
  ]),
  activeRun: z
    .object({
      startedAt: z.string(),
      preview: z.string()
    })
    .nullable(),
  previousShutdownHadActiveTask: z.boolean(),
  sessionHistory: z.array(sessionHistoryEntrySchema).default([])
});

type PersistedServiceState = z.infer<typeof serviceStateSchema>;

export class FileStateStore {
  constructor(
    private readonly filePath: string,
    private readonly defaultCwd: string,
    private readonly defaultModel: string
  ) {}

  async load(): Promise<ServiceState> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return normalizeLoadedState(serviceStateSchema.parse(JSON.parse(raw)), this.defaultCwd, this.defaultModel);
    } catch {
      return {
        threadId: null,
        currentCwd: this.defaultCwd,
        currentModel: this.defaultModel,
        recoveryStatus: "fresh",
        activeRun: null,
        previousShutdownHadActiveTask: false,
        sessionHistory: []
      };
    }
  }

  async save(state: ServiceState) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  async markFreshThread(currentCwd: string) {
    const state = await this.load();
    await this.save({
      ...state,
      threadId: null,
      currentCwd,
      currentModel: this.defaultModel,
      recoveryStatus: "fresh"
    });
  }

  async updateRecoveryStatus(status: RecoveryStatus) {
    const state = await this.load();
    await this.save({
      ...state,
      recoveryStatus: status
    });
  }

  async ensureCurrentThreadTracked(fallbackPreview = "未命名会话") {
    const state = await this.load();
    if (!state.threadId) {
      return null;
    }

    const existing = state.sessionHistory.find((entry) => entry.threadId === state.threadId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const entry: SessionHistoryEntry = {
      id: createSessionHistoryId(),
      threadId: state.threadId,
      cwd: state.currentCwd,
      model: state.currentModel,
      preview: normalizeSessionPreview(state.activeRun?.preview ?? fallbackPreview),
      createdAt: now,
      lastUsedAt: now
    };

    await this.save({
      ...state,
      sessionHistory: trimSessionHistory([entry, ...state.sessionHistory])
    });

    return entry;
  }

  async recordSession(input: {
    threadId: string;
    cwd: string;
    model: string;
    preview: string;
  }) {
    const state = await this.load();
    const now = new Date().toISOString();
    const normalizedPreview = normalizeSessionPreview(input.preview);
    const existing = state.sessionHistory.find((entry) => entry.threadId === input.threadId);
    const entry: SessionHistoryEntry = existing
      ? {
          ...existing,
          cwd: input.cwd,
          model: input.model,
          preview: normalizedPreview,
          lastUsedAt: now
        }
      : {
          id: createSessionHistoryId(),
          threadId: input.threadId,
          cwd: input.cwd,
          model: input.model,
          preview: normalizedPreview,
          createdAt: now,
          lastUsedAt: now
        };

    await this.save({
      ...state,
      sessionHistory: trimSessionHistory([entry, ...state.sessionHistory.filter((item) => item.threadId !== input.threadId)])
    });

    return entry;
  }

  async listRecentSessions(limit = SESSION_HISTORY_LIMIT) {
    const state = await this.load();
    return state.sessionHistory.slice(0, limit);
  }

  async findSessionById(sessionId: string) {
    const state = await this.load();
    return state.sessionHistory.find((entry) => entry.id === sessionId) ?? null;
  }

  async activateSession(sessionId: string) {
    const state = await this.load();
    const existing = state.sessionHistory.find((entry) => entry.id === sessionId);
    if (!existing) {
      return null;
    }

    const updatedEntry: SessionHistoryEntry = {
      ...existing,
      lastUsedAt: new Date().toISOString()
    };

    await this.save({
      ...state,
      threadId: updatedEntry.threadId,
      currentCwd: updatedEntry.cwd,
      currentModel: updatedEntry.model,
      recoveryStatus: "resume-pending",
      sessionHistory: trimSessionHistory([
        updatedEntry,
        ...state.sessionHistory.filter((entry) => entry.id !== sessionId)
      ])
    });

    return updatedEntry;
  }

  async deleteSession(sessionId: string) {
    const state = await this.load();
    const existing = state.sessionHistory.find((entry) => entry.id === sessionId);
    if (!existing) {
      return null;
    }

    const isCurrentSession = state.threadId === existing.threadId;
    await this.save({
      ...state,
      threadId: isCurrentSession ? null : state.threadId,
      currentModel: isCurrentSession ? this.defaultModel : state.currentModel,
      recoveryStatus: isCurrentSession ? "fresh" : state.recoveryStatus,
      sessionHistory: state.sessionHistory.filter((entry) => entry.id !== sessionId)
    });

    return {
      entry: existing,
      isCurrentSession
    };
  }

  async switchModel(model: string) {
    const state = await this.load();
    const sessionHistory = state.threadId
      ? state.sessionHistory.map((entry) =>
          entry.threadId === state.threadId
            ? {
                ...entry,
                model
              }
            : entry
        )
      : state.sessionHistory;

    await this.save({
      ...state,
      currentModel: model,
      sessionHistory
    });
  }
}

function normalizeSessionPreview(preview: string) {
  const compact = preview.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 120) : "未命名会话";
}

function trimSessionHistory(entries: SessionHistoryEntry[]) {
  return entries
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, SESSION_HISTORY_LIMIT);
}

function createSessionHistoryId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLoadedState(
  state: PersistedServiceState,
  defaultCwd: string,
  defaultModel: string
): ServiceState {
  const sessionHistory = trimSessionHistory(
    state.sessionHistory.map((entry) => ({
      ...entry,
      model: entry.model ?? defaultModel
    }))
  );
  const currentEntry = state.threadId
    ? sessionHistory.find((entry) => entry.threadId === state.threadId) ?? null
    : null;

  return {
    threadId: state.threadId,
    currentCwd: state.currentCwd || defaultCwd,
    currentModel: state.currentModel ?? currentEntry?.model ?? defaultModel,
    recoveryStatus: state.recoveryStatus,
    activeRun: state.activeRun,
    previousShutdownHadActiveTask: state.previousShutdownHadActiveTask,
    sessionHistory
  };
}
