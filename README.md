# PDF Toolkit MCP

**A write-capable, zero-config PDF toolkit for any MCP client.** 22 tools to read, create, render, transform, and secure PDFs — including page-to-image rendering so vision models can read scanned documents, high-fidelity Markdown→PDF, AES-256 encryption, and form-preserving merge/split. Pure WebAssembly/JavaScript, **zero native dependencies**, runs fully local from a single `npx`.

[![npm version](https://img.shields.io/npm/v/@aryanbv/pdf-toolkit-mcp)](https://www.npmjs.com/package/@aryanbv/pdf-toolkit-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![tools](https://img.shields.io/badge/tools-22-orange)]()
[![tests](https://img.shields.io/badge/tests-160%20passing-success)]()

```bash
npx -y @aryanbv/pdf-toolkit-mcp
```

No config files, no API keys, no Docker, no compiler. Works offline.

---

## Why this one

Most PDF MCP servers only **read**. This one **writes** — and does it without dragging in native build tools.

- ✍️ **Write-capable** — create, fill, merge, split, encrypt, watermark, stamp, and flatten PDFs, not just extract text.
- 👁️ **Vision-ready** — `pdf_render_pages` rasterizes pages to images so a vision model can read **scanned / image-only** PDFs that have no text layer.
- 📝 **High-fidelity creation** — turn Markdown (CommonMark + GFM) or structured data into polished, multi-page PDFs with headings, tables, lists, and code.
- 🔒 **Real security** — AES-256 password protection via qpdf, not legacy RC4.
- 🧩 **Form-preserving** — merge / split / reorder / delete keep AcroForm fields intact, auto-namespacing collisions and reporting exactly what was preserved, renamed, or dropped.
- 📦 **Zero native deps** — every engine is pure WASM or JS. `npx` just works on Node ≥ 20 across Windows/macOS/Linux, no node-gyp, no canvas, no prebuilt binaries.
- 🛡️ **Honest & safe** — stable error codes, no leaked stack traces, off-page placements rejected (not silently clipped), and output truncation that never corrupts JSON.

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

> **VS Code uses `"servers"`, not `"mcpServers"`** — copying another client's config will silently fail. Requires the GitHub Copilot extension with Agent mode.

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

Once connected, just ask in plain language — the client picks the right tool and fills in the arguments. The JSON blocks below show the **arguments** each tool receives, for reference.

---

## Tools

| Category       | Tool                       | Description                                                                                                                        |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Read**       | `pdf_extract_text`         | Extract text from PDF pages (first 10 by default)                                                                                  |
|                | `pdf_get_metadata`         | Get title, author, subject, page count, dates, producer, file size                                                                 |
|                | `pdf_get_form_fields`      | List form fields (text, checkbox, dropdown, radiogroup, listbox, button, signature) with names, types, values, and required status |
|                | `pdf_to_markdown`          | Convert a PDF to reading-order Markdown (column clustering, heading inference, list detection)                                     |
|                | `pdf_search`               | Find text across pages; returns page numbers + surrounding snippets (literal, case-insensitive by default)                         |
|                | `pdf_compare`              | Page-by-page text diff between two PDFs                                                                                            |
| **Manipulate** | `pdf_merge`                | Merge multiple PDFs into one (preserves form fields)                                                                               |
|                | `pdf_split`                | Extract a page range into a new PDF (preserves form fields)                                                                        |
|                | `pdf_delete_pages`         | Delete a page range, keep the rest (preserves form fields)                                                                         |
|                | `pdf_reorder_pages`        | Reorder pages in any order — duplicates allowed (preserves form fields)                                                            |
|                | `pdf_rotate_pages`         | Rotate pages by 90, 180, or 270 degrees                                                                                            |
|                | `pdf_flatten`              | Bake form-field values into static content (remove interactivity)                                                                  |
|                | `pdf_encrypt`              | AES-256 password protection with user/owner passwords                                                                              |
| **Create**     | `pdf_create`               | Create a PDF from plain text (page size A4/Letter/Legal; non-Latin via `fontPath`)                                                 |
|                | `pdf_create_from_markdown` | Create a rich PDF from Markdown — headings, tables, lists, code, blockquotes (A4/Letter/Legal)                                     |
|                | `pdf_create_from_template` | Create a PDF from a named template (invoice, report, letter)                                                                       |
|                | `pdf_fill_form`            | Fill form fields (text, checkbox, dropdown, radiogroup, listbox; non-Latin via `fontPath`)                                         |
|                | `pdf_add_watermark`        | Add a diagonal text watermark to pages                                                                                             |
|                | `pdf_add_page_numbers`     | Add page numbers (configurable position, format, start, size; rotation-aware)                                                      |
|                | `pdf_embed_image`          | Embed a PNG or JPEG image into a page                                                                                              |
|                | `pdf_embed_qr_code`        | Embed a QR code or barcode — QR, Code128, DataMatrix, EAN-13, PDF417, Aztec (rotation-aware)                                       |
| **Render**     | `pdf_render_pages`         | Render pages to PNG/JPEG files, or inline images a vision model can read directly                                                  |

---

## Create PDFs from Markdown

The flagship: turn Markdown into a professional, multi-page PDF in one call (CommonMark + GFM — headings, **bold**/_italic_, tables, ordered/bullet lists, fenced code, blockquotes), rendered with `@react-pdf/renderer`.

> _"Create a PDF from this Markdown report."_

`pdf_create_from_markdown` arguments:

```json
{
  "markdown": "# Quarterly Report\n\nRevenue grew **23% YoY**.\n\n| Region | Q1 2025 | Q1 2026 |\n|--------|---------|--------|\n| Americas | $1.2M | $1.5M |\n| EMEA | $800K | $960K |\n\n## Key Wins\n\n1. 12 new enterprise contracts\n2. Churn down to 3.1%",
  "outputPath": "/path/to/report.pdf",
  "pageSize": "Letter"
}
```

Tables auto-size their columns and honor alignment, nested lists indent, and long code lines wrap. Add page numbers afterward with `pdf_add_page_numbers`.

## Templates

Generate polished documents from structured data — `invoice`, `report`, and `letter`.

> _"Create an invoice for Acme Corp."_

`pdf_create_from_template` arguments:

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
    "currency": "USD",
    "paymentTerms": "Net 30"
  },
  "outputPath": "/path/to/invoice.pdf"
}
```

The `invoice` template's optional `currency` accepts an ISO code or a symbol. WinAnsi-safe symbols (`$ € £ ¥`) render directly; one that Helvetica can't draw (e.g. `INR`, `₹`, `KRW`, `TRY`) safely renders as its ISO code (`INR 20.00`), so any currency works without error. The `pdf-toolkit://templates` resource lists each template and its accepted fields.

## Read scanned & image-only PDFs (vision)

Many PDFs are scans with no text layer. `pdf_render_pages` rasterizes pages so a vision-capable client can read them.

> _"Read this scanned contract."_

Inline — return pages as images the model sees directly (max 5 pages; DPI auto-capped to protect context):

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

## Convert PDF to Markdown

> _"Convert report.pdf to Markdown so I can summarize it."_

`pdf_to_markdown` reconstructs reading order from text positions — clustering up to 2 content columns (plus full-width title/footer bands), inferring headings from font size, and detecting lists. Best on clean digital PDFs; use `pdf_render_pages` for scans. Returns the first 10 pages by default.

```json
{ "filePath": "/path/to/report.pdf", "pages": "1-5" }
```

## Search & compare

> _"Find every mention of 'indemnification' in contract.pdf."_

`pdf_search` arguments:

```json
{
  "filePath": "/path/to/contract.pdf",
  "query": "indemnification",
  "caseSensitive": false
}
```

Returns each match with its page number and a surrounding snippet. Matching is a literal, case-insensitive substring by default (set `caseSensitive: true` for exact case). Regex search is intentionally omitted — an attacker-supplied pattern can trigger catastrophic backtracking (ReDoS) that can't be interrupted in single-threaded JavaScript; safe regex is planned for a later release.

> _"What changed between v1.pdf and v2.pdf?"_

`pdf_compare` arguments:

```json
{ "filePathA": "/path/to/v1.pdf", "filePathB": "/path/to/v2.pdf" }
```

Reports a page-by-page text diff (`added` / `removed`) and `identical: true` when text matches. It compares text only — purely visual changes are not detected.

## Form-preserving merge, split, delete & flatten

Merging, splitting, reordering, and deleting pages **preserve AcroForm fields**. Fields whose names collide across inputs are auto-namespaced per source, and each tool returns `{ preserved, renamed, dropped }` — where `renamed` is an array of `{ from, to }` pairs (address a renamed field by its `to` name afterward). These tools and `pdf_flatten` also return a `flattened` boolean.

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

Use `pdf_flatten` on its own to bake an existing form's values into static content (the output path must differ from the input).

## Encryption

> _"Encrypt report.pdf with password 'secure123'."_

Applies **AES-256**. Set separate user (open) and owner (edit) passwords for granular access; the owner password defaults to the user password.

`pdf_encrypt` arguments:

```json
{
  "filePath": "/path/report.pdf",
  "outputPath": "/path/report-encrypted.pdf",
  "userPassword": "secure123",
  "ownerPassword": "admin456"
}
```

## QR codes & barcodes

> _"Add a QR code linking to our website on page 1."_

`pdf_embed_qr_code` supports QR Code, Code128, DataMatrix, EAN-13, PDF417, and Aztec. Position and size are configurable, the symbology's aspect ratio is preserved, placement is rotation-aware, and off-page placements are rejected rather than clipped.

---

## Guided prompts

The server ships 5 MCP prompts that script multi-step workflows for the client:

| Prompt              | Arguments                                                                                                                                         | What it does                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `create-invoice`    | company_name, client_name, invoice_number, items (+ optional currency, tax_rate, due_date, company_address, client_address, payment_terms, notes) | Parses line items and builds a `pdf_create_from_template` call             |
| `fill-form`         | pdf_path                                                                                                                                          | Discover fields with `pdf_get_form_fields`, then fill with `pdf_fill_form` |
| `read-scanned-pdf`  | pdf_path                                                                                                                                          | Try text extraction, fall back to inline `pdf_render_pages` for vision     |
| `pdf-to-markdown`   | pdf_path                                                                                                                                          | Convert to Markdown, then optionally summarize                             |
| `merge-and-flatten` | pdf_paths, output_path                                                                                                                            | Merge multiple PDFs and flatten the form fields                            |

## Resources

`pdf-toolkit://templates` — a JSON resource listing the templates available to `pdf_create_from_template` and the fields each one accepts.

## Try it in plain language

- "Create a PDF from this Markdown report"
- "Generate an invoice for Client Corp — 10 hours consulting at $150/hr"
- "Merge january.pdf and february.pdf into q1-combined.pdf"
- "Convert this PDF to Markdown so I can summarize it"
- "Render this scanned PDF so you can read it"
- "Search contract.pdf for 'termination'"
- "Compare draft-v1.pdf and draft-v2.pdf"
- "Fill the Name field with 'John Doe' in application.pdf"
- "Add a CONFIDENTIAL watermark to draft.pdf"
- "Encrypt financials.pdf with AES-256 password 'budget2026'"
- "Embed a QR code with our URL on the cover page"
- "Reorder pages as 3,1,2 in report.pdf"

---

## Errors & output semantics

- **Coded errors** — validation and load failures throw a `PdfError` with a stable code, surfaced as `Error [CODE]: message` (e.g. `FILE_NOT_FOUND`, `NOT_A_PDF`, `PAGE_OUT_OF_RANGE`, `ENCRYPTED_PDF`, `RESOURCE_LIMIT`). Clients can branch on the code instead of parsing text; stack traces are never leaked.
- **Write-tool output** — write tools produce a file at `outputPath` and return that path plus its size as text (MCP has no file-content type). `outputPath` may name an existing file, so a write can overwrite it; choose a path that doesn't collide with something you want to keep.
- **Truncation is JSON-safe** — large responses are capped at 25,000 characters; object payloads return a valid `{ truncated, note, preview }` envelope rather than a string sliced mid-token, so a client's `JSON.parse` never breaks.

## Known limitations

- **Merge / split / reorder / delete** — form fields are preserved; colliding names are auto-namespaced and reported in `renamed` as `{ from, to }` pairs. Exotic forms that can't be safely reconstructed are reported as `dropped` rather than failing the operation.
- **Text extraction** — returns PDF stream order, not visual reading order. Use `pdf_to_markdown` when reading order matters; raw `pdf_extract_text` may interleave multi-column layouts.
- **PDF → Markdown** — reconstructs up to 2 content columns (plus full-width title/footer bands); pages with 3+ columns fall back to single-column reading order. Best on clean digital PDFs; tabular content is emitted as positioned text in reading order, not rebuilt as Markdown tables.
- **Markdown → PDF** — CommonMark + GFM (headings, bold/italic, links, lists, tables, fenced code, blockquotes, rules). Raw HTML, task-list checkbox state, footnotes, and code syntax highlighting are not supported.
- **Compare** — text-only diff; purely visual/layout changes that don't alter text are not detected.
- **Image embedding** — JPEG and PNG only. Off-page placements are rejected with a coded error rather than silently clipped.
- **Fonts** — built-in fonts are Latin-only (WinAnsi). For non-Latin scripts (Arabic, CJK, Devanagari, …) pass a `.ttf`/`.otf` via `fontPath` to `pdf_fill_form` or `pdf_create`. Created Markdown/template PDFs use Helvetica by default.

## Tech stack

A multi-engine architecture — every engine is pure WASM or JS, **zero native dependencies**:

| Engine                               | Role                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| **@pdfme/pdf-lib**                   | Manipulate existing PDFs — merge, split, rotate, watermark, forms, images, QR, flatten |
| **@react-pdf/renderer** + **remark** | High-fidelity creation — Markdown, templates, tables, code blocks                      |
| **unpdf** (pdf.js)                   | Text extraction, metadata, and positional text for reading-order Markdown              |
| **@hyzyla/pdfium** (WASM)            | Page-to-image rendering for vision                                                     |
| **@neslinesli93/qpdf-wasm** (WASM)   | AES-256 encryption                                                                     |
| **@bwip-js/node**                    | QR codes and barcodes                                                                  |

## Requirements

- Node.js **≥ 20** (Node 18 and the 20.x line are EOL; Node 22 or 24 LTS recommended).

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

See [CLAUDE.md](CLAUDE.md) for architecture and contribution details.

## License

[MIT](LICENSE)
