import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ChatAdapter, IncomingAttachment, RelayConfig, ServiceState } from "./types.js";
import { AttachmentStore } from "./attachments.js";
import { CodexSessionManager } from "./codex.js";
import { renderBodyChunks, renderStatusMessage } from "./renderer.js";
import { FileStateStore } from "./state.js";
import { TelegramGateway } from "./telegram.js";

const STATUS_HISTORY_LIMIT = 6;
const COMMAND_HISTORY_LIMIT = 12;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;

export class RemoteControlService {
  private readonly stateStore: FileStateStore;
  private readonly attachmentStore: AttachmentStore;
  private readonly codex: CodexSessionManager;
  readonly telegram: TelegramGateway;

  constructor(private readonly config: RelayConfig) {
    this.stateStore = new FileStateStore(config.stateFile, config.defaultCwd);
    this.attachmentStore = new AttachmentStore(config.tempDir);
    this.codex = new CodexSessionManager(config, this.stateStore);
    this.telegram = new TelegramGateway(config, {
      onText: (adapter, text) => this.handleText(adapter, text),
      onCommand: (adapter, text) => this.handleCommand(adapter, text),
      onAttachment: (adapter, attachment) => this.handleAttachment(adapter, attachment)
    });
  }

  async start() {
    const state = await this.stateStore.load();
    let nextState: ServiceState | null = null;

    if (state.activeRun) {
      nextState = {
        ...state,
        activeRun: null,
        previousShutdownHadActiveTask: true
      };
    }

    if (!existsSync(state.currentCwd)) {
      nextState = {
        ...(nextState ?? state),
        threadId: null,
        currentCwd: this.config.defaultCwd,
        recoveryStatus: "recreated-after-invalid-cwd"
      };
    } else if (state.threadId) {
      nextState = {
        ...(nextState ?? state),
        recoveryStatus: "resume-pending"
      };
    }

    if (nextState) {
      await this.stateStore.save(nextState);
    }

    await this.telegram.start();
  }

  private async handleText(adapter: ChatAdapter, text: string) {
    await this.runExclusive(adapter, text, []);
  }

  private async handleAttachment(adapter: ChatAdapter, attachment: IncomingAttachment) {
    const downloaded = await this.telegram.downloadAttachment(attachment.fileId);
    const runId = createRunId();
    const state = await this.stateStore.load();
    const runDirs = await this.attachmentStore.createRunContext(state.currentCwd, runId);
    const staged = await this.attachmentStore.stageAttachment({
      inputDir: runDirs.inputDir,
      attachment: {
        ...attachment,
        fileName: attachment.fileName || basename(downloaded.filePath)
      },
      bytes: downloaded.bytes
    });

    await this.runExclusive(adapter, attachment.caption, [staged], runDirs.exportDir, runId);
  }

  private async handleCommand(adapter: ChatAdapter, commandText: string) {
    const [command, ...rest] = commandText.trim().split(/\s+/);
    const argument = rest.join(" ").trim();

    switch (command) {
      case "/status": {
        await adapter.sendHtml(await this.renderStatus());
        return;
      }
      case "/pwd": {
        const state = await this.stateStore.load();
        await adapter.sendHtml(`<code>${escapeHtml(state.currentCwd)}</code>`);
        return;
      }
      case "/stop": {
        if (!this.codex.isRunning()) {
          await adapter.sendHtml("No task is currently running.");
          return;
        }
        await this.codex.stopActiveTurn();
        await adapter.sendHtml("Stop requested.");
        return;
      }
      case "/reset": {
        if (this.codex.isRunning()) {
          await adapter.sendHtml("Cannot reset while a task is running.");
          return;
        }
        await this.codex.resetThread();
        await adapter.sendHtml("Session reset. The next task will start a fresh Codex thread.");
        return;
      }
      case "/cd": {
        if (!argument) {
          await adapter.sendHtml("Usage: <code>/cd &lt;path&gt;</code>");
          return;
        }
        if (this.codex.isRunning()) {
          await adapter.sendHtml("Cannot change directory while a task is running.");
          return;
        }
        const nextPath = resolve((await this.stateStore.load()).currentCwd, argument);
        if (!existsSync(nextPath)) {
          await adapter.sendHtml(`Path does not exist: <code>${escapeHtml(nextPath)}</code>`);
          return;
        }
        const fileStat = await stat(nextPath);
        if (!fileStat.isDirectory()) {
          await adapter.sendHtml(`Not a directory: <code>${escapeHtml(nextPath)}</code>`);
          return;
        }
        await this.codex.changeDirectory(nextPath);
        await adapter.sendHtml(
          `Working directory changed to <code>${escapeHtml(nextPath)}</code>. The next task will start a fresh Codex thread.`
        );
        return;
      }
      default: {
        await adapter.sendHtml(
          "Supported commands: <code>/status</code>, <code>/pwd</code>, <code>/cd &lt;path&gt;</code>, <code>/stop</code>, <code>/reset</code>"
        );
      }
    }
  }

