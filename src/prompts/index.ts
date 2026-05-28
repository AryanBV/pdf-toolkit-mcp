import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  // ── create-invoice ─────────────────────────────────────────────────────
  server.registerPrompt(
    "create-invoice",
    {
      title: "Create Invoice PDF",
      description:
        "Parse invoice details and generate a structured call to pdf_create_from_template.",
      argsSchema: {
        company_name: z.string().describe("Your company name"),
        client_name: z.string().describe("Client / recipient name"),
        invoice_number: z.string().describe("Invoice number (e.g. INV-001)"),
        items: z
          .string()
          .describe(
            'Line items as "description:qty:price" separated by semicolons, e.g. "Web design:1:1500;Hosting:12:29.99"',
          ),
      },
    },
    async ({ company_name, client_name, invoice_number, items }) => {
      const parsedItems = items.split(";").map((entry) => {
        const parts = entry.trim().split(":");
        return {
          description: parts[0]?.trim() ?? "",
          quantity: Number(parts[1]?.trim()) || 1,
          unitPrice: Number(parts[2]?.trim()) || 0,
        };
      });

      const today = new Date().toISOString().slice(0, 10);

      const data = {
        companyName: company_name,
        clientName: client_name,
        invoiceNumber: invoice_number,
        invoiceDate: today,
        items: parsedItems,
      };

      const text = [
        `Create an invoice PDF using the \`pdf_create_from_template\` tool with these parameters:`,
        "",
        "```json",
        JSON.stringify(
          {
            templateName: "invoice",
            data,
            outputPath: "<choose an output path>",
          },
          null,
          2,
        ),
        "```",
        "",
        "Replace `<choose an output path>` with the desired file path for the invoice PDF.",
      ].join("\n");

      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    },
  );

  // ── fill-form ──────────────────────────────────────────────────────────
  server.registerPrompt(
    "fill-form",
    {
      title: "Fill PDF Form",
      description:
        "Guide a two-step workflow: discover form fields, then fill them.",
      argsSchema: {
        pdf_path: z.string().describe("Absolute path to the PDF form"),
      },
    },
    async ({ pdf_path }) => {
      const text = [
        `Fill the PDF form at \`${pdf_path}\` using this two-step workflow:`,
        "",
        `**Step 1** — Discover the form fields:`,
        "```json",
        JSON.stringify(
          { tool: "pdf_get_form_fields", filePath: pdf_path },
          null,
          2,
        ),
        "```",
        "",
        `**Step 2** — Once you know the field names and types, fill them:`,
        "```json",
        JSON.stringify(
          {
            tool: "pdf_fill_form",
            filePath: pdf_path,
            fields: { "<field_name>": "<value>" },
            outputPath: "<choose an output path>",
          },
          null,
          2,
        ),
        "```",
        "",
        "Replace the placeholder field names and values with the actual fields discovered in Step 1.",
      ].join("\n");

      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    },
  );

  // ── read-scanned-pdf ───────────────────────────────────────────────────
  server.registerPrompt(
    "read-scanned-pdf",
    {
      title: "Read a Scanned / Image PDF",
      description:
        "Guide reading a scanned or image-only PDF by rendering its pages for vision, with a fallback to text extraction for digital PDFs.",
      argsSchema: {
        pdf_path: z.string().describe("Absolute path to the PDF to read"),
      },
    },
    async ({ pdf_path }) => {
      const text = [
        `Read the PDF at \`${pdf_path}\`. Many PDFs are scanned or image-only and contain no extractable text layer, so follow this workflow:`,
        "",
        `**Step 1** — Try a quick text extraction to detect whether this is a digital PDF:`,
        "```json",
        JSON.stringify(
          { tool: "pdf_extract_text", filePath: pdf_path },
          null,
          2,
        ),
        "```",
        "",
        `**Step 2** — If Step 1 returns little or no usable text (a scanned/image PDF), SEE the pages directly by rendering them inline for vision:`,
        "```json",
        JSON.stringify(
          { tool: "pdf_render_pages", filePath: pdf_path, inline: true },
          null,
          2,
        ),
        "```",
        "",
        'Inline rendering returns up to 5 pages as images you can read visually. For longer documents, pass a `pages` range (e.g. "1-5") and render in batches.',
      ].join("\n");

      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    },
  );

  // ── pdf-to-markdown ────────────────────────────────────────────────────
  server.registerPrompt(
    "pdf-to-markdown",
    {
      title: "Convert PDF to Markdown",
      description:
        "Guide converting a PDF into structured Markdown, then optionally summarizing it.",
      argsSchema: {
        pdf_path: z.string().describe("Absolute path to the PDF to convert"),
      },
    },
    async ({ pdf_path }) => {
      const text = [
        `Convert the PDF at \`${pdf_path}\` to Markdown:`,
        "",
        `**Step 1** — Convert the document to structured Markdown:`,
        "```json",
        JSON.stringify(
          { tool: "pdf_to_markdown", filePath: pdf_path },
          null,
          2,
        ),
        "```",
        "",
        "**Step 2** — Optionally, summarize the resulting Markdown or extract the parts the user asked about. Preserve headings, lists, and tables from the conversion.",
      ].join("\n");

      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    },
  );

  // ── merge-and-flatten ──────────────────────────────────────────────────
  server.registerPrompt(
    "merge-and-flatten",
    {
      title: "Merge PDFs and Flatten Forms",
      description:
        "Guide merging multiple PDFs into one and flattening any form fields into static content.",
      argsSchema: {
        pdf_paths: z
          .string()
          .describe(
            "Absolute paths to the PDFs to merge, separated by commas or semicolons (in order)",
          ),
        output_path: z.string().describe("Absolute path for the merged PDF"),
      },
    },
    async ({ pdf_paths, output_path }) => {
      const paths = pdf_paths
        .split(/[;,]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const text = [
        `Merge these PDFs into \`${output_path}\` and flatten any form fields:`,
        "",
        "```json",
        JSON.stringify(paths, null, 2),
        "```",
        "",
        `**Option A (one step)** — Merge and flatten in a single call. \`pdf_merge\` preserves form fields by namespacing them per source document, and \`flatten:true\` bakes them into static content:`,
        "```json",
        JSON.stringify(
          {
            tool: "pdf_merge",
            filePaths: paths,
            outputPath: output_path,
            flatten: true,
          },
          null,
          2,
        ),
        "```",
        "",
        `**Option B (two steps)** — Merge first, then flatten the result into a new file (the flatten output must differ from its input):`,
        "```json",
        JSON.stringify(
          { tool: "pdf_merge", filePaths: paths, outputPath: output_path },
          null,
          2,
        ),
        "```",
        "```json",
        JSON.stringify(
          {
            tool: "pdf_flatten",
            filePath: output_path,
            outputPath: "<a different output path>",
          },
          null,
          2,
        ),
        "```",
        "",
        "Use Option A unless you need to inspect the merged document before flattening.",
      ].join("\n");

      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    },
  );
}
