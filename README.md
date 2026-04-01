# PDF Toolkit MCP Server

MCP server for PDF manipulation — create from Markdown, fill forms, merge, split, encrypt, add QR codes. Zero-config, TypeScript-native.

[![npm version](https://img.shields.io/npm/v/@aryanbv/pdf-toolkit-mcp)](https://www.npmjs.com/package/@aryanbv/pdf-toolkit-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![tools](https://img.shields.io/badge/tools-16-orange)]()

## Install

```
npx -y @aryanbv/pdf-toolkit-mcp
```

No config files, no API keys, no Docker. Works offline.

## Create PDFs from Markdown

The standout feature — turn Markdown into professional PDFs:

> "Create a PDF from this Markdown with page numbers"

```markdown
# Quarterly Report

## Revenue

Revenue grew **23% year-over-year**, driven by enterprise expansion.

| Region    | Q1 2025  | Q1 2026  | Growth |
|-----------|----------|----------|--------|
| Americas  | $1.2M    | $1.5M    | +25%   |
| EMEA      | $800K    | $960K    | +20%   |
| APAC      | $400K    | $520K    | +30%   |

## Key Wins

1. Signed 12 new enterprise contracts
2. Reduced churn to 3.1%
3. Launched self-serve tier

---

```

This produces a multi-page PDF with formatted headings, styled tables, numbered lists, bold/italic text, and page numbers — all from a single tool call.

## Client Setup

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pdf-toolkit": {
      "command": "npx",
      "args": ["-y", "@aryanbv/pdf-toolkit-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add pdf-toolkit -- npx -y @aryanbv/pdf-toolkit-mcp
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "pdf-toolkit": {
      "command": "npx",
      "args": ["-y", "@aryanbv/pdf-toolkit-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong></summary>

> **VS Code uses `"servers"`, NOT `"mcpServers"`.** Copying the config from other clients will silently fail. Requires the GitHub Copilot extension with Agent mode enabled.

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "pdf-toolkit": {
      "command": "npx",
      "args": ["-y", "@aryanbv/pdf-toolkit-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "pdf-toolkit": {
      "command": "npx",
      "args": ["-y", "@aryanbv/pdf-toolkit-mcp"]
    }
  }
}
```

</details>

## Tools

16 tools organized by category:

| Category | Tool | Description |
|----------|------|-------------|
| **Create** | `pdf_create` | Create new PDF from text content |
| | `pdf_create_from_markdown` | Create rich PDF from Markdown (headings, tables, lists, code blocks) |
| | `pdf_create_from_template` | Create PDF from template (invoice, report, letter) |
| **Read** | `pdf_extract_text` | Extract text from PDF pages (first 10 by default) |
| | `pdf_get_metadata` | Get title, author, page count, creation date |
| | `pdf_get_form_fields` | List form fields with names, types, and values |
| **Modify** | `pdf_merge` | Merge multiple PDFs into one |
| | `pdf_split` | Extract page ranges into a new PDF |
| | `pdf_rotate_pages` | Rotate pages by 90, 180, or 270 degrees |
| | `pdf_reorder_pages` | Reorder pages in any order (supports duplication) |
| **Enhance** | `pdf_add_watermark` | Add text watermark to pages |
| | `pdf_add_page_numbers` | Add page numbers (configurable position and format) |
| | `pdf_embed_image` | Embed PNG or JPEG image into a page |
| **Forms** | `pdf_fill_form` | Fill form fields (text, checkbox, dropdown, radio) |
| **Security** | `pdf_encrypt` | Password-protect with user/owner passwords |
| | `pdf_embed_qr_code` | Embed QR code or barcode (Code128, DataMatrix, EAN-13, PDF417, Aztec) |

## Templates

Generate professional documents from structured data:

> "Create an invoice for Acme Corp"

```json
{
  "templateName": "invoice",
  "data": {
    "companyName": "Your Company",
    "clientName": "Acme Corp",
    "invoiceNumber": "INV-001",
    "invoiceDate": "2026-04-01",
    "items": [
      { "description": "Web Development", "quantity": 40, "unitPrice": 150 },
      { "description": "Hosting (Annual)", "quantity": 1, "unitPrice": 299 }
    ],
    "taxRate": 18,
    "paymentTerms": "Net 30"
  },
  "outputPath": "/path/to/invoice.pdf"
}
```

Available templates: `invoice`, `report`, `letter`.

## Encryption

> "Encrypt report.pdf with password 'secure123'"

Applies RC4 128-bit encryption. Set separate user (open) and owner (edit) passwords for granular access control.

## QR Codes & Barcodes

> "Add a QR code linking to our website on page 1"

Supported types: QR Code, Code128, DataMatrix, EAN-13, PDF417, Aztec Code. Position and size are fully configurable.

## Usage Examples

Just ask naturally:

- "Create a PDF from this Markdown report"
- "Generate an invoice for Client Corp — 10 hours consulting at $150/hr"
- "Merge january.pdf and february.pdf into q1-combined.pdf"
- "Extract text from pages 5-10 of thesis.pdf"
- "Fill the Name field with 'John Doe' in application.pdf"
- "Add a CONFIDENTIAL watermark to draft.pdf"
- "Encrypt financials.pdf with password 'budget2026'"
- "Add page numbers to presentation.pdf"
- "Embed a QR code with our URL on the cover page"
- "Reorder pages as 3,1,2 in report.pdf"

## Known Limitations

- **Merge/Split/Reorder**: Form fields are not preserved. Visual content transfers, but interactive fields are lost.
- **Text extraction**: Returns PDF stream order, not visual reading order. Multi-column layouts may interleave.
- **Extract text**: Defaults to first 10 pages to avoid exceeding LLM context. Request specific pages for longer documents.
- **Image embedding**: Only JPEG and PNG formats are supported.
- **Form filling**: Non-Latin characters (Arabic, CJK, Devanagari) require providing a custom font file (.ttf/.otf).
- **Encryption**: Uses RC4 128-bit, not AES. Adequate for access control but not modern strong encryption.
- **Markdown fonts**: pdfmake uses Roboto only. Custom fonts are not yet supported for Markdown PDFs.

## Tech Stack

Dual-engine architecture for maximum capability:

- **pdfmake** — Rich document creation (Markdown, templates, tables, headers/footers)
- **@pdfme/pdf-lib** — Existing PDF manipulation (merge, split, rotate, watermark, forms, images, QR codes)
- **unpdf** — Text extraction and metadata reading

## Requirements

- Node.js >= 18

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run test         # Run all 51 tests
npm run inspect      # Open MCP Inspector (requires Node >= 22.7.5)
```

See [CLAUDE.md](CLAUDE.md) for architecture details and contribution guidelines.

## License

MIT
