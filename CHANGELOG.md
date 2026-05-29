# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-29

**0.3.0 "Prism"** — an incremental pre-1.0 release focused on root-cause fixes,
high-fidelity creation, and real quality infrastructure. Grows the toolkit from
16 to 22 tools and adds an MCP-native layer (inline vision images, guided
prompts, a templates resource). Positioned as an honest incremental step: the
public API still has heuristic tools and a v1.1 roadmap, so `1.0.0` is reserved
for a later stable-API milestone.

### Added

- **New tool `pdf_render_pages`** — render PDF pages to PNG/JPEG image files
  (PDFium WASM, zero native deps) so a vision-capable MCP client can read
  scanned or image-only PDFs. Lazy-loaded engine keeps cold start fast. File
  output streams pages to disk rather than buffering every rendered raster in
  memory, lowering peak memory for large/high-DPI renders.
- `pdf_render_pages` **`inline`** option that returns rendered pages as inline
  image content blocks for vision-capable clients (max 5 pages, DPI auto-capped
  to protect context) — read a scanned PDF in a single call.
- **New tool `pdf_to_markdown`** — convert a PDF to reading-order Markdown
  (column clustering, char-weighted modal heading inference, list detection)
  for LLM consumption. Honest scope: best on clean digital PDFs; tabular regions
  are emitted as positioned text in reading order, not reconstructed as Markdown
  tables.
- **New tool `pdf_search`** — find text across a PDF, returning page numbers and
  surrounding snippets. Literal, case-insensitive substring match
  (`caseSensitive:true` for exact case); no regex (see Removed).
- **New tool `pdf_compare`** — page-by-page text diff between two PDFs (returns
  `identical:true` when text matches). Honest array-trim with `truncated` /
  `differingPageCount` flags, plus stream-order and page-alignment scope notes.
- **New tool `pdf_delete_pages`** — remove a page range, preserving AcroForm
  fields on the remaining pages.
- **New tool `pdf_flatten`** — bake form-field values into static content,
  removing interactivity.
- **Form-preserving page engine** (`copyPagesPreservingForms`) so
  `pdf_merge`, `pdf_split`, `pdf_reorder_pages`, and `pdf_delete_pages` carry
  AcroForm fields across instead of dropping them. Colliding field names are
  auto-namespaced per source document; each tool returns an honest
  `{ preserved, renamed, dropped }` report, and `flatten:true` bakes values into
  static content.
- Guided-workflow **prompts**: `read-scanned-pdf`, `pdf-to-markdown`,
  `merge-and-flatten` (alongside the existing `create-invoice`, `fill-form`) —
  5 prompts total.
- A `pdf-toolkit://templates` **MCP resource** listing the available
  `pdf_create_from_template` templates and their accepted fields.
- **`pdf_create_from_template` invoice `currency` field** — optional, defaults
  to `USD`. WinAnsi currencies (`$`, `EUR`, `GBP`, `JPY`) render as glyphs;
  non-WinAnsi codes (e.g. INR, KRW) fall back to the ISO code label.
- **`pdf_create` optional `fontPath`** — embed a custom `.ttf`/`.otf`, with a
  non-Latin guard that produces a clear error when the default WinAnsi standard
  font cannot render the supplied text.
- Quality infrastructure: vitest test suite (incl. real stdio integration test
  and a stdout-pollution regression test), ESLint flat config + Prettier,
  Husky + lint-staged pre-commit hooks, and GitHub Actions CI (Node 20/22/24
  matrix; `npm publish` runs with `--provenance` plus a fail-fast guard when
  `NPM_TOKEN` is unset).
- Structured stderr logger (`src/utils/logger.ts`) gated by `LOG_LEVEL`/`DEBUG`.
- Stable error codes (`ErrorCode`, `PdfError`, `toErrorResult`) in
  `src/utils/errors.ts`.
- Centralized rendering/extraction resource limits in `src/constants.ts`.

### Changed

- `pdf_encrypt` now uses **AES-256** (qpdf-wasm) instead of RC4 128-bit, and
  pre-detects an already-encrypted input, surfacing a clear `ENCRYPTED_PDF`
  error instead of mishandling it.
- `pdf_create_from_markdown` and `pdf_create_from_template` rebuilt on
  **@react-pdf/renderer + remark** (high-fidelity GFM tables, code blocks,
  nested lists, bold/italic/links) — replaces the lossy
  marked→html-to-pdfmake→pdfmake pipeline and the Roboto-only font limitation.
  Template `data` is now Zod-validated (no silent coercion).
