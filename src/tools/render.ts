import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, basename, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import {
  DEFAULT_RENDER_DPI,
  MIN_RENDER_DPI,
  MAX_RENDER_DPI,
  MAX_RENDER_PAGES,
} from "../constants.js";

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    "pdf_render_pages",
    {
      description:
        "Render PDF pages to PNG/JPEG image files so a vision-capable client can read scanned or image-only PDFs (OCR/visual inspection). Writes image files to disk and returns their paths. Default DPI 150; renders the first 50 pages unless a page range is given.",
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
          outputDir: z
            .string()
            .max(4096)
            .optional()
            .describe(
              "Absolute path to an existing directory for the images. Defaults to the input PDF's directory.",
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
    async ({ filePath, pages, dpi, format, outputDir }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const renderDpi = dpi ?? DEFAULT_RENDER_DPI;
        const renderFormat = format ?? "png";

        const pdfBytes = toUint8Array(await readFile(resolvedPath));
        const totalPages = await getPdfPageCount(resolvedPath);

        let pageIndices: number[];
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
        } else {
          const count = Math.min(totalPages, MAX_RENDER_PAGES);
          pageIndices = Array.from({ length: count }, (_, i) => i);
        }

        if (pageIndices.length > MAX_RENDER_PAGES) {
          throw new PdfError(
            `Requested ${pageIndices.length} pages, exceeding the limit of ${MAX_RENDER_PAGES} per call. Narrow the 'pages' range and try again.`,
            "RESOURCE_LIMIT",
          );
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
