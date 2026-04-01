import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import {
  loadExistingPdf,
  createNewPdf,
  savePdf,
  checkForFormFields,
} from "../services/pdf-writer.js";
import {
  validatePdfPath,
  validateOutputPath,
  validateFileSize,
  parsePageRange,
} from "../utils/validation.js";
import { toolError, toolSuccess } from "../utils/errors.js";
import { getFileSize } from "../utils/file-utils.js";
import { MAX_MERGE_FILES, MAX_PAGE_WARNING } from "../constants.js";

export function registerManipulateTools(server: McpServer): void {
  // ── pdf_merge ────────────────────────────────────────────────────────
  server.registerTool(
    "pdf_merge",
    {
      description:
        "Merge multiple PDF files into one. Warning: form fields in source PDFs are not preserved during merge — they appear visually but become non-interactive.",
      inputSchema: z
        .object({
          filePaths: z
            .array(z.string().max(4096))
            .min(2)
            .max(MAX_MERGE_FILES)
            .describe("Array of absolute paths to PDF files to merge, in order"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the merged output PDF"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePaths, outputPath }) => {
      try {
        const resolvedOutput = await validateOutputPath(outputPath);

        const resolvedPaths: string[] = [];
        for (const fp of filePaths) {
          const resolved = await validatePdfPath(fp);
          await validateFileSize(resolved);
          resolvedPaths.push(resolved);
        }

        const warnings: string[] = [];
        const mergedDoc = await createNewPdf();
        let totalPages = 0;

        for (const resolved of resolvedPaths) {
          const sourceDoc = await loadExistingPdf(resolved);
          const formCheck = checkForFormFields(sourceDoc);
          if (formCheck.hasFields) {
            warnings.push(
              `Warning: ${basename(resolved)} contains ${formCheck.fieldCount} form fields that were not preserved during merge. Form data appears visually but is no longer interactive.`
            );
          }

          const copiedPages = await mergedDoc.copyPages(
            sourceDoc,
            sourceDoc.getPageIndices()
          );
          for (const page of copiedPages) {
            mergedDoc.addPage(page);
          }
          totalPages += copiedPages.length;
        }

        if (totalPages > MAX_PAGE_WARNING) {
          warnings.push(
            `Warning: merged document has ${totalPages.toLocaleString()} pages, which may be slow to process.`
          );
        }

        await savePdf(mergedDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          totalPages,
          sourceFiles: resolvedPaths.length,
          warnings,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  // ── pdf_split ────────────────────────────────────────────────────────
  server.registerTool(
    "pdf_split",
    {
      description:
        "Extract specific pages from a PDF into a new file. Warning: form fields in the source PDF are not preserved — they appear visually but become non-interactive.",
      inputSchema: z
        .object({
          filePath: z.string().max(4096).describe("Absolute path to the source PDF file"),
          pages: z
            .string()
            .max(256)
            .describe(
              "Page range to extract, e.g. '1-5' or '1,3,5'"
            ),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, pages, outputPath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const sourceDoc = await loadExistingPdf(resolvedPath);
        const totalSourcePages = sourceDoc.getPageCount();
        const pageIndices = parsePageRange(pages, totalSourcePages);

        const warnings: string[] = [];
        const formCheck = checkForFormFields(sourceDoc);
        if (formCheck.hasFields) {
          warnings.push(
            `Warning: source PDF contains ${formCheck.fieldCount} form fields that were not preserved during split. Form data appears visually but is no longer interactive.`
          );
        }

        const newDoc = await createNewPdf();
        const copiedPages = await newDoc.copyPages(sourceDoc, pageIndices);
        for (const page of copiedPages) {
          newDoc.addPage(page);
        }

        await savePdf(newDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          extractedPages: pages,
          totalSourcePages,
          warnings,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  // ── pdf_rotate_pages ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_rotate_pages",
    {
      description:
        "Rotate pages in a PDF by 90, 180, or 270 degrees. Rotation is additive to any existing rotation. Rotates all pages if no page range is specified.",
      inputSchema: z
        .object({
          filePath: z.string().max(4096).describe("Absolute path to the source PDF file"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range to rotate, e.g. '1-5' or '1,3,5'. Omit to rotate all pages."
            ),
          degrees: z
            .union([z.literal(90), z.literal(180), z.literal(270)])
            .describe("Rotation angle: 90, 180, or 270 degrees clockwise"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the rotated output PDF"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, pages, degrees, outputPath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const totalPages = pdfDoc.getPageCount();

        let pageIndices: number[];
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
        } else {
          pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        }

        for (const idx of pageIndices) {
          const page = pdfDoc.getPage(idx);
          const currentAngle = page.getRotation().angle;
          const newAngle = (currentAngle + degrees) % 360;
          page.setRotation(pdfLib.degrees(newAngle));
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        const rotatedLabel = pages ?? (totalPages === 1 ? "1" : `1-${totalPages}`);

        return toolSuccess({
          outputPath: resolvedOutput,
          rotatedPages: rotatedLabel,
          degrees,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );
}
