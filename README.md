# PDF Toolkit MCP

A write-capable PDF toolkit for any MCP client. It provides 22 tools for reading, creating, rendering, transforming, and securing PDFs. That includes rendering pages to images so vision models can read scanned documents, building PDFs from Markdown or structured data, AES-256 encryption, and merge and split operations that keep form fields intact. There are no native dependencies, so it runs locally from a single `npx` command.

[![npm version](https://img.shields.io/npm/v/@aryanbv/pdf-toolkit-mcp)](https://www.npmjs.com/package/@aryanbv/pdf-toolkit-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![tools](https://img.shields.io/badge/tools-22-orange)]()
[![tests](https://img.shields.io/badge/tests-160%20passing-success)]()

```bash
npx -y @aryanbv/pdf-toolkit-mcp
```

It needs no config files, API keys, Docker, or compiler, and it works offline.

---

## Overview

Most PDF servers for MCP only read. This one also writes: it creates documents from Markdown or structured data, fills and flattens forms, rearranges page structure, and applies AES-256 encryption, all without a native build toolchain.

A few things worth knowing:

- It reads scans. `pdf_render_pages` rasterizes pages to images, so a vision-capable model can read scanned or image-only PDFs that have no text layer.
- Merge, split, reorder, and delete preserve AcroForm fields rather than dropping them. Names that collide between inputs are namespaced per source, and every call reports what it preserved, renamed, or dropped.
- Encryption is AES-256 through qpdf, not the legacy RC4 scheme.
- Every engine is WASM or plain JavaScript, so `npx` works on Node 20 and later across Windows, macOS, and Linux with no node-gyp, canvas binding, or prebuilt binary.
- Errors carry stable codes, stack traces stay internal, off-page placements are rejected instead of silently clipped, and large responses are truncated without breaking JSON.

---

## Client setup

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

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
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

VS Code uses `"servers"`, not `"mcpServers"`. Copying another client's config will fail silently. This also requires the GitHub Copilot extension with Agent mode.

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

Once connected, ask for what you want in plain language and the client selects the tool and fills in the arguments. The JSON blocks below show the arguments each tool accepts, for reference.

---

## Tools

| Category       | Tool                       | Description                                                                                                                        |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Read**       | `pdf_extract_text`         | Extract text from PDF pages (first 10 by default)                                                                                  |
|                | `pdf_get_metadata`         | Get title, author, subject, page count, dates, producer, and file size                                                             |
|                | `pdf_get_form_fields`      | List form fields (text, checkbox, dropdown, radiogroup, listbox, button, signature) with names, types, values, and required status |
|                | `pdf_to_markdown`          | Convert a PDF to reading-order Markdown (column clustering, heading inference, list detection)                                     |
|                | `pdf_search`               | Find text across pages and return page numbers with surrounding snippets (literal, case-insensitive by default)                    |
|                | `pdf_compare`              | Page-by-page text diff between two PDFs                                                                                            |
| **Manipulate** | `pdf_merge`                | Merge multiple PDFs into one (preserves form fields)                                                                               |
|                | `pdf_split`                | Extract a page range into a new PDF (preserves form fields)                                                                        |
|                | `pdf_delete_pages`         | Delete a page range and keep the rest (preserves form fields)                                                                      |
|                | `pdf_reorder_pages`        | Reorder pages in any order, duplicates allowed (preserves form fields)                                                             |
|                | `pdf_rotate_pages`         | Rotate pages by 90, 180, or 270 degrees                                                                                            |
|                | `pdf_flatten`              | Bake form-field values into static content (removes interactivity)                                                                 |
|                | `pdf_encrypt`              | AES-256 password protection with user and owner passwords                                                                          |
|                | `pdf_add_page_numbers`     | Add page numbers (configurable position, format, start, and size; rotation-aware)                                                  |
|                | `pdf_embed_qr_code`        | Embed a QR code or barcode (QR, Code128, DataMatrix, EAN-13, PDF417, Aztec; rotation-aware)                                        |
| **Create**     | `pdf_create`               | Create a PDF from plain text (page size A4, Letter, or Legal; non-Latin via `fontPath`)                                            |
|                | `pdf_create_from_markdown` | Create a rich PDF from Markdown: headings, tables, lists, code, blockquotes (A4, Letter, or Legal)                                 |
|                | `pdf_create_from_template` | Create a PDF from a named template (invoice, report, letter)                                                                       |
|                | `pdf_fill_form`            | Fill form fields (text, checkbox, dropdown, radiogroup, listbox; non-Latin via `fontPath`)                                         |
|                | `pdf_add_watermark`        | Add a diagonal text watermark to pages                                                                                             |
|                | `pdf_embed_image`          | Embed a PNG or JPEG image into a page                                                                                              |
| **Render**     | `pdf_render_pages`         | Render pages to PNG or JPEG files, or return inline images a vision model can read directly                                        |

---

## Create PDFs from Markdown

Turn Markdown into a multi-page PDF in a single call. It supports CommonMark and GFM: headings, bold and italic, tables, ordered and bullet lists, fenced code, and blockquotes, rendered with `@react-pdf/renderer`.

> _"Create a PDF from this Markdown report."_

`pdf_create_from_markdown` arguments:

```json
{
  "markdown": "# Quarterly Report\n\nRevenue grew **23% YoY**.\n\n| Region | Q1 2025 | Q1 2026 |\n|--------|---------|--------|\n| Americas | $1.2M | $1.5M |\n| EMEA | $800K | $960K |\n\n## Key Wins\n\n1. 12 new enterprise contracts\n2. Churn down to 3.1%",
  "outputPath": "/path/to/report.pdf",
  "pageSize": "Letter"
}
```

Tables size their columns to content and honor alignment, nested lists indent, and long code lines wrap. Add page numbers afterward with `pdf_add_page_numbers`.

## Templates

Generate documents from structured data using the `invoice`, `report`, and `letter` templates.

> _"Create an invoice for Riverbend Outfitters."_

`pdf_create_from_template` arguments:

```json
{
  "templateName": "invoice",
  "data": {
    "companyName": "Northpoint Design",
    "clientName": "Riverbend Outfitters",
    "invoiceNumber": "2026-0042",
    "invoiceDate": "2026-04-01",
    "items": [
      { "description": "Website redesign", "quantity": 40, "unitPrice": 150 },
      { "description": "Annual hosting", "quantity": 1, "unitPrice": 299 }
    ],
    "taxRate": 18,
    "currency": "USD",
    "paymentTerms": "Net 30"
  },
  "outputPath": "/path/to/invoice.pdf"
}
```

The `invoice` template's optional `currency` accepts an ISO code or a symbol. WinAnsi-safe symbols (`$ € £ ¥`) render as glyphs; a code that Helvetica cannot draw, such as `INR`, `KRW`, or `TRY`, falls back to its ISO code label (`INR 20.00`), so any currency works without error. The `pdf-toolkit://templates` resource lists every template and the fields it accepts.

## Read scanned and image-only PDFs (vision)

Many PDFs are scans with no text layer. `pdf_render_pages` rasterizes pages so a vision-capable client can read them.

> _"Read this scanned contract."_

Inline mode returns pages as images the model reads directly (up to 5 pages; DPI is auto-capped to protect the context window):

```json
{ "filePath": "/path/to/scanned.pdf", "inline": true }
```

Or write image files to disk (default 150 DPI, first 50 pages, PNG):

```json
{
  "filePath": "/path/to/scanned.pdf",
  "pages": "1-3",
  "dpi": 200,
  "format": "jpeg",
  "outputDir": "/path/to/output"
}
```

## Convert a PDF to Markdown

> _"Convert report.pdf to Markdown so I can summarize it."_

`pdf_to_markdown` reconstructs reading order from text positions. It clusters up to two content columns (plus full-width title and footer bands), infers headings from font size, and detects lists. It works best on clean digital PDFs; use `pdf_render_pages` for scans. Returns the first 10 pages by default.

```json
{ "filePath": "/path/to/report.pdf", "pages": "1-5" }
```

## Search and compare

> _"Find every mention of 'indemnification' in contract.pdf."_

`pdf_search` arguments:

```json
{
  "filePath": "/path/to/contract.pdf",
  "query": "indemnification",
  "caseSensitive": false
}
```

Each match comes back with its page number and a surrounding snippet. Matching is a literal, case-insensitive substring by default; set `caseSensitive: true` for exact case. Regex search is intentionally left out, because an attacker-supplied pattern can trigger catastrophic backtracking (ReDoS) that single-threaded JavaScript cannot reliably interrupt. Safe regex is planned for a later release.

> _"What changed between v1.pdf and v2.pdf?"_

`pdf_compare` arguments:

```json
{ "filePathA": "/path/to/v1.pdf", "filePathB": "/path/to/v2.pdf" }
```

It reports a page-by-page text diff (`added` and `removed`) and sets `identical: true` when the text matches. The diff is text only, so purely visual changes are not detected.

## Form-preserving merge, split, delete, and flatten

Merging, splitting, reordering, and deleting pages preserve AcroForm fields. Names that collide across inputs are namespaced per source, and each tool returns `{ preserved, renamed, dropped }`, where `renamed` is a list of `{ from, to }` pairs (address a renamed field by its `to` name afterward). These tools and `pdf_flatten` also return a `flattened` boolean.

> _"Merge these three forms and flatten the result."_

`pdf_merge` arguments:

```json
{
  "filePaths": ["/path/a.pdf", "/path/b.pdf", "/path/c.pdf"],
  "outputPath": "/path/merged.pdf",
  "flatten": true
}
```

> _"Remove pages 2 and 5 from report.pdf."_

`pdf_delete_pages` arguments:

```json
{
  "filePath": "/path/report.pdf",
  "pages": "2,5",
  "outputPath": "/path/trimmed.pdf"
}
```

Use `pdf_flatten` on its own to bake an existing form's values into static content. The output path must differ from the input.

## Encryption

> _"Encrypt report.pdf with the password 'secure123'."_

Encryption is AES-256. Set separate user (open) and owner (edit) passwords for granular access; the owner password defaults to the user password when omitted.

`pdf_encrypt` arguments:

```json
{
  "filePath": "/path/report.pdf",
  "outputPath": "/path/report-encrypted.pdf",
  "userPassword": "secure123",
  "ownerPassword": "admin456"
}
```

## QR codes and barcodes

> _"Add a QR code linking to our website on page 1."_

`pdf_embed_qr_code` supports QR Code, Code128, DataMatrix, EAN-13, PDF417, and Aztec. Position and size are configurable, the symbology's aspect ratio is preserved, placement is rotation-aware, and off-page placements are rejected instead of clipped.

---

## Guided prompts

The server ships five MCP prompts that script multi-step workflows for the client:

| Prompt              | Arguments                                                                                                                                            | What it does                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `create-invoice`    | company_name, client_name, invoice_number, items (plus optional currency, tax_rate, due_date, company_address, client_address, payment_terms, notes) | Parses line items and builds a `pdf_create_from_template` call             |
| `fill-form`         | pdf_path                                                                                                                                             | Discover fields with `pdf_get_form_fields`, then fill with `pdf_fill_form` |
| `read-scanned-pdf`  | pdf_path                                                                                                                                             | Try text extraction, fall back to inline `pdf_render_pages` for vision     |
| `pdf-to-markdown`   | pdf_path                                                                                                                                             | Convert to Markdown, then optionally summarize                             |
| `merge-and-flatten` | pdf_paths, output_path                                                                                                                               | Merge multiple PDFs and flatten the form fields                            |

## Resources

`pdf-toolkit://templates` is a JSON resource that lists the templates available to `pdf_create_from_template` and the fields each one accepts.

## Try it in plain language

- "Create a PDF from this Markdown report"
- "Generate an invoice for Riverbend Outfitters, 10 hours of consulting at $150/hr"
- "Merge january.pdf and february.pdf into q1-combined.pdf"
- "Convert this PDF to Markdown so I can summarize it"
- "Render this scanned PDF so you can read it"
- "Search contract.pdf for 'termination'"
- "Compare draft-v1.pdf and draft-v2.pdf"
- "Fill the Name field with 'John Doe' in application.pdf"
- "Add a CONFIDENTIAL watermark to draft.pdf"
- "Encrypt financials.pdf with the AES-256 password 'budget2026'"
- "Embed a QR code with our URL on the cover page"
- "Reorder pages as 3,1,2 in report.pdf"

---

## Errors and output semantics

- **Coded errors.** Validation and load failures throw a `PdfError` with a stable code, surfaced as `Error [CODE]: message` (for example `FILE_NOT_FOUND`, `NOT_A_PDF`, `PAGE_OUT_OF_RANGE`, `ENCRYPTED_PDF`, `RESOURCE_LIMIT`). Clients can branch on the code instead of parsing message text, and stack traces are never leaked.
- **Write-tool output.** Write tools create a file at `outputPath` and return that path plus its size as text, since MCP has no file-content type. `outputPath` can name an existing file and will overwrite it, so choose a path that does not collide with something you want to keep.
- **JSON-safe truncation.** Responses are capped at 25,000 characters. Object payloads return a valid `{ truncated, note, preview }` envelope rather than a string cut mid-token, so a client's `JSON.parse` never breaks.

## Known limitations

- **Merge, split, reorder, delete.** Form fields are preserved, and colliding names are namespaced and reported in `renamed` as `{ from, to }` pairs. Unusual forms that cannot be safely reconstructed are reported under `dropped` rather than failing the operation.
- **Text extraction.** Returns PDF stream order, not visual reading order. Use `pdf_to_markdown` when reading order matters; raw `pdf_extract_text` can interleave multi-column layouts.
- **PDF to Markdown.** Reconstructs up to two content columns (plus full-width title and footer bands); pages with three or more columns fall back to single-column reading order. It works best on clean digital PDFs. Tabular content is emitted as positioned text in reading order, not rebuilt as Markdown tables.
- **Markdown to PDF.** Supports CommonMark and GFM (headings, bold and italic, links, lists, tables, fenced code, blockquotes, and horizontal rules). Raw HTML, task-list checkbox state, footnotes, and code syntax highlighting are not supported.
- **Compare.** Text-only diff; visual or layout changes that do not alter text are not detected.
- **Image embedding.** JPEG and PNG only. Off-page placements are rejected with a coded error instead of being silently clipped.
- **Fonts.** Built-in fonts are Latin-only (WinAnsi). For non-Latin scripts such as Arabic, CJK, or Devanagari, pass a `.ttf` or `.otf` file through `fontPath` to `pdf_fill_form` or `pdf_create`. Markdown and template PDFs use Helvetica by default.

## Tech stack

A multi-engine design. Every engine is pure WASM or JavaScript:

| Engine                               | Role                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| **@pdfme/pdf-lib**                   | Manipulating existing PDFs: merge, split, rotate, watermark, forms, images, QR, flatten |
| **@react-pdf/renderer** + **remark** | Creating PDFs from Markdown and templates, including tables and code blocks             |
| **unpdf** (pdf.js)                   | Text extraction, metadata, and positional text for reading-order Markdown               |
| **@hyzyla/pdfium** (WASM)            | Rendering pages to images for vision                                                    |
| **@neslinesli93/qpdf-wasm** (WASM)   | AES-256 encryption                                                                      |
| **@bwip-js/node**                    | QR codes and barcodes                                                                   |

## Requirements

- Node.js 20 or later. Node 18 and the 20.x line are end-of-life, so Node 22 or 24 LTS is recommended.

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript
npm test           # run the vitest suite (160 tests)
npm run test:cov   # tests with coverage
npm run lint       # ESLint
npm run format     # Prettier
npm run inspect    # MCP Inspector (requires Node >= 22.7.5)
```

See [CLAUDE.md](CLAUDE.md) for architecture and contribution notes.

## License

[MIT](LICENSE)
