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
          { templateName: "invoice", data, outputPath: "<choose an output path>" },
          null,
          2,
        ),
        "```",
        "",
        "Replace `<choose an output path>` with the desired file path for the invoice PDF.",
      ].join("\n");

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
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
        JSON.stringify({ tool: "pdf_get_form_fields", filePath: pdf_path }, null, 2),
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
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
