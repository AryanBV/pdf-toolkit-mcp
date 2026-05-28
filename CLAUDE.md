# pdf-toolkit-mcp

## 1. Project Overview

**What**: A write-capable, zero-config, TypeScript-native MCP server for PDF manipulation. Provides 22 tools for reading, modifying, creating, and rendering PDFs — including page-to-image rendering for vision-capable clients, high-fidelity Markdown→PDF, AES-256 encryption, and form-preserving merge/split — usable from any MCP client (Claude Code, Claude Desktop, etc.) with zero installation beyond `npx`. Ships 5 guided-workflow prompts and a templates resource.

**Why**: Learning MCP server development, building open-source credibility, and laying groundwork for Prevyl.

- **Package**: `@aryanbv/pdf-toolkit-mcp`
- **Install**: `npx -y @aryanbv/pdf-toolkit-mcp`
- **License**: MIT
- **Repo**: github.com/AryanBV/pdf-toolkit-mcp

## 2. Tech Stack

Multi-engine architecture: **@pdfme/pdf-lib** manipulates existing PDFs + **@react-pdf/renderer** driven by **remark/mdast** handles rich creation (Markdown, templates) + **unpdf** (pdf.js) reads text/metadata and positional text + **@hyzyla/pdfium** (WASM) renders pages to images + **@neslinesli93/qpdf-wasm** (WASM) does AES-256 encryption.

| Dependency                                | Version                          | Why                                                                                                                                         |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                | strict, ESM (`"type": "module"`) | Type safety, all `.ts` imports use `.js` extension (Node16 resolution)                                                                      |
| Node.js                                   | >= 20                            | Conservative non-breaking floor (18 and 20.x are EOL); CI tests 20/22/24, 22 or 24 LTS recommended                                          |
| `@modelcontextprotocol/sdk`               | ^1.29.0                          | MCP protocol implementation. Use `server.registerTool()` — NOT `.tool()` (deprecated)                                                       |
| `@pdfme/pdf-lib`                          | ^5.5.10                          | Fork of abandoned `pdf-lib`. Existing PDF manipulation (merge, split, rotate, watermark, embed, page numbers, reorder, delete, flatten, QR) |
| `unpdf`                                   | ^1.4.0                           | Text extraction, metadata, and positional text (pdf.js). Replaces `pdfjs-dist` which requires Node 22+ canvas bindings                      |
| `@react-pdf/renderer`                     | ^4.5.1                           | High-fidelity PDF creation for Markdown and templates (Helvetica default; custom TTF via `Font.register`). Lazy-loaded inside handlers      |
| `react`                                   | ^19.2.6                          | Peer of `@react-pdf/renderer`; document trees are built with `React.createElement`                                                          |
| `unified` + `remark-parse` + `remark-gfm` | ^11 / ^11 / ^4                   | Markdown → mdast AST (CommonMark + GFM tables/strikethrough) consumed by the react-pdf renderer                                             |
| `mdast-util-to-markdown`                  | ^2.1.2                           | Serializes reconstructed layout nodes back to Markdown for `pdf_to_markdown`                                                                |
| `@hyzyla/pdfium`                          | ^2.1.13                          | PDFium compiled to WASM — renders PDF pages to raster bitmaps for `pdf_render_pages`. Zero native deps. Lazy-loaded                         |
| `@neslinesli93/qpdf-wasm`                 | ^0.3.0                           | qpdf compiled to WASM — AES-256 encryption for `pdf_encrypt`. Zero native deps. Lazy-loaded                                                 |
| `pngjs` + `jpeg-js`                       | ^7.0.0 / ^0.4.4                  | Encode PDFium raster bitmaps to PNG / JPEG buffers                                                                                          |
| `diff`                                    | ^9.0.0                           | Line-level text diff for `pdf_compare`                                                                                                      |
| `@bwip-js/node`                           | ^4.8.0                           | Barcode/QR code generation as PNG buffers. ESM — `import { toBuffer } from '@bwip-js/node'`                                                 |
| `fontkit`                                 | ^2.0.0                           | Non-Latin font embedding for form filling. Use `import fontkit from 'fontkit'` — NOT `@pdf-lib/fontkit` (stale wrapper)                     |
| `zod`                                     | ^3.25.0                          | Schema validation for tool inputs. Compatible with MCP SDK's `^3.25 \|\| ^4.0` range                                                        |
| Transport                                 | stdio                            | stdin/stdout protocol channel — console.log is forbidden                                                                                    |

## 3. Project Structure

