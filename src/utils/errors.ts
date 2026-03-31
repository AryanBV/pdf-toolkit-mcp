import { CHARACTER_LIMIT } from "../constants.js";
import type { ToolResult } from "../types.js";

export function toolError(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function toolSuccess(data: unknown): ToolResult {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2) ?? "";

  if (text.length > CHARACTER_LIMIT) {
    return {
      content: [
        {
          type: "text",
          text:
            text.slice(0, CHARACTER_LIMIT) +
            "\n\n[Output truncated at 25,000 characters. Use page ranges to extract smaller sections.]",
        },
      ],
    };
  }

  return { content: [{ type: "text", text }] };
}
