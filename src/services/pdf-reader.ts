import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { toUint8Array } from "../utils/validation.js";
import type { PageText } from "../types.js";

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

export async function loadPdf(filePath: string): Promise<PDFDocumentProxy> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);
  return getDocumentProxy(data);
}

export async function extractPdfText(
  filePath: string,
  pageIndices?: number[]
): Promise<{ totalPages: number; pages: PageText[] }> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);
  const result = await extractText(data, { mergePages: false });

  let pages: PageText[];

  if (pageIndices) {
    pages = pageIndices
      .filter((i) => i >= 0 && i < result.totalPages)
      .map((i) => ({ page: i + 1, text: result.text[i] }));
  } else {
    pages = result.text.map((text, i) => ({ page: i + 1, text }));
  }

  return { totalPages: result.totalPages, pages };
}

export async function getPdfPageCount(filePath: string): Promise<number> {
  const doc = await loadPdf(filePath);
  const count = doc.numPages;
  doc.cleanup();
  return count;
}
