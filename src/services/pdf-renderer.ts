import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { PdfError } from "../utils/errors.js";
import { MAX_RENDER_DIMENSION } from "../constants.js";
import { logger } from "../utils/logger.js";

// Lazily-loaded, cached PDFium library instance. PDFium ships as a WASM binary
// whose initialization costs ~hundreds of ms; loading it on first render keeps
// the MCP server's cold start fast, and caching the instance amortizes the cost
// across subsequent calls.
type PdfiumModule = typeof import("@hyzyla/pdfium");
type PdfiumLibrary = Awaited<ReturnType<PdfiumModule["PDFiumLibrary"]["init"]>>;

let libraryPromise: Promise<PdfiumLibrary> | null = null;

async function getLibrary(): Promise<PdfiumLibrary> {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      // Dynamic import INSIDE the function so the WASM module is only resolved
      // and instantiated when a render is actually requested.
      const { PDFiumLibrary } = await import("@hyzyla/pdfium");
      return PDFiumLibrary.init();
    })().catch((err: unknown) => {
      // Reset so a transient failure does not poison every future call.
      libraryPromise = null;
      throw err;
    });
  }
  return libraryPromise;
}

export interface RenderedPage {
  pageIndex: number;
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Per-page sink invoked once per rendered page. Returning a promise lets the
 * caller stream each encoded image to disk before the next page is rendered,
 * so file-mode rendering never holds more than one page buffer resident.
 */
export type OnPage = (page: RenderedPage) => void | Promise<void>;

export interface RenderOptions {
  pageIndices: number[];
  dpi: number;
  format: "png" | "jpeg";
  /**
   * Optional per-page callback. When provided, each encoded page is handed to
   * the callback and then released (file mode) — the function resolves to an
   * empty array and never accumulates buffers. When omitted, all rendered pages
   * are collected and returned (inline mode, bounded to a few small pages).
   */
  onPage?: OnPage;
}

/** A page's intrinsic size in PDF points (72 per inch), from PDFium. */
export interface PageSize {
  pageIndex: number;
  widthPoints: number;
  heightPoints: number;
}

function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const png = new PNG({ width, height });
  // pngjs expects RGBA in `data`; PDFium's bitmap render (with REVERSE_BYTE_ORDER)
  // already produces RGBA, so the buffer can be copied in directly.
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

function encodeJpeg(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  // jpeg-js also accepts an RGBA buffer; quality 90 balances size and fidelity.
  const encoded = jpeg.encode(
    {
      data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      width,
      height,
    },
    90,
  );
  return new Uint8Array(encoded.data);
}

type PdfiumDocument = Awaited<ReturnType<PdfiumLibrary["loadDocument"]>>;

/**
 * Initialize PDFium (lazy + cached) and parse the document, mapping failures to
 * the shared PdfError codes. Callers must `destroy()` the returned document.
 */
async function openDocument(pdfBytes: Uint8Array): Promise<PdfiumDocument> {
  let library: PdfiumLibrary;
  try {
    library = await getLibrary();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to initialize the PDF rendering engine (PDFium WASM): ${message}`,
      "WASM_LOAD_FAILED",
    );
  }

  try {
    return await library.loadDocument(pdfBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to parse PDF — the file may be corrupt, encrypted, or not a valid PDF: ${message}`,
      "CORRUPT_PDF",
    );
  }
}

/**
 * Read intrinsic page sizes (in PDF points) for the given page indices straight
 * from PDFium. This lets callers compute a safe inline DPI without a second
 * parse via pdf-lib (which would surface a misleading error on encrypted/corrupt
 * input) — failures map to the same CORRUPT_PDF/WASM_LOAD_FAILED codes as a render.
 */
export async function getPageSizes(
  pdfBytes: Uint8Array,
  pageIndices: number[],
): Promise<PageSize[]> {
  const document = await openDocument(pdfBytes);
  try {
    return pageIndices.map((pageIndex) => {
      const page = document.getPage(pageIndex);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      return {
        pageIndex,
        widthPoints: originalWidth,
        heightPoints: originalHeight,
      };
    });
  } finally {
    try {
      document.destroy();
    } catch (err) {
      logger.warn("Failed to destroy PDFium document", err);
    }
  }
}

export async function renderPdfPages(
  pdfBytes: Uint8Array,
  opts: RenderOptions,
): Promise<RenderedPage[]> {
  const scale = opts.dpi / 72;
  const document = await openDocument(pdfBytes);

  try {
    // In streaming (file) mode we never retain buffers: each page is handed to
    // the callback and then dropped. In inline mode (no callback) we collect the
    // small, DPI-capped pages to return.
    const results: RenderedPage[] = [];

    for (const pageIndex of opts.pageIndices) {
      const page = document.getPage(pageIndex);

      // Guard against memory blow-ups: reject pages that would exceed the
      // dimension cap before allocating the bitmap buffer.
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const projectedWidth = Math.floor(originalWidth * scale);
      const projectedHeight = Math.floor(originalHeight * scale);
      if (
        projectedWidth > MAX_RENDER_DIMENSION ||
        projectedHeight > MAX_RENDER_DIMENSION
      ) {
        throw new PdfError(
          `Page ${pageIndex + 1} would render at ${projectedWidth}x${projectedHeight}px, exceeding the ${MAX_RENDER_DIMENSION}px limit. Use a lower dpi.`,
          "RESOURCE_LIMIT",
        );
      }

      // render: "bitmap" with default BGRA colorSpace + REVERSE_BYTE_ORDER flag
      // yields raw RGBA pixel data — directly consumable by pngjs and jpeg-js.
      const rendered = await page.render({ scale, render: "bitmap" });

      const data =
        opts.format === "png"
          ? encodePng(rendered.data, rendered.width, rendered.height)
          : encodeJpeg(rendered.data, rendered.width, rendered.height);

      const renderedPage: RenderedPage = {
        pageIndex,
        data,
        width: rendered.width,
        height: rendered.height,
      };

      if (opts.onPage) {
        // Stream this page out and release it before rendering the next one,
        // so at most one encoded page buffer is resident at a time.
        await opts.onPage(renderedPage);
      } else {
        results.push(renderedPage);
      }
    }

    return results;
  } finally {
    try {
      document.destroy();
    } catch (err) {
      logger.warn("Failed to destroy PDFium document", err);
    }
  }
}
