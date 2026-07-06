import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseRoot = join(projectRoot, "release", process.platform);
const buildRoot = join(projectRoot, "build");
const blobPath = join(buildRoot, "sea-prep.blob");
const bootstrapEntry = join(buildRoot, "sea", "bootstrap.cjs");
const appBundlePath = join(buildRoot, "sea", "app.mjs");
const releaseAppBundlePath = join(releaseRoot, "app.mjs");
const bundleOnly = process.argv.includes("--bundle-only");

async function main() {
  await rm(buildRoot, { recursive: true, force: true });
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(join(buildRoot, "sea"), { recursive: true });
  await mkdir(releaseRoot, { recursive: true });

  await writeFile(bootstrapEntry, createBootstrapSource(), "utf-8");

  await esbuild.build({
    entryPoints: [join(projectRoot, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: {
      js: `import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`
    },
    outfile: appBundlePath
  });

  await cp(appBundlePath, releaseAppBundlePath);

  if (bundleOnly) {
    console.log(`[build-native] Bootstrap created at ${bootstrapEntry}`);
    console.log(`[build-native] App bundle created at ${appBundlePath}`);
    return;
  }

  const seaConfigPath = join(buildRoot, "sea-config.json");
  await writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: bootstrapEntry,
        output: blobPath,
        disableExperimentalSEAWarning: true
      },
      null,
      2
    )
  );

  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  const executableName = process.platform === "win32" ? "telegram-codex-remote-control.exe" : "telegram-codex-remote-control";
  const targetExecutable = join(releaseRoot, executableName);
  await cp(process.execPath, targetExecutable);

  const postjectCli = resolve(dirname(require.resolve("postject/package.json")), "dist", "cli.js");
  const postjectArgs = [
    postjectCli,
    targetExecutable,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
  ];

  if (process.platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }

  execFileSync(process.execPath, postjectArgs, {
    cwd: projectRoot,
    stdio: "inherit"
  });

  const vendorRoot = resolveVendorRoot();
  const runtimeRoot = join(releaseRoot, "runtime", "codex");
  await cp(vendorRoot, runtimeRoot, { recursive: true });

  await mkdir(join(releaseRoot, "config"), { recursive: true });
  await cp(
    join(projectRoot, "config", "relay.config.example.json"),
    join(releaseRoot, "config", "relay.config.example.json")
  );
  await cp(join(projectRoot, ".env.example"), join(releaseRoot, ".env.example"));

  console.log(`[build-native] Native package created in ${releaseRoot}`);
}

function createBootstrapSource() {
  return `
const { dirname, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const appEntry = resolve(dirname(process.execPath), "app.mjs");
  await import(pathToFileURL(appEntry).href);
})().catch((error) => {
  console.error("[bootstrap] Fatal error:", error);
  process.exit(1);
});
`.trimStart();
}

function resolveVendorRoot() {
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  const packageJson = JSON.parse(execRead(packageJsonPath));
  const optionalDependencyKey = resolveOptionalDependencyKey();
  if (!packageJson.optionalDependencies?.[optionalDependencyKey]) {
    throw new Error(`Unsupported platform for Codex sidecar: ${process.platform}/${process.arch}`);
  }

  const vendorPackageJsonPath = require.resolve(`${optionalDependencyKey}/package.json`);
  return join(dirname(vendorPackageJsonPath), "vendor", resolveTargetTriple());
}

function resolveOptionalDependencyKey() {
  if (process.platform === "win32" && process.arch === "x64") return "@openai/codex-win32-x64";
  if (process.platform === "win32" && process.arch === "arm64") return "@openai/codex-win32-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "@openai/codex-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "@openai/codex-linux-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "@openai/codex-darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "@openai/codex-darwin-arm64";
  throw new Error(`Unsupported platform for Codex sidecar: ${process.platform}/${process.arch}`);
}

function resolveTargetTriple() {
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-musl";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-musl";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  throw new Error(`Unsupported platform for Codex sidecar: ${process.platform}/${process.arch}`);
}

function execRead(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
  return require("node:fs").readFileSync(filePath, "utf-8");
}

main().catch((error) => {
  console.error("[build-native]", error);
  process.exit(1);
});
