import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import {
  extractPdfText,
  extractPositionedText,
  getPdfPageCount,
} from "../services/pdf-reader.js";
import { loadExistingPdf } from "../services/pdf-writer.js";
import {
  validatePdfPath,
  validateFileSize,
  parsePageRange,
} from "../utils/validation.js";
import { PdfError, toolSuccess, toErrorResult } from "../utils/errors.js";
import { getFileSize } from "../utils/file-utils.js";
import {
  CHARACTER_LIMIT,
  DEFAULT_EXTRACT_PAGES,
  MAX_SEARCH_RESULTS,
} from "../constants.js";
import { layoutToMarkdown } from "./markdown-from-layout.js";
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
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range, e.g. '1-5' or '1,3,5'. Defaults to first 10 pages.",
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
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_get_metadata ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_get_metadata",
    {
      description:
        "Get metadata from a PDF file including title, author, subject, page count, creation/modification dates, and producer information.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file"),
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
          fileSize: await getFileSize(resolvedPath),
        };

        return toolSuccess(metadata);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_get_form_fields ──────────────────────────────────────────────
  server.registerTool(
    "pdf_get_form_fields",
    {
      description:
        "List all form fields in a PDF with their names, types, current values, and required status. Returns hasForm: false for PDFs without forms.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file"),
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
        } catch (formError) {
          // Reaching here means the PDF parsed but its AcroForm structure is
          // broken. A PDF that simply has no form does NOT throw — pdf-lib
          // returns an empty field list — so we must surface this as a real
          // failure rather than masking it as "no form".
          throw new PdfError(
            `Failed to read form fields — the PDF's form structure may be corrupt: ${
              formError instanceof Error ? formError.message : String(formError)
            }`,
            "CORRUPT_PDF",
          );
        }

        return toolSuccess({
          hasForm: fields.length > 0,
          fieldCount: fields.length,
          fields,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_to_markdown ──────────────────────────────────────────────────
  server.registerTool(
    "pdf_to_markdown",
    {
      description:
        "Convert a PDF to clean, reading-order Markdown for LLM consumption: reconstructs columns, infers headings from font size, and detects lists. Best on clean, digital (text-based) PDFs; degrades on scanned/image-only PDFs (use pdf_render_pages for those) and very complex layouts. Returns the first 10 pages by default.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range, e.g. '1-5' or '1,3,5'. Defaults to first 10 pages.",
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
        let pageLabel: string;
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
          pageLabel = pages;
        } else {
          const count = Math.min(DEFAULT_EXTRACT_PAGES, totalPages);
          pageIndices = Array.from({ length: count }, (_, i) => i);
          pageLabel = count === 1 ? "1" : `1-${count}`;
        }

        const layouts = await extractPositionedText(resolvedPath, pageIndices);
        const markdown = layoutToMarkdown(layouts);

        if (markdown.trim().length === 0) {
          return toolSuccess(
            `No extractable text found on pages ${pageLabel} of ${totalPages}. This may be a scanned or image-only PDF — use pdf_render_pages to read it visually.`,
          );
        }

        return toolSuccess(markdown);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_search ───────────────────────────────────────────────────────
  server.registerTool(
    "pdf_search",
    {
      description:
        "Search text across a PDF and return matches with a short surrounding snippet and the page number. Treats the query as a literal substring unless regex is true. Case-insensitive by default. Searches all pages unless a range is given.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file"),
          query: z
            .string()
            .min(1)
            .max(1024)
            .describe("Text to find (literal substring unless regex is true)"),
          regex: z
            .boolean()
            .optional()
            .describe("Treat the query as a JavaScript regular expression."),
          caseSensitive: z
            .boolean()
            .optional()
            .describe("Match case exactly. Defaults to false."),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe("Page range, e.g. '1-5'. Defaults to all pages."),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, query, regex, caseSensitive, pages }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);

        const totalPages = await getPdfPageCount(resolvedPath);

        let pageIndices: number[] | undefined;
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
        }

        const matcher = buildMatcher(
          query,
          regex ?? false,
          caseSensitive ?? false,
        );

        const { pages: pageTexts } = await extractPdfText(
          resolvedPath,
          pageIndices,
        );

        const results: { page: number; context: string }[] = [];
        let totalMatches = 0;
        let capped = false;

        // A user-supplied regex can backtrack catastrophically (ReDoS) and hang
        // the single-threaded stdio server. Bound the scan by a wall-clock
        // budget (checked every N iterations to keep Date.now() cheap) and an
        // absolute iteration cap as a defensive backstop.
        const searchStart = Date.now();
        let iterations = 0;

        for (const { page, text } of pageTexts) {
          if (!text) continue;
          // Reset lastIndex for global regexes between pages.
          matcher.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = matcher.exec(text)) !== null) {
            iterations++;
            if (
              iterations % SEARCH_TIME_CHECK_INTERVAL === 0 &&
              Date.now() - searchStart > SEARCH_TIME_BUDGET_MS
            ) {
              throw new PdfError(
                "Search exceeded its time budget — narrow the query or simplify the pattern.",
                "RESOURCE_LIMIT",
              );
            }
            if (iterations > MAX_SEARCH_ITERATIONS) {
              throw new PdfError(
                "Search exceeded its time budget — narrow the query or simplify the pattern.",
                "RESOURCE_LIMIT",
              );
            }

            totalMatches++;
            if (results.length < MAX_SEARCH_RESULTS) {
              results.push({
                page,
                context: snippet(text, match.index, match[0].length),
              });
            } else {
              capped = true;
            }
            // Avoid an infinite loop on zero-width matches.
            if (match.index === matcher.lastIndex) matcher.lastIndex++;
          }
        }

        const notes: string[] = [];
        if (capped) {
          notes.push(
            `Results capped at ${MAX_SEARCH_RESULTS}. Narrow the query or use a page range to see more.`,
          );
        }

        // Trim the results ARRAY (not the serialized byte stream) so the JSON we
        // return stays valid and under CHARACTER_LIMIT — a byte-level slice
        // would corrupt the JSON mid-object on high-hit searches.
        const { results: trimmedResults, dropped } = trimResultsToLimit(
          results,
          { query, totalMatches },
        );
        if (dropped > 0) {
          notes.push(
            `Showing ${trimmedResults.length} of ${results.length} returned matches; ${dropped} omitted to stay under the ${CHARACTER_LIMIT.toLocaleString()}-character response limit. Use a page range to narrow the search.`,
          );
        }

        const response: Record<string, unknown> = {
          query,
          totalMatches,
          results: trimmedResults,
        };
        if (notes.length > 0) {
          response.note = notes.join(" ");
        }

        return toolSuccess(response);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