  private async renderStatus() {
    const state = await this.stateStore.load();
    const mode = state.activeRun ? "running" : "idle";
    const threadText = state.threadId ? state.threadId : "pending new thread";
    return [
      `<b>Status</b>`,
      `<code>mode: ${escapeHtml(mode)}</code>`,
      `<code>cwd: ${escapeHtml(state.currentCwd)}</code>`,
      `<code>thread: ${escapeHtml(threadText)}</code>`,
      `<code>recovery: ${escapeHtml(state.recoveryStatus)}</code>`,
      `<code>base_url: ${escapeHtml(this.config.codex.baseUrl ?? "default (OpenAI official)")}</code>`,
      `<code>provider: ${escapeHtml(renderProviderStatus(this.config))}</code>`,
      `<code>model: ${escapeHtml(this.config.codex.model)}</code>`,
      `<code>reasoning_effort: ${escapeHtml(this.config.codex.reasoningEffort ?? "default")}</code>`,
      `<code>approval_policy: ${escapeHtml(this.config.codex.approvalPolicy)}</code>`,
      `<code>sandbox_mode: ${escapeHtml(this.config.codex.sandboxMode)}</code>`,
      `<code>network_access: ${this.config.codex.networkAccessEnabled ? "enabled" : "disabled"}</code>`,
      `<code>previous_shutdown_had_active_task: ${state.previousShutdownHadActiveTask ? "yes" : "no"}</code>`
    ].join("\n");
  }

  private async runExclusive(
    adapter: ChatAdapter,
    text: string,
    attachments: Awaited<ReturnType<AttachmentStore["stageAttachment"]>>[],
    exportDirOverride?: string,
    runId?: string
  ) {
    const state = await this.stateStore.load();
    if (state.activeRun) {
      await adapter.sendHtml("A task is already running. Use <code>/stop</code> first.");
      return;
    }

    const currentCwd = state.currentCwd;
    const currentRunId = runId || createRunId();
    const runDirs =
      exportDirOverride
        ? { exportDir: exportDirOverride }
        : await this.attachmentStore.createRunContext(currentCwd, currentRunId);
    const exportSnapshot = await this.attachmentStore.snapshotExportDir(runDirs.exportDir);

    const activeState: ServiceState = {
      ...state,
      activeRun: {
        startedAt: new Date().toISOString(),
        preview: text.slice(0, 120)
      },
      previousShutdownHadActiveTask: true
    };
    await this.stateStore.save(activeState);

    const statusLines: string[] = [];
    const commandLines: string[] = [];
    let body = "";
    let statusMessageId: number | null = null;
    let bodyMessageIds: number[] = [];
    let renderedStatus = "";
    let renderedBodyChunks: string[] = [];
    let lastSyncAt = 0;
    let typingTimer: NodeJS.Timeout | null = null;
    let typingInFlight = false;

    const sendTyping = async () => {
      if (typingInFlight) {
        return;
      }

      typingInFlight = true;
      try {
        await adapter.sendTyping();
      } catch (error) {
        console.error("[service] Failed to send Telegram typing action:", error);
      } finally {
        typingInFlight = false;
      }
    };

    const startTypingHeartbeat = async () => {
      await sendTyping();
      typingTimer = setInterval(() => {
        void sendTyping();
      }, TELEGRAM_TYPING_INTERVAL_MS);
    };

    const stopTypingHeartbeat = () => {
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = null;
      }
    };

