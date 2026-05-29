import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import pdfLib from "@pdfme/pdf-lib";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);

interface ToolResultLike {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function textOf(result: ToolResultLike): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (const line of lines) {
    const page = doc.addPage([300, 400]);
    page.drawText(line, { x: 20, y: 360, size: 12 });
  }
  return doc.save();
}

describe("pdf_encrypt (AES-256) / pdf_compare / pdf_embed_qr_code bounds", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "crypto-test-client", version: "0.0.0" });
    await client.connect(transport);
    workDir = await mkdtemp(join(tmpdir(), "pdf-crypto-test-"));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── pdf_encrypt ─────────────────────────────────────────────────────
  it("encrypts a PDF with AES-256 (verifiable in the output bytes)", async () => {
    const inputPath = join(workDir, "plain.pdf");
    const outputPath = join(workDir, "encrypted.pdf");
    await writeFile(inputPath, await makePdf(["Confidential text"]));

    const result = (await client.callTool({
      name: "pdf_encrypt",
      arguments: { filePath: inputPath, outputPath, userPassword: "secret123" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.encryption).toBe("AES-256");
    expect(payload.fileSize).toMatch(/KB$/);

    // Verify the bytes are genuinely AES-256 encrypted.
    const bytes = await readFile(outputPath);
    const asLatin1 = Buffer.from(bytes).toString("latin1");
    expect(asLatin1).toContain("/Encrypt");
    expect(asLatin1).toContain("/AESV3"); // AES-256 crypt filter

    // Loading WITHOUT ignoreEncryption must throw (proves it is encrypted).
    await expect(
      pdfLib.PDFDocument.load(new Uint8Array(bytes)),
    ).rejects.toThrow(/encrypted/i);
  }, 30_000);

  it("returns a clean error when the input file is missing", async () => {
    const result = (await client.callTool({
      name: "pdf_encrypt",
      arguments: {
        filePath: join(workDir, "nope.pdf"),
        outputPath: join(workDir, "out.pdf"),
        userPassword: "x",
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("returns a clean error for garbage bytes in a .pdf file", async () => {
    const garbagePath = join(workDir, "garbage.pdf");
    await writeFile(garbagePath, "this is not a pdf at all\n");

    const result = (await client.callTool({
      name: "pdf_encrypt",
      arguments: {
        filePath: garbagePath,
        outputPath: join(workDir, "garbage-out.pdf"),
        userPassword: "x",
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  // ── pdf_compare ─────────────────────────────────────────────────────
  it("reports identical:true for two PDFs with the same text", async () => {
    const a = join(workDir, "cmp-a.pdf");
    const b = join(workDir, "cmp-b.pdf");
    const content = ["Page one text", "Page two text"];
    await writeFile(a, await makePdf(content));
    await writeFile(b, await makePdf(content));

    const result = (await client.callTool({
      name: "pdf_compare",
      arguments: { filePathA: a, filePathB: b },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.identical).toBe(true);
    expect(payload.differences).toEqual([]);
    expect(payload.pageCountA).toBe(2);
    expect(payload.pageCountB).toBe(2);
  }, 30_000);

  it("reports identical:false with the differing page for changed text", async () => {
    const a = join(workDir, "diff-a.pdf");
    const b = join(workDir, "diff-b.pdf");
    await writeFile(a, await makePdf(["Same first page", "Original second"]));
    await writeFile(b, await makePdf(["Same first page", "Changed second"]));

    const result = (await client.callTool({
      name: "pdf_compare",
      arguments: { filePathA: a, filePathB: b },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.identical).toBe(false);
    expect(payload.differences).toHaveLength(1);
    expect(payload.differences[0].page).toBe(2);
    expect(payload.differences[0].added).toContain("Changed second");
    expect(payload.differences[0].removed).toContain("Original second");
    // Same page count → not truncated, and the same-layout scope note is present.
    expect(payload.truncated).toBe(false);
    expect(payload.differingPageCount).toBe(1);
    expect(payload.note).toMatch(/content-stream-order/i);
    expect(payload.note).toMatch(/same-layout/i);
  }, 30_000);

  // ── pdf_compare: page-alignment caveat surfaces on differing page counts ──
  it("surfaces the absolute-page-index alignment caveat when page counts differ", async () => {
    const a = join(workDir, "align-a.pdf");
    const b = join(workDir, "align-b.pdf");
    // B has an extra page inserted at the front, so every page shifts: absolute
    // index alignment must report this rather than silently mis-pairing pages.
    await writeFile(a, await makePdf(["Alpha page", "Beta page"]));
    await writeFile(
      b,
      await makePdf(["Inserted intro", "Alpha page", "Beta page"]),
    );

    const result = (await client.callTool({
      name: "pdf_compare",
      arguments: { filePathA: a, filePathB: b },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCountA).toBe(2);
    expect(payload.pageCountB).toBe(3);
    expect(payload.identical).toBe(false);
    // The note must explicitly warn that page counts differ and that alignment
    // is by absolute page index (the insert/delete cascade caveat).
    expect(payload.note).toMatch(/page counts differ/i);
    expect(payload.note).toMatch(/absolute page index/i);
  }, 30_000);

  // ── pdf_compare: large diffs are trimmed honestly (valid JSON, not sliced) ──
  it("trims a large diff honestly with truncated:true and valid JSON", async () => {
    const a = join(workDir, "big-a.pdf");
    const b = join(workDir, "big-b.pdf");

    // Build two many-page PDFs where every page differs, and each page carries a
    // large block of text so the serialized differences array blows past the
    // CHARACTER_LIMIT (25,000). A naive byte-slice would corrupt the JSON; the
    // honest array-trim must keep the response parseable and report the drop.
    // pdf.js drops text drawn off the page edge, so a single overflowing line
    // extracts to only ~50 chars — far too small to ever exceed the diff budget.
    // Build DENSE pages instead: many short lines that all sit WITHIN the page,
    // fully different per side, so every page yields a large extractable diff and
    // the honest array-trim path actually runs.
    const pageCount = 40;
    const linesPerPage = 25;
    const buildDense = async (tag: "A" | "B"): Promise<Uint8Array> => {
      const doc = await pdfLib.PDFDocument.create();
      const word = tag === "A" ? "alpha" : "omega";
      for (let p = 0; p < pageCount; p++) {
        const page = doc.addPage([300, 400]);
        for (let j = 0; j < linesPerPage; j++) {
          page.drawText(`${tag}-p${p}-l${j}-${word}-${word}`, {
            x: 15,
            y: 385 - j * 14,
            size: 9,
          });
        }
      }
      return doc.save();
    };
    await writeFile(a, await buildDense("A"));
    await writeFile(b, await buildDense("B"));

    const result = (await client.callTool({
      name: "pdf_compare",
      arguments: { filePathA: a, filePathB: b },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const raw = textOf(result);

    // The response must be valid JSON — proves the diff array was trimmed, NOT
    // byte-sliced (a slice mid-string would throw here).
    const payload = JSON.parse(raw);

    expect(payload.identical).toBe(false);
    // Every page differs, so the TRUE count is the full page count…
    expect(payload.differingPageCount).toBe(pageCount);
    // …but the returned array is trimmed to fit, and the flag/note say so.
    expect(payload.truncated).toBe(true);
    expect(payload.differences.length).toBeLessThan(pageCount);
    expect(payload.differences.length).toBeGreaterThan(0);
    expect(payload.truncationNote).toMatch(
      /Showing \d+ of \d+ differing pages/,
    );
    expect(payload.truncationNote).toMatch(/omitted/i);
    // The serialized differences must stay within the response character limit.
    expect(raw.length).toBeLessThanOrEqual(25_000);
  }, 60_000);

  // ── pdf_embed_qr_code bounds ────────────────────────────────────────
  it("rejects a QR placement that falls off the page (INVALID_INPUT)", async () => {
    const inputPath = join(workDir, "qr-src.pdf");
    const outputPath = join(workDir, "qr-out.pdf");
    await writeFile(inputPath, await makePdf(["QR target page"]));

    const result = (await client.callTool({
      name: "pdf_embed_qr_code",
      arguments: {
        filePath: inputPath,
        outputPath,
        content: "https://example.com",
        page: 1,
        // page is 300x400; placing a 100pt QR at x=280 overflows the right edge.
        x: 280,
        y: 50,
        size: 100,
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).toMatch(/does not fit|page size/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("embeds a QR code that fits within the page", async () => {
    const inputPath = join(workDir, "qr-ok-src.pdf");
    const outputPath = join(workDir, "qr-ok-out.pdf");
    await writeFile(inputPath, await makePdf(["QR target page"]));

    const result = (await client.callTool({
      name: "pdf_embed_qr_code",
      arguments: {
        filePath: inputPath,
        outputPath,
        content: "https://example.com",
        page: 1,
        x: 50,
        y: 50,
        size: 100,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.fileSize).toMatch(/KB$/);
    // A QR code is square: the aspect-preserving box stays square.
    expect(payload.drawnSize.width).toBe(payload.drawnSize.height);
  }, 30_000);

  // ── QR-NONSQUARE: rectangular symbologies keep their aspect ratio ─────
  it("embeds a code128 barcode with a non-square (aspect-preserved) box", async () => {
    const inputPath = join(workDir, "barcode-src.pdf");
    const outputPath = join(workDir, "barcode-out.pdf");
    await writeFile(inputPath, await makePdf(["barcode target page"]));

    const result = (await client.callTool({
      name: "pdf_embed_qr_code",
      arguments: {
        filePath: inputPath,
        outputPath,
        content: "ABC-12345",
        page: 1,
        x: 50,
        y: 50,
        size: 100,
        type: "code128",
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.type).toBe("code128");
    // code128 is wider than it is tall: the drawn box must NOT be squashed
    // into a square. width is the bounding dimension; height is smaller.
    expect(payload.drawnSize.width).toBeGreaterThan(payload.drawnSize.height);
    expect(payload.drawnSize.width).toBeLessThanOrEqual(100);
    expect(payload.drawnSize.height).toBeLessThan(100);
  }, 30_000);

  // ── QR-ROTATE: placement respects the rotated viewer space ─────────────
  it("embeds a QR onto a 90°-rotated page and preserves the rotation", async () => {
    // A 300x400 page rotated 90° presents a 400(w) x 300(h) viewer space. A QR
    // small enough to fit that swapped box must succeed without un-rotating.
    const inputPath = join(workDir, "qr-rot-src.pdf");
    const outputPath = join(workDir, "qr-rot-out.pdf");
    {
      const doc = await pdfLib.PDFDocument.create();
      const page = doc.addPage([300, 400]);
      page.drawText("rotated QR target", { x: 20, y: 360, size: 12 });
      page.setRotation(pdfLib.degrees(90));
      await writeFile(inputPath, await doc.save());
    }

    const result = (await client.callTool({
      name: "pdf_embed_qr_code",
      arguments: {
        filePath: inputPath,
        outputPath,
        content: "https://example.com",
        page: 1,
        // Fits within the rotated 400x300 viewer space.
        x: 50,
        y: 50,
        size: 100,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.fileSize).toMatch(/KB$/);

    // The page's display rotation must be untouched by the QR embed.
    const bytes = await readFile(outputPath);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPage(0).getRotation().angle).toBe(90);
  }, 30_000);

  it("rejects a QR that overflows the rotated viewer height (INVALID_INPUT)", async () => {
    // On the rotated page the visible height is only 300pt (the page's width). A
    // QR taller than that must be rejected against the rotated viewer box, not
    // the un-rotated 400pt height.
    const inputPath = join(workDir, "qr-rot-overflow-src.pdf");
    const outputPath = join(workDir, "qr-rot-overflow-out.pdf");
    {
      const doc = await pdfLib.PDFDocument.create();
      const page = doc.addPage([300, 400]);
      page.setRotation(pdfLib.degrees(90));
      await writeFile(inputPath, await doc.save());
    }

    const result = (await client.callTool({
      name: "pdf_embed_qr_code",
      arguments: {
        filePath: inputPath,
        outputPath,
        content: "https://example.com",
        page: 1,
        // y=50 + size=280 = 330 > 300 viewer height → overflows.
        x: 50,
        y: 50,
        size: 280,
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).toMatch(/does not fit|page size/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  // ── reorder error codes (shared single-page validator) ────────────────
  it("reorder reports PAGE_OUT_OF_RANGE for an out-of-range page number", async () => {
    const src = join(workDir, "reorder-bad-src.pdf");
    const out = join(workDir, "reorder-bad-out.pdf");
    await writeFile(src, await makePdf(["p1", "p2"]));

    const result = (await client.callTool({
      name: "pdf_reorder_pages",
      arguments: { filePath: src, pageOrder: "1,3", outputPath: out }, // only 2 pages
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    // Out-of-range page is PAGE_OUT_OF_RANGE here, consistent with every other
    // page-selecting tool (was INVALID_INPUT before the shared validator).
    expect(text).toContain("PAGE_OUT_OF_RANGE");
    expect(text).toMatch(/exceeds document length/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("reorder reports INVALID_INPUT for a malformed page token", async () => {
    const src = join(workDir, "reorder-bad2-src.pdf");
    const out = join(workDir, "reorder-bad2-out.pdf");
    await writeFile(src, await makePdf(["p1", "p2"]));

    const result = (await client.callTool({
      name: "pdf_reorder_pages",
      arguments: { filePath: src, pageOrder: "1,3abc", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    // "3abc" is rejected as malformed syntax (not silently parsed to 3).
    expect(text).toContain("INVALID_INPUT");
    expect(text).toMatch(/invalid page number/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);
});
