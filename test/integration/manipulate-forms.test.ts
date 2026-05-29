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

/** A single-page PDF with text + checkbox + dropdown + radio-group fields. */
async function makeFormPdf(textValue = "Alice"): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const form = doc.getForm();

  const tf = form.createTextField("name");
  tf.addToPage(page, { x: 20, y: 300, width: 200, height: 20 });
  tf.setText(textValue);

  const cb = form.createCheckBox("agree");
  cb.addToPage(page, { x: 20, y: 260, width: 15, height: 15 });
  cb.check();

  const dd = form.createDropdown("color");
  dd.addOptions(["red", "green", "blue"]);
  dd.select("green");
  dd.addToPage(page, { x: 20, y: 220, width: 120, height: 20 });

  const rg = form.createRadioGroup("size");
  rg.addOptionToPage("S", page, { x: 20, y: 180, width: 15, height: 15 });
  rg.addOptionToPage("M", page, { x: 50, y: 180, width: 15, height: 15 });
  rg.select("M");

  form.updateFieldAppearances();
  return doc.save();
}

/** A two-page form: page 1 has 'name', page 2 has 'email'. */
async function makeTwoPageFormPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const p1 = doc.addPage([300, 400]);
  const p2 = doc.addPage([300, 400]);
  const form = doc.getForm();

  const f1 = form.createTextField("name");
  f1.addToPage(p1, { x: 20, y: 300, width: 200, height: 20 });
  f1.setText("Alice");

  const f2 = form.createTextField("email");
  f2.addToPage(p2, { x: 20, y: 300, width: 200, height: 20 });
  f2.setText("a@b.com");

  form.updateFieldAppearances();
  return doc.save();
}

/** A plain (form-less) multi-line PDF. */
async function makePlainPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (const line of lines) {
    const page = doc.addPage([300, 400]);
    page.drawText(line, { x: 20, y: 360, size: 12 });
  }
  return doc.save();
}

async function fieldNamesOf(path: string): Promise<string[]> {
  const bytes = await readFile(path);
  const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
  return doc
    .getForm()
    .getFields()
    .map((f) => f.getName())
    .sort();
}

