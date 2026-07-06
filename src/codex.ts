import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Codex, type Input, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type { RelayConfig, RelayRunEvent, RunResult, ServiceState, StagedAttachment } from "./types.js";
import { FileStateStore } from "./state.js";

export class CodexSessionManager {
  private readonly codex: Codex;
  private activeAbortController: AbortController | null = null;

  constructor(
    private readonly config: RelayConfig,
    private readonly stateStore: FileStateStore
  ) {
    const runtime = resolveRuntimePaths(config.appRoot);
    const mergedPath = prependPath(runtime.pathEntries, process.env.Path ?? process.env.PATH ?? "");
    const configOverrides = buildCodexConfigOverrides(config);

    this.codex = new Codex({
      apiKey: config.openaiApiKey,
      baseUrl: configOverrides ? undefined : config.codex.baseUrl,
      codexPathOverride: runtime.executablePath,
      config: configOverrides,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        ),
        CODEX_HOME: config.codexHome,
        PATH: mergedPath,
        Path: mergedPath
      }
    });
  }

  async getState() {
    return this.stateStore.load();
  }

  isRunning() {
    return this.activeAbortController !== null;
  }

  async stopActiveTurn() {
    this.activeAbortController?.abort();
  }

  async resetThread() {
    const state = await this.stateStore.load();
    await this.stateStore.save({
      ...state,
      threadId: null,
      recoveryStatus: "fresh"
    });
  }

  async changeDirectory(nextPath: string) {
    const state = await this.stateStore.load();
    const resolvedPath = resolve(nextPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    await this.stateStore.save({
      ...state,
      currentCwd: resolvedPath,
      threadId: null,
      recoveryStatus: "fresh"
    });

    return resolvedPath;
  }

  async runTask(input: {
    text: string;
    attachments: StagedAttachment[];
    exportDir: string;
    onEvent: (event: RelayRunEvent) => Promise<void> | void;
  }): Promise<RunResult> {
    const state = await this.stateStore.load();
    const threadOptions = buildThreadOptions(this.config, state, input.attachments, input.exportDir);

    const attempt = async (mode: "resume" | "fresh") => {
      const thread =
        mode === "resume" && state.threadId
          ? this.codex.resumeThread(state.threadId, threadOptions)
          : this.codex.startThread(threadOptions);

      const payload = buildCodexInput(input.text, input.attachments, input.exportDir);
      const abortController = new AbortController();
      this.activeAbortController = abortController;

      let sawEvent = false;
      let currentThreadId = state.threadId;
      let markedResumed = false;
      const seenAgentText = new Map<string, string>();

      try {
        const { events } = await thread.runStreamed(payload, {
          signal: abortController.signal
        });

        for await (const event of events) {
          sawEvent = true;
          if (mode === "resume" && !markedResumed) {
            markedResumed = true;
            await this.stateStore.save({
              ...(await this.stateStore.load()),
              threadId: currentThreadId,
              recoveryStatus: "resumed"
            });
          }

          if (event.type === "thread.started") {
            currentThreadId = event.thread_id;
            await this.stateStore.save({
              ...(await this.stateStore.load()),
              threadId: currentThreadId,
              recoveryStatus: mode === "resume" ? "resumed" : "fresh"
            });
            continue;
          }

          await emitRelayEvents({
            event,
            seenAgentText,
            onEvent: input.onEvent
          });
        }

        return {
          stopped: false,
          threadId: currentThreadId
        };
      } catch (error) {
        if (abortController.signal.aborted) {
          return {
            stopped: true,
            threadId: currentThreadId
          };
        }

        if (mode === "resume" && !sawEvent) {
          await this.stateStore.save({
            ...(await this.stateStore.load()),
            threadId: null,
            recoveryStatus: "recreated-after-missing-thread"
          });
          await input.onEvent({
            type: "status",
            text: "Saved Codex session was unavailable. Creating a fresh session."
          });
          return attempt("fresh");
        }

        throw error;
      } finally {
        this.activeAbortController = null;
      }
    };

    return state.threadId ? attempt("resume") : attempt("fresh");
  }
}

