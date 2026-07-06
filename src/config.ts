import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z, ZodError } from "zod";
import type { RelayConfig } from "./types.js";

const fileConfigSchema = z.object({
  defaultCwd: z.string().min(1),
  dataDir: z.string().min(1),
  tempDir: z.string().min(1),
  stateFile: z.string().min(1),
  codexHome: z.string().min(1),
  telegram: z.object({
    pollTimeoutSeconds: z.number().int().positive()
  }),
  codex: z.object({
    baseUrl: z.string().optional().refine(isValidAbsoluteUrl, {
      message: "Invalid config: codex.baseUrl must be a valid absolute URL"
    }),
    provider: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        envKey: z.string().min(1).optional(),
        wireApi: z.enum(["responses"]).optional(),
        supportsWebsockets: z.boolean().optional()
      })
      .optional(),
    model: z.string().min(1),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]),
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    skipGitRepoCheck: z.boolean(),
    networkAccessEnabled: z.boolean()
  })
});

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_ID: z.coerce.number().int().positive(),
  OPENAI_API_KEY: z.string().min(1)
});

export function resolveAppRoot() {
  if (process.env.RELAY_HOME) {
    return resolve(process.env.RELAY_HOME);
  }

  const execName = basename(process.execPath).toLowerCase();
  const looksLikeNode =
    execName === "node" ||
    execName === "node.exe" ||
    execName === "nodejs" ||
    execName === "nodejs.exe";

  return looksLikeNode ? resolve(process.cwd()) : resolve(dirname(process.execPath));
}

export function loadConfig(): RelayConfig {
  const appRoot = resolveAppRoot();
  dotenv.config({ path: resolve(appRoot, ".env") });

  const configPath = resolve(appRoot, "config", "relay.config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const env = parseOrThrow(envSchema, process.env);
  const fileConfig = parseOrThrow(fileConfigSchema, JSON.parse(readFileSync(configPath, "utf-8")));

  const config: RelayConfig = {
    appRoot,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    allowedTelegramUserId: env.ALLOWED_TELEGRAM_USER_ID,
    openaiApiKey: env.OPENAI_API_KEY,
    defaultCwd: resolve(appRoot, fileConfig.defaultCwd),
    dataDir: resolve(appRoot, fileConfig.dataDir),
    tempDir: resolve(appRoot, fileConfig.tempDir),
    stateFile: resolve(appRoot, fileConfig.stateFile),
    codexHome: resolve(appRoot, fileConfig.codexHome),
    telegram: fileConfig.telegram,
    codex: {
      baseUrl: fileConfig.codex.baseUrl,
      provider: fileConfig.codex.provider,
      model: fileConfig.codex.model,
      reasoningEffort: fileConfig.codex.reasoningEffort,
      approvalPolicy: fileConfig.codex.approvalPolicy,
      sandboxMode: fileConfig.codex.sandboxMode,
      skipGitRepoCheck: fileConfig.codex.skipGitRepoCheck,
      networkAccessEnabled: fileConfig.codex.networkAccessEnabled
    }
  };

  if (!existsSync(config.defaultCwd)) {
    throw new Error(`Invalid defaultCwd: ${config.defaultCwd}`);
  }

  if (config.codex.provider && !config.codex.baseUrl) {
    throw new Error("Invalid config: codex.provider requires codex.baseUrl");
  }

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
  mkdirSync(config.codexHome, { recursive: true });

  return config;
}

function isValidAbsoluteUrl(value: string | undefined) {
  if (value === undefined) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw formatConfigError(result.error);
}

function formatConfigError(error: ZodError) {
  const [issue] = error.issues;
  if (!issue) {
    return new Error("Invalid config");
  }

  const path = issue.path.join(".");
  if (path === "codex.reasoningEffort") {
    return new Error("Invalid config: codex.reasoningEffort must be one of minimal|low|medium|high|xhigh");
  }

  if (path === "codex.baseUrl") {
    return new Error("Invalid config: codex.baseUrl must be a valid absolute URL");
  }

  return new Error(`Invalid config: ${path || "root"} ${issue.message}`);
}
