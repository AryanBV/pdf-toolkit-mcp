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

### Fixed

- **`pdf_merge`, `pdf_split`, `pdf_reorder_pages` now PRESERVE AcroForm form
  fields** instead of silently stripping them (the long-standing pdf-lib
  `copyPages` limitation). Fields whose names collide across inputs are
  auto-namespaced; `flatten:true` bakes values into static content. Each tool
  reports `{ preserved, renamed, dropped }`.
- `pdf_get_metadata` now includes `fileSize` in its response.
- `pdf_get_form_fields` no longer silently masks a corrupt form structure as
  "no form" — it surfaces a real `CORRUPT_PDF` error.
- Quality infrastructure: vitest test suite (incl. real stdio integration test
  and a stdout-pollution regression test), ESLint flat config + Prettier,
  Husky + lint-staged pre-commit hooks, and GitHub Actions CI.
- Structured stderr logger (`src/utils/logger.ts`) gated by `LOG_LEVEL`/`DEBUG`.
- Stable error codes (`ErrorCode`, `PdfError`, `toErrorResult`) in
  `src/utils/errors.ts`.
- Centralized rendering/extraction resource limits in `src/constants.ts`.

### Changed

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