function buildThreadOptions(
  config: RelayConfig,
  state: ServiceState,
  attachments: StagedAttachment[],
  exportDir: string
): ThreadOptions {
  const attachmentDirectories = [...new Set(attachments.map((attachment) => dirname(attachment.path)))];
  return {
    model: config.codex.model,
    modelReasoningEffort: config.codex.reasoningEffort,
    approvalPolicy: config.codex.approvalPolicy,
    sandboxMode: config.codex.sandboxMode,
    workingDirectory: state.currentCwd,
    skipGitRepoCheck: config.codex.skipGitRepoCheck,
    networkAccessEnabled: config.codex.networkAccessEnabled,
    additionalDirectories: [exportDir, ...attachmentDirectories]
  };
}

function buildCodexInput(text: string, attachments: StagedAttachment[], exportDir: string): Input {
  const promptParts = [
    text,
    `If you need to return images or files to Telegram, place copies under: ${exportDir}`
  ];

  const input: Input = [{ type: "text", text: promptParts.join("\n\n") }];

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      input.push({ type: "local_image", path: attachment.path });
      continue;
    }

    promptParts.push(`Attached file available at ${attachment.path}`);
    (input[0] as { type: "text"; text: string }).text = promptParts.join("\n\n");
  }

  return input;
}

async function emitRelayEvents(input: {
  event: ThreadEvent;
  seenAgentText: Map<string, string>;
  onEvent: (event: RelayRunEvent) => Promise<void> | void;
}) {
  const event = input.event;
  if (event.type === "item.updated" || event.type === "item.completed") {
    if (event.item.type === "agent_message") {
      const previous = input.seenAgentText.get(event.item.id) ?? "";
      const next = event.item.text;
      const delta = next.slice(previous.length);
      input.seenAgentText.set(event.item.id, next);
      if (delta) {
        await input.onEvent({ type: "text-delta", delta });
      }
      return;
    }

    if (event.item.type === "command_execution") {
      await input.onEvent({
        type: "command",
        command: event.item.command
      });
      return;
    }

    if (event.item.type === "error") {
      await input.onEvent({
        type: "status",
        text: event.item.message
      });
      return;
    }

    if (event.item.type === "mcp_tool_call") {
      await input.onEvent({
        type: "status",
        text: `Using ${event.item.server}/${event.item.tool}`
      });
      return;
    }
  }

  if (event.type === "turn.failed") {
    throw new Error(event.error.message);
  }

  if (event.type === "error") {
    // Codex can emit transient transport errors before it retries or falls back.
    await input.onEvent({
      type: "status",
      text: event.message
    });
  }
}

function buildCodexConfigOverrides(config: RelayConfig) {
  const provider = config.codex.provider;
  if (!provider || !config.codex.baseUrl) {
    return undefined;
  }

  const providerId = provider.id ?? "relay_proxy";
  return {
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        name: provider.name ?? "Relay Proxy",
        base_url: config.codex.baseUrl,
        env_key: provider.envKey ?? "OPENAI_API_KEY",
        wire_api: provider.wireApi ?? "responses",
        ...(provider.supportsWebsockets === undefined
          ? {}
          : { supports_websockets: provider.supportsWebsockets })
      }
    }
  };
}

function resolveRuntimePaths(appRoot: string) {
  if (process.env.CODEX_BIN) {
    return {
      executablePath: process.env.CODEX_BIN,
      pathEntries: process.env.CODEX_PATH_DIR ? [process.env.CODEX_PATH_DIR] : []
    };
  }

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const sidecarExecutable = resolve(appRoot, "runtime", "codex", "bin", executableName);
  const sidecarPathDir = resolve(appRoot, "runtime", "codex", "codex-path");

  if (existsSync(sidecarExecutable)) {
    return {
      executablePath: sidecarExecutable,
      pathEntries: existsSync(sidecarPathDir) ? [sidecarPathDir] : []
    };
  }

  return {
    executablePath: undefined,
    pathEntries: []
  };
}

function prependPath(prefixes: string[], existing: string) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  return [...prefixes.filter(Boolean), ...existing.split(delimiter).filter(Boolean)].join(delimiter);
}
