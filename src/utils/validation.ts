import { resolve, extname, dirname } from "node:path";
import { access, stat } from "node:fs/promises";
import {
  MAX_FILE_SIZE_MB,
  MAX_PAGE_NUMBER,
  SUPPORTED_IMAGE_FORMATS,
} from "../constants.js";
import type { ParsedPageRange } from "../types.js";
import { PdfError } from "./errors.js";

export async function validatePdfPath(filePath: string): Promise<string> {
  const resolved = resolve(filePath);

  if (extname(resolved).toLowerCase() !== ".pdf") {
    throw new PdfError(
      `Not a PDF file: ${resolved}. File must have a .pdf extension.`,
      "NOT_A_PDF",
    );
  }

  try {
    const stats = await stat(resolved);
    if (stats.isDirectory()) {
      throw new PdfError(
        `Not a PDF file: ${resolved} is a directory.`,
        "INVALID_INPUT",
      );
    }
  } catch (err) {
    if (err instanceof PdfError) throw err;
    throw new PdfError(
      `File not found: ${resolved}. Check the path and try again.`,
      "FILE_NOT_FOUND",
    );
  }

  return resolved;
}

export async function validateOutputPath(
  outputPath: string,
  inputPath?: string,
): Promise<string> {
  const resolved = resolve(outputPath);

  if (extname(resolved).toLowerCase() !== ".pdf") {
    throw new PdfError(
      `Output path must have a .pdf extension: ${resolved}`,
      "INVALID_INPUT",
    );
  }

  // Verify the parent directory exists (we do NOT probe W_OK — it is
  // unreliable on Windows and would reject valid targets).
  try {
    await access(dirname(resolved));
  } catch {
    throw new PdfError(
      `Output directory does not exist: ${dirname(resolved)}. Create the directory first.`,
      "INVALID_INPUT",
    );
  }

  if (inputPath && resolve(inputPath) === resolved) {
    throw new PdfError(
      `Output path cannot be the same as input path: ${resolved}. Choose a different output path.`,
      "INVALID_INPUT",
    );
  }

  return resolved;
}

export async function validateFontPath(filePath: string): Promise<string> {
  const resolved = resolve(filePath);
  const ext = extname(resolved).toLowerCase();

  if (ext !== ".ttf" && ext !== ".otf") {
    throw new PdfError(
      `Not a font file: ${resolved}. File must have a .ttf or .otf extension.`,
      "UNSUPPORTED_FORMAT",
    );
  }

  try {
    await access(resolved);
  } catch {
    throw new PdfError(
      `File not found: ${resolved}. Check the path and try again.`,
      "FILE_NOT_FOUND",
    );
  }

  return resolved;
}

const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] =
  SUPPORTED_IMAGE_FORMATS.flatMap((mime) =>
    mime === "image/png"
      ? [".png"]
      : mime === "image/jpeg"
        ? [".jpg", ".jpeg"]
        : [],
  );

export async function validateImagePath(filePath: string): Promise<string> {
  const resolved = resolve(filePath);
  const ext = extname(resolved).toLowerCase();

  if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
    throw new PdfError(
      `Unsupported image format: ${resolved}. Only JPEG (.jpg, .jpeg) and PNG (.png) files are supported.`,
      "UNSUPPORTED_FORMAT",
    );
  }

  try {
    await access(resolved);
  } catch {
    throw new PdfError(
      `File not found: ${resolved}. Check the path and try again.`,
      "FILE_NOT_FOUND",
    );
  }

  return resolved;
}

export async function validateFileSize(
  filePath: string,
  maxMb: number = MAX_FILE_SIZE_MB,
): Promise<void> {
  const stats = await stat(filePath);
  const sizeMb = stats.size / (1024 * 1024);

  if (sizeMb > maxMb) {
    throw new PdfError(
      `File too large: ${sizeMb.toFixed(1)} MB (limit: ${maxMb} MB). Use a smaller file or split it first.`,
      "RESOURCE_LIMIT",
    );
  }
}

export function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

export function parsePageRange(
  rangeStr: string,
  totalPages: number,
): ParsedPageRange {
  const pages = new Set<number>();
  const segments = rangeStr.split(",").map((s) => s.trim());

  for (const segment of segments) {
    if (segment.includes("-")) {
      // Strictly reject anything that is not "<digits>-<digits>" before
      // parsing, so "5-2-1", "1-", "-3", "3.5-4", "a-b" all fail cleanly.
      if (!/^\d+-\d+$/.test(segment)) {
        throw new PdfError(
          `Invalid page range format: "${segment}". Use "start-end" (e.g., "1-5").`,
          "INVALID_INPUT",
        );
      }

      const parts = segment.split("-");
      const start = Number.parseInt(parts[0], 10);
      const end = Number.parseInt(parts[1], 10);

      if (start < 1 || end < 1) {
        throw new PdfError(
          `Page numbers must be at least 1: "${segment}".`,
          "INVALID_INPUT",
        );
      }

      if (start > MAX_PAGE_NUMBER || end > MAX_PAGE_NUMBER) {
        throw new PdfError(
          `Page number exceeds maximum (${MAX_PAGE_NUMBER.toLocaleString()}).`,
          "INVALID_INPUT",
        );
      }

      if (start > end) {
        throw new PdfError(
          `Invalid range: "${segment}". Start page must not exceed end page.`,
          "INVALID_INPUT",
        );
      }

      if (start > totalPages || end > totalPages) {
        throw new PdfError(
          `Page range "${segment}" exceeds document length (${totalPages} pages).`,
          "PAGE_OUT_OF_RANGE",
        );
      }

      for (let i = start; i <= end; i++) {
        pages.add(i - 1);
      }
    } else {
      // Strictly reject non-digit single segments ("abc", "3.5", "3abc",
      // empty string from "1,,3") before parsing.
      if (!/^\d+$/.test(segment)) {
        throw new PdfError(
          `Invalid page number: "${segment}". Pages must be integers.`,
          "INVALID_INPUT",
        );
      }

      const page = Number.parseInt(segment, 10);

      if (page < 1) {
        throw new PdfError(
          `Page numbers must be at least 1, got ${page}.`,
          "INVALID_INPUT",
        );
      }

      if (page > MAX_PAGE_NUMBER) {
        throw new PdfError(
          `Page number exceeds maximum (${MAX_PAGE_NUMBER.toLocaleString()}).`,
          "INVALID_INPUT",
        );
      }

      if (page > totalPages) {
        throw new PdfError(
          `Page ${page} exceeds document length (${totalPages} pages).`,
          "PAGE_OUT_OF_RANGE",
        );
      }

      pages.add(page - 1);
    }
  }

  return [...pages].sort((a, b) => a - b);
}
