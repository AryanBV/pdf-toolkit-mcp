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
    const message = err instanceof Error ? err.message : String(err);
    // pdf-lib throws EncryptedPDFError (name) for encrypted documents and a
    // message mentioning encryption. Surface a stable ENCRYPTED_PDF code so
    // callers can branch on it; any other parse failure is CORRUPT_PDF.
    const isEncrypted =
      (err instanceof Error && err.name === "EncryptedPDFError") ||
      /encrypt/i.test(message);
    if (isEncrypted) {
      throw new PdfError(
        `PDF is encrypted: ${filePath}. Decrypt it before processing.`,
        "ENCRYPTED_PDF",
      );
    }
    throw new PdfError(
      `Failed to parse PDF — the file may be corrupt or not a valid PDF: ${message}`,
      "CORRUPT_PDF",
    );
  }
}

export async function createNewPdf(): Promise<PDFDocument> {
  return pdfLib.PDFDocument.create();
}

export async function savePdf(
  pdfDoc: PDFDocument,
  outputPath: string,
): Promise<string> {
  pdfDoc.setProducer("@aryanbv/pdf-toolkit-mcp");
  const pdfBytes = await pdfDoc.save();
  await writeFile(outputPath, pdfBytes);
  return outputPath;
}