```
pdf-toolkit-mcp/
├── src/
│   ├── index.ts                  # Entry point — shebang (#!/usr/bin/env node), MCP server init, tool/prompt/resource registration
│   ├── types.ts                  # Shared TypeScript types and interfaces
│   ├── constants.ts              # Shared config: CHARACTER_LIMIT, DEFAULT_EXTRACT_PAGES, MAX_FILE_SIZE_MB, render/inline DPI + page caps, MAX_SEARCH_RESULTS, etc.
│   ├── tools/
│   │   ├── read.ts               # Read tools: pdf_extract_text, pdf_get_metadata, pdf_get_form_fields, pdf_to_markdown, pdf_search
│   │   ├── manipulate.ts         # Mutation tools: pdf_merge, pdf_split, pdf_rotate_pages, pdf_encrypt, pdf_compare, pdf_add_page_numbers, pdf_embed_qr_code, pdf_reorder_pages, pdf_delete_pages
│   │   ├── create.ts             # Creation tools: pdf_create, pdf_fill_form, pdf_add_watermark, pdf_embed_image, pdf_create_from_markdown, pdf_create_from_template, pdf_flatten
│   │   ├── render.ts             # pdf_render_pages — page→image rendering (file output or inline image blocks)
│   │   └── markdown-from-layout.ts # Positional-text layout → reading-order Markdown (column clustering, heading inference) for pdf_to_markdown
│   ├── services/
│   │   ├── pdf-reader.ts         # PDF reading — text extraction, positional text, metadata, page counting via unpdf (pdf.js)
│   │   ├── pdf-writer.ts         # PDF writing — load/create/save via @pdfme/pdf-lib; savePdf() stamps producer metadata
│   │   ├── pdf-creator.ts        # Rich PDF creation — Markdown/template → @react-pdf/renderer → PDF bytes (lazy-loads react-pdf + remark)
│   │   ├── pdf-renderer.ts       # Page→image rendering via @hyzyla/pdfium (WASM) + pngjs/jpeg-js encode (lazy-loaded)
│   │   ├── pdf-crypto.ts         # AES-256 encryption via @neslinesli93/qpdf-wasm (lazy-loaded)
│   │   └── pdf-page-engine.ts    # Form-preserving page copy (copyPagesPreservingForms) — namespaces colliding field names, reports {preserved, renamed, dropped}
│   ├── templates/
│   │   ├── index.ts              # Template registry barrel export (name → {schema, build})
│   │   ├── invoice.ts            # Invoice template builder (react-pdf)
│   │   ├── report.ts             # Report template builder (react-pdf)
│   │   └── letter.ts             # Letter template builder (react-pdf)
│   ├── prompts/
│   │   └── index.ts              # 5 guided-workflow prompts: create-invoice, fill-form, read-scanned-pdf, pdf-to-markdown, merge-and-flatten
│   ├── resources/
│   │   └── index.ts              # MCP resource pdf-toolkit://templates — lists templates and their accepted fields
│   └── utils/
│       ├── validation.ts         # Input validation — file/output/font/image paths, page ranges, file size, toUint8Array
│       ├── errors.ts             # Error handling — ErrorCode union, PdfError, toErrorResult, toolError, toolSuccess
│       ├── file-utils.ts         # File utilities — getFileSize for write tool responses
│       └── logger.ts             # Structured stderr logger gated by LOG_LEVEL/DEBUG (never writes to stdout)
├── test/                         # vitest suites — integration (per tool group, real stdio, stdout-pollution regression) + unit
├── dist/                         # Build output (gitignored)
├── package.json
├── tsconfig.json
├── .npmignore
├── CLAUDE.md                     # This file — project context for Claude Code
├── CHANGELOG.md                  # Keep a Changelog format
├── LICENSE                       # MIT
└── README.md
```

## 4. MCP SDK Patterns

### Tool Registration (use this pattern for every tool)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "pdf-toolkit-mcp",
  version, // resolved from package.json at runtime — single source of truth
});

