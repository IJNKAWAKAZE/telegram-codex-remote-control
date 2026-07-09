import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ChatAdapter, ChatInlineKeyboardMarkup, IncomingAttachment, RelayConfig, ServiceState, SessionHistoryEntry } from "./types.js";
import { AttachmentStore } from "./attachments.js";
import { CodexSessionManager } from "./codex.js";
import {
  renderBodyChunks,
  renderRichBodyChunks,
  renderStatusMessage,
  renderStreamingBodyChunk,
  splitStreamingBodyText
} from "./renderer.js";
import { FileStateStore, SESSION_HISTORY_LIMIT } from "./state.js";
import { TelegramGateway } from "./telegram.js";

const STATUS_HISTORY_LIMIT = 6;
const COMMAND_HISTORY_LIMIT = 12;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;
type BodyRenderMode = "html-live" | "html-final" | "rich";

export class RemoteControlService {
  private readonly stateStore: FileStateStore;
  private readonly attachmentStore: AttachmentStore;
  private readonly codex: CodexSessionManager;
  private activeTaskToken: symbol | null = null;
  readonly telegram: TelegramGateway;

  constructor(private readonly config: RelayConfig) {
    this.stateStore = new FileStateStore(config.stateFile, config.defaultCwd);
    this.attachmentStore = new AttachmentStore(config.tempDir);
    this.codex = new CodexSessionManager(config, this.stateStore);
    this.telegram = new TelegramGateway(config, {
      onText: (adapter, text) => this.handleText(adapter, text),
      onCommand: (adapter, text) => this.handleCommand(adapter, text),
      onAttachment: (adapter, attachment) => this.handleAttachment(adapter, attachment),
      onCallback: (adapter, data, messageId) => this.handleCallback(adapter, data, messageId)
    });
  }

  async start() {
    await this.stateStore.ensureCurrentThreadTracked();
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
    await this.runTaskGuarded(adapter, async () => {
      await this.runExclusive(adapter, text, []);
    });
  }

