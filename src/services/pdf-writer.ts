import { readFile, writeFile } from "node:fs/promises";
import type { PDFDocument } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
import { toUint8Array } from "../utils/validation.js";

export async function loadExistingPdf(filePath: string): Promise<PDFDocument> {
  const buffer = await readFile(filePath);
  const data = toUint8Array(buffer);
  return pdfLib.PDFDocument.load(data);
}

export async function createNewPdf(): Promise<PDFDocument> {
  return pdfLib.PDFDocument.create();
}

export async function savePdf(
  pdfDoc: PDFDocument,
  outputPath: string
): Promise<string> {
  pdfDoc.setProducer("@aryanbv/pdf-toolkit-mcp");
  const pdfBytes = await pdfDoc.save();
  await writeFile(outputPath, pdfBytes);
  return outputPath;
}

export function checkForFormFields(
  pdfDoc: PDFDocument
): { hasFields: boolean; fieldCount: number } {
  try {
    const fields = pdfDoc.getForm().getFields();
    return { hasFields: fields.length > 0, fieldCount: fields.length };
  } catch {
    return { hasFields: false, fieldCount: 0 };
  }
}