describe("form-preserving merge / split / delete_pages / reorder", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "forms-test-client", version: "0.0.0" });
    await client.connect(transport);
    workDir = await mkdtemp(join(tmpdir(), "pdf-forms-test-"));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── HEADLINE: merge preserves fields (root fix proof) ─────────────────
  it("merges two form PDFs and PRESERVES fields (namespaced on collision)", async () => {
    const a = join(workDir, "form-a.pdf");
    const b = join(workDir, "form-b.pdf");
    const out = join(workDir, "merged-forms.pdf");
    await writeFile(a, await makeFormPdf());
    await writeFile(b, await makeFormPdf());

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: { filePaths: [a, b], outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.pageCount).toBe(2);
    expect(payload.inputFiles).toBe(2);
    // First copy: 4 preserved, no rename. Second copy: 4 more preserved, all renamed.
    expect(payload.formFields.preserved).toBe(8);
    expect(payload.formFields.dropped).toEqual([]);
    expect(
      payload.formFields.renamed.map((r: { from: string }) => r.from).sort(),
    ).toEqual(["agree", "color", "name", "size"].sort());

    // Re-load the OUTPUT and assert fields actually survived (not stripped).
    const names = await fieldNamesOf(out);
    expect(names.length).toBe(8);
    // Two distinct names per logical field (one plain, one namespaced).
    expect(names).toContain("name");
    expect(names.filter((n) => n.endsWith(".name"))).toHaveLength(1);
    expect(names.filter((n) => n === "name")).toHaveLength(1);
  }, 30_000);

  // ── split preserves fields on surviving pages ─────────────────────────
  it("splits a two-page form keeping only page 1's field", async () => {
    const src = join(workDir, "twopage.pdf");
    const out = join(workDir, "split-p1.pdf");
    await writeFile(src, await makeTwoPageFormPdf());

    const result = (await client.callTool({
      name: "pdf_split",
      arguments: { filePath: src, pages: "1", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.formFields.preserved).toBe(1);

    const names = await fieldNamesOf(out);
    expect(names).toEqual(["name"]); // 'email' lived on the omitted page 2
  }, 30_000);

  // ── split on a form-LESS PDF (the common case) reports zero form activity ─
  it("splits a plain (form-less) PDF and reports zero form activity", async () => {
    const src = join(workDir, "split-plain-src.pdf");
    const out = join(workDir, "split-plain-out.pdf");
    // Distinct per-page markers so we can prove the right pages were kept.
    await writeFile(
      src,
      await makePlainPdf(["PAGEONE", "PAGETWO", "PAGETHREE", "PAGEFOUR"]),
    );

    const result = (await client.callTool({
      name: "pdf_split",
      arguments: { filePath: src, pages: "1,3", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.totalSourcePages).toBe(4);
    expect(payload.flattened).toBe(false);
    // A form-less source has no fields to preserve, rename, or drop.
    expect(payload.formFields).toEqual({
      preserved: 0,
      renamed: [],
      dropped: [],
    });

    // The output must hold exactly the two extracted pages.
    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPageCount()).toBe(2);

    // And those pages must be page 1 and page 3 — not 2 or 4.
    const extract = (await client.callTool({
      name: "pdf_extract_text",
      arguments: { filePath: out },
    })) as ToolResultLike;
    expect(extract.isError).toBeFalsy();
    const text = textOf(extract);
    expect(text).toContain("PAGEONE");
    expect(text).toContain("PAGETHREE");
    expect(text).not.toContain("PAGETWO");
    expect(text).not.toContain("PAGEFOUR");
  }, 30_000);

  // ── delete_pages keeps remaining fields ───────────────────────────────
  it("delete_pages removes page 1 and keeps page 2's field", async () => {
    const src = join(workDir, "twopage-del.pdf");
    const out = join(workDir, "deleted-p1.pdf");
    await writeFile(src, await makeTwoPageFormPdf());

    const result = (await client.callTool({
      name: "pdf_delete_pages",
      arguments: { filePath: src, pages: "1", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.remainingPageCount).toBe(1);
    expect(payload.formFields.preserved).toBe(1);

    const names = await fieldNamesOf(out);
    expect(names).toEqual(["email"]); // page 1 ('name') was deleted
  }, 30_000);

  it("delete_pages refuses to delete every page (isError)", async () => {
    const src = join(workDir, "single-del.pdf");
    const out = join(workDir, "deleted-all.pdf");
    await writeFile(src, await makePlainPdf(["only page"]));

    const result = (await client.callTool({
      name: "pdf_delete_pages",
      arguments: { filePath: src, pages: "1", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).toMatch(/at least one page/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  // ── reorder preserves fields ──────────────────────────────────────────
  it("reorders a two-page form and keeps both fields", async () => {
    const src = join(workDir, "twopage-reorder.pdf");
    const out = join(workDir, "reordered.pdf");
    await writeFile(src, await makeTwoPageFormPdf());

    const result = (await client.callTool({
      name: "pdf_reorder_pages",
      arguments: { filePath: src, pageOrder: "2,1", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBe(2);
    expect(payload.formFields.preserved).toBe(2);

    const names = await fieldNamesOf(out);
    expect(names).toEqual(["email", "name"]);
  }, 30_000);

  // ── flatten bakes values and removes interactivity ────────────────────
  it("flatten:true on merge yields 0 interactive fields with values visible", async () => {
    const a = join(workDir, "flat-a.pdf");
    const b = join(workDir, "flat-b.pdf");
    const out = join(workDir, "flattened.pdf");
    await writeFile(a, await makeFormPdf("VisibleValue"));
    await writeFile(b, await makeFormPdf("VisibleValue"));

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: { filePaths: [a, b], outputPath: out, flatten: true },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.flattened).toBe(true);
    expect(payload.formFields.preserved).toBe(0);

    // Output must have NO interactive fields after flattening.
    const names = await fieldNamesOf(out);
    expect(names).toEqual([]);

    // The flattened value remains visible in the page's drawn content.
    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPageCount()).toBe(2);

    // The baked field value must be extractable as page text (proof it was
    // burned into the content stream, not just dropped with the field).
    const extract = (await client.callTool({
      name: "pdf_extract_text",
      arguments: { filePath: out },
    })) as ToolResultLike;
    expect(extract.isError).toBeFalsy();
    expect(textOf(extract)).toContain("VisibleValue");
  }, 30_000);

  // ── plain (form-less) merge still works, zero form activity ───────────
  it("merges plain form-less PDFs with zero form activity reported", async () => {
    const a = join(workDir, "plain-a.pdf");
    const b = join(workDir, "plain-b.pdf");
    const out = join(workDir, "plain-merged.pdf");
    await writeFile(a, await makePlainPdf(["A1", "A2"]));
    await writeFile(b, await makePlainPdf(["B1"]));

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: { filePaths: [a, b], outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBe(3);
    expect(payload.formFields).toEqual({
      preserved: 0,
      renamed: [],
      dropped: [],
    });
  }, 30_000);

  // ── failure modes ─────────────────────────────────────────────────────
  it("merge returns a clean error when an input file is missing", async () => {
    const a = join(workDir, "plain-ok.pdf");
    await writeFile(a, await makePlainPdf(["ok"]));

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: {
        filePaths: [a, join(workDir, "missing.pdf")],
        outputPath: join(workDir, "merge-missing-out.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  }, 30_000);

  it("merge returns a clean error for garbage .pdf bytes", async () => {
    const a = join(workDir, "plain-ok2.pdf");
    const garbage = join(workDir, "garbage.pdf");
    await writeFile(a, await makePlainPdf(["ok"]));
    await writeFile(garbage, "this is not a pdf at all\n");

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: {
        filePaths: [a, garbage],
        outputPath: join(workDir, "merge-garbage-out.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  }, 30_000);

  it("merge rejects more than MAX_MERGE_FILES inputs (schema validation)", async () => {
    const a = join(workDir, "ok-a.pdf");
    await writeFile(a, await makePlainPdf(["ok"]));
    const tooMany = Array.from({ length: 51 }, () => a); // MAX_MERGE_FILES = 50

    const result = (await client.callTool({
      name: "pdf_merge",
      arguments: { filePaths: tooMany, outputPath: join(workDir, "too.pdf") },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  }, 30_000);

  // ── FPE-1: duplicated form page is reported honestly in `dropped` ──────
  it("reorder with a DUPLICATE form page reports the field in dropped, not preserved", async () => {
    // Single page carrying one form field; reorder duplicates it (1,1). The
    // shared widget ref cannot belong to two page copies, so the field must be
    // dropped (truthful) — never falsely counted as preserved (Rule 8).
    const src = join(workDir, "dup-form-src.pdf");
    const out = join(workDir, "dup-form-out.pdf");
    await writeFile(src, await makeFormPdf("Alice"));

    const result = (await client.callTool({
      name: "pdf_reorder_pages",
      arguments: { filePath: src, pageOrder: "1,1", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBe(2);

    // The form fields on the duplicated page must NOT be reported as preserved.
    expect(payload.formFields.preserved).toBe(0);
    // The fixture has exactly four top-level fields (name, agree, color, size);
    // duplicating the page drops all four (each widget would belong to two page
    // copies), so the count is deterministic.
    expect(payload.formFields.dropped.length).toBe(4);
    // The reason must be explicit about duplication.
    expect(payload.formFields.dropped.join(" ")).toMatch(/duplicat/i);
    // And the original field name must appear in the dropped report.
    expect(payload.formFields.dropped.join(" ")).toMatch(/\bname\b/);

    // Re-loading the output must NOT surface those fields as interactive.
    const names = await fieldNamesOf(out);
    expect(names).toEqual([]);
  }, 30_000);

  // ── TEST-01: write tools return fileSize + reload as valid PDFs ───────
  it("pdf_rotate_pages writes a reloadable PDF with fileSize", async () => {
    const src = join(workDir, "rotate-src.pdf");
    const out = join(workDir, "rotate-out.pdf");
    await writeFile(src, await makePlainPdf(["r1", "r2"]));

    const result = (await client.callTool({
      name: "pdf_rotate_pages",
      arguments: { filePath: src, degrees: 90, outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.degrees).toBe(90);
    expect(typeof payload.fileSize).toBe("string");
    expect(payload.fileSize.length).toBeGreaterThan(0);

    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
  }, 30_000);

  it("pdf_add_page_numbers writes a reloadable PDF with fileSize", async () => {
    const src = join(workDir, "pgnum-src.pdf");
    const out = join(workDir, "pgnum-out.pdf");
    await writeFile(src, await makePlainPdf(["a", "b", "c"]));

    const result = (await client.callTool({
      name: "pdf_add_page_numbers",
      arguments: { filePath: src, outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.totalPages).toBe(3);
    expect(typeof payload.fileSize).toBe("string");
    expect(payload.fileSize.length).toBeGreaterThan(0);

    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPageCount()).toBe(3);
  }, 30_000);

  // ── PG-NUM-ROTATE: page numbers on a pre-rotated page succeed ─────────
  it("pdf_add_page_numbers handles a pre-rotated page (preserves rotation, fileSize)", async () => {
    // Build a 90°-rotated single-page PDF.
    const rotatedSrc = join(workDir, "pgnum-rotated-src.pdf");
    const out = join(workDir, "pgnum-rotated-out.pdf");
    const doc = await pdfLib.PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.drawText("rotated", { x: 20, y: 360, size: 12 });
    page.setRotation(pdfLib.degrees(90));
    await writeFile(rotatedSrc, await doc.save());

    const result = (await client.callTool({
      name: "pdf_add_page_numbers",
      arguments: {
        filePath: rotatedSrc,
        outputPath: out,
        position: "bottom-center",
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.totalPages).toBe(1);
    expect(typeof payload.fileSize).toBe("string");

    // The page's display rotation must be preserved (number drawn upright via
    // the rotate option, not by un-rotating the page).
    const bytes = await readFile(out);
    const reloaded = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(reloaded.getPage(0).getRotation().angle).toBe(90);
  }, 30_000);

  it("pdf_add_watermark writes a reloadable PDF with fileSize", async () => {
    const src = join(workDir, "wm-src.pdf");
    const out = join(workDir, "wm-out.pdf");
    await writeFile(src, await makePlainPdf(["w1", "w2"]));

    const result = (await client.callTool({
      name: "pdf_add_watermark",
      arguments: { filePath: src, text: "DRAFT", outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(typeof payload.fileSize).toBe("string");
    expect(payload.fileSize.length).toBeGreaterThan(0);

    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getPageCount()).toBe(2);
  }, 30_000);
});
