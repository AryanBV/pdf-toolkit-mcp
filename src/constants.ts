export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_EXTRACT_PAGES = 10;
export const MAX_FILE_SIZE_MB = 100;
export const MAX_MERGE_FILES = 50;
export const SUPPORTED_IMAGE_FORMATS = ["image/png", "image/jpeg"] as const;
export const MAX_PAGE_WARNING = 10_000;
export const MAX_PAGE_NUMBER = 100_000;

// Rendering limits (pdf_render_pages) — guard against memory blow-ups
export const DEFAULT_RENDER_DPI = 150;
export const MIN_RENDER_DPI = 36;
export const MAX_RENDER_DPI = 300;
export const MAX_RENDER_PAGES = 50;
export const MAX_RENDER_DIMENSION = 5_000;

// Inline rendering limits (pdf_render_pages inline:true) — base64 image blocks
// are returned directly in the tool result, so keep them small to protect the
// LLM context window.
export const MAX_INLINE_RENDER_PAGES = 5;
export const MAX_INLINE_DIMENSION = 1_500;

// Text-extraction / search / markdown limits
export const MAX_SEARCH_RESULTS = 500;
export const MAX_MARKDOWN_INPUT_CHARS = 5_000_000;

// Image-embedding guard — reject absurdly large rasters before embedding.
export const MAX_IMAGE_DIMENSION = 20_000;
