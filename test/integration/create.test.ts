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

const NO_STACK = /\bat .*\(.*:\d+:\d+\)/;

/**
 * Extract text from a PDF file via the server's pdf_extract_text tool. Defaults
 * to the first 10 pages, which covers every fixture these tests generate.
 */
async function extractAll(client: Client, path: string): Promise<string> {
  const result = (await client.callTool({
    name: "pdf_extract_text",
    arguments: { filePath: path },
  })) as ToolResultLike;
  expect(result.isError).toBeFalsy();
  return textOf(result);
}

/** A single-page form PDF with one text field. */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const form = doc.getForm();
  const tf = form.createTextField("fullName");
  tf.addToPage(page, { x: 20, y: 300, width: 200, height: 20 });
  form.updateFieldAppearances();
  return doc.save();
}

async function makePlainPdf(): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawText("no form here", { x: 20, y: 360, size: 12 });
  return doc.save();
}

describe("create tools (react-pdf + remark engine)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "create-test-client", version: "0.0.0" });
    await client.connect(transport);
    workDir = await mkdtemp(join(tmpdir(), "pdf-create-test-"));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── pdf_create_from_markdown ──────────────────────────────────────────
  it("renders markdown (heading, paragraph, list, table, code) to a valid PDF", async () => {
    const out = join(workDir, "md-rich.pdf");
    const markdown = [
      "# Quarterly Heading",
      "",
      "An introductory paragraph with **bold** and *italic* text.",
      "",
      "- alpha bullet",
      "- beta bullet",
      "",
      "| Product | Units |",
      "|---------|-------|",
      "| Gizmo   | 314   |",
      "",
      "```js",
      "const answer = 42;",
      "```",
    ].join("\n");

    const result = (await client.callTool({
      name: "pdf_create_from_markdown",
      arguments: { markdown, outputPath: out, title: "T", author: "A" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.fileSize).toBeTruthy();
    expect(payload.pageCount).toBeGreaterThanOrEqual(1);

    // Output is a real PDF.
    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");

    // Markdown fidelity: heading text and a table cell value survive rendering.
    const text = await extractAll(client, out);
    expect(text).toContain("Quarterly Heading");
    expect(text).toContain("Gizmo");
    expect(text).toContain("314");
    expect(text).toContain("const answer = 42;");
  }, 30_000);

  it("returns a clean error when the output directory does not exist", async () => {
    const result = (await client.callTool({
      name: "pdf_create_from_markdown",
      arguments: {
        markdown: "# hi",
        outputPath: join(workDir, "no-such-dir", "x.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/directory does not exist/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  // ── pdf_create_from_template ──────────────────────────────────────────
  it("generates an invoice from the prompt's data shape with client + line item", async () => {
    const out = join(workDir, "invoice.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "invoice",
        data: {
          companyName: "Acme Corp",
          clientName: "Wile E. Coyote",
          invoiceNumber: "INV-777",
          invoiceDate: "2026-01-01",
          items: [
            { description: "Rocket Skates", quantity: 3, unitPrice: 49.5 },
          ],
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.templateName).toBe("invoice");
    expect(payload.pageCount).toBeGreaterThanOrEqual(1);

    const text = await extractAll(client, out);
    expect(text).toContain("Wile E. Coyote");
    expect(text).toContain("Rocket Skates");
  }, 30_000);

  it("generates a report PDF", async () => {
    const out = join(workDir, "report.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "report",
        data: {
          title: "Annual Review",
          author: "Jane Doe",
          sections: [{ heading: "Summary", body: "Everything went well." }],
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const text = await extractAll(client, out);
    expect(text).toContain("Annual Review");
    expect(text).toContain("Summary");
  }, 30_000);

  it("generates a letter PDF", async () => {
    const out = join(workDir, "letter.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "letter",
        data: {
          senderName: "Alice Sender",
          recipientName: "Bob Recipient",
          subject: "Greetings",
          body: "First paragraph.\nSecond paragraph.",
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const text = await extractAll(client, out);
    expect(text).toContain("Bob Recipient");
    expect(text).toContain("Greetings");
  }, 30_000);

  it("rejects invalid template data (items not an array) with INVALID_INPUT", async () => {
    const out = join(workDir, "bad-invoice.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "invoice",
        data: { companyName: "Acme", items: "not-an-array" },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  // ── pdf_flatten ───────────────────────────────────────────────────────
  it("flattens a filled form so no interactive fields remain", async () => {
    const src = join(workDir, "form.pdf");
    const filled = join(workDir, "form-filled.pdf");
    const flat = join(workDir, "form-flat.pdf");
    await writeFile(src, await makeFormPdf());

    // Fill the field first so a value is baked in on flatten.
    const fill = (await client.callTool({
      name: "pdf_fill_form",
      arguments: {
        filePath: src,
        fields: { fullName: "Flattened Value" },
        outputPath: filled,
      },
    })) as ToolResultLike;
    expect(fill.isError).toBeFalsy();

    const result = (await client.callTool({
      name: "pdf_flatten",
      arguments: { filePath: filled, outputPath: flat },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.flattenedFields).toBe(1);

    const bytes = await readFile(flat);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    expect(doc.getForm().getFields().length).toBe(0);
  }, 30_000);

  it("flattening a form-less PDF succeeds with a note (not an error)", async () => {
    const src = join(workDir, "plain.pdf");
    const out = join(workDir, "plain-flat.pdf");
    await writeFile(src, await makePlainPdf());

    const result = (await client.callTool({
      name: "pdf_flatten",
      arguments: { filePath: src, outputPath: out },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.flattenedFields).toBe(0);
    expect(payload.note).toMatch(/no form fields/i);
  }, 30_000);

  it("pdf_flatten returns a clean error for a missing file", async () => {
    const result = (await client.callTool({
      name: "pdf_flatten",
      arguments: {
        filePath: join(workDir, "ghost.pdf"),
        outputPath: join(workDir, "ghost-out.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  // ── pdf_embed_image ───────────────────────────────────────────────────
  it("embedding a corrupt / non-image file returns a clean error", async () => {
    const pdf = join(workDir, "host.pdf");
    const fakePng = join(workDir, "fake.png");
    await writeFile(pdf, await makePlainPdf());
    await writeFile(fakePng, "this is definitely not a PNG\n");

    const result = (await client.callTool({
      name: "pdf_embed_image",
      arguments: {
        filePath: pdf,
        imagePath: fakePng,
        page: 1,
        x: 10,
        y: 10,
        outputPath: join(workDir, "embedded.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/decode|corrupt|not a valid/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("embedding a missing image file returns a clean error", async () => {
    const pdf = join(workDir, "host2.pdf");
    await writeFile(pdf, await makePlainPdf());

    const result = (await client.callTool({
      name: "pdf_embed_image",
      arguments: {
        filePath: pdf,
        imagePath: join(workDir, "missing.png"),
        page: 1,
        x: 10,
        y: 10,
        outputPath: join(workDir, "embedded2.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);
});
