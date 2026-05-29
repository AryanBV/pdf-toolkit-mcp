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

  it("toolSuccess returns a VALID JSON envelope when an object payload overflows", () => {
    const r = toolSuccess({ pages: [{ page: 1, text: "x".repeat(30_000) }] });
    expect(() => JSON.parse(r.content[0].text)).not.toThrow();
    const parsed = JSON.parse(r.content[0].text) as {
      truncated: boolean;
      preview: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe("string");
  });

  it("toolSuccess byte-slices a long plain string with a truncation note", () => {
    const r = toolSuccess("x".repeat(30_000));
    expect(r.content[0].text.length).toBeLessThan(26_000);
    expect(r.content[0].text).toContain("truncated");
    expect(r.content[0].text.startsWith("x")).toBe(true);
  });

  it("toolSuccess round-trips a small object payload unchanged", () => {
    const input = { totalPages: 3, pages: [{ page: 1, text: "hello" }] };
    const r = toolSuccess(input);
    expect(JSON.parse(r.content[0].text)).toEqual(input);
  });
});
