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

/** A PDF carrying a real AcroForm with one field of each common type. */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const form = doc.getForm();

  const tf = form.createTextField("fullName");
  tf.addToPage(page, { x: 20, y: 320, width: 200, height: 20 });
  tf.setText("Alice");

  const cb = form.createCheckBox("agree");
  cb.addToPage(page, { x: 20, y: 280, width: 15, height: 15 });
  cb.check();

  const dd = form.createDropdown("color");
  dd.addOptions(["red", "green", "blue"]);
  dd.select("green");
  dd.addToPage(page, { x: 20, y: 240, width: 120, height: 20 });

  form.updateFieldAppearances();
  return doc.save();
}

/**
 * A structurally valid PDF whose AcroForm is corrupt: its `/Fields` array
 * references a non-dictionary object (a number), so the document loads fine but
 * reading the form throws `UnexpectedObjectTypeError` inside pdf-lib. Saved with
 * `updateFieldAppearances: false` so the corruption survives serialization (the
 * normal save path would otherwise re-read the fields and throw before writing).
 * This is the exact shape pdf_get_form_fields must surface as CORRUPT_PDF rather
 * than masking as "no form".
 */
async function makeCorruptFormPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.load(await makeFormPdf());
  const acro = doc.getForm().acroForm;
  const numberRef = doc.context.register(doc.context.obj(42));
  acro.dict.set(pdfLib.PDFName.of("Fields"), doc.context.obj([numberRef]));
  return doc.save({ updateFieldAppearances: false });
}

/** A single-page PDF with `count` repetitions of `word`, for high-hit search. */
async function makeManyMatchesPdf(
  word: string,
  count: number,
): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  // Spread repetitions across several pages so each drawn line stays short
  // enough to extract cleanly; the total occurrence count is what matters.
  const perLine = 10;
  const linesPerPage = 40;
  let drawn = 0;
  while (drawn < count) {
    const page = doc.addPage([612, 792]);
    let y = 760;
    for (let line = 0; line < linesPerPage && drawn < count; line++) {
      const words: string[] = [];
      for (let w = 0; w < perLine && drawn < count; w++) {
        words.push(word);
        drawn++;
      }
      page.drawText(words.join(" "), { x: 20, y, size: 10, font });
      y -= 16;
    }
  }
  return doc.save();
}

describe("read tools (pdf_to_markdown, pdf_search, metadata polish)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;
  let pdfPath: string;
  let formPath: string;
  let corruptFormPath: string;
  let manyMatchesPath: string;

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

    formPath = join(workDir, "form.pdf");
    await writeFile(formPath, await makeFormPdf());

    corruptFormPath = join(workDir, "corrupt-form.pdf");
    await writeFile(corruptFormPath, await makeCorruptFormPdf());

    // 500 occurrences > MAX_SEARCH_RESULTS (500) and the resulting result set
    // serializes well past CHARACTER_LIMIT (25k), forcing the array trim.
    manyMatchesPath = join(workDir, "many-matches.pdf");
    await writeFile(
      manyMatchesPath,
      await makeManyMatchesPdf("matchtoken", 700),
    );
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

  // ── pdf_search: ReDoS budget + JSON-safe trimming (READ-01 / READ-03) ──

  it("terminates (does not hang) on a zero-width-matching regex", async () => {
    // A global regex that can match the empty string would loop forever without
    // the zero-width advance guard. The call must return a normal result, not
    // hang the single-threaded stdio server. The tight per-call assertion below
    // (well under the 30s test timeout) is the real anti-hang signal.
    const start = Date.now();
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "a*", regex: true },
    })) as ToolResultLike;
    const elapsed = Date.now() - start;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(typeof payload.totalMatches).toBe("number");
    // Should complete fast; the time-budget guard caps the worst case at ~1.5s
    // of scanning, so even with stdio overhead this stays far below the timeout.
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("does not hang while scanning a large body and returns valid JSON", async () => {
    // Exercises the periodic clock-check branch (iterations % N) over a large
    // match set. The result must be returned promptly and remain parseable.
    const start = Date.now();
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: manyMatchesPath, query: "matchtoken" },
    })) as ToolResultLike;
    const elapsed = Date.now() - start;

    expect(result.isError).toBeFalsy();
    expect(() => JSON.parse(textOf(result))).not.toThrow();
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it("trims the results ARRAY (not the JSON bytes) on a high-hit search", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: manyMatchesPath, query: "matchtoken" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const raw = textOf(result);

    // The response must be VALID JSON — the old byte-level CHARACTER_LIMIT slice
    // would corrupt a high-hit result mid-object. This is the core READ-03 fix.
    const payload = JSON.parse(raw);
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.totalMatches).toBeGreaterThanOrEqual(700);

    // The serialized response stays under the 25,000-char limit because the
    // ARRAY was trimmed, and the trim is reported in the note rather than via a
    // truncated tail.
    expect(raw.length).toBeLessThanOrEqual(25_000);
    expect(raw).not.toContain("[Output truncated at");
    expect(payload.note).toMatch(/omitted|capped/i);

    // Every surviving result is a complete, well-formed object.
    for (const r of payload.results) {
      expect(typeof r.page).toBe("number");
      expect(typeof r.context).toBe("string");
    }
  }, 30_000);

  // ── pdf_get_form_fields behavioral coverage (TEST-01) ──────────────────

  it("lists form fields for a form PDF", async () => {
    const result = (await client.callTool({
      name: "pdf_get_form_fields",
      arguments: { filePath: formPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.hasForm).toBe(true);
    expect(payload.fieldCount).toBe(3);

    const byName = new Map<string, { type: string; value: unknown }>(
      payload.fields.map(
        (f: { name: string; type: string; value: unknown }) => [
          f.name,
          { type: f.type, value: f.value },
        ],
      ),
    );
    expect(byName.get("fullName")?.type).toBe("text");
    expect(byName.get("fullName")?.value).toBe("Alice");
    expect(byName.get("agree")?.type).toBe("checkbox");
    expect(byName.get("agree")?.value).toBe(true);
    expect(byName.get("color")?.type).toBe("dropdown");
    expect(byName.get("color")?.value).toBe("green");
  }, 30_000);

  it("surfaces CORRUPT_PDF for a broken AcroForm instead of swallowing it", async () => {
    const result = (await client.callTool({
      name: "pdf_get_form_fields",
      arguments: { filePath: corruptFormPath },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("CORRUPT_PDF");
    // Must NOT masquerade as a form-less PDF.
    expect(text).not.toContain('"hasForm": false');
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
