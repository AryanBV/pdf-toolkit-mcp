import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import zlib from "node:zlib";
import pdfLib from "@pdfme/pdf-lib";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);

/**
 * A CJK font shipped inside the @pdfme/pdf-lib package, used as a real .otf
 * fixture for the non-Latin form-fill regression test. Resolved relative to the
 * repo root rather than via require.resolve (the package's `exports` field
 * blocks subpath resolution of asset files).
 */
const CJK_FONT_PATH = fileURLToPath(
  new URL(
    "../../node_modules/@pdfme/pdf-lib/assets/fonts/source_hans_jp/SourceHanSerifJP-Regular.otf",
    import.meta.url,
  ),
);

/**
 * Decode a page's content stream(s) to a latin1 string so tests can inspect the
 * text-positioning operators (e.g. the `Tm` matrix). Handles both a single
 * stream and an array of indirect content streams, inflating FlateDecode.
 */
function decodePageContent(
  doc: InstanceType<typeof pdfLib.PDFDocument>,
  pageIndex: number,
): string {
  const ctx = doc.context;
  const node = doc.getPage(pageIndex).node;
  const contents = node.Contents();
  if (!contents) return "";

  const decodeStream = (stream: unknown): string => {
    // PDFRawStream exposes its encoded bytes via `.contents`.
    const raw = (stream as { contents?: Uint8Array }).contents;
    if (!raw) return "";
    let bytes: Uint8Array = raw;
    try {
      bytes = new Uint8Array(zlib.inflateSync(Buffer.from(raw)));
    } catch {
      // Not FlateDecode-compressed; use the raw bytes as-is.
    }
    return Buffer.from(bytes).toString("latin1");
  };

  if (contents.constructor.name === "PDFArray") {
    const arr = contents as unknown as {
      size(): number;
      get(i: number): unknown;
    };
    let out = "";
    for (let i = 0; i < arr.size(); i++) {
      const el = arr.get(i);
      const stream =
        (el as { constructor: { name: string } }).constructor.name === "PDFRef"
          ? ctx.lookup(el as Parameters<typeof ctx.lookup>[0])
          : el;
      out += decodeStream(stream) + "\n";
    }
    return out;
  }
  return decodeStream(contents);
}

