/**
 * Automated test harness for all 10 PDF toolkit MCP tools.
 * Tests handler functions directly via a mock McpServer.
 * Run: npm run test
 */

import { join } from "node:path";
import { access, unlink } from "node:fs/promises";
import type { ZodTypeAny } from "zod";
import { registerReadTools } from "../src/tools/read.js";
import { registerManipulateTools } from "../src/tools/manipulate.js";
import { registerCreateTools } from "../src/tools/create.js";
import { loadExistingPdf } from "../src/services/pdf-writer.js";

// ── Types ───────────────────────────────────────────────────────────────

interface ToolEntry {
  schema: ZodTypeAny;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResponse>;
}

interface ToolResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

// ── Mock McpServer ──────────────────────────────────────────────────────

const tools = new Map<string, ToolEntry>();

const mockServer = {
  registerTool(
    name: string,
    config: { inputSchema: ZodTypeAny; [key: string]: unknown },
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResponse>
  ): void {
    tools.set(name, { schema: config.inputSchema, handler });
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dirname!, "..", "test-fixtures");
const SAMPLE = join(FIXTURES, "sample.pdf");
const FORM = join(FIXTURES, "sample-form.pdf");
const IMAGE = join(FIXTURES, "sample-image.png");
const NOT_PDF = join(FIXTURES, "not-a-pdf.txt");

const results: TestResult[] = [];
const cleanupFiles: string[] = [];

function parseResponseData(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args, {});
}