  private async handleAttachment(adapter: ChatAdapter, attachment: IncomingAttachment) {
    await this.runTaskGuarded(adapter, async () => {
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
    });
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
      case "/sessions": {
        if (this.isTaskBusy()) {
          await adapter.sendHtml("任务运行中，无法管理历史会话。");
          return;
        }
        await this.sendSessionPicker(adapter);
        return;
      }
      case "/stop": {
        if (!this.isTaskBusy()) {
          await adapter.sendHtml("当前没有正在运行的任务。");
          return;
        }
        if (!this.codex.isRunning()) {
          await adapter.sendHtml("任务正在启动或收尾，当前没有可中止的 Codex 执行。");
          return;
        }
        await this.codex.stopActiveTurn();
        await adapter.sendHtml("已发送停止请求。");
        return;
      }
      case "/new":
      case "/reset": {
        if (this.isTaskBusy()) {
          await adapter.sendHtml("任务运行中，无法新建会话。");
          return;
        }
        await this.codex.resetThread();
        await adapter.sendHtml("已切换为新会话。下一次任务会启动新的 Codex 线程。");
        return;
      }
      case "/cd": {
        if (!argument) {
          await adapter.sendHtml("用法：<code>/cd &lt;路径&gt;</code>");
          return;
        }
        if (this.isTaskBusy()) {
          await adapter.sendHtml("任务运行中，无法切换目录。");
          return;
        }
        const nextPath = resolve((await this.stateStore.load()).currentCwd, argument);
        if (!existsSync(nextPath)) {
          await adapter.sendHtml(`路径不存在：<code>${escapeHtml(nextPath)}</code>`);
          return;
        }
        const fileStat = await stat(nextPath);
        if (!fileStat.isDirectory()) {
          await adapter.sendHtml(`不是目录：<code>${escapeHtml(nextPath)}</code>`);
          return;
        }
        await this.codex.changeDirectory(nextPath);
        await adapter.sendHtml(
          `工作目录已切换到 <code>${escapeHtml(nextPath)}</code>。下一次任务会启动新的 Codex 线程。`
        );
        return;
      }
      default: {
        await adapter.sendHtml(
          "支持的命令：<code>/status</code>、<code>/pwd</code>、<code>/cd &lt;路径&gt;</code>、<code>/stop</code>、<code>/new</code>、<code>/sessions</code>"
        );
      }
    }
  }

  private async handleCallback(adapter: ChatAdapter, data: string, messageId: number | null) {
    if (!data.startsWith("session:")) {
      await adapter.answerCallback();
      return;
    }

    if (this.isTaskBusy()) {
      await adapter.answerCallback("任务运行中，无法管理历史会话。");
      return;
    }

    const [, action, sessionId] = data.split(":");
    if (!action || !sessionId) {
      await adapter.answerCallback("这个按钮已经失效。");
      return;
    }

    switch (action) {
      case "use": {
        const session = await this.stateStore.findSessionById(sessionId);
        if (!session) {
          await adapter.answerCallback("会话不存在或已被删除。");
          await this.refreshSessionPicker(adapter, messageId, "目标会话不存在或已被删除。");
          return;
        }

        if (!existsSync(session.cwd)) {
          await adapter.answerCallback("该会话的工作目录不存在。");
          await this.refreshSessionPicker(
            adapter,
            messageId,
            `无法切换到会话“${session.preview}”，因为目录不存在：${session.cwd}`
          );
          return;
        }

        const currentState = await this.stateStore.load();
        if (currentState.threadId === session.threadId && currentState.currentCwd === session.cwd) {
          await adapter.answerCallback("已经是当前会话。");
          await this.refreshSessionPicker(adapter, messageId, `当前已经是会话“${session.preview}”。`);
          return;
        }

        const activated = await this.stateStore.activateSession(sessionId);
        if (!activated) {
          await adapter.answerCallback("会话不存在或已被删除。");
          await this.refreshSessionPicker(adapter, messageId, "目标会话不存在或已被删除。");
          return;
        }

        await adapter.answerCallback("已切换会话。");
        await this.refreshSessionPicker(
          adapter,
          messageId,
          `已切换到会话“${activated.preview}”，工作目录为 ${activated.cwd}`
        );
        return;
      }
      case "delete": {
        const deleted = await this.stateStore.deleteSession(sessionId);
        if (!deleted) {
          await adapter.answerCallback("会话不存在或已被删除。");
          await this.refreshSessionPicker(adapter, messageId, "目标会话不存在或已被删除。");
          return;
        }

        await adapter.answerCallback("已删除会话记录。");
        await this.refreshSessionPicker(
          adapter,
          messageId,
          deleted.isCurrentSession
            ? `已删除当前会话“${deleted.entry.preview}”。下一次任务会新建会话。`
            : `已删除会话“${deleted.entry.preview}”。`
        );
        return;
      }
      default: {
        await adapter.answerCallback("这个按钮已经失效。");
      }
    }
  }

  private async renderStatus() {
    const state = await this.stateStore.load();
    const mode = this.isTaskBusy() || state.activeRun ? "运行中" : "空闲";
    const threadText = state.threadId ? state.threadId : "待创建新线程";
    return [
      `<b>状态</b>`,
      `<code>运行状态: ${escapeHtml(mode)}</code>`,
      `<code>工作目录: ${escapeHtml(state.currentCwd)}</code>`,
      `<code>线程: ${escapeHtml(threadText)}</code>`,
      `<code>恢复状态: ${escapeHtml(formatRecoveryStatus(state.recoveryStatus))}</code>`,
      `<code>接口地址: ${escapeHtml(this.config.codex.baseUrl ?? "默认（OpenAI 官方）")}</code>`,
      `<code>提供方: ${escapeHtml(renderProviderStatus(this.config))}</code>`,
      `<code>模型: ${escapeHtml(this.config.codex.model)}</code>`,
      `<code>推理强度: ${escapeHtml(formatReasoningEffort(this.config.codex.reasoningEffort))}</code>`,
      `<code>审批策略: ${escapeHtml(formatApprovalPolicy(this.config.codex.approvalPolicy))}</code>`,
      `<code>沙箱模式: ${escapeHtml(formatSandboxMode(this.config.codex.sandboxMode))}</code>`,
      `<code>网络访问: ${this.config.codex.networkAccessEnabled ? "已启用" : "已禁用"}</code>`,
      `<code>历史会话: ${state.sessionHistory.length}/${SESSION_HISTORY_LIMIT}</code>`,
      `<code>上次退出时有未完成任务: ${state.previousShutdownHadActiveTask ? "是" : "否"}</code>`
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
      await adapter.sendHtml("已有任务在运行，请先使用 <code>/stop</code>。");
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
    let streamingBodySegments: string[] = [];
    let statusMessageId: number | null = null;
    let bodyMessageIds: number[] = [];
    let renderedStatus = "";
    let renderedBodyChunks: string[] = [];
    let renderedBodyMode: BodyRenderMode | null = null;
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

    const syncMessages = async (stateLabel: string, force = false, bodyMode: BodyRenderMode = "html-live") => {
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
      const bodyChunks =
        bodyMode === "rich"
          ? renderRichBodyChunks(body)
          : bodyMode === "html-final"
            ? renderBodyChunks(body)
            : streamingBodySegments.map((segment) => renderStreamingBodyChunk(segment));
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
        if (renderedBodyMode === bodyMode && renderedBodyChunks[index] === chunk) {
          continue;
        }

        if (existingMessageId) {
          if (bodyMode === "rich") {
            await adapter.editRichMarkdown(existingMessageId, chunk);
          } else {
            await adapter.editHtml(existingMessageId, chunk);
          }
        } else {
          bodyMessageIds.push(
            bodyMode === "rich" ? await adapter.replyRichMarkdown(chunk) : await adapter.replyHtml(chunk)
          );
        }
        renderedBodyChunks[index] = chunk;
      }

      while (bodyMessageIds.length > bodyChunks.length) {
        const messageId = bodyMessageIds.pop();
        renderedBodyChunks.pop();
        if (messageId) {
          await adapter.deleteMessage(messageId);
        }
      }

      renderedBodyMode = bodyChunks.length ? bodyMode : renderedBodyMode;
    };

    try {
      await startTypingHeartbeat();
      await syncMessages("运行中", true);

      const result = await this.codex.runTask({
        text,
        attachments,
        exportDir: runDirs.exportDir,
        onEvent: async (event) => {
          if (event.type === "text-delta") {
            body += event.delta;
            streamingBodySegments = appendStreamingSegments(streamingBodySegments, event.delta);
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
          await syncMessages("运行中");
        }
      });

      stopTypingHeartbeat();
      if (result.stopped) {
        await syncMessages("已停止", true);
      } else {
        try {
          await syncMessages("已完成", true, "rich");
        } catch (error) {
          console.error("[service] Failed to render rich Telegram output, falling back to HTML:", error);
          await syncMessages("已完成", true, "html-final");
        }
      }

      const artifacts = await this.attachmentStore.collectNewArtifacts(runDirs.exportDir, exportSnapshot);
      for (const artifact of artifacts) {
        const caption = `已生成文件：<code>${escapeHtml(artifact.fileName)}</code>`;
        if (artifact.kind === "image") {
          await adapter.sendPhoto(artifact.path, caption);
        } else {
          await adapter.sendDocument(artifact.path, artifact.fileName, caption);
        }
      }
    } catch (error) {
      stopTypingHeartbeat();
      statusLines.push(error instanceof Error ? error.message : String(error));
      await syncMessages("执行失败", true);
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

  private isTaskBusy() {
    return this.activeTaskToken !== null;
  }

  private async runTaskGuarded(adapter: ChatAdapter, task: () => Promise<void>) {
    if (this.isTaskBusy()) {
      await adapter.sendHtml("已有任务在运行，请先使用 <code>/stop</code>。");
      return;
    }

    const token = Symbol("active-task");
    this.activeTaskToken = token;

    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[service] Background task setup failed:", error);
      await adapter.sendHtml(`执行失败：<code>${escapeHtml(message)}</code>`);
    } finally {
      if (this.activeTaskToken === token) {
        this.activeTaskToken = null;
      }
    }
  }

  private async sendSessionPicker(adapter: ChatAdapter, notice?: string) {
    const { html, replyMarkup } = await this.renderSessionPicker(notice);
    await adapter.sendHtml(html, replyMarkup ? { replyMarkup } : undefined);
  }

  private async refreshSessionPicker(adapter: ChatAdapter, messageId: number | null, notice?: string) {
    const { html, replyMarkup } = await this.renderSessionPicker(notice);
    const options = replyMarkup ? { replyMarkup } : undefined;
    if (messageId === null) {
      await adapter.sendHtml(html, options);
      return;
    }

    await adapter.editHtml(messageId, html, options);
  }

  private async renderSessionPicker(notice?: string) {
    const state = await this.stateStore.load();
    const sessions = await this.stateStore.listRecentSessions();
    const lines = [
      "<b>最近会话</b>",
      `<code>仅保留最近 ${SESSION_HISTORY_LIMIT} 条。点击左侧切换，右侧删除。</code>`
    ];

    if (notice) {
      lines.push("", escapeHtml(notice));
    }

    if (!sessions.length) {
      lines.push("", "暂无历史会话。");
      return {
        html: lines.join("\n"),
        replyMarkup: { inline_keyboard: [] }
      };
    }

    const replyMarkup: ChatInlineKeyboardMarkup = {
      inline_keyboard: sessions.map((session) => [
        {
          text: formatSessionButtonLabel(session, state.threadId),
          callback_data: `session:use:${session.id}`
        },
        {
          text: "删除",
          callback_data: `session:delete:${session.id}`
        }
      ])
    };

    return {
      html: lines.join("\n"),
      replyMarkup
    };
  }
}

function appendStreamingSegments(existingSegments: string[], delta: string) {
  if (!delta) {
    return existingSegments;
  }

  if (!existingSegments.length) {
    return splitStreamingBodyText(delta);
  }

  const nextSegments = [...existingSegments];
  const lastSegment = nextSegments.pop() ?? "";
  const replacementSegments = splitStreamingBodyText(`${lastSegment}${delta}`);
  nextSegments.push(...replacementSegments);
  return nextSegments;
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
    return config.codex.baseUrl ? "OpenAI 兼容接口覆写" : "默认 OpenAI";
  }

  const providerId = provider.id ?? "relay_proxy";
  const websocketStatus =
    provider.supportsWebsockets === undefined
      ? "默认 WebSocket 设置"
      : provider.supportsWebsockets
        ? "WebSocket 已启用"
        : "仅 HTTPS";

  return `${providerId} (${websocketStatus})`;
}