/** Extract the first text matrix (`Tm`: a b c d e f) from a content stream. */
function firstTextMatrix(content: string): number[] | null {
  const m = content.match(
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/,
  );
  if (!m) return null;
  return m.slice(1, 7).map(Number);
}

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

  // ── pdf_create ────────────────────────────────────────────────────────
  it("pdf_create writes a real PDF and reports its fileSize", async () => {
    const out = join(workDir, "plain-create.pdf");
    const result = (await client.callTool({
      name: "pdf_create",
      arguments: {
        outputPath: out,
        content: "Hello from pdf_create.\nSecond line of body text.",
        title: "Created Doc",
        author: "Tester",
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.fileSize).toBeTruthy();
    expect(payload.pageCount).toBeGreaterThanOrEqual(1);

    // Output bytes are a real PDF.
    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");

    // Body text survives.
    const text = await extractAll(client, out);
    expect(text).toContain("Hello from pdf_create.");
  }, 30_000);

  // ── pdf_fill_form ─────────────────────────────────────────────────────
  it("pdf_fill_form fills a form field (happy path) and reports fileSize", async () => {
    const src = join(workDir, "fill-src.pdf");
    const out = join(workDir, "fill-out.pdf");
    await writeFile(src, await makeFormPdf());

    const result = (await client.callTool({
      name: "pdf_fill_form",
      arguments: {
        filePath: src,
        fields: { fullName: "Ada Lovelace" },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.filledFields).toBe(1);
    expect(payload.fileSize).toBeTruthy();

    // Output is a real PDF and the field carries the filled value.
    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    const tf = doc.getForm().getTextField("fullName");
    expect(tf.getText()).toBe("Ada Lovelace");
  }, 30_000);

  it("pdf_fill_form returns FIELD_NOT_FOUND for an unknown field name", async () => {
    const src = join(workDir, "fill-src2.pdf");
    const out = join(workDir, "fill-out2.pdf");
    await writeFile(src, await makeFormPdf());

    const result = (await client.callTool({
      name: "pdf_fill_form",
      arguments: {
        filePath: src,
        fields: { noSuchField: "value" },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("FIELD_NOT_FOUND");
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("pdf_fill_form rejects non-Latin text without a fontPath", async () => {
    const src = join(workDir, "fill-nonlatin-src.pdf");
    const out = join(workDir, "fill-nonlatin-out.pdf");
    await writeFile(src, await makeFormPdf());

    const result = (await client.callTool({
      name: "pdf_fill_form",
      arguments: {
        filePath: src,
        fields: { fullName: "こんにちは世界" },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/non-latin/i);
    expect(text).toMatch(/fontPath/);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("pdf_fill_form embeds non-Latin text with a real .otf fontPath (round-trips, no clobber)", async () => {
    // Regression for the silent fontPath bug: previously the field appearance
    // was built BEFORE setText and then save() re-rendered it with the default
    // WinAnsi font, throwing "WinAnsi cannot encode" for CJK glyphs. The fix
    // sets the value first, applies the custom font to appearances, and saves
    // with updateFieldAppearances:false so the embedded glyphs survive.
    let hasFont = true;
    try {
      await access(CJK_FONT_PATH);
    } catch {
      hasFont = false;
    }
    if (!hasFont) {
      // Skip cleanly if the bundled fixture font is unavailable for any reason.
      return;
    }

    const src = join(workDir, "fill-cjk-src.pdf");
    const out = join(workDir, "fill-cjk-out.pdf");
    await writeFile(src, await makeFormPdf());

    const jp = "こんにちは世界";
    const result = (await client.callTool({
      name: "pdf_fill_form",
      arguments: {
        filePath: src,
        fields: { fullName: jp },
        outputPath: out,
        fontPath: CJK_FONT_PATH,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.filledFields).toBe(1);
    expect(payload.fileSize).toBeTruthy();

    // The output is a real PDF and the non-Latin value round-trips intact.
    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    const tf = doc.getForm().getTextField("fullName");
    expect(tf.getText()).toBe(jp);
  }, 30_000);

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

  it("renders a non-USD currency symbol on the invoice (regression: hardcoded $)", async () => {
    const out = join(workDir, "invoice-eur.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "invoice",
        data: {
          companyName: "Euro Co",
          clientName: "Client GmbH",
          invoiceNumber: "INV-EUR-1",
          currency: "EUR",
          items: [{ description: "Widget", quantity: 2, unitPrice: 10 }],
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const text = await extractAll(client, out);
    // The Euro symbol must appear and the dollar sign must NOT.
    expect(text).toContain("€");
    expect(text).not.toContain("$");
    // Total = 2 * 10 = 20.00 in EUR.
    expect(text).toContain("€20.00");
  }, 30_000);

  it("renders a non-WinAnsi currency as its ISO code instead of crashing (INR)", async () => {
    const out = join(workDir, "invoice-inr.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "invoice",
        data: {
          companyName: "Rupee Co",
          clientName: "Client Pvt Ltd",
          invoiceNumber: "INV-INR-1",
          currency: "INR",
          items: [{ description: "Widget", quantity: 2, unitPrice: 10 }],
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    // ₹ is not WinAnsi-encodable; the Helvetica invoice must NOT throw. It falls
    // back to the ASCII ISO code so every currency renders safely.
    expect(result.isError).toBeFalsy();
    const text = await extractAll(client, out);
    expect(text).toContain("INR 20.00");
    expect(text).not.toContain("₹");
  }, 30_000);

  it("defaults the invoice currency to USD ($) when none is provided", async () => {
    const out = join(workDir, "invoice-default-usd.pdf");
    const result = (await client.callTool({
      name: "pdf_create_from_template",
      arguments: {
        templateName: "invoice",
        data: {
          companyName: "Dollar Co",
          clientName: "USD Client",
          items: [{ description: "Item", quantity: 1, unitPrice: 5 }],
        },
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const text = await extractAll(client, out);
    expect(text).toContain("$5.00");
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
    expect(text).toContain("UNSUPPORTED_FORMAT");
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
    expect(text).toContain("FILE_NOT_FOUND");
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("embedding onto an out-of-range page returns PAGE_OUT_OF_RANGE", async () => {
    const pdf = join(workDir, "host3.pdf");
    const png = join(workDir, "tiny.png");
    await writeFile(pdf, await makePlainPdf());
    // A minimal valid 1x1 PNG so decoding succeeds and the page check is hit.
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );

    const result = (await client.callTool({
      name: "pdf_embed_image",
      arguments: {
        filePath: pdf,
        imagePath: png,
        page: 99,
        x: 10,
        y: 10,
        outputPath: join(workDir, "embedded3.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("PAGE_OUT_OF_RANGE");
    expect(text).toMatch(/exceeds document length/i);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("embeds an in-bounds image successfully (happy path)", async () => {
    const pdf = join(workDir, "host-ok.pdf");
    const png = join(workDir, "tiny-ok.png");
    await writeFile(pdf, await makePlainPdf());
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    const out = join(workDir, "embedded-ok.pdf");

    // The host page is 300x400; a 50x50 image at (10,10) fits entirely.
    const result = (await client.callTool({
      name: "pdf_embed_image",
      arguments: {
        filePath: pdf,
        imagePath: png,
        page: 1,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        outputPath: out,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(out);
    expect(payload.fileSize).toBeTruthy();
    expect(payload.dimensions).toEqual({ width: 50, height: 50 });

    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  }, 30_000);

  it("rejects an off-page image placement instead of silently clipping", async () => {
    const pdf = join(workDir, "host-offpage.pdf");
    const png = join(workDir, "tiny-offpage.png");
    await writeFile(pdf, await makePlainPdf());
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );

    // The host page is 300x400; x=5000 pushes the image entirely off-page.
    const result = (await client.callTool({
      name: "pdf_embed_image",
      arguments: {
        filePath: pdf,
        imagePath: png,
        page: 1,
        x: 5000,
        y: 10,
        width: 50,
        height: 50,
        outputPath: join(workDir, "embedded-offpage.pdf"),
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("INVALID_INPUT");
    expect(text).toMatch(/does not fit on page/i);
    // Reports the page dimensions so the caller can correct placement.
    expect(text).toContain("300x400");
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  // ── pdf_add_watermark ─────────────────────────────────────────────────
  it("centers the diagonal watermark on the page (regression: off-center)", async () => {
    // Build a known-size single-page PDF (US Letter: 612x792).
    const src = join(workDir, "wm-src.pdf");
    {
      const doc = await pdfLib.PDFDocument.create();
      doc.addPage([612, 792]);
      await writeFile(src, await doc.save());
    }
    const out = join(workDir, "wm-out.pdf");

    const result = (await client.callTool({
      name: "pdf_add_watermark",
      arguments: {
        filePath: src,
        text: "CONFIDENTIAL",
        outputPath: out,
        // Defaults: rotation 45, fontSize 50.
      },
    })) as ToolResultLike;
    expect(result.isError).toBeFalsy();

    // Recover the text draw origin from the watermarked content stream and
    // verify the watermark's rotated bounding-box CENTER lands on the page
    // center. The old code centered the unrotated origin, leaving the box off
    // center by roughly the rotated half-extents.
    const bytes = await readFile(out);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(bytes));
    const content = decodePageContent(doc, 0);
    const tm = firstTextMatrix(content);
    expect(tm).not.toBeNull();
    const [a, b, , , e, f] = tm as number[];
    // Recompute the same geometry the tool uses.
    const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    const fSize = 50;
    const rot = 45;
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const halfW = font.widthOfTextAtSize("CONFIDENTIAL", fSize) / 2;
    const halfH = font.heightAtSize(fSize) / 2;
    const dx = halfW * cos - halfH * sin;
    const dy = halfW * sin + halfH * cos;
    // The matrix rotation must match the requested 45 degrees.
    expect(a).toBeCloseTo(cos, 3);
    expect(b).toBeCloseTo(sin, 3);
    // Box center = origin (e,f) + rotated half-extents ≈ page center (306, 396).
    expect(e + dx).toBeCloseTo(306, 0);
    expect(f + dy).toBeCloseTo(396, 0);
  }, 30_000);

  // ── pdf_create (non-Latin + wrapping / overflow) ──────────────────────
  it("pdf_create rejects non-Latin content without a fontPath", async () => {
    const out = join(workDir, "create-nonlatin.pdf");
    const result = (await client.callTool({
      name: "pdf_create",
      arguments: {
        outputPath: out,
        content: "日本語のテキスト",
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("UNSUPPORTED_FORMAT");
    expect(text).toMatch(/fontPath/);
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);

  it("pdf_create renders non-Latin content with a fontPath", async () => {
    let hasFont = true;
    try {
      await access(CJK_FONT_PATH);
    } catch {
      hasFont = false;
    }
    if (!hasFont) return;

    const out = join(workDir, "create-cjk.pdf");
    const result = (await client.callTool({
      name: "pdf_create",
      arguments: {
        outputPath: out,
        content: "日本語のテキスト",
        fontPath: CJK_FONT_PATH,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBeGreaterThanOrEqual(1);
    const bytes = await readFile(out);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  }, 30_000);

  it("pdf_create wraps long lines and overflows onto multiple pages", async () => {
    const out = join(workDir, "create-overflow.pdf");
    // A long single paragraph plus many lines to force wrapping + page overflow
    // on a small page with large margins.
    const longWord = "supercalifragilisticexpialidocious ".repeat(20);
    const manyLines = Array.from(
      { length: 200 },
      (_, i) => `Line ${i + 1}: ${longWord}`,
    ).join("\\n");

    const result = (await client.callTool({
      name: "pdf_create",
      arguments: {
        outputPath: out,
        content: manyLines,
        pageSize: "A4",
        fontSize: 14,
        margin: 60,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    // 200 wrapped+overflowed lines must span more than one page.
    expect(payload.pageCount).toBeGreaterThan(1);
    expect(payload.pageSize).toBe("A4");

    const text = await extractAll(client, out);
    expect(text).toContain("Line 1:");
  }, 30_000);
});