    const syncMessages = async (stateLabel: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastSyncAt < 750) {
        return;
      }

      const statusMessage = renderStatusMessage({
        state: stateLabel,
        cwd: currentCwd,
        statusLines,
        commandLines
      });
      const bodyChunks = renderBodyChunks(body);
      lastSyncAt = now;

      if (statusMessageId) {
        if (renderedStatus !== statusMessage) {
          await adapter.editHtml(statusMessageId, statusMessage);
          renderedStatus = statusMessage;
        }
      } else {
        statusMessageId = await adapter.replyHtml(statusMessage);
        renderedStatus = statusMessage;
      }

      for (let index = 0; index < bodyChunks.length; index += 1) {
        const chunk = bodyChunks[index];
        const existingMessageId = bodyMessageIds[index];
        if (renderedBodyChunks[index] === chunk) {
          continue;
        }

        if (existingMessageId) {
          await adapter.editHtml(existingMessageId, chunk);
        } else {
          bodyMessageIds.push(await adapter.replyHtml(chunk));
        }
        renderedBodyChunks[index] = chunk;
      }
    };

    try {
      await startTypingHeartbeat();
      await syncMessages("Running", true);

      const result = await this.codex.runTask({
        text,
        attachments,
        exportDir: runDirs.exportDir,
        onEvent: async (event) => {
          if (event.type === "text-delta") {
            body += event.delta;
          } else if (event.type === "command") {
            const summarizedCommand = summarizeCommand(event.command);
            if (commandLines.at(-1) !== summarizedCommand) {
              commandLines.push(summarizedCommand);
              if (commandLines.length > COMMAND_HISTORY_LIMIT) {
                commandLines.splice(0, commandLines.length - COMMAND_HISTORY_LIMIT);
              }
            }
          } else if (event.type === "status") {
            if (statusLines.at(-1) !== event.text) {
              statusLines.push(event.text);
              if (statusLines.length > STATUS_HISTORY_LIMIT) {
                statusLines.splice(0, statusLines.length - STATUS_HISTORY_LIMIT);
              }
            }
          }
          await syncMessages("Running");
        }
      });

      stopTypingHeartbeat();
      await syncMessages(result.stopped ? "Stopped" : "Completed", true);

      const artifacts = await this.attachmentStore.collectNewArtifacts(runDirs.exportDir, exportSnapshot);
      for (const artifact of artifacts) {
        const caption = `Generated: <code>${escapeHtml(artifact.fileName)}</code>`;
        if (artifact.kind === "image") {
          await adapter.sendPhoto(artifact.path, caption);
        } else {
          await adapter.sendDocument(artifact.path, artifact.fileName, caption);
        }
      }
    } catch (error) {
      stopTypingHeartbeat();
      statusLines.push(error instanceof Error ? error.message : String(error));
      await syncMessages("Failed", true);
      console.error("[service] Task failed:", error);
    } finally {
      stopTypingHeartbeat();
      const latest = await this.stateStore.load();
      await this.stateStore.save({
        ...latest,
        activeRun: null,
        previousShutdownHadActiveTask: false
      });
    }
  }
}

function createRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderProviderStatus(config: RelayConfig) {
  const provider = config.codex.provider;
  if (!provider) {
    return config.codex.baseUrl ? "openai base_url override" : "default openai";
  }

  const providerId = provider.id ?? "relay_proxy";
  const websocketStatus =
    provider.supportsWebsockets === undefined ? "default websockets" : provider.supportsWebsockets ? "websockets on" : "https only";

  return `${providerId} (${websocketStatus})`;
}

function summarizeCommand(command: string) {
  return command.length > 240 ? `${command.slice(0, 237)}...` : command;
}