const CONTEXT_RADIUS = 60;

// Wall-clock budget for a single pdf_search scan. A catastrophically
// backtracking user regex (ReDoS) would otherwise block the single-threaded
// stdio event loop indefinitely.
const SEARCH_TIME_BUDGET_MS = 1500;
// How often to consult the clock inside the match loop. Checking every
// iteration would add a syscall per match; every Nth keeps the guard cheap
// while still bounding overrun to a small slice of the budget.
const SEARCH_TIME_CHECK_INTERVAL = 500;
// Absolute backstop independent of clock granularity.
const MAX_SEARCH_ITERATIONS = 5_000_000;

/**
 * Trim the results array so the full serialized JSON response stays under
 * CHARACTER_LIMIT. We measure the actual serialized size (results plus the
 * surrounding envelope) and drop trailing results until it fits, rather than
 * letting toolSuccess() byte-slice the JSON mid-object and corrupt it.
 */
function trimResultsToLimit(
  results: { page: number; context: string }[],
  envelope: { query: string; totalMatches: number },
): { results: { page: number; context: string }[]; dropped: number } {
  const serializedLength = (
    rows: { page: number; context: string }[],
  ): number =>
    JSON.stringify(
      {
        query: envelope.query,
        totalMatches: envelope.totalMatches,
        results: rows,
        // Reserve headroom for the longest note we might attach after trimming
        // (the "capped" note and the "omitted" note can both be present).
        note: "x".repeat(400),
      },
      null,
      2,
    ).length;

  if (serializedLength(results) <= CHARACTER_LIMIT) {
    return { results, dropped: 0 };
  }

  // Binary-search the largest prefix of results that serializes under the
  // limit, so a huge match set doesn't require a linear walk.
  let lo = 0;
  let hi = results.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serializedLength(results.slice(0, mid)) <= CHARACTER_LIMIT) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const kept = results.slice(0, lo);
  return { results: kept, dropped: results.length - kept.length };
}

/** Build a global RegExp matcher for either a literal substring or a user regex. */
function buildMatcher(
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  if (isRegex) {
    try {
      return new RegExp(query, flags);
    } catch (err) {
      throw new PdfError(
        `Invalid regular expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "INVALID_INPUT",
      );
    }
  }
  return new RegExp(escapeRegExp(query), flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A short snippet of text around a match, with ellipses when truncated. */
function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, " ").trim();
}
