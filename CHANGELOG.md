# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Work toward **v1.0 "Prism"** — a major upgrade focused on root-cause fixes,
high-fidelity creation, and real quality infrastructure.

### Added

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

### Security

- Pinned patched versions of transitive dependencies via `overrides`, resolving
  7 advisories (1 high) originating from the MCP SDK's HTTP-transport chain and
  jsdom (none of which the stdio server loads at runtime).
