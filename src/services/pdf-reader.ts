import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { toUint8Array } from "../utils/validation.js";
import { PdfError } from "../utils/errors.js";
import type { PageText, PageTextLayout, PositionedTextItem } from "../types.js";

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// A pdf.js text-content item. We only depend on the positional subset of the
// public `TextItem` shape; marked-content items (which lack `str`) are skipped.
interface RawTextItem {
  str: string;
  // 6-element text matrix [a, b, c, d, e, f]: e = x, f = y (PDF user space,
  // origin bottom-left). The vertical scale d (and skew b) give the glyph size.
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(item: unknown): item is RawTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    "transform" in item &&
    Array.isArray((item as { transform: unknown }).transform)
  );
}

export async function loadPdf(filePath: string): Promise<PDFDocumentProxy> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);
  return getDocumentProxy(data);
}

export async function extractPdfText(
  filePath: string,
  pageIndices?: number[],
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

/**
 * Extract positioned text items for the given (0-based) page indices using
 * pdf.js' per-page `getTextContent()`. Each item carries its x/y position,
 * width/height and an inferred font size, enabling reading-order and heading
 * reconstruction that plain text extraction cannot provide.
 */
export async function extractPositionedText(
  filePath: string,
  pageIndices: number[],
): Promise<PageTextLayout[]> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);

  let doc: PDFDocumentProxy;
  try {
    doc = await getDocumentProxy(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to parse PDF — the file may be corrupt, encrypted, or not a valid PDF: ${message}`,
      "CORRUPT_PDF",
    );
  }

  try {
    const layouts: PageTextLayout[] = [];

    for (const index of pageIndices) {
      if (index < 0 || index >= doc.numPages) continue;

      // pdf.js page numbers are 1-based.
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const items: PositionedTextItem[] = [];
      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        if (raw.str.length === 0) continue;

        const transform = raw.transform;
        const x = transform[4];
        const y = transform[5];

        // Glyph size: the vertical scale of the text matrix (sqrt(c^2 + d^2))
        // is the most reliable size signal; pdf.js' `height` field is 0 for some
        // fonts. Fall back to `height` when the matrix yields nothing.
        const matrixSize = Math.hypot(transform[2], transform[3]);
        const fontSize = matrixSize > 0 ? matrixSize : raw.height;

        items.push({
          str: raw.str,
          x,
          y,
          width: raw.width,
          height: raw.height,
          fontSize,
        });
      }

      layouts.push({
        page: index + 1,
        width: viewport.width,
        height: viewport.height,
        items,
      });

      page.cleanup();
    }

    return layouts;
  } finally {
    doc.cleanup();
  }
}
