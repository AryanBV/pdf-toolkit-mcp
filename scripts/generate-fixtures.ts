/**
 * Generates test fixture files for the automated test harness.
 * Run: npm run generate-fixtures
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { PDFDocument } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";

const FIXTURES_DIR = join(import.meta.dirname!, "..", "test-fixtures");

// ── sample.pdf — 3-page PDF with text on each page ─────────────────────

async function createSamplePdf(): Promise<void> {
  const doc: PDFDocument = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);

  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage(pdfLib.PageSizes.A4);
    const { height } = page.getSize();

    page.drawText(`Page ${i} content`, {
      x: 50,
      y: height - 80,
      size: 16,
      font,
    });

    page.drawText(
      `This is the body text on page ${i}. It contains enough text to verify extraction works correctly across multiple pages.`,
      { x: 50, y: height - 120, size: 12, font }
    );
  }

  doc.setTitle("Test Sample PDF");
  doc.setAuthor("pdf-toolkit-mcp");

  const bytes = await doc.save();
  await writeFile(join(FIXTURES_DIR, "sample.pdf"), bytes);
}

// ── sample-form.pdf — PDF with AcroForm fields ─────────────────────────

async function createFormPdf(): Promise<void> {
  const doc: PDFDocument = await pdfLib.PDFDocument.create();
  const page = doc.addPage(pdfLib.PageSizes.A4);
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const { height } = page.getSize();

  const form = doc.getForm();

  // Text field: Name
  page.drawText("Name:", { x: 50, y: height - 80, size: 12, font });
  const nameField = form.createTextField("Name");
  nameField.addToPage(page, { x: 120, y: height - 95, width: 200, height: 25 });

  // Checkbox: Agree
  page.drawText("Agree:", { x: 50, y: height - 130, size: 12, font });
  const agreeField = form.createCheckBox("Agree");
  agreeField.addToPage(page, { x: 120, y: height - 145, width: 15, height: 15 });

  // Dropdown: Country
  page.drawText("Country:", { x: 50, y: height - 180, size: 12, font });
  const countryField = form.createDropdown("Country");
  countryField.setOptions(["US", "UK", "IN"]);
  countryField.addToPage(page, { x: 120, y: height - 195, width: 200, height: 25 });

  const bytes = await doc.save();
  await writeFile(join(FIXTURES_DIR, "sample-form.pdf"), bytes);
}

// ── sample-image.png — minimal valid 100x100 red PNG ────────────────────

function createMinimalPng(): Buffer {
  const width = 100;
  const height = 100;

  // Build raw scanlines: each row = filter byte (0x00) + RGB pixels
  const rawData = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row++) {
    const offset = row * (1 + width * 3);
    rawData[offset] = 0x00; // no filter
    for (let col = 0; col < width; col++) {
      const px = offset + 1 + col * 3;
      rawData[px] = 0xff;     // R
      rawData[px + 1] = 0x00; // G
      rawData[px + 2] = 0x00; // B
    }
  }

  const compressed = deflateSync(rawData);

  // Helper: write a PNG chunk
  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, "ascii");
    const crcData = Buffer.concat([typeBytes, data]);

    // CRC-32 (standard PNG CRC)
    let crc = 0xffffffff;
    for (const byte of crcData) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    crc ^= 0xffffffff;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);

    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IEND chunk
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", iend),
  ]);
}

// ── not-a-pdf.txt — plain text file for error testing ───────────────────

async function createNotAPdf(): Promise<void> {
  await writeFile(
    join(FIXTURES_DIR, "not-a-pdf.txt"),
    "This is not a PDF file. It is a plain text file used for error handling tests."
  );
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });

  await Promise.all([
    createSamplePdf(),
    createFormPdf(),
    writeFile(join(FIXTURES_DIR, "sample-image.png"), createMinimalPng()),
    createNotAPdf(),
  ]);

  console.log("Generated test fixtures in test-fixtures/:");
  console.log("  - sample.pdf (3 pages with text)");
  console.log("  - sample-form.pdf (AcroForm: Name, Agree, Country)");
  console.log("  - sample-image.png (100x100 red PNG)");
  console.log("  - not-a-pdf.txt (plain text)");
}

main().catch((err) => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});
