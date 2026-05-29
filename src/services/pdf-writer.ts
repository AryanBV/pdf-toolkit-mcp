import { readFile, writeFile } from "node:fs/promises";
import type { PDFDocument } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
import { toUint8Array } from "../utils/validation.js";
import { PdfError } from "../utils/errors.js";

export async function loadExistingPdf(filePath: string): Promise<PDFDocument> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);
  try {
    return await pdfLib.PDFDocument.load(data);
  } catch (err) {
    // pdf-lib throws a typed EncryptedPDFError for encrypted documents; any
    // other parse failure is genuinely corrupt. Match on the class (not a
    // message substring) so a corrupt PDF whose error text merely mentions
    // "encrypt" is not mislabeled ENCRYPTED_PDF.
    if (err instanceof pdfLib.EncryptedPDFError) {
      throw new PdfError(
        `PDF is encrypted: ${filePath}. Decrypt it before processing.`,
        "ENCRYPTED_PDF",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to parse PDF — the file may be corrupt or not a valid PDF: ${message}`,
      "CORRUPT_PDF",
    );
  }
}

export async function createNewPdf(): Promise<PDFDocument> {
  return pdfLib.PDFDocument.create();
}

export interface SavePdfOptions {
  /**
   * Whether `save()` should regenerate form-field appearance streams with the
   * default WinAnsi (Helvetica) font. pdf-lib defaults this to `true`, which is
   * the desired behavior for ordinary saves. Pass `false` when a custom font
   * has already been applied to field appearances (e.g. non-Latin form fill) so
   * the save does not re-render them with the default font and clobber the
   * embedded glyphs. Omitting the option preserves pdf-lib's default behavior,
   * so every existing caller is unaffected.
   */
  updateFieldAppearances?: boolean;
}

export async function savePdf(
  pdfDoc: PDFDocument,
  outputPath: string,
  options?: SavePdfOptions,
): Promise<string> {
  pdfDoc.setProducer("@aryanbv/pdf-toolkit-mcp");
  // Only forward updateFieldAppearances when the caller set it; otherwise leave
  // it undefined so pdf-lib applies its own default (true) — keeping behavior
  // identical for all other callers.
  const pdfBytes =
    options?.updateFieldAppearances === undefined
      ? await pdfDoc.save()
      : await pdfDoc.save({
          updateFieldAppearances: options.updateFieldAppearances,
        });
  await writeFile(outputPath, pdfBytes);
  return outputPath;
}
