import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PDFFont } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
import { z } from "zod";
import {
  loadExistingPdf,
  createNewPdf,
  savePdf,
} from "../services/pdf-writer.js";
import {
  validatePdfPath,
  validateOutputPath,
  validateFileSize,
  validateFontPath,
  validateImagePath,
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
import { createFromMarkdown, renderTemplate } from "../services/pdf-creator.js";
import { templateRegistry } from "../templates/index.js";
import type { TemplateName } from "../types.js";
import { writeFile } from "node:fs/promises";
import { MAX_IMAGE_DIMENSION, MAX_MARKDOWN_INPUT_CHARS } from "../constants.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const paragraphs = text.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }

    const words = paragraph.split(/\s+/).filter(Boolean);
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else if (currentLine === "") {
        // Single word exceeds maxWidth — break mid-word
        let partial = "";
        for (const char of word) {
          const testPartial = partial + char;
          if (
            font.widthOfTextAtSize(testPartial, fontSize) > maxWidth &&
            partial
          ) {
            lines.push(partial);
            partial = char;
          } else {
            partial = testPartial;
          }
        }
        currentLine = partial;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

const WATERMARK_COLORS: Record<string, ReturnType<typeof pdfLib.rgb>> = {
  gray: pdfLib.rgb(0.7, 0.7, 0.7),
  red: pdfLib.rgb(0.8, 0, 0),
  blue: pdfLib.rgb(0, 0, 0.8),
  green: pdfLib.rgb(0, 0.6, 0),
  black: pdfLib.rgb(0, 0, 0),
};

// ── Tool Registration ───────────────────────────────────────────────────

// destructiveHint stays false on every write tool here: each produces a NEW
// file at `outputPath` rather than mutating its input in place. If a file
// already exists at that path it is overwritten, but the source PDF is never
// altered — so these are non-destructive in the MCP sense.
export function registerCreateTools(server: McpServer): void {
  // ── pdf_create ──────────────────────────────────────────────────────
  server.registerTool(
    "pdf_create",
    {
      description:
        "Create a new PDF from text content with automatic line wrapping and page overflow. Supports A4, Letter, and Legal page sizes.",
      inputSchema: z
        .object({
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF file"),
          content: z
            .string()
            .min(1)
            .max(10_000_000)
            .describe("Text content for the PDF. Use \\n for line breaks."),
          title: z
            .string()
            .max(1000)
            .optional()
            .describe("PDF document title metadata"),
          author: z
            .string()
            .max(1000)
            .optional()
            .describe("PDF document author metadata"),
          pageSize: z
            .enum(["A4", "Letter", "Legal"])
            .optional()
            .describe("Page size. Defaults to A4."),
          fontSize: z
            .number()
            .min(6)
            .max(72)
            .optional()
            .describe("Font size in points (6–72). Defaults to 12."),
          margin: z
            .number()
            .min(0)
            .max(500)
            .optional()
            .describe("Page margin in points (0–500). Defaults to 50."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      outputPath,
      content,
      title,
      author,
      pageSize,
      fontSize,
      margin,
    }) => {
      try {
        const resolvedOutput = await validateOutputPath(outputPath);

        const size = pageSize ?? "A4";
        const fSize = fontSize ?? 12;
        const marg = margin ?? 50;
        const [pageWidth, pageHeight] =
          pdfLib.PageSizes[size as keyof typeof pdfLib.PageSizes];
        const lineHeight = fSize * 1.2;

        const pdfDoc = await createNewPdf();
        if (title) pdfDoc.setTitle(title);
        if (author) pdfDoc.setAuthor(author);

        const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
        const maxWidth = pageWidth - 2 * marg;

        // Parse escape sequences (LLMs send literal \n and \t)
        let textContent = content.replace(/\\n/g, "\n");
        textContent = textContent.replace(/\\t/g, "\t");

        const wrappedLines = wrapText(textContent, font, fSize, maxWidth);

        let page = pdfDoc.addPage([pageWidth, pageHeight]);
        let currentY = pageHeight - marg;

        for (const line of wrappedLines) {
          if (currentY - fSize < marg) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            currentY = pageHeight - marg;
          }

          if (line !== "") {
            page.drawText(line, {
              x: marg,
              y: currentY,
              size: fSize,
              font,
            });
          }

          currentY -= lineHeight;
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          pageCount: pdfDoc.getPageCount(),
          title: title ?? null,
          pageSize: size,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_fill_form ───────────────────────────────────────────────────
  server.registerTool(
    "pdf_fill_form",
    {
      description:
        "Fill form fields in a PDF. Supports text, checkbox, dropdown, and radio fields. Provide fontPath for non-Latin text (Arabic, CJK, etc.).",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PDF file with form fields"),
          fields: z
            .record(z.union([z.string(), z.boolean()]))
            .describe(
              "Object mapping field names to values. Strings for text/dropdown/radio, booleans for checkboxes.",
            ),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the filled output PDF"),
          flatten: z
            .boolean()
            .optional()
            .describe(
              "Flatten form fields after filling (makes them non-editable). Defaults to false.",
            ),
          fontPath: z
            .string()
            .max(4096)
            .optional()
            .describe(
              "Absolute path to a .ttf/.otf font file for non-Latin character support.",
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
    async ({ filePath, fields, outputPath, flatten, fontPath }) => {
      try {
        const BLOCKED_KEYS = ["__proto__", "constructor", "prototype"];
        if (Object.keys(fields).some((k) => BLOCKED_KEYS.includes(k))) {
          return toolError("Input contains prohibited key names.");
        }

        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfDoc = await loadExistingPdf(resolvedPath);

        let form;
        try {
          form = pdfDoc.getForm();
          form.deleteXFA();
        } catch {
          return toolError(
            "This PDF does not contain any form fields. Use pdf_get_form_fields to inspect a PDF's form structure.",
          );
        }

        const allFields = form.getFields();
        if (allFields.length === 0) {
          return toolError(
            "This PDF does not contain any form fields. Use pdf_get_form_fields to inspect a PDF's form structure.",
          );
        }

        // Check for non-Latin characters when no fontPath provided
        if (!fontPath) {
          for (const [name, value] of Object.entries(fields)) {
            if (typeof value === "string") {
              const hasNonLatin = [...value].some(
                (ch) => ch.charCodeAt(0) > 255,
              );
              if (hasNonLatin) {
                return toolError(
                  `Non-Latin characters detected in field '${name}'. Provide a fontPath parameter pointing to a .ttf/.otf font file that supports these characters.`,
                );
              }
            }
          }
        }

        // Load custom font if fontPath provided
        let customFont: PDFFont | undefined;
        if (fontPath) {
          const resolvedFontPath = await validateFontPath(fontPath);
          await validateFileSize(resolvedFontPath);
          const fontBuffer = await readFile(resolvedFontPath);
          const fontBytes = toUint8Array(fontBuffer);

          const fontkit = await import("fontkit");
          pdfDoc.registerFontkit(
            fontkit as unknown as Parameters<typeof pdfDoc.registerFontkit>[0],
          );
          customFont = await pdfDoc.embedFont(fontBytes);
        }

        const availableNames = allFields.map((f) => f.getName());
        let filledCount = 0;

        for (const [name, value] of Object.entries(fields)) {
          const field = allFields.find((f) => f.getName() === name);
          if (!field) {
            throw new PdfError(
              `Field '${name}' not found in PDF. Available fields: ${availableNames.join(", ")}`,
              "FIELD_NOT_FOUND",
            );
          }

          if (field instanceof pdfLib.PDFTextField) {
            if (customFont) {
              field.updateAppearances(customFont);
            }
            field.setText(String(value));
          } else if (field instanceof pdfLib.PDFCheckBox) {
            if (value) {
              field.check();
            } else {
              field.uncheck();
            }
          } else if (field instanceof pdfLib.PDFDropdown) {
            field.select(String(value));
          } else if (field instanceof pdfLib.PDFRadioGroup) {
            field.select(String(value));
          } else {
            return toolError(
              `Field '${name}' is of unsupported type for filling. Supported types: text, checkbox, dropdown, radio.`,
            );
          }

          filledCount++;
        }

        if (flatten) {
          form.flatten();
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          filledFields: filledCount,
          flattened: flatten ?? false,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_add_watermark ───────────────────────────────────────────────
  server.registerTool(
    "pdf_add_watermark",
    {
      description:
        "Add a text watermark to PDF pages. Watermark is centered and rotated diagonally by default. Applies to all pages if no page range is specified.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          text: z
            .string()
            .max(1000)
            .describe("Watermark text to overlay on pages"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the watermarked output PDF"),
          pages: z
            .string()
            .max(256)
            .optional()
            .describe(
              "Page range, e.g. '1-5' or '1,3,5'. Omit to watermark all pages.",
            ),
          opacity: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Watermark opacity (0.0–1.0). Defaults to 0.3."),
          fontSize: z
            .number()
            .min(10)
            .max(200)
            .optional()
            .describe("Watermark font size (10–200). Defaults to 50."),
          color: z
            .enum(["gray", "red", "blue", "green", "black"])
            .optional()
            .describe("Watermark color. Defaults to gray."),
          rotation: z
            .number()
            .min(0)
            .max(360)
            .optional()
            .describe(
              "Watermark rotation in degrees (0–360). Defaults to 45 (diagonal).",
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
    async ({
      filePath,
      text,
      outputPath,
      pages,
      opacity,
      fontSize,
      color,
      rotation,
    }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
        const totalPages = pdfDoc.getPageCount();

        const fSize = fontSize ?? 50;
        const opac = opacity ?? 0.3;
        const col = WATERMARK_COLORS[color ?? "gray"];
        const rot = rotation ?? 45;

        let pageIndices: number[];
        if (pages) {
          pageIndices = parsePageRange(pages, totalPages);
        } else {
          pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        }

        for (const idx of pageIndices) {
          const page = pdfDoc.getPage(idx);
          const { width, height } = page.getSize();
          const textWidth = font.widthOfTextAtSize(text, fSize);

          page.drawText(text, {
            x: (width - textWidth) / 2,
            y: height / 2,
            size: fSize,
            font,
            color: col,
            opacity: opac,
            rotate: pdfLib.degrees(rot),
          });
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        const watermarkedLabel =
          pages ?? (totalPages === 1 ? "1" : `1-${totalPages}`);

        return toolSuccess({
          outputPath: resolvedOutput,
          watermarkedPages: watermarkedLabel,
          text,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_embed_image ─────────────────────────────────────────────────
  server.registerTool(
    "pdf_embed_image",
    {
      description:
        "Embed a PNG or JPEG image into a specific page of a PDF. Supports custom positioning and optional scaling with aspect ratio preservation.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          imagePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the PNG or JPEG image file"),
          page: z
            .number()
            .int()
            .min(1)
            .describe("Target page number (1-indexed)"),
          x: z
            .number()
            .describe("X position in points from the left edge of the page"),
          y: z
            .number()
            .describe("Y position in points from the bottom edge of the page"),
          width: z
            .number()
            .optional()
            .describe(
              "Image width in points. Omit to use original width (or scale proportionally if height is set).",
            ),
          height: z
            .number()
            .optional()
            .describe(
              "Image height in points. Omit to use original height (or scale proportionally if width is set).",
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
    async ({ filePath, imagePath, page, x, y, width, height, outputPath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const resolvedImagePath = await validateImagePath(imagePath);
        await validateFileSize(resolvedImagePath);
        const ext = extname(resolvedImagePath).toLowerCase();
        const imageBuffer = await readFile(resolvedImagePath);
        const imageBytes = toUint8Array(imageBuffer);

        if (imageBytes.length === 0) {
          throw new PdfError(
            `Image file is empty: ${resolvedImagePath}.`,
            "UNSUPPORTED_FORMAT",
          );
        }

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const totalPages = pdfDoc.getPageCount();

        if (page > totalPages) {
          throw new PdfError(
            `Page ${page} exceeds document length (${totalPages} pages).`,
            "PAGE_OUT_OF_RANGE",
          );
        }

        // pdf-lib decodes the image bytes here; a corrupt or mislabeled file
        // throws. Surface a clean UNSUPPORTED_FORMAT error rather than a stack.
        let image;
        try {
          image =
            ext === ".png"
              ? await pdfDoc.embedPng(imageBytes)
              : await pdfDoc.embedJpg(imageBytes);
        } catch {
          throw new PdfError(
            `Failed to decode image: ${resolvedImagePath}. The file may be corrupt or not a valid ${ext === ".png" ? "PNG" : "JPEG"} image.`,
            "UNSUPPORTED_FORMAT",
          );
        }

        if (
          image.width > MAX_IMAGE_DIMENSION ||
          image.height > MAX_IMAGE_DIMENSION
        ) {
          throw new PdfError(
            `Image dimensions ${image.width}x${image.height}px exceed the limit of ${MAX_IMAGE_DIMENSION}px per side.`,
            "RESOURCE_LIMIT",
          );
        }

        // Calculate dimensions preserving aspect ratio
        let drawWidth: number;
        let drawHeight: number;

        if (width !== undefined && height !== undefined) {
          drawWidth = width;
          drawHeight = height;
        } else if (width !== undefined) {
          drawWidth = width;
          drawHeight = width * (image.height / image.width);
        } else if (height !== undefined) {
          drawHeight = height;
          drawWidth = height * (image.width / image.height);
        } else {
          drawWidth = image.width;
          drawHeight = image.height;
        }

        const targetPage = pdfDoc.getPage(page - 1);
        targetPage.drawImage(image, {
          x,
          y,
          width: drawWidth,
          height: drawHeight,
        });

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          page,
          position: { x, y },
          dimensions: { width: drawWidth, height: drawHeight },
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_create_from_markdown ──────────────────────────────────────────
  server.registerTool(
    "pdf_create_from_markdown",
    {
      description:
        "Create a rich, high-fidelity PDF from Markdown (CommonMark + GFM). Supports headings, bold/italic, links, ordered/bullet lists, tables, fenced code blocks, blockquotes, and horizontal rules.",
      inputSchema: z
        .object({
          markdown: z
            .string()
            .min(1)
            .max(10_000_000)
            .describe("Markdown content to render as PDF"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF file"),
          pageSize: z
            .enum(["A4", "LETTER", "LEGAL"])
            .optional()
            .describe("Page size. Defaults to A4."),
          title: z
            .string()
            .max(1000)
            .optional()
            .describe("PDF document title metadata"),
          author: z
            .string()
            .max(1000)
            .optional()
            .describe("PDF document author metadata"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ markdown, outputPath, pageSize, title, author }) => {
      try {
        if (markdown.length > MAX_MARKDOWN_INPUT_CHARS) {
          throw new PdfError(
            "Markdown input exceeds the maximum size.",
            "RESOURCE_LIMIT",
          );
        }

        const resolvedOutput = await validateOutputPath(outputPath);

        const bytes = await createFromMarkdown(markdown, {
          pageSize: pageSize ?? "A4",
          title,
          author,
        });

        await writeFile(resolvedOutput, bytes);
        const fileSize = await getFileSize(resolvedOutput);
        const pdfDoc = await pdfLib.PDFDocument.load(bytes);

        return toolSuccess({
          outputPath: resolvedOutput,
          pageCount: pdfDoc.getPageCount(),
          pageSize: pageSize ?? "A4",
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_create_from_template ──────────────────────────────────────────
  server.registerTool(
    "pdf_create_from_template",
    {
      description:
        "Create a polished PDF from a named template (invoice, report, or letter). Pass structured data matching the template's fields; data is validated against the template's schema.",
      inputSchema: z
        .object({
          templateName: z
            .enum(["invoice", "report", "letter"])
            .describe("Template to use: invoice, report, or letter"),
          data: z
            .record(z.unknown())
            .describe(
              "Template data. Invoice: companyName, clientName, invoiceNumber, invoiceDate, items[{description, quantity, unitPrice}], taxRate, dueDate, notes, paymentTerms. Report: title, author, date, subtitle, sections[{heading, body}]. Letter: senderName, senderAddress, recipientName, recipientAddress, subject, body, closing, signatureName.",
            ),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF file"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ templateName, data, outputPath }) => {
      try {
        const BLOCKED_KEYS = ["__proto__", "constructor", "prototype"];
        if (Object.keys(data).some((k) => BLOCKED_KEYS.includes(k))) {
          return toolError("Input contains prohibited key names.");
        }

        const resolvedOutput = await validateOutputPath(outputPath);

        const entry = templateRegistry[templateName as TemplateName];
        if (!entry) {
          return toolError(
            `Unknown template: ${templateName}. Available templates: invoice, report, letter.`,
          );
        }

        const parsed = entry.schema.safeParse(data);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
          throw new PdfError(
            `Invalid data for '${templateName}' template — ${path}${issue?.message ?? "validation failed"}.`,
            "INVALID_INPUT",
          );
        }

        // `parsed.data` is the validated output of `entry.schema`, which exactly
        // matches `entry.build`'s parameter; the registry union erases that link,
        // so cast the builder to accept the parsed shape.
        const build = entry.build as (
          d: typeof parsed.data,
        ) => Promise<Parameters<typeof renderTemplate>[0]>;
        const element = await build(parsed.data);

        const bytes = await renderTemplate(element);
        await writeFile(resolvedOutput, bytes);
        const fileSize = await getFileSize(resolvedOutput);
        const pdfDoc = await pdfLib.PDFDocument.load(bytes);

        return toolSuccess({
          outputPath: resolvedOutput,
          templateName,
          pageCount: pdfDoc.getPageCount(),
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  // ── pdf_flatten ───────────────────────────────────────────────────────
  server.registerTool(
    "pdf_flatten",
    {
      description:
        "Flatten a PDF's form fields, baking their current values into the page content and removing interactivity. Form-less PDFs are copied unchanged.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .max(4096)
            .describe("Absolute path to the source PDF file"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the flattened output PDF"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, outputPath }) => {
      try {
        const resolvedPath = await validatePdfPath(filePath);
        await validateFileSize(resolvedPath);
        const resolvedOutput = await validateOutputPath(outputPath, filePath);

        const pdfDoc = await loadExistingPdf(resolvedPath);

        let fieldCount = 0;
        let note =
          "Flattened form fields; the document is now non-interactive.";
        try {
          const form = pdfDoc.getForm();
          fieldCount = form.getFields().length;
          if (fieldCount > 0) {
            form.flatten();
          } else {
            note =
              "PDF has no form fields; output is a copy of the input (nothing to flatten).";
          }
        } catch {
          note =
            "PDF has no form fields; output is a copy of the input (nothing to flatten).";
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          flattenedFields: fieldCount,
          note,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
