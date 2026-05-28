# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-28

**v1.0 "Prism"** — a major upgrade focused on root-cause fixes, high-fidelity
creation, and real quality infrastructure. Grows the toolkit from 16 to 22
tools and adds an MCP-native layer (inline vision images, guided prompts, a
templates resource).

### Added

- **New tool `pdf_render_pages`** — render PDF pages to PNG/JPEG image files
  (PDFium WASM, zero native deps) so a vision-capable MCP client can read
  scanned or image-only PDFs. Lazy-loaded engine keeps cold start fast.
- **New tool `pdf_to_markdown`** — convert a PDF to reading-order Markdown
  (column clustering, font-size heading inference, list detection) for LLM
  consumption. Honest scope: best on clean digital PDFs.
- **New tool `pdf_search`** — find text across a PDF, returning page numbers
  and surrounding snippets; literal or regex, case-insensitive by default.
- **New tool `pdf_compare`** — page-by-page text diff between two PDFs.
- **New tool `pdf_delete_pages`** — remove a page range, preserving form fields
  on the remaining pages.
- **New tool `pdf_flatten`** — bake form-field values into static content,
  removing interactivity.
- `pdf_render_pages` gains an **`inline`** option that returns rendered pages as
  inline image content blocks for vision-capable clients (max 5 pages, DPI
  auto-capped to protect context) — read a scanned PDF in a single call.
- Guided-workflow **prompts**: `read-scanned-pdf`, `pdf-to-markdown`,
  `merge-and-flatten` (alongside the existing `create-invoice`, `fill-form`).
- A `pdf-toolkit://templates` **MCP resource** listing the available
  `pdf_create_from_template` templates and their accepted fields.
- Quality infrastructure: vitest test suite (incl. real stdio integration test
  and a stdout-pollution regression test), ESLint flat config + Prettier,
  Husky + lint-staged pre-commit hooks, and GitHub Actions CI.
- Structured stderr logger (`src/utils/logger.ts`) gated by `LOG_LEVEL`/`DEBUG`.
- Stable error codes (`ErrorCode`, `PdfError`, `toErrorResult`) in
  `src/utils/errors.ts`.
- Centralized rendering/extraction resource limits in `src/constants.ts`.

### Fixed

- **`pdf_merge`, `pdf_split`, `pdf_reorder_pages` now PRESERVE AcroForm form
  fields** instead of silently stripping them (the long-standing pdf-lib
  `copyPages` limitation). Fields whose names collide across inputs are
  auto-namespaced; `flatten:true` bakes values into static content. Each tool
  reports `{ preserved, renamed, dropped }`.
- `pdf_get_form_fields` no longer silently masks a corrupt form structure as
  "no form" — it surfaces a real `CORRUPT_PDF` error.

### Changed

- `pdf_get_metadata` now includes `fileSize` in its response.
- Server version is now derived from `package.json` at runtime — a single source
  of truth that can no longer drift from the published version.
- Dockerfile builds from source in a multi-stage build instead of pinning a
  stale published version.
- `pdf_encrypt` now uses **AES-256** (qpdf-wasm) instead of RC4 128-bit.
- `pdf_embed_qr_code` rejects placements that fall off the page instead of
  silently clipping the barcode.
- `pdf_create_from_markdown` and `pdf_create_from_template` rebuilt on
  **@react-pdf/renderer + remark** (high-fidelity GFM tables, code blocks,
  nested lists, bold/italic/links) — replaces the lossy
  marked→html-to-pdfmake→pdfmake pipeline and the Roboto-only font limitation.
  Template `data` is now Zod-validated (no silent coercion).
- `pdf_embed_image` validates images and guards against oversized/corrupt
  rasters (`MAX_IMAGE_DIMENSION`).

### Security

- Pinned patched versions of transitive dependencies via `overrides`, resolving
  7 advisories (1 high) originating from the MCP SDK's HTTP-transport chain and
  jsdom (none of which the stdio server loads at runtime).
- Removed the `@pdfsmaller/pdf-encrypt-lite` (RC4) dependency in favor of
  AES-256 encryption.
- Removed `pdfmake`, `html-to-pdfmake`, `jsdom`, and `marked` (replaced by
  @react-pdf/renderer + remark) — eliminates the jsdom memory-leak risk and the
  Roboto-only font constraint.

### Hardening (pre-release)

A pre-ship hardening pass applied before tagging the 1.0.0 release. All items
land in 1.0.0 as it has not yet been published.

- **`pdf_search` ReDoS time budget** — user-supplied `regex` queries are now
  evaluated under a wall-clock time budget so a pathological/catastrophic
  backtracking pattern can no longer hang the server; it aborts with a
  `RESOURCE_LIMIT` error instead.
- **Coded `PdfError` across all validators** — `validatePdfPath`,
  `validateOutputPath`, `validateFontPath`, `validateImagePath`,
  `validateFileSize`, `parsePageRange`, and `loadExistingPdf` now throw a
  `PdfError` carrying a stable `ErrorCode` (`FILE_NOT_FOUND`, `INVALID_INPUT`,
  `NOT_A_PDF`, `UNSUPPORTED_FORMAT`, `RESOURCE_LIMIT`, `PAGE_OUT_OF_RANGE`,
  `ENCRYPTED_PDF`, `CORRUPT_PDF`, `PERMISSION_DENIED`, …) so clients can branch
  on the code rather than parsing message text. `toErrorResult` formats these as
  `Error [CODE]: message`; bare errors stay `Error: message` and never leak a
  stack.
- **`ENCRYPTED_PDF` detection** — encrypted inputs to the read/manipulate tools
  now surface a clear `ENCRYPTED_PDF` error from `loadExistingPdf` instead of
  failing obscurely or being silently mishandled.
- **`prepack` build guard** — added a `prepack` script (`npm run build`) so
  `npm pack` / `npm publish` always rebuild `dist/` first. `dist/` is
  gitignored, so a manual publish from a clean checkout previously risked
  shipping an empty package.
- **Node engines `>=20`** — `engines.node` raised from `>=18` to `>=20` (both 18
  and 20 are EOL; `>=20` is the conservative non-breaking floor). CI now tests
  Node 20, 22, and 24, and `npm publish` runs with `--provenance` plus a
  fail-fast guard when `NPM_TOKEN` is unset.
- **`pdf_embed_qr_code` aspect-ratio fix** — embedded barcodes/QR codes keep
  their intrinsic aspect ratio instead of being stretched to the requested box.
- **`pdf_render_pages` file-mode streaming** — file output streams pages to disk
  rather than buffering every rendered raster in memory, lowering peak memory
  for large/high-DPI renders.
- **Duplicate-page form honesty** — `pdf_reorder_pages` (and other tools that
  can emit a page more than once) report form-field outcomes truthfully when a
  page is duplicated rather than over-counting preserved fields.
- **`getFileSize` MB/GB scaling** — the human-readable file-size helper now
  scales into MB and GB instead of reporting large outputs in kilobytes.
- **New regression tests** — added/updated tests covering the ReDoS time
  budget, coded validator errors, `ENCRYPTED_PDF` detection, QR aspect ratio,
  file-mode render streaming, duplicate-page form reporting, `getFileSize`
  scaling, and prompt coverage (`create-invoice`, `fill-form`).