function expectZodError(name: string, args: Record<string, unknown>): void {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const result = tool.schema.safeParse(args);
  if (result.success) {
    throw new Error("Expected Zod validation error but input was accepted");
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runTest(
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanup(): Promise<void> {
  for (const f of cleanupFiles) {
    try {
      await unlink(f);
    } catch {
      // File may not exist if test failed before creating it
    }
  }
  cleanupFiles.length = 0;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Register all tools ──────────────────────────────────────────────────

// @ts-expect-error — mock only implements registerTool, which is all tools use
registerReadTools(mockServer);
// @ts-expect-error — mock only implements registerTool
registerManipulateTools(mockServer);
// @ts-expect-error — mock only implements registerTool
registerCreateTools(mockServer);

// ── Test cases ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  // ──────────── pdf_extract_text ────────────

  await runTest("#1 pdf_extract_text — happy path", async () => {
    const res = await callTool("pdf_extract_text", { filePath: SAMPLE });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.totalPages === 3, `expected totalPages=3, got ${data.totalPages}`);
    assert(Array.isArray(data.pages), "pages should be an array");
    assert((data.pages as unknown[]).length === 3, "should extract 3 pages");
  });

  await runTest("#2 pdf_extract_text — error: non-existent file", async () => {
    const res = await callTool("pdf_extract_text", { filePath: "/nonexistent/path.pdf" });
    assert(res.isError === true, "should be an error");
    assert(res.content[0].text.includes("not found"), "error should mention file not found");
  });

  await runTest("#3 pdf_extract_text — edge: defaults to first 10 pages", async () => {
    const res = await callTool("pdf_extract_text", { filePath: SAMPLE });
    const data = parseResponseData(res);
    // 3-page PDF < 10 default, so all 3 should be returned
    assert((data.pages as unknown[]).length === 3, "should return all 3 pages for small PDF");
  });

  // ──────────── pdf_get_metadata ────────────

  await runTest("#4 pdf_get_metadata — happy path", async () => {
    const res = await callTool("pdf_get_metadata", { filePath: SAMPLE });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(typeof data.pageCount === "number", "should have pageCount");
  });

  await runTest("#5 pdf_get_metadata — error: non-existent file", async () => {
    const res = await callTool("pdf_get_metadata", { filePath: "/nonexistent/path.pdf" });
    assert(res.isError === true, "should be an error");
  });

  await runTest("#6 pdf_get_metadata — edge: pageCount is 3", async () => {
    const res = await callTool("pdf_get_metadata", { filePath: SAMPLE });
    const data = parseResponseData(res);
    assert(data.pageCount === 3, `expected pageCount=3, got ${data.pageCount}`);
    assert(data.title === "Test Sample PDF", `expected title 'Test Sample PDF', got '${data.title}'`);
  });

  // ──────────── pdf_get_form_fields ────────────

  await runTest("#7 pdf_get_form_fields — happy path", async () => {
    const res = await callTool("pdf_get_form_fields", { filePath: FORM });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.hasForm === true, "should have form");
    assert(data.fieldCount === 3, `expected 3 fields, got ${data.fieldCount}`);
  });

  await runTest("#8 pdf_get_form_fields — error: PDF without form", async () => {
    const res = await callTool("pdf_get_form_fields", { filePath: SAMPLE });
    const data = parseResponseData(res);
    // sample.pdf has no form — should return hasForm: false (not isError)
    assert(data.hasForm === false, "should report hasForm: false");
  });

  await runTest("#9 pdf_get_form_fields — edge: verify field types", async () => {
    const res = await callTool("pdf_get_form_fields", { filePath: FORM });
    const data = parseResponseData(res);
    const fields = data.fields as { name: string; type: string }[];
    const nameField = fields.find((f) => f.name === "Name");
    const agreeField = fields.find((f) => f.name === "Agree");
    const countryField = fields.find((f) => f.name === "Country");
    assert(nameField?.type === "text", `Name should be text, got ${nameField?.type}`);
    assert(agreeField?.type === "checkbox", `Agree should be checkbox, got ${agreeField?.type}`);
    assert(countryField?.type === "dropdown", `Country should be dropdown, got ${countryField?.type}`);
  });

  // ──────────── pdf_merge ────────────

  const mergedPath = join(FIXTURES, "test-merged.pdf");

  await runTest("#10 pdf_merge — happy path", async () => {
    cleanupFiles.push(mergedPath);
    const res = await callTool("pdf_merge", {
      filePaths: [SAMPLE, SAMPLE],
      outputPath: mergedPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.totalPages === 6, `expected 6 pages, got ${data.totalPages}`);
    assert(await fileExists(mergedPath), "merged file should exist");
  });
  await cleanup();

  await runTest("#11 pdf_merge — error: single file (Zod min 2)", async () => {
    expectZodError("pdf_merge", {
      filePaths: [SAMPLE],
      outputPath: mergedPath,
    });
  });

  await runTest("#12 pdf_merge — edge: verify merged page count", async () => {
    cleanupFiles.push(mergedPath);
    await callTool("pdf_merge", {
      filePaths: [SAMPLE, SAMPLE],
      outputPath: mergedPath,
    });
    const doc = await loadExistingPdf(mergedPath);
    assert(doc.getPageCount() === 6, `merged PDF should have 6 pages, got ${doc.getPageCount()}`);
  });
  await cleanup();

  // ──────────── pdf_split ────────────

  const splitPath = join(FIXTURES, "test-split.pdf");

  await runTest("#13 pdf_split — happy path", async () => {
    cleanupFiles.push(splitPath);
    const res = await callTool("pdf_split", {
      filePath: SAMPLE,
      pages: "1-2",
      outputPath: splitPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.extractedPages === "1-2", `expected pages '1-2', got '${data.extractedPages}'`);
  });
  await cleanup();

  await runTest("#14 pdf_split — error: page 5 from 3-page PDF", async () => {
    const res = await callTool("pdf_split", {
      filePath: SAMPLE,
      pages: "5",
      outputPath: splitPath,
    });
    assert(res.isError === true, "should be an error");
    assert(res.content[0].text.includes("exceeds"), "should mention exceeding page count");
  });

  await runTest("#15 pdf_split — edge: verify output has 2 pages", async () => {
    cleanupFiles.push(splitPath);
    await callTool("pdf_split", {
      filePath: SAMPLE,
      pages: "1-2",
      outputPath: splitPath,
    });
    const doc = await loadExistingPdf(splitPath);
    assert(doc.getPageCount() === 2, `split PDF should have 2 pages, got ${doc.getPageCount()}`);
  });
  await cleanup();

  // ──────────── pdf_rotate_pages ────────────

  const rotatedPath = join(FIXTURES, "test-rotated.pdf");

  await runTest("#16 pdf_rotate_pages — happy path", async () => {
    cleanupFiles.push(rotatedPath);
    const res = await callTool("pdf_rotate_pages", {
      filePath: SAMPLE,
      degrees: 90,
      outputPath: rotatedPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.degrees === 90, `expected degrees=90, got ${data.degrees}`);
    assert(typeof data.outputPath === "string", "should have outputPath");
  });
  await cleanup();

  await runTest("#17 pdf_rotate_pages — error: invalid degrees (45)", async () => {
    expectZodError("pdf_rotate_pages", {
      filePath: SAMPLE,
      degrees: 45,
      outputPath: rotatedPath,
    });
  });

  await runTest("#18 pdf_rotate_pages — edge: verify output exists", async () => {
    cleanupFiles.push(rotatedPath);
    await callTool("pdf_rotate_pages", {
      filePath: SAMPLE,
      degrees: 180,
      outputPath: rotatedPath,
    });
    assert(await fileExists(rotatedPath), "rotated file should exist");
  });
  await cleanup();

  // ──────────── pdf_create ────────────

  const createdPath = join(FIXTURES, "test-created.pdf");

  await runTest("#19 pdf_create — happy path", async () => {
    cleanupFiles.push(createdPath);
    const res = await callTool("pdf_create", {
      outputPath: createdPath,
      content: "Hello World\nThis is a test PDF.\nThird line of content.",
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(typeof data.pageCount === "number" && (data.pageCount as number) >= 1, "should have at least 1 page");
  });
  await cleanup();

  await runTest("#20 pdf_create — error: empty outputPath", async () => {
    const res = await callTool("pdf_create", {
      outputPath: "",
      content: "test",
    });
    assert(res.isError === true, "should be an error");
  });

  await runTest("#21 pdf_create — edge: long text spans 2+ pages", async () => {
    cleanupFiles.push(createdPath);
    // Generate enough text for multiple pages (~60 lines per A4 page at 12pt)
    const longText = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: This is a test line with enough text to fill up the page progressively.`).join("\n");
    const res = await callTool("pdf_create", {
      outputPath: createdPath,
      content: longText,
    });
    const data = parseResponseData(res);
    assert((data.pageCount as number) >= 2, `expected 2+ pages, got ${data.pageCount}`);
  });
  await cleanup();

  // ──────────── pdf_fill_form ────────────

  const filledPath = join(FIXTURES, "test-filled.pdf");

  await runTest("#22 pdf_fill_form — happy path", async () => {
    cleanupFiles.push(filledPath);
    const res = await callTool("pdf_fill_form", {
      filePath: FORM,
      fields: { Name: "John" },
      outputPath: filledPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.filledFields === 1, `expected 1 filled field, got ${data.filledFields}`);
  });
  await cleanup();

  await runTest("#23 pdf_fill_form — error: non-existent field", async () => {
    cleanupFiles.push(filledPath);
    const res = await callTool("pdf_fill_form", {
      filePath: FORM,
      fields: { Foo: "bar" },
      outputPath: filledPath,
    });
    assert(res.isError === true, "should be an error");
    assert(res.content[0].text.includes("Name"), "error should list available fields including 'Name'");
  });
  await cleanup();

  await runTest("#24 pdf_fill_form — edge: flatten=true", async () => {
    cleanupFiles.push(filledPath);
    const res = await callTool("pdf_fill_form", {
      filePath: FORM,
      fields: { Name: "Jane" },
      outputPath: filledPath,
      flatten: true,
    });
    const data = parseResponseData(res);
    assert(data.flattened === true, `expected flattened=true, got ${data.flattened}`);
  });
  await cleanup();

  // ──────────── pdf_add_watermark ────────────

  const watermarkPath = join(FIXTURES, "test-watermark.pdf");

  await runTest("#25 pdf_add_watermark — happy path", async () => {
    cleanupFiles.push(watermarkPath);
    const res = await callTool("pdf_add_watermark", {
      filePath: SAMPLE,
      text: "DRAFT",
      outputPath: watermarkPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.text === "DRAFT", `expected text='DRAFT', got '${data.text}'`);
  });
  await cleanup();

  await runTest("#26 pdf_add_watermark — error: non-existent source", async () => {
    const res = await callTool("pdf_add_watermark", {
      filePath: "/nonexistent/source.pdf",
      text: "DRAFT",
      outputPath: watermarkPath,
    });
    assert(res.isError === true, "should be an error");
  });

  await runTest("#27 pdf_add_watermark — edge: specific pages '1,3'", async () => {
    cleanupFiles.push(watermarkPath);
    const res = await callTool("pdf_add_watermark", {
      filePath: SAMPLE,
      text: "CONFIDENTIAL",
      outputPath: watermarkPath,
      pages: "1,3",
    });
    const data = parseResponseData(res);
    assert(data.watermarkedPages === "1,3", `expected pages '1,3', got '${data.watermarkedPages}'`);
  });
  await cleanup();

  // ──────────── pdf_embed_image ────────────

  const embedPath = join(FIXTURES, "test-embed.pdf");

  await runTest("#28 pdf_embed_image — happy path", async () => {
    cleanupFiles.push(embedPath);
    const res = await callTool("pdf_embed_image", {
      filePath: SAMPLE,
      imagePath: IMAGE,
      page: 1,
      x: 50,
      y: 500,
      outputPath: embedPath,
    });
    const data = parseResponseData(res);
    assert(!res.isError, "should not be an error");
    assert(data.page === 1, `expected page=1, got ${data.page}`);
    assert(typeof (data.dimensions as Record<string, number>).width === "number", "should have dimensions");
  });
  await cleanup();

  await runTest("#29 pdf_embed_image — error: non-image file", async () => {
    const res = await callTool("pdf_embed_image", {
      filePath: SAMPLE,
      imagePath: NOT_PDF,
      page: 1,
      x: 50,
      y: 500,
      outputPath: embedPath,
    });
    assert(res.isError === true, "should be an error");
    assert(res.content[0].text.includes("Unsupported image"), "should mention unsupported format");
  });

  await runTest("#30 pdf_embed_image — edge: verify output exists", async () => {
    cleanupFiles.push(embedPath);
    await callTool("pdf_embed_image", {
      filePath: SAMPLE,
      imagePath: IMAGE,
      page: 1,
      x: 0,
      y: 0,
      width: 50,
      outputPath: embedPath,
    });
    assert(await fileExists(embedPath), "embed output file should exist");
  });
  await cleanup();
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify fixtures exist
  for (const f of [SAMPLE, FORM, IMAGE, NOT_PDF]) {
    if (!(await fileExists(f))) {
      console.error(`Missing fixture: ${f}`);
      console.error("Run 'npm run generate-fixtures' first.");
      process.exit(1);
    }
  }

  await runAllTests();

  // Print results
  console.log("\n─── Test Results ───────────────────────────────────────\n");

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
      failed++;
    }
  }

  console.log(`\n─── Summary: ${passed} passed, ${failed} failed ───────\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
