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

export interface RenderOptions {
  pageIndices: number[];
  dpi: number;
  format: "png" | "jpeg";
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

export async function renderPdfPages(
  pdfBytes: Uint8Array,
  opts: RenderOptions,
): Promise<RenderedPage[]> {
  const scale = opts.dpi / 72;

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

  let document: Awaited<ReturnType<PdfiumLibrary["loadDocument"]>>;
  try {
    document = await library.loadDocument(pdfBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to parse PDF — the file may be corrupt, encrypted, or not a valid PDF: ${message}`,
      "CORRUPT_PDF",
    );
  }

  try {
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

      results.push({
        pageIndex,
        data,
        width: rendered.width,
        height: rendered.height,
      });
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
