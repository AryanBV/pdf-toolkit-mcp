import { describe, it, expect } from "vitest";
import {
  toolError,
  toolSuccess,
  toErrorResult,
  PdfError,
} from "../../src/utils/errors.js";

describe("errors", () => {
  it("toolError without a code returns the message verbatim", () => {
    const r = toolError("boom");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("boom");
  });

  it("toolError with a code prefixes it", () => {
    const r = toolError("missing", "FILE_NOT_FOUND");
    expect(r.content[0].text).toBe("Error [FILE_NOT_FOUND]: missing");
  });

  it("toErrorResult maps a PdfError's code", () => {
    const r = toErrorResult(new PdfError("nope", "CORRUPT_PDF"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Error [CORRUPT_PDF]: nope");
  });

  it("toErrorResult wraps a plain Error", () => {
    const r = toErrorResult(new Error("plain"));
    expect(r.content[0].text).toBe("Error: plain");
  });

  it("toErrorResult handles non-Error throws", () => {
    const r = toErrorResult("just a string");
    expect(r.content[0].text).toBe("Error: just a string");
  });

  it("toolSuccess truncates output over the character limit", () => {
    const r = toolSuccess("x".repeat(30_000));
    expect(r.content[0].text.length).toBeLessThan(26_000);
    expect(r.content[0].text).toContain("truncated");
  });

  it("toolSuccess serializes objects as pretty JSON", () => {
    const r = toolSuccess({ a: 1 });
    expect(r.content[0].text).toContain('"a": 1');
  });
});
