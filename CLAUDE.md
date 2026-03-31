# pdf-toolkit-mcp

## 1. Project Overview

**What**: The first write-capable, zero-config, TypeScript-native MCP server for PDF manipulation. Provides 10 tools for reading, modifying, and creating PDFs — usable from any MCP client (Claude Code, Claude Desktop, etc.) with zero installation beyond `npx`.

**Why**: Learning MCP server development, building open-source credibility, and laying groundwork for Prevyl.

- **Package**: `@aryanbv/pdf-toolkit-mcp`
- **Install**: `npx -y @aryanbv/pdf-toolkit-mcp`
- **License**: MIT
- **Repo**: github.com/AryanBV/pdf-toolkit-mcp

## 2. Tech Stack

| Dependency | Version | Why |
|---|---|---|
| TypeScript | strict, ESM (`"type": "module"`) | Type safety, all `.ts` imports use `.js` extension (Node16 resolution) |
| Node.js | >= 18 | Minimum LTS with stable ESM support |
| `@modelcontextprotocol/sdk` | ^1.28.0 | MCP protocol implementation. Use `server.registerTool()` — NOT `.tool()` (deprecated) |
| `@pdfme/pdf-lib` | ^5.5.10 | Fork of abandoned `pdf-lib`. Active maintenance, same API surface |
| `unpdf` | ^1.4.0 | Text extraction. Replaces `pdfjs-dist` which requires Node 22+ canvas bindings |
| `fontkit` | ^2.0.0 | Non-Latin font embedding for form filling. Use `import fontkit from 'fontkit'` — NOT `@pdf-lib/fontkit` (stale wrapper) |
| `zod` | ^3.25.0 | Schema validation for tool inputs. Compatible with MCP SDK's `^3.25 \|\| ^4.0` range |
| Transport | stdio | stdin/stdout protocol channel — console.log is forbidden |

## 3. Project Structure

```
pdf-toolkit-mcp/
├── src/
│   ├── index.ts            # Entry point — shebang (#!/usr/bin/env node), MCP server init, tool registration
│   ├── types.ts            # Shared TypeScript types and interfaces
│   ├── constants.ts        # Shared config: CHARACTER_LIMIT, DEFAULT_EXTRACT_PAGES, MAX_FILE_SIZE_MB, etc.
│   ├── tools/
│   │   ├── read.ts         # Read-only tools: pdf_extract_text, pdf_get_metadata, pdf_count_pages
│   │   ├── manipulate.ts   # Mutation tools: pdf_merge, pdf_split, pdf_rotate_pages, pdf_add_watermark
│   │   └── create.ts       # Creation tools: pdf_create, pdf_fill_form, pdf_embed_image
│   ├── services/
│   │   ├── pdf-reader.ts   # PDF reading service — text extraction, metadata, page counting via unpdf
│   │   └── pdf-writer.ts   # PDF writing service — merge, split, create, form fill, watermark via @pdfme/pdf-lib
│   └── utils/
│       ├── validation.ts   # Input validation — file paths, page ranges, file size checks
│       └── errors.ts       # Error handling — MCP error responses, PDF-specific error types
├── dist/                   # Build output (gitignored)
├── package.json
├── tsconfig.json
├── .npmignore
├── CLAUDE.md               # This file — project context for Claude Code
├── LICENSE                  # MIT
└── README.md
```

## 4. MCP SDK Patterns

### Tool Registration (use this pattern for every tool)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

const server = new McpServer({
  name: "pdf-toolkit-mcp",
  version: "0.1.0",
});