- **`pdf_fill_form` `fontPath` actually applies non-Latin fonts** — a custom
  `.ttf`/`.otf` supplied via `fontPath` is embedded and applied to the filled
  field appearances, so non-Latin scripts (Arabic, CJK, Devanagari, etc.) render
  correctly instead of the embed being ignored.
- **`pdf_embed_image` rejects off-page placement** — a requested position/size
  that would push any part of the image outside the page bounds now throws a
  coded error instead of silently clipping the image. Images are also validated
  against oversized/corrupt rasters (`MAX_IMAGE_DIMENSION`).
- **`pdf_embed_qr_code`** rejects placements that fall off the page instead of
  silently clipping, and keeps the embedded barcode/QR code's intrinsic aspect
  ratio instead of stretching it to the requested box.
- **`pdf_add_watermark` diagonal centering fixed** — diagonal watermarks are
  rotated about the text's own center and anchored at the page center, so the
  watermark is properly centered rather than offset by the rotation pivot.
- **`pdf_add_page_numbers` honors page `/Rotate`** — page numbers are positioned
  correctly on pages that carry a display-rotation flag.
- **Coded `PdfError` across all validators and the read/load paths** —
  `validatePdfPath`, `validateOutputPath`, `validateFontPath`,
  `validateImagePath`, `validateFileSize`, `parsePageRange`, the unpdf read path,
  and `pdf-writer`'s `loadExistingPdf` now throw a `PdfError` carrying a stable
  `ErrorCode` (`FILE_NOT_FOUND`, `INVALID_INPUT`, `NOT_A_PDF`,
  `UNSUPPORTED_FORMAT`, `RESOURCE_LIMIT`, `PAGE_OUT_OF_RANGE`, `ENCRYPTED_PDF`,
  `CORRUPT_PDF`, `PERMISSION_DENIED`, …) so clients can branch on the code rather
  than parsing message text. `toErrorResult` formats these as
  `Error [CODE]: message`; bare errors stay `Error: message` and never leak a
  stack.
- `pdf_get_metadata` now includes `fileSize` in its response.
- Server version is now derived from `package.json` at runtime — a single source
  of truth that can no longer drift from the published version.
- Dockerfile builds from source in a multi-stage build instead of pinning a
  stale published version.
- **Node engines `>=20`** — `engines.node` raised from `>=18` to `>=20` (both 18
  and 20.x are EOL; `>=20` is the conservative non-breaking floor).
- Added a `prepack` build guard (`npm run build`) so `npm pack` / `npm publish`
  always rebuild `dist/` first. `dist/` is gitignored, so a manual publish from a
  clean checkout previously risked shipping an empty package.
- `getFileSize` now scales into MB and GB instead of reporting large outputs in
  kilobytes.

### Fixed

- **`pdf_merge`, `pdf_split`, `pdf_reorder_pages`, `pdf_delete_pages` now
  PRESERVE AcroForm form fields** instead of silently stripping them (the
  long-standing pdf-lib `copyPages` limitation), via the form-preserving page
  engine described under Added.
- **Duplicate-page form honesty** — `pdf_reorder_pages` (and other tools that can
  emit a page more than once) report form-field outcomes truthfully when a page
  is duplicated rather than over-counting preserved fields.
- `pdf_get_form_fields` no longer silently masks a corrupt form structure as
  "no form" — it surfaces a real `CORRUPT_PDF` error.

### Removed

- **`pdf_search` `regex` parameter removed** — search is now literal,
  case-insensitive substring matching only. Rationale: a user-supplied regular
  expression can trigger catastrophic backtracking (ReDoS) that single-threaded
  JavaScript cannot reliably interrupt, so the attack surface is removed rather
  than merely bounded by a wall-clock time budget. Safe regex search is deferred
  to v1.1.
- Removed the `@pdfsmaller/pdf-encrypt-lite` (RC4) dependency in favor of
  AES-256 encryption.
- Removed `pdfmake`, `html-to-pdfmake`, `jsdom`, and `marked` (replaced by
  @react-pdf/renderer + remark) — eliminates the jsdom memory-leak risk and the
  Roboto-only font constraint.

### Security

- **`pdf_search` ReDoS surface eliminated** — the user-supplied `regex`
  parameter was removed entirely (see Removed), so no pathological pattern can
  hang the single-threaded server.
- Pinned patched versions of transitive dependencies via `overrides`, resolving
  advisories originating from the MCP SDK's HTTP-transport chain and jsdom (none
  of which the stdio server loads at runtime).
- AES-256 encryption replaces the removed RC4 dependency.
