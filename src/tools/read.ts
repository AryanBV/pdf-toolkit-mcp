import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import { extractPdfText, getPdfPageCount } from "../services/pdf-reader.js";
import { loadExistingPdf } from "../services/pdf-writer.js";
import {
  validatePdfPath,
  validateFileSize,
  parsePageRange,
} from "../utils/validation.js";
import { toolError, toolSuccess } from "../utils/errors.js";
import { DEFAULT_EXTRACT_PAGES } from "../constants.js";
import type { PdfMetadata, FormField } from "../types.js";

export function registerReadTools(server: McpServer): void {
  // ── pdf_extract_text ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_extract_text",
    {
      description:
        "Extract text content from a PDF file. Returns first 10 pages by default to avoid exceeding LLM context limits. Use the 'pages' parameter for specific pages.",
      inputSchema: z
        .object({
          filePath: z.string().describe("Absolute path to the PDF file"),
          pages: z
            .string()
            .optional()
            .describe(
              "Page range, e.g. '1-5' or '1,3,5'. Defaults to first 10 pages."
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
    async ({ filePath, pages }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const totalPages = await getPdfPageCount(resolvedPath);

        let pageIndices: number[];
        let extractedLabel: string;

        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
          extractedLabel = pages;
        } else {
          const count = Math.min(DEFAULT_EXTRACT_PAGES, totalPages);
          pageIndices = Array.from({ length: count }, (_, i) => i);
          extractedLabel = count === 1 ? "1" : `1-${count}`;
        }

        const result = await extractPdfText(resolvedPath, pageIndices);

        const response: Record<string, unknown> = {
          totalPages,
          extractedPages: extractedLabel,
          pages: result.pages,
        };

        if (result.pages.length < totalPages) {
          response.note = `Showing pages ${extractedLabel} of ${totalPages}. Request specific pages for more.`;
        }

        return toolSuccess(response);
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  // ── pdf_get_metadata ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_get_metadata",
    {
      description:
        "Get metadata from a PDF file including title, author, subject, page count, creation/modification dates, and producer information.",
      inputSchema: z
        .object({
          filePath: z.string().describe("Absolute path to the PDF file"),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const pdfDoc = await loadExistingPdf(resolvedPath);

        const metadata: PdfMetadata = {
          title: pdfDoc.getTitle(),
          author: pdfDoc.getAuthor(),
          subject: pdfDoc.getSubject(),
          creator: pdfDoc.getCreator(),
          producer: pdfDoc.getProducer(),
          creationDate: pdfDoc.getCreationDate()?.toISOString(),
          modificationDate: pdfDoc.getModificationDate()?.toISOString(),
          pageCount: pdfDoc.getPageCount(),
          keywords: pdfDoc.getKeywords(),
        };

        return toolSuccess(metadata);
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  // ── pdf_get_form_fields ──────────────────────────────────────────────
  server.registerTool(
    "pdf_get_form_fields",
    {
      description:
        "List all form fields in a PDF with their names, types, current values, and required status. Returns hasForm: false for PDFs without forms.",
      inputSchema: z
        .object({
          filePath: z.string().describe("Absolute path to the PDF file"),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const pdfDoc = await loadExistingPdf(resolvedPath);

        let fields: FormField[];
        try {
          const form = pdfDoc.getForm();
          form.deleteXFA();
          const pdfFields = form.getFields();

          fields = pdfFields.map((field) => {
            let type: FormField["type"];
            let value: string | boolean;

            if (field instanceof pdfLib.PDFTextField) {
              type = "text";
              value = field.getText() ?? "";
            } else if (field instanceof pdfLib.PDFCheckBox) {
              type = "checkbox";
              value = field.isChecked();
            } else if (field instanceof pdfLib.PDFDropdown) {
              type = "dropdown";
              value = field.getSelected().join(", ");
            } else if (field instanceof pdfLib.PDFRadioGroup) {
              type = "radiogroup";
              value = field.getSelected() ?? "";
            } else if (field instanceof pdfLib.PDFButton) {
              type = "button";
              value = "";
            } else if (field instanceof pdfLib.PDFSignature) {
              type = "signature";
              value = "";
            } else {
              type = "text";
              value = "";
            }

            let required = false;
            try {
              required = field.isRequired();
            } catch {
              // Some fields don't support isRequired
            }

            return {
              name: field.getName(),
              type,
              value,
              required,
            };
          });
        } catch {
          return toolSuccess({ hasForm: false, fieldCount: 0, fields: [] });
        }

        return toolSuccess({
          hasForm: fields.length > 0,
          fieldCount: fields.length,
          fields,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );
}