function summarizeCommand(command: string) {
  return command.length > 240 ? `${command.slice(0, 237)}...` : command;
}

function formatSessionButtonLabel(session: SessionHistoryEntry, currentThreadId: string | null) {
  const time = formatSessionTime(session.lastUsedAt);
  const cwdLabel = abbreviateText(basename(session.cwd) || session.cwd, 12);
  const preview = abbreviateText(session.preview, 20);
  const prefix = session.threadId === currentThreadId ? "当前 · " : "";
  return `${prefix}${time} | ${cwdLabel} | ${preview}`;
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function abbreviateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 1))}…` : value;
}

function formatRecoveryStatus(status: ServiceState["recoveryStatus"]) {
  switch (status) {
    case "fresh":
      return "新会话";
    case "resume-pending":
      return "等待恢复";
    case "resumed":
      return "已恢复";
    case "recreated-after-missing-thread":
      return "原会话不可用，已新建";
    case "recreated-after-invalid-cwd":
      return "工作目录失效，已新建";
  }
}

function formatReasoningEffort(reasoningEffort: RelayConfig["codex"]["reasoningEffort"]) {
  switch (reasoningEffort) {
    case undefined:
      return "默认";
    case "minimal":
      return "最小（minimal）";
    case "low":
      return "低（low）";
    case "medium":
      return "中（medium）";
    case "high":
      return "高（high）";
    case "xhigh":
      return "很高（xhigh）";
  }
}

function formatApprovalPolicy(approvalPolicy: RelayConfig["codex"]["approvalPolicy"]) {
  switch (approvalPolicy) {
    case "never":
      return "从不询问（never）";
    case "on-request":
      return "按需询问（on-request）";
    case "on-failure":
      return "失败时询问（on-failure）";
    case "untrusted":
      return "不受信任时询问（untrusted）";
  }
}

function formatSandboxMode(sandboxMode: RelayConfig["codex"]["sandboxMode"]) {
  switch (sandboxMode) {
    case "read-only":
      return "只读（read-only）";
    case "workspace-write":
      return "工作区可写（workspace-write）";
    case "danger-full-access":
      return "完全访问（danger-full-access）";
  }
}