server.registerTool(
  "pdf_extract_text",
  {
    description:
      "Extract text content from a PDF file. Returns first 10 pages by default to avoid exceeding LLM context limits.",
    inputSchema: z
      .object({
        filePath: z.string().describe("Absolute path to the PDF file"),
        pages: z
          .string()
          .optional()
          .describe(
            "Page range, e.g. '1-5' or '1,3,5'. Defaults to first 10 pages.",
          ),
      })
      .strict(),
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
  },
);
```

### Error Response Pattern

Throw a `PdfError(message, code)` from validators/services and let the tool's
`catch` funnel it through `toErrorResult(err)` — this converts any thrown value
into a clean error `ToolResult` (never leaks a stack). Codes come from the
`ErrorCode` union in `src/utils/errors.ts` (`INVALID_INPUT`, `FILE_NOT_FOUND`,
`NOT_A_PDF`, `CORRUPT_PDF`, `ENCRYPTED_PDF`, `PAGE_OUT_OF_RANGE`,
`FIELD_NOT_FOUND`, `UNSUPPORTED_FORMAT`, `RESOURCE_LIMIT`, `PERMISSION_DENIED`,
`WASM_LOAD_FAILED`, `INTERNAL`, …) so clients can branch on a stable code rather
than message text.

The shared validators in `src/utils/validation.ts` all throw coded `PdfError`s
(not bare `Error`s): `validatePdfPath` → `FILE_NOT_FOUND` / `INVALID_INPUT` /
`NOT_A_PDF`; `validateOutputPath` → `INVALID_INPUT` (missing parent);
`validateFontPath` → `FILE_NOT_FOUND` / `UNSUPPORTED_FORMAT`; `validateImagePath`
→ `FILE_NOT_FOUND` / `UNSUPPORTED_FORMAT`; `validateFileSize` → `RESOURCE_LIMIT`;
`parsePageRange` → `INVALID_INPUT` (malformed) / `PAGE_OUT_OF_RANGE`;
`loadExistingPdf` → `ENCRYPTED_PDF` / `CORRUPT_PDF`. `toErrorResult` formats a
`PdfError` as `Error [CODE]: message` and a bare `Error` as `Error: message`.
The message text is essentially unchanged from earlier versions (only the code
prefix was added), so substring assertions in tests still hold.

```typescript
import { PdfError, toErrorResult, toolSuccess } from "../utils/errors.js";

