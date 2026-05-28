import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import pdfLib from "@pdfme/pdf-lib";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResultLike {
  isError?: boolean;
  content: ContentBlock[];
}

function textOf(result: ToolResultLike): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function makeMultiPagePdf(pages: number): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([300, 400]);
    p.drawText(`Hello page ${i + 1}`);
  }
  return doc.save();
}

describe("MCP-native enhancements (inline render, prompts, resources)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;
  let twoPagePath: string;
  let sixPagePath: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "mcp-native-test-client", version: "0.0.0" });
    await client.connect(transport);

    workDir = await mkdtemp(join(tmpdir(), "pdf-mcp-native-"));
    twoPagePath = join(workDir, "two.pdf");
    sixPagePath = join(workDir, "six.pdf");
    await writeFile(twoPagePath, await makeMultiPagePdf(2));
    await writeFile(sixPagePath, await makeMultiPagePdf(6));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── 1. Inline rendering ─────────────────────────────────────────────────
  it("returns inline image blocks and writes no files when inline:true", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "pdf-inline-"));
    const pdfInIsolated = join(isolated, "doc.pdf");
    await writeFile(pdfInIsolated, await makeMultiPagePdf(2));

    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: pdfInIsolated, inline: true },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();

    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);
    expect(imageBlocks).toHaveLength(2);

    for (const block of imageBlocks) {
      expect(typeof block.data).toBe("string");
      expect((block.data ?? "").length).toBeGreaterThan(0);
      expect(block.mimeType).toBe("image/png");
    }

    // First block should be a text summary.
    expect(result.content[0]?.type).toBe("text");
    expect(textOf(result)).toMatch(/Rendered 2 page\(s\) inline/i);

    // No image files written to the PDF's directory.
    const entries = await readdir(isolated);
    expect(entries.filter((e) => /\.(png|jpe?g)$/i.test(e))).toHaveLength(0);
    expect(entries).toEqual(["doc.pdf"]);

    await rm(isolated, { recursive: true, force: true });
  }, 30_000);

  it("returns JPEG mimeType when inline format is jpeg", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: {
        filePath: twoPagePath,
        pages: "1",
        format: "jpeg",
        inline: true,
      },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0].mimeType).toBe("image/jpeg");
  }, 30_000);

  it("errors when inline page count exceeds MAX_INLINE_RENDER_PAGES", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: sixPagePath, pages: "1-6", inline: true },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/limited to 5 pages|RESOURCE_LIMIT/i);
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);

  it("non-inline render still writes files and returns text paths (regression)", async () => {
    const result = (await client.callTool({
      name: "pdf_render_pages",
      arguments: { filePath: twoPagePath, format: "png" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    expect(result.content.every((c) => c.type === "text")).toBe(true);
    const payload = JSON.parse(textOf(result));
    expect(payload.pageCount).toBe(2);
    expect(payload.images).toHaveLength(2);
    expect(typeof payload.images[0].path).toBe("string");
  }, 30_000);

  // ── 2. Guided-workflow prompts ──────────────────────────────────────────
  it("lists the three new guided-workflow prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("read-scanned-pdf");
    expect(names).toContain("pdf-to-markdown");
    expect(names).toContain("merge-and-flatten");
    // Existing prompts remain.
    expect(names).toContain("create-invoice");
    expect(names).toContain("fill-form");
  });

  it("read-scanned-pdf returns a non-empty user message", async () => {
    const result = await client.getPrompt({
      name: "read-scanned-pdf",
      arguments: { pdf_path: "/x.pdf" },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content.type).toBe("text");
    const text = first.content.type === "text" ? first.content.text : "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("/x.pdf");
    expect(text).toMatch(/pdf_render_pages/);
  });

  it("merge-and-flatten parses the path list and references merge/flatten", async () => {
    const result = await client.getPrompt({
      name: "merge-and-flatten",
      arguments: { pdf_paths: "/a.pdf, /b.pdf", output_path: "/out.pdf" },
    });
    const text =
      result.messages[0].content.type === "text"
        ? result.messages[0].content.text
        : "";
    expect(text).toContain("/a.pdf");
    expect(text).toContain("/b.pdf");
    expect(text).toContain("/out.pdf");
    expect(text).toMatch(/pdf_merge/);
    expect(text).toMatch(/flatten/);
  });

  it("create-invoice parses line items into a pdf_create_from_template call", async () => {
    const result = await client.getPrompt({
      name: "create-invoice",
      arguments: {
        company_name: "Acme Co",
        client_name: "Globex",
        invoice_number: "INV-007",
        items: "Web design:2:1500;Hosting:12:29.99",
      },
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content.type).toBe("text");
    const text = first.content.type === "text" ? first.content.text : "";

    expect(text).toMatch(/pdf_create_from_template/);
    expect(text).toContain("INV-007");

    // The embedded JSON block must contain the parsed line items.
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const payload = JSON.parse(jsonMatch![1]) as {
      templateName: string;
      data: {
        companyName: string;
        clientName: string;
        invoiceNumber: string;
        items: { description: string; quantity: number; unitPrice: number }[];
      };
    };
    expect(payload.templateName).toBe("invoice");
    expect(payload.data.companyName).toBe("Acme Co");
    expect(payload.data.clientName).toBe("Globex");
    expect(payload.data.invoiceNumber).toBe("INV-007");
    expect(payload.data.items).toEqual([
      { description: "Web design", quantity: 2, unitPrice: 1500 },
      { description: "Hosting", quantity: 12, unitPrice: 29.99 },
    ]);
  });

  it("fill-form returns a two-step discover-then-fill workflow", async () => {
    const result = await client.getPrompt({
      name: "fill-form",
      arguments: { pdf_path: "/forms/application.pdf" },
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content.type).toBe("text");
    const text = first.content.type === "text" ? first.content.text : "";

    expect(text).toContain("/forms/application.pdf");
    expect(text).toMatch(/pdf_get_form_fields/);
    expect(text).toMatch(/pdf_fill_form/);
  });

  // ── 3. templates resource ───────────────────────────────────────────────
  it("lists the templates resource", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("pdf-toolkit://templates");
  });

  it("reads the templates resource as JSON listing invoice/report/letter", async () => {
    const result = await client.readResource({
      uri: "pdf-toolkit://templates",
    });
    expect(result.contents.length).toBeGreaterThan(0);
    const content = result.contents[0];
    expect(content.uri).toBe("pdf-toolkit://templates");
    expect(content.mimeType).toBe("application/json");

    const text = typeof content.text === "string" ? content.text : "";
    const payload = JSON.parse(text) as {
      templates: { name: string; description: string; fields: string[] }[];
    };
    const names = payload.templates.map((t) => t.name);
    expect(names).toContain("invoice");
    expect(names).toContain("report");
    expect(names).toContain("letter");

    const invoice = payload.templates.find((t) => t.name === "invoice");
    expect(invoice).toBeDefined();
    expect(invoice?.fields).toContain("items");
    expect(invoice?.fields.length).toBeGreaterThan(0);
  });
});
