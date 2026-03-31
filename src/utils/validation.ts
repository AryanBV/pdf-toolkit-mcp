import { resolve, extname, dirname } from "node:path";
import { access, stat } from "node:fs/promises";
import { MAX_FILE_SIZE_MB } from "../constants.js";
import type { ParsedPageRange } from "../types.js";

export async function validatePdfPath(filePath: string): Promise<string> {
  const resolved = resolve(filePath);

  if (extname(resolved).toLowerCase() !== ".pdf") {
    throw new Error(
      `Not a PDF file: ${resolved}. File must have a .pdf extension.`
    );
  }

  try {
    await access(resolved);
  } catch {
    throw new Error(
      `File not found: ${resolved}. Check the path and try again.`
    );
  }

  return resolved;
}

export async function validateOutputPath(
  outputPath: string,
  inputPath?: string
): Promise<string> {
  const resolved = resolve(outputPath);

  if (extname(resolved).toLowerCase() !== ".pdf") {
    throw new Error(
      `Output path must have a .pdf extension: ${resolved}`
    );
  }

  try {
    await access(dirname(resolved));
  } catch {
    throw new Error(
      `Output directory does not exist: ${dirname(resolved)}. Create the directory first.`
    );
  }

  if (inputPath && resolve(inputPath) === resolved) {
    throw new Error(
      `Output path cannot be the same as input path: ${resolved}. Choose a different output path.`
    );
  }

  return resolved;
}

export async function validateFileSize(
  filePath: string,
  maxMb: number = MAX_FILE_SIZE_MB
): Promise<void> {
  const stats = await stat(filePath);
  const sizeMb = stats.size / (1024 * 1024);

  if (sizeMb > maxMb) {
    throw new Error(
      `File too large: ${sizeMb.toFixed(1)} MB (limit: ${maxMb} MB). Use a smaller file or split it first.`
    );
  }
}

export function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

export function parsePageRange(
  rangeStr: string,
  totalPages: number
): ParsedPageRange {
  const pages = new Set<number>();
  const segments = rangeStr.split(",").map((s) => s.trim());

  for (const segment of segments) {
    if (segment.includes("-")) {
      const parts = segment.split("-");
      if (parts.length !== 2) {
        throw new Error(
          `Invalid page range format: "${segment}". Use "start-end" (e.g., "1-5").`
        );
      }

      const start = Number.parseInt(parts[0], 10);
      const end = Number.parseInt(parts[1], 10);

      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(
          `Invalid page numbers in range: "${segment}". Pages must be integers.`
        );
      }

      if (start < 1 || end < 1) {
        throw new Error(
          `Page numbers must be at least 1: "${segment}".`
        );
      }

      if (start > end) {
        throw new Error(
          `Invalid range: "${segment}". Start page must not exceed end page.`
        );
      }

      if (start > totalPages || end > totalPages) {
        throw new Error(
          `Page range "${segment}" exceeds document length (${totalPages} pages).`
        );
      }

      for (let i = start; i <= end; i++) {
        pages.add(i - 1);
      }
    } else {
      const page = Number.parseInt(segment, 10);

      if (Number.isNaN(page)) {
        throw new Error(
          `Invalid page number: "${segment}". Pages must be integers.`
        );
      }

      if (page < 1) {
        throw new Error(
          `Page numbers must be at least 1, got ${page}.`
        );
      }

      if (page > totalPages) {
        throw new Error(
          `Page ${page} exceeds document length (${totalPages} pages).`
        );
      }

      pages.add(page - 1);
    }
  }

  return [...pages].sort((a, b) => a - b);
}
