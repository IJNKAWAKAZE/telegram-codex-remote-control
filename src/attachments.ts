import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { lookup as lookupMime } from "mime-types";
import type { IncomingAttachment, OutboundArtifact, StagedAttachment } from "./types.js";

type ExportSnapshot = Map<string, { mtimeMs: number; size: number }>;

export class AttachmentStore {
  constructor(private readonly tempRoot: string) {}

  async createRunContext(cwd: string, runId: string) {
    const inputDir = resolve(this.tempRoot, runId, "input");
    const exportDir = resolve(cwd, ".relay-out");
    await mkdir(inputDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    return { inputDir, exportDir };
  }

  async stageAttachment(input: {
    inputDir: string;
    attachment: IncomingAttachment;
    bytes: Buffer;
  }): Promise<StagedAttachment> {
    const fileName = sanitizeFileName(input.attachment.fileName);
    const path = join(input.inputDir, fileName);
    await writeFile(path, input.bytes);

    return {
      kind: input.attachment.mimeType.startsWith("image/") ? "image" : "file",
      fileName,
      path,
      mimeType: input.attachment.mimeType
    };
  }

  async snapshotExportDir(exportDir: string): Promise<ExportSnapshot> {
    const entries = await listFilesRecursive(exportDir);
    const snapshot: ExportSnapshot = new Map();

    for (const filePath of entries) {
      const fileStat = await stat(filePath);
      snapshot.set(filePath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size
      });
    }

    return snapshot;
  }

  async collectNewArtifacts(exportDir: string, previous: ExportSnapshot): Promise<OutboundArtifact[]> {
    const entries = await listFilesRecursive(exportDir);
    const artifacts: OutboundArtifact[] = [];

    for (const filePath of entries) {
      const fileStat = await stat(filePath);
      const previousValue = previous.get(filePath);

      if (
        previousValue &&
        previousValue.mtimeMs === fileStat.mtimeMs &&
        previousValue.size === fileStat.size
      ) {
        continue;
      }

      const extension = extname(filePath).toLowerCase();
      const mimeType = String(lookupMime(filePath) || "application/octet-stream");
      artifacts.push({
        kind: extension.startsWith(".png") ||
          extension.startsWith(".jpg") ||
          extension.startsWith(".jpeg") ||
          extension.startsWith(".gif") ||
          extension.startsWith(".webp")
          ? "image"
          : "file",
        fileName: basename(filePath),
        path: filePath,
        mimeType
      });
    }

    artifacts.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return artifacts;
  }
}

function sanitizeFileName(fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "attachment.bin";
  }

  return trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
