import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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

const STACK_FRAME_RE = /\bat .*\(.*:\d+:\d+\)/;

/**
 * A document with a large-font title and smaller body text, plus distinct
 * per-page words for search. Title (28pt) >> body (12pt) so heading inference
 * should mark the title line with `#`.
 */
async function makeDocPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);

  // Page 1
  const p1 = doc.addPage([400, 600]);
  const h1 = p1.getHeight();
  p1.drawText("Quarterly Report", { x: 50, y: h1 - 60, size: 28, font });
  p1.drawText("This document discusses the apricot harvest in detail.", {
    x: 50,
    y: h1 - 120,
    size: 12,
    font,
  });
  p1.drawText("It also covers logistics and distribution planning.", {
    x: 50,
    y: h1 - 150,
    size: 12,
    font,
  });

  // Page 2 — contains a unique word for page-targeted search.
  const p2 = doc.addPage([400, 600]);
  const h2 = p2.getHeight();
  p2.drawText("Appendix", { x: 50, y: h2 - 60, size: 28, font });
  p2.drawText("The blueberry shipment arrived on schedule.", {
    x: 50,
    y: h2 - 120,
    size: 12,
    font,
  });

  return doc.save();
}

describe("read tools (pdf_to_markdown, pdf_search, metadata polish)", () => {
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
    client = new Client({ name: "read-test-client", version: "0.0.0" });
    await client.connect(transport);

    workDir = await mkdtemp(join(tmpdir(), "pdf-read-test-"));
    pdfPath = join(workDir, "doc.pdf");
    await writeFile(pdfPath, await makeDocPdf());
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── pdf_to_markdown ──────────────────────────────────────────────────

  it("produces markdown containing the expected text", async () => {
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: pdfPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const md = textOf(result);
    expect(md).toContain("Quarterly Report");
    expect(md.toLowerCase()).toContain("apricot harvest");
  }, 30_000);

  it("infers a heading (#) from the larger-font title line", async () => {
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: pdfPath, pages: "1" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const md = textOf(result);
    // The 28pt title should become a Markdown heading.
    expect(md).toMatch(/^#{1,3} Quarterly Report/m);
    // Body text should NOT be a heading.
    expect(md).not.toMatch(/^#{1,3} This document/m);
  }, 30_000);

  it("returns isError for a non-existent file", async () => {
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: join(workDir, "missing.pdf") },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found|File not found/i);
    expect(text).not.toMatch(STACK_FRAME_RE);
  }, 30_000);

  it("returns a clean error for garbage bytes in a .pdf file", async () => {
    const garbagePath = join(workDir, "garbage.pdf");
    await writeFile(garbagePath, "this is definitely not a pdf\n");

    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: garbagePath },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(STACK_FRAME_RE);
  }, 30_000);

  // ── pdf_search ───────────────────────────────────────────────────────

  it("finds a known word and reports the correct page", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "blueberry" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBeGreaterThanOrEqual(1);
    expect(payload.results[0].page).toBe(2);
    expect(payload.results[0].context.toLowerCase()).toContain("blueberry");
  }, 30_000);

  it("respects caseSensitive matching", async () => {
    const insensitive = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "APRICOT" },
    })) as ToolResultLike;
    const sensitive = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "APRICOT", caseSensitive: true },
    })) as ToolResultLike;

    expect(JSON.parse(textOf(insensitive)).totalMatches).toBeGreaterThanOrEqual(
      1,
    );
    // The fixture text uses lowercase "apricot", so a case-sensitive search for
    // "APRICOT" must find nothing.
    expect(JSON.parse(textOf(sensitive)).totalMatches).toBe(0);
  }, 30_000);

  it("returns totalMatches 0 (not an error) when nothing matches", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "zzzznonexistentzzzz" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBe(0);
    expect(payload.results).toHaveLength(0);
  }, 30_000);

  it("matches with a valid regex", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "ap\\w+ot", regex: true },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("returns INVALID_INPUT for an invalid regex", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "(unclosed", regex: true },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).not.toMatch(STACK_FRAME_RE);
  }, 30_000);

  // ── pdf_get_metadata polish ──────────────────────────────────────────

  it("includes fileSize in the metadata response", async () => {
    const result = (await client.callTool({
      name: "pdf_get_metadata",
      arguments: { filePath: pdfPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.fileSize).toBeTruthy();
    expect(payload.fileSize).toMatch(/KB|MB|bytes|B/i);
  }, 30_000);
});
