# PDF Toolkit MCP Server

MCP server for PDF manipulation — render pages to images for vision, create from Markdown, fill forms, merge/split (form-preserving), AES-256 encrypt, search, compare, add QR codes. Zero-config, TypeScript-native.

[![npm version](https://img.shields.io/npm/v/@aryanbv/pdf-toolkit-mcp)](https://www.npmjs.com/package/@aryanbv/pdf-toolkit-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![tools](https://img.shields.io/badge/tools-22-orange)]()

## Install

```
npx -y @aryanbv/pdf-toolkit-mcp
```

No config files, no API keys, no Docker. Works offline.

## Create PDFs from Markdown

The standout feature — turn Markdown into professional PDFs:

> "Create a PDF from this Markdown report"

```markdown
# Quarterly Report

## Revenue

Revenue grew **23% year-over-year**, driven by enterprise expansion.

| Region   | Q1 2025 | Q1 2026 | Growth |
| -------- | ------- | ------- | ------ |
| Americas | $1.2M   | $1.5M   | +25%   |
| EMEA     | $800K   | $960K   | +20%   |
| APAC     | $400K   | $520K   | +30%   |

## Key Wins

1. Signed 12 new enterprise contracts
2. Reduced churn to 3.1%
3. Launched self-serve tier
```

This produces a multi-page PDF with formatted headings, styled tables, numbered lists, and bold/italic text from a single tool call (CommonMark + GFM, rendered with @react-pdf/renderer). Add page numbers afterward with `pdf_add_page_numbers`.

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

22 tools organized by category:

| Category       | Tool                       | Description                                                                  |
| -------------- | -------------------------- | ---------------------------------------------------------------------------- |
| **Read**       | `pdf_extract_text`         | Extract text from PDF pages (first 10 by default)                            |
|                | `pdf_get_metadata`         | Get title, author, subject, page count, dates, producer, file size           |
|                | `pdf_get_form_fields`      | List form fields with names, types, values, and required status              |
|                | `pdf_to_markdown`          | Convert a PDF to reading-order Markdown (columns, headings, lists)           |
|                | `pdf_search`               | Find text across pages; returns page numbers and snippets (literal or regex) |
|                | `pdf_compare`              | Page-by-page text diff between two PDFs                                      |
| **Manipulate** | `pdf_merge`                | Merge multiple PDFs into one (preserves form fields)                         |
|                | `pdf_split`                | Extract page ranges into a new PDF (preserves form fields)                   |
|                | `pdf_delete_pages`         | Delete a page range, keeping the rest (preserves form fields)                |
|                | `pdf_reorder_pages`        | Reorder pages in any order (duplicates allowed; preserves form fields)       |
|                | `pdf_rotate_pages`         | Rotate pages by 90, 180, or 270 degrees                                      |
|                | `pdf_flatten`              | Bake form-field values into static content (remove interactivity)            |
|                | `pdf_encrypt`              | AES-256 password protection with user/owner passwords                        |
| **Create**     | `pdf_create`               | Create new PDF from text content                                             |
|                | `pdf_create_from_markdown` | Create rich PDF from Markdown (headings, tables, lists, code blocks)         |
|                | `pdf_create_from_template` | Create PDF from template (invoice, report, letter)                           |
|                | `pdf_fill_form`            | Fill form fields (text, checkbox, dropdown, radio)                           |
|                | `pdf_add_watermark`        | Add text watermark to pages                                                  |
|                | `pdf_add_page_numbers`     | Add page numbers (configurable position and format)                          |
|                | `pdf_embed_image`          | Embed PNG or JPEG image into a page                                          |
|                | `pdf_embed_qr_code`        | Embed QR code or barcode (Code128, DataMatrix, EAN-13, PDF417, Aztec)        |
| **Render**     | `pdf_render_pages`         | Render pages to PNG/JPEG (or inline images) so a vision model can read them  |

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

## Read Scanned & Image-Only PDFs (Vision)

Many PDFs are scans with no extractable text layer. `pdf_render_pages` rasterizes pages so a vision-capable client can read them directly.

> "Read this scanned contract"

Render pages inline as images the model can see in a single call (max 5 pages, DPI auto-capped to protect context):

```json
{
  "tool": "pdf_render_pages",
  "filePath": "/path/to/scanned.pdf",
  "inline": true
}
```

Or write image files to disk (default 150 DPI, first 50 pages, PNG):

```json
{
  "tool": "pdf_render_pages",
  "filePath": "/path/to/scanned.pdf",
  "pages": "1-3",
  "dpi": 200,
  "format": "jpeg",
  "outputDir": "/path/to/output"
}
```

## Convert PDF to Markdown

> "Convert report.pdf to Markdown so I can summarize it"

`pdf_to_markdown` reconstructs reading order from text positions — clustering columns, inferring headings from font size, and detecting lists. Best on clean digital PDFs (use `pdf_render_pages` for scans). Returns the first 10 pages by default.

```json
{ "tool": "pdf_to_markdown", "filePath": "/path/to/report.pdf", "pages": "1-5" }
```

## Search & Compare

> "Find every mention of 'indemnification' in contract.pdf"

```json
{
  "tool": "pdf_search",
  "filePath": "/path/to/contract.pdf",
  "query": "indemnification",
  "regex": false,
  "caseSensitive": false
}
```

Returns matches with the page number and a surrounding snippet. Set `regex: true` to treat the query as a JavaScript regular expression.

> "What changed between v1.pdf and v2.pdf?"

```json
{
  "tool": "pdf_compare",
  "filePathA": "/path/to/v1.pdf",
  "filePathB": "/path/to/v2.pdf"
}
```

`pdf_compare` reports a page-by-page text diff (`added`/`removed`) and `identical: true` when the text matches. It compares text only — visual changes that don't alter text are not detected.

## Form-Preserving Merge, Split, Delete & Flatten

Merging, splitting, reordering, and deleting pages **preserve AcroForm fields**. Fields whose names collide across inputs are auto-namespaced per source, and each tool reports `{ preserved, renamed, dropped }`.

> "Merge these three forms and flatten the result"

```json
{
  "tool": "pdf_merge",
  "filePaths": ["/path/a.pdf", "/path/b.pdf", "/path/c.pdf"],
  "outputPath": "/path/merged.pdf",
  "flatten": true
}
```

> "Remove pages 2 and 5 from report.pdf"

```json
{
  "tool": "pdf_delete_pages",
  "filePath": "/path/report.pdf",
  "pages": "2,5",
  "outputPath": "/path/trimmed.pdf"
}
```

Use `pdf_flatten` on its own to bake an existing form's values into static content (the output path must differ from the input).

## Encryption

> "Encrypt report.pdf with password 'secure123'"

Applies **AES-256** encryption. Set separate user (open) and owner (edit) passwords for granular access control; the owner password defaults to the user password.

```json
{
  "tool": "pdf_encrypt",
  "filePath": "/path/report.pdf",
  "outputPath": "/path/report-encrypted.pdf",
  "userPassword": "secure123",
  "ownerPassword": "admin456"
}
```

## QR Codes & Barcodes

> "Add a QR code linking to our website on page 1"

Supported types: QR Code, Code128, DataMatrix, EAN-13, PDF417, Aztec Code. Position and size are fully configurable.

## Guided Prompts

The server ships 5 MCP prompts that script multi-step workflows for the client:

| Prompt              | Arguments                                        | What it does                                                               |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `create-invoice`    | company_name, client_name, invoice_number, items | Parses line items and builds a `pdf_create_from_template` call             |
| `fill-form`         | pdf_path                                         | Discover fields with `pdf_get_form_fields`, then fill with `pdf_fill_form` |
| `read-scanned-pdf`  | pdf_path                                         | Try text extraction, fall back to inline `pdf_render_pages` for vision     |
| `pdf-to-markdown`   | pdf_path                                         | Convert to Markdown, then optionally summarize                             |
| `merge-and-flatten` | pdf_paths, output_path                           | Merge multiple PDFs and flatten the form fields                            |

## Resources

`pdf-toolkit://templates` — a JSON resource listing the templates available to `pdf_create_from_template` and the fields each one accepts.

## Usage Examples

Just ask naturally:

- "Create a PDF from this Markdown report"
- "Generate an invoice for Client Corp — 10 hours consulting at $150/hr"
- "Merge january.pdf and february.pdf into q1-combined.pdf"
- "Extract text from pages 5-10 of thesis.pdf"
- "Convert this PDF to Markdown so I can summarize it"
- "Render this scanned PDF so you can read it"
- "Search contract.pdf for 'termination'"
- "Compare draft-v1.pdf and draft-v2.pdf"
- "Fill the Name field with 'John Doe' in application.pdf"
- "Delete pages 2 and 5 from report.pdf"
- "Add a CONFIDENTIAL watermark to draft.pdf"
- "Encrypt financials.pdf with AES-256 password 'budget2026'"
- "Add page numbers to presentation.pdf"
- "Embed a QR code with our URL on the cover page"
- "Reorder pages as 3,1,2 in report.pdf"

## Errors & Output Semantics

- **Coded errors**: Validation and load failures throw a `PdfError` carrying a stable error code, surfaced to the client as `Error [CODE]: message` (e.g. `Error [FILE_NOT_FOUND]: ...`, `Error [NOT_A_PDF]: ...`, `Error [PAGE_OUT_OF_RANGE]: ...`, `Error [ENCRYPTED_PDF]: ...`, `Error [RESOURCE_LIMIT]: ...`). Clients can branch on the code instead of parsing message text; stack traces are never leaked.
- **Write-tool output semantics**: Write tools produce a new file at `outputPath` and return that path plus the file size as text (MCP has no file content type). Because `outputPath` may name an existing file, a write can overwrite it — yet these tools declare `destructiveHint: false`. The annotation reflects "produces output" semantics (the tool's job is to emit a result file), not a guarantee that no existing file is ever replaced. Choose an `outputPath` that does not collide with a file you want to keep.

## Known Limitations

- **Merge/Split/Reorder/Delete**: Form fields are preserved; colliding field names are auto-namespaced and reported as `renamed`. Exotic forms that can't be safely reconstructed are reported as `dropped` rather than failing the operation.
- **Text extraction**: Returns PDF stream order, not visual reading order. Use `pdf_to_markdown` when reading order matters; raw `pdf_extract_text` may interleave multi-column layouts.
- **Extract text / to Markdown**: Default to the first 10 pages to avoid exceeding LLM context. Request specific pages for longer documents.
- **Markdown to PDF**: Supports CommonMark + GFM (headings, bold/italic, links, lists, tables, fenced code, blockquotes, rules). Raw HTML, GFM task-list checkbox state, footnotes, and code syntax highlighting are not supported.
- **PDF to Markdown**: Best on clean digital PDFs; scanned/image-only or very complex layouts degrade — render those with `pdf_render_pages`.
- **Compare**: Text-only diff; purely visual/layout changes that don't alter text are not detected.
- **Image embedding**: Only JPEG and PNG formats are supported.
- **Form filling**: Non-Latin characters (Arabic, CJK, Devanagari) require providing a custom font file (.ttf/.otf) via `fontPath`.
- **Created-PDF fonts**: Markdown/template PDFs use Helvetica by default (custom TTF via `Font.register`).

## Tech Stack

Multi-engine architecture for maximum capability — all engines are pure WASM/JS with zero native dependencies:

- **@pdfme/pdf-lib** — Existing PDF manipulation (merge, split, rotate, watermark, forms, images, QR codes, flatten)
- **@react-pdf/renderer + remark** — High-fidelity creation (Markdown, templates, tables, code blocks)
- **unpdf** (pdf.js) — Text extraction, metadata, and positional text for reading-order Markdown
- **@hyzyla/pdfium** (WASM) — Page-to-image rendering for vision
- **@neslinesli93/qpdf-wasm** (WASM) — AES-256 encryption
- **@bwip-js/node** — QR codes and barcodes

## Requirements

- Node.js >= 20 (Node 18 and the 20.x line are EOL; Node 22 or 24 LTS recommended)

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run the vitest suite
npm run test:cov     # Run tests with coverage
npm run lint         # Lint with ESLint
npm run format       # Format with Prettier
npm run inspect      # Open MCP Inspector (requires Node >= 22.7.5)
```

See [CLAUDE.md](CLAUDE.md) for architecture details and contribution guidelines.

## License

MIT
