import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import pdfLib from "@pdfme/pdf-lib";
import { PNG } from "pngjs";

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

async function makeTwoPagePdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const p1 = doc.addPage([300, 400]);
  p1.drawText("Hello page 1");
  const p2 = doc.addPage([300, 400]);
  p2.drawText("Hello page 2");
  return doc.save();
}

async function makeManyPagePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Hello page ${i + 1}`);
  }
  return doc.save();
}

describe("pdf_render_pages", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;
  let pdfPath: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "render-test-client", version: "0.0.0" });
    await client.connect(transport);

    workDir = await mkdtemp(join(tmpdir(), "pdf-render-test-"));
    pdfPath = join(workDir, "sample.pdf");
    await writeFile(pdfPath, await makeTwoPagePdf());
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("renders both pages to PNG and returns decodable images", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: pdfPath, format: "png" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.format).toBe("png");
    expect(payload.pageCount).toBe(2);
    expect(payload.images).toHaveLength(2);

    for (const img of payload.images) {
      const bytes = await readFile(img.path);
      const decoded = PNG.sync.read(bytes);
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
    }
  }, 30_000);

  it("renders to JPEG when requested", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: pdfPath, pages: "1", format: "jpeg" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.format).toBe("jpeg");
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].path.endsWith(".jpg")).toBe(true);

    const bytes = await readFile(payload.images[0].path);
    // JPEG SOI marker.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  }, 30_000);

  it("higher dpi produces larger image dimensions", async () => {
    // Distinct output dirs so the two renders do not overwrite the same file.
    const lowDir = await mkdtemp(join(tmpdir(), "pdf-render-low-"));
    const highDir = await mkdtemp(join(tmpdir(), "pdf-render-high-"));

    const low = (await client.callTool({
      name: "pdf_render_pages",
      arguments: {
        filePath: pdfPath,
        pages: "1",
        dpi: 72,
        format: "png",
        outputDir: lowDir,
      },
    })) as ToolResultLike;
    const high = (await client.callTool({
      name: "pdf_render_pages",
      arguments: {
        filePath: pdfPath,
        pages: "1",
        dpi: 144,
        format: "png",
        outputDir: highDir,
      },
    })) as ToolResultLike;

    expect(low.isError).toBeFalsy();
    expect(high.isError).toBeFalsy();

    const lowImg = PNG.sync.read(
      await readFile(JSON.parse(textOf(low)).images[0].path),
    );
    const highImg = PNG.sync.read(
      await readFile(JSON.parse(textOf(high)).images[0].path),
    );

    expect(highImg.width).toBeGreaterThan(lowImg.width);
    expect(highImg.height).toBeGreaterThan(lowImg.height);

    await rm(lowDir, { recursive: true, force: true });
    await rm(highDir, { recursive: true, force: true });
  }, 30_000);

  it("returns an error for a non-existent file", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: join(workDir, "does-not-exist.pdf") },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found|File not found/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("returns a clean error for garbage bytes in a .pdf file", async () => {
    const garbagePath = join(workDir, "garbage.pdf");
    await writeFile(garbagePath, "this is not a pdf at all\n");

    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: garbagePath },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("returns an error when the page range is out of range", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: pdfPath, pages: "99" },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/exceeds document length|out of range/i);
  }, 30_000);

  it("rejects requests exceeding the page limit", async () => {
    // 1-51 = 51 pages, above MAX_RENDER_PAGES (50). parsePageRange enforces the
    // doc length first, so build a request that is in-range yet over the limit by
    // using a document with enough pages is impractical here; instead assert the
    // limit message surfaces for an over-limit range against a large enough doc.
    const bigDoc = await pdfLib.PDFDocument.create();
    for (let i = 0; i < 60; i++) bigDoc.addPage([100, 100]);
    const bigPath = join(workDir, "big.pdf");
    await writeFile(bigPath, await bigDoc.save());

    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: bigPath, pages: "1-51" },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/limit of 50|exceeding the limit/i);
  }, 30_000);

  // RENDER-1: file mode must stream each page straight to disk (one buffer
  // resident at a time) and still produce exactly one image file per requested
  // page. A multi-page render exercises the onPage callback path end to end.
  it("file mode writes exactly one image file per page (streamed)", async () => {
    const manyDir = await mkdtemp(join(tmpdir(), "pdf-render-many-"));
    const manyPath = join(manyDir, "many.pdf");
    const pageCount = 12;
    await writeFile(manyPath, await makeManyPagePdf(pageCount));

    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: {
        filePath: manyPath,
        pages: `1-${pageCount}`,
        format: "png",
        outputDir: manyDir,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBe(pageCount);
    expect(payload.images).toHaveLength(pageCount);

    // Every reported page is present exactly once, in order, and the file each
    // points to actually exists on disk (proves each page was written, not just
    // accumulated and reported).
    const reportedPages = payload.images.map(
      (img: { page: number }) => img.page,
    );
    expect(reportedPages).toEqual(
      Array.from({ length: pageCount }, (_, i) => i + 1),
    );
    for (const img of payload.images) {
      const bytes = await readFile(img.path);
      const decoded = PNG.sync.read(bytes);
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
    }

    await rm(manyDir, { recursive: true, force: true });
  }, 60_000);

  // RENDER-3: inline mode derives page sizes from PDFium (the render engine),
  // not a second pdf-lib parse — so a corrupt/garbage PDF surfaces one clean,
  // coded error rather than a misleading double-parse message or a leaked stack.
  it("returns a clean coded error for garbage bytes in inline mode", async () => {
    const garbageInlinePath = join(workDir, "garbage-inline.pdf");
    await writeFile(garbageInlinePath, "definitely not a pdf\n");

    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: garbageInlinePath, inline: true },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    // Coded error format from toErrorResult — no leaked stack frames.
    expect(text).toMatch(/Error \[[A-Z_]+\]:/);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  }, 30_000);
});
