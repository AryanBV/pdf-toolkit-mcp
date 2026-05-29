import { CHARACTER_LIMIT } from "../constants.js";
import type { ToolResult } from "../types.js";

/**
 * Stable error codes returned to clients. These let MCP clients react to
 * specific failure classes without string-matching messages.
 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "FILE_NOT_FOUND"
  | "NOT_A_PDF"
  | "PERMISSION_DENIED"
  | "CORRUPT_PDF"
  | "ENCRYPTED_PDF"
  | "PAGE_OUT_OF_RANGE"
  | "FIELD_NOT_FOUND"
  | "UNSUPPORTED_FORMAT"
  | "RESOURCE_LIMIT"
  | "WASM_LOAD_FAILED"
  | "INTERNAL";

/** Error carrying a stable {@link ErrorCode}. Validators/services throw this. */
export class PdfError extends Error {
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode = "INTERNAL") {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

/**
 * Build an error ToolResult. When a code is supplied the message is prefixed
 * with `Error [CODE]:`; without a code the message is returned verbatim
 * (backward-compatible with existing call sites).
 */
export function toolError(message: string, code?: ErrorCode): ToolResult {
  const text = code ? `Error [${code}]: ${message}` : message;
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

/** Convert any thrown value into a clean error ToolResult (never leaks a stack). */
export function toErrorResult(err: unknown): ToolResult {
  if (err instanceof PdfError) return toolError(err.message, err.code);
  const message = err instanceof Error ? err.message : String(err);
  return toolError(`Error: ${message}`);
}

export function toolSuccess(data: unknown): ToolResult {
  // Plain strings are returned as-is and byte-sliced on overflow (not JSON).
  if (typeof data === "string") {
    const text =
      data.length > CHARACTER_LIMIT
        ? data.slice(0, CHARACTER_LIMIT) +
          `\n\n[Output truncated at ${CHARACTER_LIMIT.toLocaleString()} characters. Use page ranges to extract smaller sections.]`
        : data;
    return { content: [{ type: "text", text }] };
  }

  // Object payloads are serialized to JSON. On overflow, return a VALID JSON
  // envelope (preview is an escaped string value) so the client's JSON.parse
  // never sees a token sliced in half.
  const serialized = JSON.stringify(data, null, 2) ?? "";
  if (serialized.length > CHARACTER_LIMIT) {
    const envelope = {
      truncated: true,
      note: "Output exceeded 25,000 characters; request a smaller page range or fewer items.",
      preview: serialized.slice(0, CHARACTER_LIMIT - 400),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    };
  }

  return { content: [{ type: "text", text: serialized }] };
}
