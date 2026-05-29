import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  PDFFont,
  PDFTextField as PdfLibTextField,
  PDFDropdown as PdfLibDropdown,
  PDFOptionList as PdfLibOptionList,
} from "@pdfme/pdf-lib";
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
import { PdfError, toolSuccess, toErrorResult } from "../utils/errors.js";
import { getFileSize } from "../utils/file-utils.js";
import { createFromMarkdown, renderTemplate } from "../services/pdf-creator.js";
import { templateRegistry } from "../templates/index.js";
import { writeFile } from "node:fs/promises";
import { MAX_IMAGE_DIMENSION, MAX_TEXT_INPUT_CHARS } from "../constants.js";

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
        // Single word exceeds maxWidth — break mid-word. Keep a running width
        // and add each glyph's advance once instead of re-measuring the whole
        // growing prefix every iteration (avoids O(n^2) on a single unbroken
        // token up to the input cap). Note: summing per-glyph advances ignores
        // pairwise kerning (standard fonts kern too), so these mid-word break
        // points are approximate and kerning-free — they slightly over-estimate
        // width (so a line never overflows the page) and may break a few
        // characters earlier than a kerning-aware whole-prefix measurement.
        let partial = "";
        let partialWidth = 0;
        for (const char of word) {
          const charWidth = font.widthOfTextAtSize(char, fontSize);
          if (partialWidth + charWidth > maxWidth && partial) {
            lines.push(partial);
            partial = char;
            partialWidth = charWidth;
          } else {
            partial += char;
            partialWidth += charWidth;
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
        "Create a new PDF from text content with automatic line wrapping and page overflow. Supports A4, Letter, and Legal page sizes. Provide fontPath for non-Latin text (Arabic, CJK, etc.).",
      inputSchema: z
        .object({
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF file"),
          content: z
            .string()
            .min(1)
            .max(MAX_TEXT_INPUT_CHARS)
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
          fontPath: z
            .string()
            .max(4096)
            .optional()
            .describe(
              "Absolute path to a .ttf/.otf font file for non-Latin character support (Arabic, CJK, etc.). The built-in font is Latin-only.",
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
      outputPath,
      content,
      title,
      author,
      pageSize,
      fontSize,
      margin,
      fontPath,
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

        // Parse escape sequences (LLMs send literal \n and \t)
        let textContent = content.replace(/\\n/g, "\n");
        textContent = textContent.replace(/\\t/g, "\t");

        let font: PDFFont;
        if (fontPath) {
          // Custom font: embed via fontkit so non-Latin scripts render.
          const resolvedFontPath = await validateFontPath(fontPath);
          await validateFileSize(resolvedFontPath);
          const fontBuffer = await readFile(resolvedFontPath);
          const fontBytes = toUint8Array(fontBuffer);

          const fontkit = await import("fontkit");
          pdfDoc.registerFontkit(
            fontkit as unknown as Parameters<typeof pdfDoc.registerFontkit>[0],
          );
          font = await pdfDoc.embedFont(fontBytes);
        } else {
          // Built-in Helvetica is WinAnsi-only. Guard non-Latin content with a
          // clear, coded error instead of letting pdf-lib throw a cryptic
          // encoding failure deep inside drawText.
          const hasNonLatin = [...textContent].some(
            (ch) => ch.charCodeAt(0) > 255,
          );
          if (hasNonLatin) {
            throw new PdfError(
              "Content contains non-Latin characters. The built-in font supports Latin (WinAnsi) only — provide a fontPath pointing to a .ttf/.otf font file that supports these characters.",
              "UNSUPPORTED_FORMAT",
            );
          }
          font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
        }

        const usableWidth = pageWidth - 2 * marg;
        const usableHeight = pageHeight - 2 * marg;
        if (usableWidth < fSize || usableHeight < fSize) {
          throw new PdfError(
            `The usable area (${usableWidth.toFixed(0)}x${usableHeight.toFixed(0)} points) is too small for a margin of ${marg} and font size of ${fSize} on a ${size} page. Reduce the margin or font size so the usable area is at least the font size on each axis.`,
            "INVALID_INPUT",
          );
        }

        const wrappedLines = wrapText(textContent, font, fSize, usableWidth);

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
        "Fill form fields in a PDF. Supports text, checkbox, dropdown, radio, and list-box (multi-select) fields. Provide fontPath for non-Latin text (Arabic, CJK, etc.).",
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
          throw new PdfError(
            "Input contains prohibited key names.",
            "INVALID_INPUT",
          );
        }

        if (Object.keys(fields).length === 0) {
          throw new PdfError(
            "No fields provided. Pass an object mapping at least one field name to a value.",
            "INVALID_INPUT",
          );
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
          throw new PdfError(
            "This PDF's form could not be read; it may be corrupt or use an unsupported form structure. Use pdf_get_form_fields to inspect it.",
            "CORRUPT_PDF",
          );
        }

        const allFields = form.getFields();
        if (allFields.length === 0) {
          throw new PdfError(
            "This PDF does not contain any form fields. Use pdf_get_form_fields to inspect a PDF's form structure.",
            "INVALID_INPUT",
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
                throw new PdfError(
                  `Non-Latin characters detected in field '${name}'. The built-in font supports Latin (WinAnsi) only — provide a fontPath pointing to a .ttf/.otf font file that supports these characters.`,
                  "UNSUPPORTED_FORMAT",
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
        // Deferred appearance-rebuilds for text/dropdown/option-list fields that
        // received a custom font. Stored as closures so each runs AFTER all
        // values are set (value-first, appearance-second ordering) and so the
        // per-field `updateAppearances(font)` is dispatched against its own
        // concrete type rather than a union. Checkboxes and radio groups render
        // symbol glyphs (not text), so they neither accept nor need a font.
        const rebuildAppearances: Array<() => void> = [];

        for (const [name, value] of Object.entries(fields)) {
          const field = allFields.find((f) => f.getName() === name);
          if (!field) {
            throw new PdfError(
              `Field '${name}' not found in PDF. Available fields: ${availableNames.join(", ")}`,
              "FIELD_NOT_FOUND",
            );
          }

          if (field instanceof pdfLib.PDFTextField) {
            // IMPORTANT: set the value FIRST. Generating appearances before the
            // value is set renders an empty field and re-marks it dirty.
            field.setText(String(value));
            if (customFont) {
              const f: PdfLibTextField = field;
              rebuildAppearances.push(() => f.updateAppearances(customFont));
            }
          } else if (field instanceof pdfLib.PDFCheckBox) {
            if (value) {
              field.check();
            } else {
              field.uncheck();
            }
          } else if (field instanceof pdfLib.PDFDropdown) {
            field.select(String(value));
            if (customFont) {
              const f: PdfLibDropdown = field;
              rebuildAppearances.push(() => f.updateAppearances(customFont));
            }
          } else if (field instanceof pdfLib.PDFRadioGroup) {
            // select() throws on a value not in the group's option set. Surface
            // a clean error listing the valid choices.
            try {
              field.select(String(value));
            } catch {
              throw new PdfError(
                `Invalid value '${String(value)}' for radio field '${name}'. Valid options: ${field.getOptions().join(", ")}.`,
                "INVALID_INPUT",
              );
            }
          } else if (field instanceof pdfLib.PDFOptionList) {
            // select() throws on a value not in the list's option set. Surface
            // a clean error listing the valid choices.
            try {
              field.select(String(value));
            } catch {
              throw new PdfError(
                `Invalid value '${String(value)}' for option-list field '${name}'. Valid options: ${field.getOptions().join(", ")}.`,
                "INVALID_INPUT",
              );
            }
            if (customFont) {
              const f: PdfLibOptionList = field;
              rebuildAppearances.push(() => f.updateAppearances(customFont));
            }
          } else {
            throw new PdfError(
              `Field '${name}' is of unsupported type for filling. Supported types: text, checkbox, dropdown, radio.`,
              "UNSUPPORTED_FORMAT",
            );
          }

          filledCount++;
        }

        // When a custom font is supplied, regenerate each filled field's
        // appearance streams with that font AFTER all values are set, then save
        // WITHOUT letting pdf-lib re-render appearances with the default WinAnsi
        // font (which would clobber the embedded non-Latin glyphs). We update
        // both per-field (updateAppearances) and at the form level
        // (updateFieldAppearances) so the AcroForm default-appearance/font
        // resources reference the embedded font.
        if (customFont) {
          for (const rebuild of rebuildAppearances) {
            rebuild();
          }
          form.updateFieldAppearances(customFont);
        }

        if (flatten) {
          // Flatten using the already-built (custom-font) appearances rather
          // than regenerating them with the default font.
          form.flatten(
            customFont ? { updateFieldAppearances: false } : undefined,
          );
        }

        await savePdf(
          pdfDoc,
          resolvedOutput,
          // Suppress the default-font appearance regeneration on save only when
          // we applied a custom font; otherwise keep pdf-lib's default behavior.
          customFont ? { updateFieldAppearances: false } : undefined,
        );
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

        // The built-in Helvetica is WinAnsi (Latin) only. Reject non-Latin text
        // up front with a clear, coded error rather than letting pdf-lib throw a
        // cryptic encoding failure inside drawText. This tool has no fontPath
        // option, so a custom font is not an available workaround here.
        if ([...text].some((ch) => ch.charCodeAt(0) > 255)) {
          throw new PdfError(
            "Watermark text contains non-Latin characters. The built-in watermark font supports Latin (WinAnsi) only.",
            "UNSUPPORTED_FORMAT",
          );
        }

        const pdfDoc = await loadExistingPdf(resolvedPath);
        const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
        const totalPages = pdfDoc.getPageCount();
        if (totalPages === 0) {
          throw new PdfError(
            "The PDF has no pages; nothing to watermark.",
            "INVALID_INPUT",
          );
        }

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

        // pdf-lib rotates drawn text about its draw origin (the baseline-left of
        // the string), NOT about the text's center. Centering the unrotated
        // origin and then rotating therefore swings the text off-center. To
        // center the text's bounding box on the page after rotation, we offset
        // the draw origin by the rotated half-extents of that box.
        const rad = (rot * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const textWidth = font.widthOfTextAtSize(text, fSize);
        const textHeight = font.heightAtSize(fSize);
        const halfW = textWidth / 2;
        const halfH = textHeight / 2;
        // Vector from the draw origin (baseline-left) to the box center, rotated
        // by `rot` (counter-clockwise, matching pdf-lib's positive rotation).
        const dx = halfW * cos - halfH * sin;
        const dy = halfW * sin + halfH * cos;

        for (const idx of pageIndices) {
          const page = pdfDoc.getPage(idx);
          const { width, height } = page.getSize();

          page.drawText(text, {
            x: width / 2 - dx,
            y: height / 2 - dy,
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
            .positive()
            .optional()
            .describe(
              "Image width in points. Omit to use original width (or scale proportionally if height is set).",
            ),
          height: z
            .number()
            .positive()
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

        if (drawWidth <= 0 || drawHeight <= 0) {
          throw new PdfError(
            `Computed draw dimensions ${drawWidth.toFixed(0)}x${drawHeight.toFixed(0)} points are not positive. Provide positive width/height (or omit both to use the image's native size).`,
            "INVALID_INPUT",
          );
        }

        const targetPage = pdfDoc.getPage(page - 1);

        // Bounds check: the image is placed with its bottom-left corner at
        // (x, y) (PDF origin is bottom-left). Reject placements that fall off
        // the page so the image is never silently clipped or pushed off-page.
        const { width: pageWidth, height: pageHeight } = targetPage.getSize();
        if (
          x < 0 ||
          y < 0 ||
          x + drawWidth > pageWidth ||
          y + drawHeight > pageHeight
        ) {
          throw new PdfError(
            `Image does not fit on page ${page}. Page size is ${pageWidth.toFixed(0)}x${pageHeight.toFixed(0)} points; the image draws as ${drawWidth.toFixed(0)}x${drawHeight.toFixed(0)} points with its bottom-left corner at (${x}, ${y}), extending to (${(x + drawWidth).toFixed(0)}, ${(y + drawHeight).toFixed(0)}). Reduce width/height or move x/y so 0 <= x, 0 <= y, x+width <= ${pageWidth.toFixed(0)}, y+height <= ${pageHeight.toFixed(0)}.`,
            "INVALID_INPUT",
          );
        }

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
            .max(MAX_TEXT_INPUT_CHARS)
            .describe("Markdown content to render as PDF"),
          outputPath: z
            .string()
            .max(4096)
            .describe("Absolute path for the output PDF file"),
          pageSize: z
            .enum(["A4", "Letter", "Legal"])
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
        // Size is enforced by the schema's .max(MAX_TEXT_INPUT_CHARS) on the
        // `markdown` field, which rejects oversize input before this handler
        // runs — no redundant runtime guard needed.
        const resolvedOutput = await validateOutputPath(outputPath);

        // The schema accepts title-case sizes for consistency with pdf_create;
        // react-pdf's pageSize union is uppercase, so map across.
        const REACT_PDF_PAGE_SIZE = {
          A4: "A4",
          Letter: "LETTER",
          Legal: "LEGAL",
        } as const;
        const size = pageSize ?? "A4";

        const bytes = await createFromMarkdown(markdown, {
          pageSize: REACT_PDF_PAGE_SIZE[size],
          title,
          author,
        });

        await writeFile(resolvedOutput, bytes);
        const fileSize = await getFileSize(resolvedOutput);
        const pdfDoc = await pdfLib.PDFDocument.load(bytes);

        return toolSuccess({
          outputPath: resolvedOutput,
          pageCount: pdfDoc.getPageCount(),
          pageSize: size,
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
              "Template data. Invoice: companyName, clientName, invoiceNumber, invoiceDate, items[{description, quantity, unitPrice}], taxRate, currency (ISO code or symbol, default USD), dueDate, notes, paymentTerms. Report: title, author, date, subtitle, sections[{heading, body}]. Letter: senderName, senderAddress, recipientName, recipientAddress, subject, body, closing, signatureName.",
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
        // visible date defaults to the current date when omitted, so output is
        // not byte-identical across calls
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ templateName, data, outputPath }) => {
      try {
        const BLOCKED_KEYS = ["__proto__", "constructor", "prototype"];
        if (Object.keys(data).some((k) => BLOCKED_KEYS.includes(k))) {
          throw new PdfError(
            "Input contains prohibited key names.",
            "INVALID_INPUT",
          );
        }

        const resolvedOutput = await validateOutputPath(outputPath);

        // The Zod enum on `templateName` already rejects unknown names, so the
        // registry lookup always resolves.
        const entry = templateRegistry[templateName];

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
        let flattened = false;
        let note =
          "PDF has no form fields; output is a copy of the input (nothing to flatten).";
        try {
          const form = pdfDoc.getForm();
          fieldCount = form.getFields().length;
          if (fieldCount > 0) {
            form.flatten();
            flattened = true;
            note =
              "Flattened form fields; the document is now non-interactive.";
          }
        } catch (e) {
          // A genuinely form-less PDF surfaces here with fieldCount === 0; keep
          // the lenient copy path. But if fields were counted, flatten() itself
          // failed (corrupt/odd appearance streams) — never claim success when
          // the saved file would still carry interactive fields.
          if (fieldCount > 0) {
            throw new PdfError(
              `Failed to flatten ${fieldCount} form field(s): ${
                e instanceof Error ? e.message : String(e)
              }`,
              "INTERNAL",
            );
          }
        }

        await savePdf(pdfDoc, resolvedOutput);
        const fileSize = await getFileSize(resolvedOutput);

        return toolSuccess({
          outputPath: resolvedOutput,
          flattened,
          flattenedFields: flattened ? fieldCount : 0,
          note,
          fileSize,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
