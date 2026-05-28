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

/** A single-page PDF that literally contains the regex metacharacter string. */
async function makeMetaCharPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText("The pattern (a+)+ is famous for ReDoS.", {
    x: 20,
    y: 150,
    size: 12,
    font,
  });
  return doc.save();
}

/**
 * A two-column page: the left column's lines all sit at small x, the right
 * column's at a large x, with a wide horizontal gutter between them. Reading
 * order must emit the entire left column before the right column — NOT
 * interleave them row-by-row (which raw stream order would do).
 */
async function makeTwoColumnPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  const h = page.getHeight();

  const leftLines = ["leftone", "lefttwo", "leftthree"];
  const rightLines = ["rightone", "righttwo", "rightthree"];

  // Same y per row, but left column at x=40, right column at x=360 (wide gutter).
  for (let i = 0; i < leftLines.length; i++) {
    const y = h - 60 - i * 30;
    page.drawText(leftLines[i], { x: 40, y, size: 12, font });
    page.drawText(rightLines[i], { x: 360, y, size: 12, font });
  }

  return doc.save();
}

/**
 * A heading-HEAVY page: five short 24pt heading lines plus one body paragraph
 * of three 12pt lines. By ITEM COUNT the median font size is 24pt (a heading
 * size) — the old median-baseline heuristic would treat 24pt as body text and
 * FAIL to mark the headings (24 < 24 × 1.15). The modal (character-weighted)
 * baseline correctly identifies 12pt as body (it carries far more text), so the
 * 24pt lines are detected as headings. This is the FIX-2 regression fixture.
 */
async function makeHeadingHeavyPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const page = doc.addPage([500, 700]);
  const h = page.getHeight();

  const headings = [
    "Section Alpha",
    "Section Bravo",
    "Section Charlie",
    "Section Delta",
    "Section Echo",
  ];
  let y = h - 50;
  for (const heading of headings) {
    page.drawText(heading, { x: 40, y, size: 24, font });
    y -= 40;
  }

  // One body paragraph — three long 12pt lines carrying most of the characters.
  const body = [
    "This running body paragraph contains the bulk of the page text content.",
    "It is set in a smaller twelve point font than every section heading above.",
    "By character weight it is clearly the body, so headings must outrank it.",
  ];
  for (const line of body) {
    page.drawText(line, { x: 40, y, size: 12, font });
    y -= 20;
  }

  return doc.save();
}

