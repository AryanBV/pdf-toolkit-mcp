# PDF Toolkit MCP Server

The first write-capable, zero-config PDF MCP server for Claude, Cursor, VS Code, and Windsurf.

[![npm version](https://img.shields.io/npm/v/@aryanbv/pdf-toolkit-mcp)](https://www.npmjs.com/package/@aryanbv/pdf-toolkit-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

## What It Does

Create, merge, split, fill forms, watermark, rotate, and embed images in PDFs — all through natural language. 10 tools, zero config, works offline. Install with one command.

## Quick Start

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

| Tool | Type | Description |
|------|------|-------------|
| `pdf_extract_text` | Read | Extract text from PDF pages (first 10 by default) |
| `pdf_get_metadata` | Read | Get title, author, page count, and dates |
| `pdf_get_form_fields` | Read | List form fields with names, types, and values |
| `pdf_merge` | Write | Merge multiple PDFs into one |
| `pdf_split` | Write | Extract page ranges into a new PDF |
| `pdf_rotate_pages` | Write | Rotate pages by 90, 180, or 270 degrees |
| `pdf_create` | Write | Create a new PDF from text content |
| `pdf_fill_form` | Write | Fill form fields (text, checkbox, dropdown, radio) |
| `pdf_add_watermark` | Write | Add a text watermark to pages |
| `pdf_embed_image` | Write | Embed a PNG or JPEG image into a page |

## Usage Examples

Just ask naturally:

- "Extract text from my-report.pdf"
- "Merge invoice-jan.pdf and invoice-feb.pdf into combined.pdf"
- "Split pages 1-3 from document.pdf into summary.pdf"
- "What form fields are in application.pdf?"
- "Fill the Name field with 'John Doe' in form.pdf"
- "Add a DRAFT watermark to proposal.pdf"
- "Create a new PDF with this text: [content]"

## Known Limitations

- **Merge/Split**: Form fields are not preserved. Visual content transfers, but interactive fields are lost.
- **Text extraction**: Returns PDF stream order, not visual reading order. Multi-column layouts may interleave.
- **Extract text**: Defaults to first 10 pages. Request specific pages for longer documents.
- **Image embedding**: Only JPEG and PNG formats are supported.
- **Form filling**: Non-Latin characters (Arabic, CJK, etc.) require providing a custom font file (.ttf/.otf).

## Requirements

- Node.js >= 18

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run test         # Run all 30 tests
npm run inspect      # Open MCP Inspector (requires Node >= 22.7.5)
```

See [CLAUDE.md](CLAUDE.md) for architecture details and contribution guidelines.

## License

MIT
