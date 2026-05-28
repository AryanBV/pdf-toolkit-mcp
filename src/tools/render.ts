import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, basename, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PDFDocument } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import { renderPdfPages } from "../services/pdf-renderer.js";
import { getPdfPageCount } from "../services/pdf-reader.js";
import {
  validatePdfPath,
  validateFileSize,
  parsePageRange,
  toUint8Array,
} from "../utils/validation.js";
import { PdfError, toolSuccess, toErrorResult } from "../utils/errors.js";
import { getFileSize } from "../utils/file-utils.js";
import type { ToolResult } from "../types.js";
import {
  DEFAULT_RENDER_DPI,
  MIN_RENDER_DPI,
  MAX_RENDER_DPI,
  MAX_RENDER_PAGES,
  MAX_INLINE_RENDER_PAGES,
  MAX_INLINE_DIMENSION,
} from "../constants.js";

// For inline rendering we cap the effective DPI so neither dimension of the
// largest requested page exceeds MAX_INLINE_DIMENSION. This keeps the base64
// payload small enough to protect the LLM context window. Page sizes come from
// pdf-lib (already a dependency) in PDF points (72 per inch); a render at
// `dpi` scales each point by dpi/72.
function safeInlineDpi(
  doc: PDFDocument,
  pageIndices: number[],
  requestedDpi: number,
): number {
  const pages = doc.getPages();
  let maxPoints = 0;
  for (const idx of pageIndices) {
    const page = pages[idx];
    if (!page) continue;
    const { width, height } = page.getSize();
    maxPoints = Math.max(maxPoints, width, height);
  }

  if (maxPoints <= 0) return requestedDpi;

  // dpi such that maxPoints * (dpi / 72) === MAX_INLINE_DIMENSION
  const dpiCap = Math.floor((MAX_INLINE_DIMENSION * 72) / maxPoints);
  return Math.max(MIN_RENDER_DPI, Math.min(requestedDpi, dpiCap));
}

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    "pdf_render_pages",
    {
      description:
        "Render PDF pages to images so a vision-capable client can read scanned or image-only PDFs (OCR/visual inspection). Default writes PNG/JPEG files to disk and returns their paths. Set inline:true to return pages as inline image blocks the model can see directly (max 5 pages, DPI auto-capped). Default DPI 150; renders the first 50 pages unless a page range is given.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range to render, e.g. '1-5,8'. Defaults to the first 50 pages.",
            ),
          dpi: z
            .number()
            .int()
            .min(MIN_RENDER_DPI)
            .max(MAX_RENDER_DPI)
            .optional()
            .describe(
              `Render resolution in DPI (${MIN_RENDER_DPI}–${MAX_RENDER_DPI}). Defaults to ${DEFAULT_RENDER_DPI}.`,
            ),
          format: z
            .enum(["png", "jpeg"])
            .optional()
            .describe("Output image format. Defaults to png."),
          inline: z
            .boolean()
            .optional()
            .describe(
              `Return rendered pages as inline image blocks the model can see directly instead of writing files. Max ${MAX_INLINE_RENDER_PAGES} pages; DPI is auto-capped so neither dimension exceeds ${MAX_INLINE_DIMENSION}px. Defaults to false.`,
            ),
          outputDir: z
            .string()
            .max(4096)
            .optional()
            .describe(
              "Absolute path to an existing directory for the images. Defaults to the input PDF's directory. Ignored when inline is true.",
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, pages, dpi, format, inline, outputDir }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const renderDpi = dpi ?? DEFAULT_RENDER_DPI;
        const renderFormat = format ?? "png";

        const pdfBytes = toUint8Array(await readFile(resolvedPath));
        const totalPages = await getPdfPageCount(resolvedPath);

        const inlineMode = inline === true;

        let pageIndices: number[];
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
        } else {
          const defaultCap = inlineMode
            ? MAX_INLINE_RENDER_PAGES
            : MAX_RENDER_PAGES;
          const count = Math.min(totalPages, defaultCap);
          pageIndices = Array.from({ length: count }, (_, i) => i);
        }

        if (pageIndices.length > MAX_RENDER_PAGES) {
          throw new PdfError(
            `Requested ${pageIndices.length} pages, exceeding the limit of ${MAX_RENDER_PAGES} per call. Narrow the 'pages' range and try again.`,
            "RESOURCE_LIMIT",
          );
        }

        // ── Inline mode: return base64 image content blocks, write no files ──
        if (inlineMode) {
          if (pageIndices.length > MAX_INLINE_RENDER_PAGES) {
            throw new PdfError(
              `Inline rendering is limited to ${MAX_INLINE_RENDER_PAGES} pages per call (requested ${pageIndices.length}). Narrow the 'pages' range, or use inline:false to write image files instead.`,
              "RESOURCE_LIMIT",
            );
          }

          const doc = await pdfLib.PDFDocument.load(pdfBytes);
          const effectiveDpi = safeInlineDpi(doc, pageIndices, renderDpi);

          const rendered = await renderPdfPages(pdfBytes, {
            pageIndices,
            dpi: effectiveDpi,
            format: renderFormat,
          });

          const mimeType = renderFormat === "png" ? "image/png" : "image/jpeg";

          const result: ToolResult = {
            content: [
              {
                type: "text",
                text: `Rendered ${rendered.length} page(s) inline at ${effectiveDpi} DPI (${renderFormat.toUpperCase()}).`,
              },
              ...rendered.map((img) => ({
                type: "image" as const,
                data: Buffer.from(img.data).toString("base64"),
                mimeType,
              })),
            ],
          };
          return result;
        }

        let resolvedOutputDir: string;
        if (outputDir) {
          resolvedOutputDir = resolve(outputDir);
          try {
            await access(resolvedOutputDir);
          } catch {
            throw new PdfError(
              `Output directory does not exist: ${resolvedOutputDir}. Create the directory first.`,
              "INVALID_INPUT",
            );
          }
        } else {
          resolvedOutputDir = resolve(resolvedPath, "..");
        }

        const rendered = await renderPdfPages(pdfBytes, {
          pageIndices,
          dpi: renderDpi,
          format: renderFormat,
        });

        const ext = renderFormat === "png" ? "png" : "jpg";
        const pdfBaseName = basename(resolvedPath, extname(resolvedPath));

        const images: { page: number; path: string; fileSize: string }[] = [];
        for (const img of rendered) {
          const pageNumber = img.pageIndex + 1;
          const outPath = join(
            resolvedOutputDir,
            `${pdfBaseName}-page-${pageNumber}.${ext}`,
          );
          await writeFile(outPath, img.data);
          const fileSize = await getFileSize(outPath);
          images.push({ page: pageNumber, path: outPath, fileSize });
        }

        return toolSuccess({
          outputDir: resolvedOutputDir,
          format: renderFormat,
          dpi: renderDpi,
          pageCount: images.length,
          images,
        });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );
}
