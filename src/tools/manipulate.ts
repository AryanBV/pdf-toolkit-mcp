import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import { diffLines } from "diff";
import { toBuffer as bwipToBuffer } from "@bwip-js/node";
import {
  loadExistingPdf,
  createNewPdf,
  savePdf,
} from "../services/pdf-writer.js";
import {
  copyPagesPreservingForms,
  type FormCopyReport,
} from "../services/pdf-page-engine.js";
import { encryptPdf } from "../services/pdf-crypto.js";
import { extractPdfText, getPdfPageCount } from "../services/pdf-reader.js";
import {
  validatePdfPath,
  validateOutputPath,
  validateFileSize,
  parsePageRange,
  toUint8Array,
} from "../utils/validation.js";
import {
  PdfError,
  toolError,
  toolSuccess,
  toErrorResult,
} from "../utils/errors.js";
import { getFileSize } from "../utils/file-utils.js";
import { MAX_MERGE_FILES, MAX_PAGE_WARNING } from "../constants.js";

/** Empty form report used as the seed for aggregation. */
function emptyFormReport(): FormCopyReport {
  return { preserved: 0, renamed: [], dropped: [] };
}

/** Merge a per-source form report into a running aggregate. */
function accumulateFormReport(
  total: FormCopyReport,
  next: FormCopyReport,
): void {
  total.preserved += next.preserved;
  total.renamed.push(...next.renamed);
  total.dropped.push(...next.dropped);
}

