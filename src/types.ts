export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexWireApi = "responses";
export type CodexProviderConfig = {
  id?: string;
  name?: string;
  envKey?: string;
  wireApi?: CodexWireApi;
  supportsWebsockets?: boolean;
};

export type RelayConfig = {
  appRoot: string;
  telegramBotToken: string;
  allowedTelegramUserId: number;
  openaiApiKey: string;
  defaultCwd: string;
  dataDir: string;
  tempDir: string;
  stateFile: string;
  codexHome: string;
  telegram: {
    pollTimeoutSeconds: number;
  };
  codex: {
    baseUrl?: string;
    provider?: CodexProviderConfig;
    model: string;
    reasoningEffort?: ModelReasoningEffort;
    approvalPolicy: ApprovalPolicy;
    sandboxMode: SandboxMode;
    skipGitRepoCheck: boolean;
    networkAccessEnabled: boolean;
  };
};

export type RecoveryStatus =
  | "fresh"
  | "resume-pending"
  | "resumed"
  | "recreated-after-missing-thread"
  | "recreated-after-invalid-cwd";

export type ServiceState = {
  threadId: string | null;
  currentCwd: string;
  recoveryStatus: RecoveryStatus;
  activeRun: {
    startedAt: string;
    preview: string;
  } | null;
  previousShutdownHadActiveTask: boolean;
};

export type StagedAttachment = {
  kind: "image" | "file";
  fileName: string;
  path: string;
  mimeType: string;
};

export type OutboundArtifact = {
  kind: "image" | "file";
  fileName: string;
  path: string;
  mimeType: string;
};

export type RelayRunEvent =
  | { type: "status"; text: string }
  | { type: "command"; command: string }
  | { type: "text-delta"; delta: string };

export type RunResult = {
  stopped: boolean;
  threadId: string | null;
};

export type ChatAdapter = {
  replyHtml(html: string): Promise<number>;
  editHtml(messageId: number, html: string): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  sendHtml(html: string): Promise<void>;
  sendTyping(): Promise<void>;
  sendPhoto(path: string, caption?: string): Promise<void>;
  sendDocument(path: string, fileName: string, caption?: string): Promise<void>;
};

export type IncomingAttachment = {
  fileId: string;
  fileName: string;
  mimeType: string;
  caption: string;
};
