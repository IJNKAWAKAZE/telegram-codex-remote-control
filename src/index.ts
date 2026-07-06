import { appendFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveAppRoot } from "./config.js";
import { RemoteControlService } from "./service.js";

async function main() {
  const config = loadConfig();
  clearStartupErrorLog(config.appRoot);
  const service = new RemoteControlService(config);
  await service.start();
}

main().catch((error) => {
  writeStartupErrorLog(error);
  console.error("[main] Fatal error:", error);
  process.exit(1);
});

function writeStartupErrorLog(error: unknown) {
  try {
    const appRoot = resolveAppRoot();
    const logPath = resolve(appRoot, "startup-error.log");
    const payload = error instanceof Error ? error.stack || error.message : String(error);
    appendFileSync(logPath, `[${new Date().toISOString()}] ${payload}\n\n`, "utf-8");
  } catch {
    // Startup logging must never mask the original fatal error.
  }
}

function clearStartupErrorLog(appRoot: string) {
  const logPath = resolve(appRoot, "startup-error.log");
  if (existsSync(logPath)) {
    rmSync(logPath);
  }
}