/** A page containing a bullet list and an ordered list under a body line. */
async function makeListPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const page = doc.addPage([400, 600]);
  const h = page.getHeight();

  const lines = [
    "Shopping list for the week:",
    "- apples",
    "- bananas",
    "- cherries",
    "Steps to follow:",
    "1. wash produce",
    "2. chop produce",
    "3. cook produce",
  ];
  for (let i = 0; i < lines.length; i++) {
    page.drawText(lines[i], { x: 40, y: h - 60 - i * 28, size: 12, font });
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
  let metaCharPath: string;
  let twoColumnPath: string;
  let listPath: string;
  let headingHeavyPath: string;

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

    metaCharPath = join(workDir, "metachar.pdf");
    await writeFile(metaCharPath, await makeMetaCharPdf());

    twoColumnPath = join(workDir, "two-column.pdf");
    await writeFile(twoColumnPath, await makeTwoColumnPdf());

    listPath = join(workDir, "lists.pdf");
    await writeFile(listPath, await makeListPdf());

    headingHeavyPath = join(workDir, "heading-heavy.pdf");
    await writeFile(headingHeavyPath, await makeHeadingHeavyPdf());
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

  it("infers headings on a heading-heavy page (modal, not median, baseline)", async () => {
    // The median font size on this page is a HEADING size (more heading lines
    // than body lines by item count); only the modal (character-weighted)
    // baseline correctly classifies the 24pt section lines as headings.
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: headingHeavyPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const md = textOf(result);

    // Every 24pt section line must become a Markdown heading.
    expect(md).toMatch(/^#{1,3} Section Alpha$/m);
    expect(md).toMatch(/^#{1,3} Section Echo$/m);

    // The 12pt body lines must NOT be headings.
    expect(md).not.toMatch(/^#{1,3} This running body paragraph/m);
  }, 30_000);

  it("documents the tables-not-reconstructed scope honestly in its description", async () => {
    const tools = await client.listTools();
    const toMarkdown = tools.tools.find((t) => t.name === "pdf_to_markdown");
    expect(toMarkdown).toBeDefined();
    // The description must honestly state that tables are not reconstructed as
    // Markdown tables, so callers do not expect grid output.
    expect(toMarkdown?.description?.toLowerCase()).toMatch(
      /tables.*not.*reconstructed|not.*reconstructed.*table/,
    );
  }, 30_000);

  it("emits two-column content in reading order (left column before right)", async () => {
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: twoColumnPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const md = textOf(result);

    // All six tokens must be present.
    for (const token of [
      "leftone",
      "lefttwo",
      "leftthree",
      "rightone",
      "righttwo",
      "rightthree",
    ]) {
      expect(md).toContain(token);
    }

    // Reading order: the LAST left-column token must appear before the FIRST
    // right-column token. Raw pdf.js stream order would interleave rows
    // (leftone rightone lefttwo …); column reconstruction must not.
    expect(md.indexOf("leftthree")).toBeLessThan(md.indexOf("rightone"));
  }, 30_000);

  it("detects bullet and ordered lists", async () => {
    const result = (await client.callTool({
      name: "pdf_to_markdown",
      arguments: { filePath: listPath },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const md = textOf(result);

    // Bullet items become Markdown "- " items.
    expect(md).toMatch(/^- apples$/m);
    expect(md).toMatch(/^- bananas$/m);
    expect(md).toMatch(/^- cherries$/m);

    // Ordered items keep their number and become "N. " items.
    expect(md).toMatch(/^1\. wash produce$/m);
    expect(md).toMatch(/^2\. chop produce$/m);
    expect(md).toMatch(/^3\. cook produce$/m);
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

  it("matches a multi-word literal substring", async () => {
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "apricot harvest" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBeGreaterThanOrEqual(1);
    expect(payload.results[0].context.toLowerCase()).toContain(
      "apricot harvest",
    );
  }, 30_000);

  // ── pdf_search: literal-only / ReDoS-proof + JSON-safe trim (READ-01/03) ──

  it("rejects the removed `regex` parameter (.strict schema)", async () => {
    // pdf_search is literal-only for v1.0; the regex switch was removed. The
    // .strict() Zod schema must reject any caller still passing it rather than
    // silently ignoring it. Depending on the SDK version a rejected input
    // surfaces either as a thrown protocol error or an isError tool result;
    // both are acceptable — what matters is it is NOT silently accepted.
    let rejected = false;
    try {
      const result = (await client.callTool({
        name: "pdf_search",
        arguments: { filePath: pdfPath, query: "apricot", regex: true },
      })) as ToolResultLike;
      if (result.isError) {
        rejected = true;
        expect(textOf(result)).not.toMatch(STACK_FRAME_RE);
      }
    } catch {
      // Schema validation rejected the call at the protocol layer.
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 30_000);

  it("still removes the `regex` field from the published input schema", async () => {
    const tools = await client.listTools();
    const search = tools.tools.find((t) => t.name === "pdf_search");
    expect(search).toBeDefined();
    const props = (search?.inputSchema?.properties ?? {}) as Record<
      string,
      unknown
    >;
    // The regex switch is gone; literal-only search has no such parameter.
    expect(props.regex).toBeUndefined();
    expect(props.query).toBeDefined();
    expect(props.caseSensitive).toBeDefined();
  }, 30_000);

  it("treats regex metacharacters as literal text and returns promptly", async () => {
    // The classic catastrophic-backtracking pattern "(a+)+" must be matched as
    // the literal 5-character string, never compiled as a regex. The fixture
    // contains no such string, so totalMatches is 0 — and crucially the call
    // returns near-instantly because there is no user-controlled pattern that
    // could ReDoS the single-threaded stdio server.
    const start = Date.now();
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: "(a+)+" },
    })) as ToolResultLike;
    const elapsed = Date.now() - start;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("finds a literal metacharacter string when present in the text", async () => {
    // Proves the escape path is exact: searching for "(a+)+" matches the
    // literal "(a+)+" that the metacharacter fixture actually contains.
    const result = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: metaCharPath, query: "(a+)+" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalMatches).toBeGreaterThanOrEqual(1);
    expect(payload.results[0].context).toContain("(a+)+");
  }, 30_000);

  it("treats a leading-dot wildcard query as a literal, not 'any character'", async () => {
    // A bare "." would match every character if interpreted as a regex. As a
    // literal it must only match actual period characters. The doc fixture has
    // sentences ending in ".", so there are matches — but far fewer than the
    // total character count, and a non-period query like "x" elsewhere is
    // unaffected. We assert the literal "." matches and metachar ".*" does not.
    const wildcard = (await client.callTool({
      name: "pdf_search",
      arguments: { filePath: pdfPath, query: ".*" },
    })) as ToolResultLike;

    expect(wildcard.isError).toBeFalsy();
    // ".*" never appears literally in the fixture, so zero matches.
    expect(JSON.parse(textOf(wildcard)).totalMatches).toBe(0);
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