server.registerTool(
  "pdf_extract_text",
  {
    description: "Extract text content from a PDF file. Returns first 10 pages by default to avoid exceeding LLM context limits.",
    inputSchema: z.object({
      filePath: z.string().describe("Absolute path to the PDF file"),
      pages: z.string().optional().describe("Page range, e.g. '1-5' or '1,3,5'. Defaults to first 10 pages."),
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, pages }) => {
    // Implementation here
    return {
      content: [{ type: "text", text: "extracted text..." }],
    };
  }
);
```

### Error Response Pattern

```typescript
return {
  isError: true,
  content: [{ type: "text", text: `Error: ${error.message}` }],
};
```

### Server Startup

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const transport = new StdioServerTransport();
await server.connect(transport);
```

## 5. Critical Rules

Every rule has a reason. Do not remove or weaken any of these.

1. **NEVER `console.log()`** — stdout is the MCP stdio transport channel. Any stray output corrupts the protocol and crashes the client.

2. **ALWAYS `new Uint8Array(await readFile(path))`** — Buffer subclass breaks unpdf internals. Always convert to a plain Uint8Array before passing to unpdf.

3. **ALWAYS accept absolute paths** — Rejecting absolute paths is the #1 usability bug in every PDF MCP server. All tools must accept absolute file paths without restriction.

4. **ALWAYS `.strict()` on Zod schemas** — Rejects unexpected parameters from LLMs. Without `.strict()`, LLMs can hallucinate extra fields that silently pass validation.

5. **NEVER use `outputSchema`** — Claude Code silently drops tools that include `outputSchema` in their registration. Tools become invisible.

6. **Write tools return file path as text** — MCP has no `FileContent` type. Return the output file path as a text content block so the LLM knows where to find the result.

7. **`extract_text` defaults to first 10 pages** — Large PDFs can produce megabytes of text that exceed LLM context windows. Default to `DEFAULT_EXTRACT_PAGES` (10) and let users override.

8. **`merge`/`split` must warn about form field stripping** — `copyPages()` silently drops AcroForm fields. Tool descriptions and responses must mention this limitation.

9. **Check `CHARACTER_LIMIT` (25,000) on all responses** — Truncate with an actionable message: "Output truncated at 25,000 chars. Use page ranges to extract smaller sections."

10. **Tool descriptions under 200 tokens** — Include only 1-2 critical behaviors. Long descriptions waste LLM context and reduce tool selection accuracy.

11. **All `.ts` imports use `.js` extension** — Required by ESM with Node16 module resolution. `import { foo } from "./bar.js"` even though the source file is `bar.ts`.

12. **All tool names: `pdf_` prefix, snake_case** — Consistent naming convention across all 10 tools. Examples: `pdf_extract_text`, `pdf_merge`, `pdf_fill_form`.

13. **Every tool declares annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. These enable MCP clients to make informed decisions about auto-approval and confirmation prompts.

14. **`@pdfme/pdf-lib` ESM Import Pattern** — The package's `exports` field maps `import.node` to a CJS build, so Node.js cannot resolve named ESM imports at runtime. Use this dual-import pattern:

```typescript
import type { PDFDocument } from "@pdfme/pdf-lib";  // compile-time types only
import pdfLib from "@pdfme/pdf-lib";                 // runtime default import

// Access static methods via the default import:
pdfLib.PDFDocument.load(data)   // not PDFDocument.load()
pdfLib.PDFDocument.create()     // not PDFDocument.create()

// Use the type import for annotations:
function example(pdfDoc: PDFDocument): void {}
```

See `src/services/pdf-writer.ts` for the canonical example. All files that import from `@pdfme/pdf-lib` must follow this pattern.

## 6. Tools Reference

| Tool | File | Library | Type | Description |
|---|---|---|---|---|
| `pdf_extract_text` | `tools/read.ts` | unpdf | Read | Extract text from PDF pages (default: first 10) |
| `pdf_get_metadata` | `tools/read.ts` | unpdf | Read | Get document title, author, page count, creation date |
| `pdf_count_pages` | `tools/read.ts` | unpdf | Read | Return total page count |
| `pdf_merge` | `tools/manipulate.ts` | @pdfme/pdf-lib | Write | Merge multiple PDFs into one (warns: strips form fields) |
| `pdf_split` | `tools/manipulate.ts` | @pdfme/pdf-lib | Write | Split PDF by page ranges (warns: strips form fields) |
| `pdf_rotate_pages` | `tools/manipulate.ts` | @pdfme/pdf-lib | Write | Rotate specified pages by 90/180/270 degrees |
| `pdf_add_watermark` | `tools/manipulate.ts` | @pdfme/pdf-lib | Write | Add text watermark to all or specified pages |
| `pdf_create` | `tools/create.ts` | @pdfme/pdf-lib | Write | Create new PDF from text content |
| `pdf_fill_form` | `tools/create.ts` | @pdfme/pdf-lib + fontkit | Write | Fill PDF form fields (supports non-Latin via fontkit) |
| `pdf_embed_image` | `tools/create.ts` | @pdfme/pdf-lib | Write | Embed PNG/JPEG image into a PDF page |

**Deferred to v0.2.0:**
- `pdf_encrypt` — pdf-lib lacks native encryption; would need an external library (e.g., `node-qpdf`), adding a system dependency that breaks zero-config.
- `pdf_compress` — pdf-lib's `save()` does only minimal compression. Meaningful compression requires `qpdf` or `ghostscript`, which are system-level binaries.

## 7. Known Limitations

These are inherent to the underlying libraries and cannot be worked around without switching libraries.

1. **`copyPages()` strips AcroForm fields** — Merging or splitting PDFs that contain form fields will silently drop those fields. This is a pdf-lib limitation. Tools must warn users in the response.

2. **`setRotation()` doesn't transform coordinate system** — Rotating a page only changes the display rotation flag; it doesn't actually transform the content stream coordinates. Existing content may appear offset after rotation.

3. **Image embedding supports JPEG/PNG only** — `@pdfme/pdf-lib` can embed JPEG and PNG images. Other formats (WebP, GIF, TIFF, SVG) must be converted externally before embedding.

4. **Standard fonts are WinAnsi-only (Latin)** — pdf-lib's built-in standard fonts (Helvetica, Times Roman, etc.) only support WinAnsi encoding (basic Latin characters). Non-Latin scripts (Arabic, CJK, Devanagari, etc.) require fontkit with a `.ttf`/`.otf` font file.

5. **`save()` does minimal compression** — pdf-lib's PDF serialization does not apply advanced compression (object streams, cross-reference compression). Output files may be larger than input. Meaningful compression requires external tools.

6. **Text extraction returns PDF stream order, not visual reading order** — `unpdf` extracts text in the order it appears in the PDF content stream, which may differ from the visual left-to-right, top-to-bottom reading order. Multi-column layouts and complex formatting may produce jumbled output.

## 8. Build & Test Commands

```bash
npm run build     # Compile TypeScript → dist/
npm run dev       # Watch mode — recompile on file changes
npm start         # Run the MCP server (stdio transport)
npm run inspect   # Open MCP Inspector for interactive testing
```

**Note**: MCP Inspector (`@modelcontextprotocol/inspector`) requires Node >= 22.7.5 to run. The server itself works on Node >= 18.
