import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { RecoveryStatus, ServiceState } from "./types.js";

const serviceStateSchema = z.object({
  threadId: z.string().nullable(),
  currentCwd: z.string().min(1),
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
  previousShutdownHadActiveTask: z.boolean()
});

export class FileStateStore {
  constructor(
    private readonly filePath: string,
    private readonly defaultCwd: string
  ) {}

  async load(): Promise<ServiceState> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return serviceStateSchema.parse(JSON.parse(raw));
    } catch {
      return {
        threadId: null,
        currentCwd: this.defaultCwd,
        recoveryStatus: "fresh",
        activeRun: null,
        previousShutdownHadActiveTask: false
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
}