export function registerManipulateTools(server: McpServer): void {
  // ── pdf_merge ────────────────────────────────────────────────────────
  server.registerTool(
    "pdf_merge",
    {
      description:
        "Merge multiple PDF files into one. AcroForm fields are preserved; fields whose names collide across inputs are auto-renamed (namespaced by source). Set flatten:true to bake field values into static content.",
      inputSchema: z
        .object({
          filePaths: z
            .array(z.string().max(4096))
            .min(2)
            .max(MAX_MERGE_FILES)
            .describe(
              "Array of absolute paths to PDF files to merge, in order",
            ),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the merged output PDF"),
          flatten: z
            .boolean()
            .optional()
            .describe(
              "Flatten the merged form: bake field values into static content and remove interactivity. Defaults to false.",
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
    async ({ filePaths, outputPath, flatten }) => {
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
        const formReport = emptyFormReport();
        let totalPages = 0;

        for (let i = 0; i < resolvedPaths.length; i++) {
          const resolved = resolvedPaths[i];
          const sourceDoc = await loadExistingPdf(resolved);
          const namespacePrefix = `${i + 1}-${basename(resolved, ".pdf")}`;

          const report = await copyPagesPreservingForms(
            mergedDoc,
            sourceDoc,
            sourceDoc.getPageIndices(),
            { namespacePrefix },
          );
          accumulateFormReport(formReport, report);
          totalPages += sourceDoc.getPageCount();
        }

        if (flatten) {
          mergedDoc.getForm().flatten();
        }

        if (totalPages > MAX_PAGE_WARNING) {
          warnings.push(
            `Warning: merged document has ${totalPages.toLocaleString()} pages, which may be slow to process.`,
          );
        }

        await savePdf(mergedDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          pageCount: totalPages,
          inputFiles: resolvedPaths.length,
          flattened: flatten === true,
          formFields: {
            preserved: flatten ? 0 : formReport.preserved,
            renamed: formReport.renamed,
            dropped: formReport.dropped,
          },
          warnings,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  // ── pdf_split ────────────────────────────────────────────────────────
  server.registerTool(
    "pdf_split",
    {
      description:
        "Extract specific pages from a PDF into a new file. AcroForm fields on the extracted pages are preserved; fields on omitted pages are dropped. Set flatten:true to bake field values into static content.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          pages: z
            .string()
            .max(256)
            .describe("Page range to extract, e.g. '1-5' or '1,3,5'"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF"),
          flatten: z
            .boolean()
            .optional()
            .describe(
              "Flatten the extracted form: bake field values into static content and remove interactivity. Defaults to false.",
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
    async ({ filePath, pages, outputPath, flatten }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const sourceDoc = await loadExistingPdf(resolvedPath);
        const totalSourcePages = sourceDoc.getPageCount();
        const pageIndices = parsePageRange(pages, totalSourcePages);

        const newDoc = await createNewPdf();
        const formReport = await copyPagesPreservingForms(
          newDoc,
          sourceDoc,
          pageIndices,
          { namespacePrefix: basename(resolvedPath, ".pdf") },
        );

        if (flatten) {
          newDoc.getForm().flatten();
        }

        await savePdf(newDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          extractedPages: pages,
          totalSourcePages,
          flattened: flatten === true,
          formFields: {
            preserved: flatten ? 0 : formReport.preserved,
            renamed: formReport.renamed,
            dropped: formReport.dropped,
          },
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  // ── pdf_rotate_pages ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_rotate_pages",
    {
      description:
        "Rotate pages in a PDF by 90, 180, or 270 degrees. Rotation is additive to any existing rotation. Rotates all pages if no page range is specified.",
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
              "Page range to rotate, e.g. '1-5' or '1,3,5'. Omit to rotate all pages.",
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

        const rotatedLabel =
          pages ?? (totalPages === 1 ? "1" : `1-${totalPages}`);

        return toolSuccess({
          outputPath: resolvedOutput,
          rotatedPages: rotatedLabel,
          degrees,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  // ── pdf_encrypt ─────────────────────────────────────────────────────
  server.registerTool(
    "pdf_encrypt",
    {
      description:
        "Encrypt a PDF with AES-256 password protection. Requires a user password to open. Owner password controls editing permissions (defaults to the user password).",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the encrypted output PDF"),
          userPassword: z
            .string()
            .min(1)
            .max(128)
            .describe("Password required to open the PDF"),
          ownerPassword: z
            .string()
            .max(128)
            .optional()
            .describe(
              "Password for editing permissions. Defaults to userPassword if omitted.",
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
    async ({ filePath, outputPath, userPassword, ownerPassword }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfBytes = toUint8Array(await readFile(resolvedPath));

        const encryptedBytes = await encryptPdf(pdfBytes, {
          userPassword,
          ownerPassword,
          keyLength: 256,
        });

        await writeFile(resolvedOutput, encryptedBytes);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          encryption: "AES-256",
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_compare ─────────────────────────────────────────────────────
  server.registerTool(
    "pdf_compare",
    {
      description:
        "Compare the extracted text of two PDFs page by page and report the differences. Returns identical:true when the text matches. Compares text only — visual/layout changes that don't alter text are not detected.",
      inputSchema: z
        .object({
          filePathA: z
            .string()
            .max(4096)
            .describe("Absolute path to the first (baseline) PDF file"),
          filePathB: z
            .string()
            .max(4096)
            .describe("Absolute path to the second (comparison) PDF file"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range to compare, e.g. '1-5' or '1,3,5'. Defaults to all pages.",
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePathA, filePathB, pages }) => {
      try {
        const resolvedA = await validatePdfPath(filePathA);
        const resolvedB = await validatePdfPath(filePathB);
        await validateFileSize(resolvedA);
        await validateFileSize(resolvedB);

        const pageCountA = await getPdfPageCount(resolvedA);
        const pageCountB = await getPdfPageCount(resolvedB);

        let pageIndices: number[] | undefined;
        if (pages) {
          // Validate the range against the longer document so a page that exists
          // in only one file can still be diffed (the missing side shows as empty).
          pageIndices = parsePageRange(pages, Math.max(pageCountA, pageCountB));
        }

        const [textA, textB] = await Promise.all([
          extractPdfText(resolvedA, pageIndices),
          extractPdfText(resolvedB, pageIndices),
        ]);

        const byPageA = new Map(textA.pages.map((p) => [p.page, p.text ?? ""]));
        const byPageB = new Map(textB.pages.map((p) => [p.page, p.text ?? ""]));
        const pageNumbers = [
          ...new Set([...byPageA.keys(), ...byPageB.keys()]),
        ].sort((a, b) => a - b);

        const differences: { page: number; added: string; removed: string }[] =
          [];

        for (const pageNum of pageNumbers) {
          const a = byPageA.get(pageNum) ?? "";
          const b = byPageB.get(pageNum) ?? "";
          if (a === b) continue;

          const changes = diffLines(a, b);
          const added = changes
            .filter((c) => c.added)
            .map((c) => c.value)
            .join("");
          const removed = changes
            .filter((c) => c.removed)
            .map((c) => c.value)
            .join("");

          differences.push({
            page: pageNum,
            added: added.trim(),
            removed: removed.trim(),
          });
        }

        return toolSuccess({
          identical: differences.length === 0,
          pageCountA,
          pageCountB,
          comparedPages: pages ?? "all",
          differences,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_add_page_numbers ────────────────────────────────────────────
  server.registerTool(
    "pdf_add_page_numbers",
    {
      description:
        "Add page numbers to a PDF. Supports configurable position, format, starting number, and font size.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF"),
          position: z
            .enum(["bottom-center", "bottom-right", "top-center", "top-right"])
            .optional()
            .describe("Position of page numbers. Defaults to bottom-center."),
          format: z
            .enum(["Page X of Y", "X of Y", "X", "- X -"])
            .optional()
            .describe('Number format. Defaults to "Page X of Y".'),
          startFrom: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Starting page number. Defaults to 1."),
          fontSize: z
            .number()
            .min(6)
            .max(24)
            .optional()
            .describe("Font size for page numbers (6–24). Defaults to 10."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, outputPath, position, format, startFrom, fontSize }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
        const totalPages = pdfDoc.getPageCount();

        const pos = position ?? "bottom-center";
        const fmt = format ?? "Page X of Y";
        const start = startFrom ?? 1;
        const fSize = fontSize ?? 10;

        for (let i = 0; i < totalPages; i++) {
          const page = pdfDoc.getPage(i);
          const { width, height } = page.getSize();
          const pageNum = i + start;
          const totalNum = totalPages + start - 1;

          let text: string;
          switch (fmt) {
            case "Page X of Y":
              text = `Page ${pageNum} of ${totalNum}`;
              break;
            case "X of Y":
              text = `${pageNum} of ${totalNum}`;
              break;
            case "X":
              text = String(pageNum);
              break;
            case "- X -":
              text = `- ${pageNum} -`;
              break;
            default:
              text = `Page ${pageNum} of ${totalNum}`;
          }

          const textWidth = font.widthOfTextAtSize(text, fSize);
          const margin = 40;

          let x: number;
          let y: number;

          switch (pos) {
            case "bottom-center":
              x = (width - textWidth) / 2;
              y = margin / 2;
              break;
            case "bottom-right":
              x = width - margin - textWidth;
              y = margin / 2;
              break;
            case "top-center":
              x = (width - textWidth) / 2;
              y = height - margin / 2;
              break;
            case "top-right":
              x = width - margin - textWidth;
              y = height - margin / 2;
              break;
            default:
              x = (width - textWidth) / 2;
              y = margin / 2;
          }

          page.drawText(text, {
            x,
            y,
            size: fSize,
            font,
            color: pdfLib.rgb(0.4, 0.4, 0.4),
          });
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          totalPages,
          position: pos,
          format: fmt,
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  // ── pdf_embed_qr_code ───────────────────────────────────────────────
  server.registerTool(
    "pdf_embed_qr_code",
    {
      description:
        "Embed a QR code or barcode into a specific page of a PDF at given coordinates. Supports qrcode, code128, datamatrix, ean13, pdf417, and azteccode.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          content: z
            .string()
            .min(1)
            .max(4096)
            .describe("Data to encode in the QR code or barcode"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF"),
          page: z
            .number()
            .int()
            .min(1)
            .describe("Target page number (1-indexed)"),
          x: z.number().describe("X position in points from the left edge"),
          y: z.number().describe("Y position in points from the bottom edge"),
          size: z
            .number()
            .min(10)
            .max(1000)
            .optional()
            .describe(
              "Size of the QR code/barcode in points. Defaults to 100.",
            ),
          type: z
            .enum([
              "qrcode",
              "code128",
              "datamatrix",
              "ean13",
              "pdf417",
              "azteccode",
            ])
            .optional()
            .describe("Barcode type. Defaults to qrcode."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, content, outputPath, page, x, y, size, type }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const barcodeType = type ?? "qrcode";
        const barcodeSize = size ?? 100;

        // Generate barcode as PNG buffer
        const pngBuffer = await bwipToBuffer({
          bcid: barcodeType,
          text: content,
          scale: 3,
          includetext: false,
        });

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const totalPages = pdfDoc.getPageCount();

        if (page > totalPages) {
          return toolError(
            `Page ${page} exceeds document length (${totalPages} pages).`,
          );
        }

        const image = await pdfDoc.embedPng(pngBuffer);
        const targetPage = pdfDoc.getPage(page - 1);

        // Bounds check: the barcode is placed with its bottom-left corner at
        // (x, y) (PDF origin is bottom-left). Reject placements that fall off
        // the page so the barcode is never silently clipped or invisible.
        const { width: pageWidth, height: pageHeight } = targetPage.getSize();
        if (
          x < 0 ||
          y < 0 ||
          x + barcodeSize > pageWidth ||
          y + barcodeSize > pageHeight
        ) {
          throw new PdfError(
            `Barcode does not fit on page ${page}. Page size is ${pageWidth.toFixed(0)}x${pageHeight.toFixed(0)} points; requested placement is a ${barcodeSize}pt square with its bottom-left corner at (${x}, ${y}), which extends to (${x + barcodeSize}, ${y + barcodeSize}). Reduce size or move x/y so 0 <= x, 0 <= y, x+size <= ${pageWidth.toFixed(0)}, y+size <= ${pageHeight.toFixed(0)}.`,
            "INVALID_INPUT",
          );
        }

        targetPage.drawImage(image, {
          x,
          y,
          width: barcodeSize,
          height: barcodeSize,
        });

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          page,
          type: barcodeType,
          position: { x, y },
          size: barcodeSize,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_reorder_pages ───────────────────────────────────────────────
  server.registerTool(
    "pdf_reorder_pages",
    {
      description:
        "Reorder pages in a PDF. Specify the new page order as a comma-separated string (e.g. '3,1,2'). Duplicates are allowed. AcroForm fields are preserved. Set flatten:true to bake field values into static content.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          pageOrder: z
            .string()
            .max(10000)
            .describe(
              "New page order as comma-separated 1-indexed numbers, e.g. '3,1,2,4' or '1,1,2' (duplicates allowed)",
            ),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the reordered output PDF"),
          flatten: z
            .boolean()
            .optional()
            .describe(
              "Flatten the reordered form: bake field values into static content and remove interactivity. Defaults to false.",
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
    async ({ filePath, pageOrder, outputPath, flatten }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const sourceDoc = await loadExistingPdf(resolvedPath);
        const totalPages = sourceDoc.getPageCount();

        // Parse page order
        const orderParts = pageOrder.split(",").map((s) => s.trim());
        const indices: number[] = [];
        for (const part of orderParts) {
          const num = parseInt(part, 10);
          if (isNaN(num) || num < 1 || num > totalPages) {
            return toolError(
              `Invalid page number: ${part}. Must be between 1 and ${totalPages}.`,
            );
          }
          indices.push(num - 1); // Convert to 0-indexed
        }

        if (indices.length > 2000) {
          return toolError("Page order exceeds maximum of 2000 output pages.");
        }

        const newDoc = await createNewPdf();
        const formReport = await copyPagesPreservingForms(
          newDoc,
          sourceDoc,
          indices,
          { namespacePrefix: basename(resolvedPath, ".pdf") },
        );

        if (flatten) {
          newDoc.getForm().flatten();
        }

        await savePdf(newDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          pageOrder,
          pageCount: indices.length,
          flattened: flatten === true,
          formFields: {
            preserved: flatten ? 0 : formReport.preserved,
            renamed: formReport.renamed,
            dropped: formReport.dropped,
          },
          fileSize,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  // ── pdf_delete_pages ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_delete_pages",
    {
      description:
        "Delete specific pages from a PDF, keeping the rest in their original order. AcroForm fields on the remaining pages are preserved. Set flatten:true to bake field values into static content. Cannot delete every page.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          pages: z
            .string()
            .max(256)
            .describe("Page range to DELETE, e.g. '2' or '1-3,5'"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF"),
          flatten: z
            .boolean()
            .optional()
            .describe(
              "Flatten the resulting form: bake field values into static content and remove interactivity. Defaults to false.",
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
    async ({ filePath, pages, outputPath, flatten }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const sourceDoc = await loadExistingPdf(resolvedPath);
        const totalPages = sourceDoc.getPageCount();

        const toDelete = new Set(parsePageRange(pages, totalPages));
        const remainingIndices = Array.from(
          { length: totalPages },
          (_, i) => i,
        ).filter((i) => !toDelete.has(i));

        if (remainingIndices.length === 0) {
          throw new PdfError(
            "Cannot delete every page: the output PDF must keep at least one page.",
            "INVALID_INPUT",
          );
        }

        const newDoc = await createNewPdf();
        const formReport = await copyPagesPreservingForms(
          newDoc,
          sourceDoc,
          remainingIndices,
          { namespacePrefix: basename(resolvedPath, ".pdf") },
        );

        if (flatten) {
          newDoc.getForm().flatten();
        }

        await savePdf(newDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          removedPages: pages,
          remainingPageCount: remainingIndices.length,
          flattened: flatten === true,
          formFields: {
            preserved: flatten ? 0 : formReport.preserved,
            renamed: formReport.renamed,
            dropped: formReport.dropped,
          },
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