async (args) => {
  try {
    // ... validate; throw new PdfError("…", "PAGE_OUT_OF_RANGE") on failure
    return toolSuccess({ outputPath, fileSize });
  } catch (error) {
    return toErrorResult(error); // → { isError: true, content: [{ type: "text", text: "Error [CODE]: …" }] }
  }
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

8. **`merge`/`split`/`reorder`/`delete` PRESERVE AcroForm fields** — use `copyPagesPreservingForms()` from `src/services/pdf-page-engine.ts`, NOT bare `copyPages()` (which drops fields). Field names that collide across inputs are auto-namespaced; pass `flatten:true` to bake values into static content. Every such tool returns `formFields: { preserved, renamed, dropped }` so callers know exactly what happened. Exotic/edge-case forms that can't be carried over are reported in `dropped` rather than failing silently.

9. **Check `CHARACTER_LIMIT` (25,000) on all responses** — Truncate with an actionable message: "Output truncated at 25,000 chars. Use page ranges to extract smaller sections."

10. **Tool descriptions under 200 tokens** — Include only 1-2 critical behaviors. Long descriptions waste LLM context and reduce tool selection accuracy.

11. **All `.ts` imports use `.js` extension** — Required by ESM with Node16 module resolution. `import { foo } from "./bar.js"` even though the source file is `bar.ts`.

12. **All tool names: `pdf_` prefix, snake_case** — Consistent naming convention across all 22 tools. Examples: `pdf_extract_text`, `pdf_merge`, `pdf_fill_form`.

13. **Every tool declares annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. These enable MCP clients to make informed decisions about auto-approval and confirmation prompts. Write tools declare `destructiveHint: false` (MCP-01 rationale): their semantics are "produce output" — they write a new file at `outputPath`. Because `outputPath` may point at an existing file, a write _can_ overwrite it, but the annotation describes the tool's intent (emit a result file), not a guarantee that no file is ever replaced. Treat `destructiveHint: false` as "creates output", and pick an `outputPath` that does not collide with a file you want to keep.

14. **`@pdfme/pdf-lib` ESM Import Pattern** — The package's `exports` field maps `import.node` to a CJS build, so Node.js cannot resolve named ESM imports at runtime. Use this dual-import pattern:

```typescript
import type { PDFDocument } from "@pdfme/pdf-lib"; // compile-time types only
import pdfLib from "@pdfme/pdf-lib"; // runtime default import

// Access static methods via the default import:
pdfLib.PDFDocument.load(data); // not PDFDocument.load()
pdfLib.PDFDocument.create(); // not PDFDocument.create()

// Use the type import for annotations:
function example(pdfDoc: PDFDocument): void {}
```

See `src/services/pdf-writer.ts` for the canonical example. All files that import from `@pdfme/pdf-lib` must follow this pattern.

15. **Lazy-load heavy WASM/render engines inside handlers** — `@react-pdf/renderer` + remark (`pdf-creator.ts`), `@hyzyla/pdfium` (`pdf-renderer.ts`), and `@neslinesli93/qpdf-wasm` (`pdf-crypto.ts`) are only `await import(...)`-ed the first time a tool that needs them runs. This keeps server cold-start fast for clients that just read PDFs and never trigger those code paths. Cache the loaded module in a module-level promise so it initializes at most once.

16. **Heavy engines are pure WASM/JS — zero native deps** — PDFium and qpdf are shipped as WebAssembly, and react-pdf is pure JS. There are no node-gyp builds, prebuilt binaries, or canvas bindings, so `npx -y @aryanbv/pdf-toolkit-mcp` works on Node >= 20 across platforms without a compiler. When wiring a WASM engine, resolve its `.wasm` asset relative to the package (e.g. `require.resolve(".../qpdf.wasm")`) rather than assuming a CWD.

17. **fileSize in every write tool response** — All tools that write files must include `fileSize` (human-readable string like "12.3 KB") in their response. Use `getFileSize()` from `src/utils/file-utils.ts`.

18. **Producer metadata on every generated PDF** — `pdf-writer.ts`'s `savePdf()` automatically sets `producer` to `@aryanbv/pdf-toolkit-mcp` for all `@pdfme/pdf-lib` outputs. For react-pdf-created PDFs (`pdf_create_from_markdown`, `pdf_create_from_template`), the producer is set via the `<Document producer>` prop (`DocumentProps`) in `pdf-creator.ts`.

## 6. Tools Reference

| Tool                       | File                  | Library                        | Type  | Description                                                                                                |
| -------------------------- | --------------------- | ------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------- |
| `pdf_extract_text`         | `tools/read.ts`       | unpdf                          | Read  | Extract text from PDF pages (default: first 10)                                                            |
| `pdf_get_metadata`         | `tools/read.ts`       | @pdfme/pdf-lib                 | Read  | Get title, author, subject, page count, dates, producer, fileSize                                          |
| `pdf_get_form_fields`      | `tools/read.ts`       | @pdfme/pdf-lib                 | Read  | List form fields with names, types, values, required (surfaces `CORRUPT_PDF` on broken forms)              |
| `pdf_to_markdown`          | `tools/read.ts`       | unpdf + mdast-util-to-markdown | Read  | Convert a PDF to reading-order Markdown (column clustering, heading inference, list detection)             |
| `pdf_search`               | `tools/read.ts`       | unpdf                          | Read  | Find text across pages, returning page numbers + snippets (literal or `regex`, case-insensitive default)   |
| `pdf_merge`                | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Merge multiple PDFs into one; preserves AcroForm fields (namespaces collisions), optional `flatten`        |
| `pdf_split`                | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Extract page ranges into a new PDF; preserves AcroForm fields on extracted pages, optional `flatten`       |
| `pdf_rotate_pages`         | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Rotate specified pages by 90/180/270 degrees (additive to existing rotation)                               |
| `pdf_encrypt`              | `tools/manipulate.ts` | @neslinesli93/qpdf-wasm        | Write | Encrypt PDF with AES-256 user/owner passwords                                                              |
| `pdf_compare`              | `tools/manipulate.ts` | unpdf + diff                   | Read  | Page-by-page text diff between two PDFs (returns `identical:true` when text matches)                       |
| `pdf_add_page_numbers`     | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Add page numbers at configurable position, format, start number, and font size                             |
| `pdf_embed_qr_code`        | `tools/manipulate.ts` | @bwip-js/node + @pdfme/pdf-lib | Write | Embed QR/barcode into a page (rejects off-page placements instead of clipping)                             |
| `pdf_reorder_pages`        | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Reorder pages (duplicates allowed); preserves AcroForm fields, optional `flatten`                          |
| `pdf_delete_pages`         | `tools/manipulate.ts` | @pdfme/pdf-lib                 | Write | Delete a page range, keeping the rest; preserves AcroForm fields, optional `flatten`                       |
| `pdf_create`               | `tools/create.ts`     | @pdfme/pdf-lib                 | Write | Create new PDF from text content (auto wrap + page overflow)                                               |
| `pdf_fill_form`            | `tools/create.ts`     | @pdfme/pdf-lib + fontkit       | Write | Fill PDF form fields (supports non-Latin via `fontPath`, optional `flatten`)                               |
| `pdf_add_watermark`        | `tools/create.ts`     | @pdfme/pdf-lib                 | Write | Add text watermark to all or specified pages                                                               |
| `pdf_embed_image`          | `tools/create.ts`     | @pdfme/pdf-lib                 | Write | Embed PNG/JPEG image into a PDF page                                                                       |
| `pdf_create_from_markdown` | `tools/create.ts`     | @react-pdf/renderer + remark   | Write | Create rich PDF from Markdown (CommonMark + GFM: headings, tables, lists, code, blockquotes)               |
| `pdf_create_from_template` | `tools/create.ts`     | @react-pdf/renderer            | Write | Create PDF from named template (invoice, report, letter); `data` is Zod-validated                          |
| `pdf_flatten`              | `tools/create.ts`     | @pdfme/pdf-lib                 | Write | Bake form-field values into static content, removing interactivity                                         |
| `pdf_render_pages`         | `tools/render.ts`     | @hyzyla/pdfium + pngjs/jpeg-js | Write | Render pages to PNG/JPEG files (or `inline:true` image blocks for vision) so clients can read scanned PDFs |

## 7. Known Limitations

These are inherent to the underlying libraries and cannot be worked around without switching libraries.

1. **Form preservation has an honest fallback** — `pdf_merge`/`split`/`reorder`/`delete` carry AcroForm fields across via `copyPagesPreservingForms()` instead of dropping them. Fields whose names collide across inputs are auto-namespaced (per source document) and reported in `renamed`. Exotic or structurally unusual forms that cannot be safely reconstructed are dropped and listed in `dropped` rather than failing the whole operation — so the response is always truthful about what survived. Use `flatten:true` when you don't need interactivity.

2. **`setRotation()` doesn't transform coordinate system** — Rotating a page only changes the display rotation flag (`/Rotate`); it doesn't actually transform the content stream coordinates. Subsequent draws onto a rotated page use unrotated coordinates.

3. **Image embedding supports JPEG/PNG only** — `@pdfme/pdf-lib` can embed JPEG and PNG images. Other formats (WebP, GIF, TIFF, SVG) must be converted externally before embedding.

4. **Standard fonts are WinAnsi-only (Latin)** — pdf-lib's built-in standard fonts (Helvetica, Times Roman, etc.) only support WinAnsi encoding (basic Latin characters). Non-Latin scripts (Arabic, CJK, Devanagari, etc.) in `pdf_fill_form` require fontkit with a `.ttf`/`.otf` font file via `fontPath`.

5. **`save()` does minimal compression** — pdf-lib's PDF serialization does not apply advanced compression (object streams, cross-reference compression). Output files may be larger than input. Meaningful compression requires external tools.

6. **Text extraction returns PDF stream order, not visual reading order** — `unpdf` (pdf.js) extracts text in content-stream order, which may differ from the visual left-to-right, top-to-bottom reading order. `pdf_to_markdown` reconstructs columns and reading order from positional text and is the better choice when order matters; raw `pdf_extract_text` may interleave multi-column layouts.

7. **Encryption is AES-256, opaque to the toolkit** — `pdf_encrypt` uses AES-256 via `@neslinesli93/qpdf-wasm`. The other tools read/write unencrypted PDFs; an already-encrypted input surfaces an `ENCRYPTED_PDF` error rather than being silently mishandled.

8. **react-pdf font + Markdown scope** — Created PDFs (`pdf_create_from_markdown`, `pdf_create_from_template`) use `@react-pdf/renderer` with Helvetica by default; custom fonts are supported via `Font.register` (not yet exposed as a tool parameter). Markdown supports CommonMark + GFM (headings, bold/italic, links, ordered/bullet lists, tables, fenced code blocks, blockquotes, horizontal rules) but NOT: raw/embedded HTML, GFM task-list checkbox state, footnotes, or code-block syntax highlighting.

## 8. Build & Test Commands

```bash
npm run build       # Compile TypeScript → dist/
npm run dev         # Watch mode — recompile on file changes
npm start           # Run the MCP server (stdio transport)
npm test            # Run the vitest suite (pretest builds first)
npm run test:watch  # Vitest in watch mode
npm run test:cov    # Vitest with v8 coverage
npm run lint        # ESLint (flat config)
npm run format      # Prettier --write
npm run inspect     # Open MCP Inspector for interactive testing
```

Tests run on **vitest** under `test/` — integration suites per tool group plus a
real stdio integration test and a stdout-pollution regression test. ESLint +
Prettier are enforced via Husky + lint-staged pre-commit hooks and GitHub
Actions CI.

**Note**: MCP Inspector (`@modelcontextprotocol/inspector`) requires Node >= 22.7.5 to run. The server itself requires Node >= 20 (22 or 24 LTS recommended).
