import { describe, it, expect } from "vitest";
import {
  parsePageRange,
  validatePdfPath,
  validateImagePath,
  validateFontPath,
  validateOutputPath,
} from "../../src/utils/validation.js";
import { formatBytes } from "../../src/utils/file-utils.js";
import { PdfError } from "../../src/utils/errors.js";

/** Capture the PdfError thrown by `fn`, or fail if nothing is thrown. */
async function catchPdfError(fn: () => unknown): Promise<PdfError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PdfError) return err;
    throw new Error(
      `Expected a PdfError but got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error("Expected a PdfError to be thrown, but none was");
}

describe("parsePageRange", () => {
  it("parses a single page (1-based input → 0-based output)", () => {
    expect(parsePageRange("3", 10)).toEqual([2]);
  });

  it("parses a comma list and a range, de-duped and sorted", () => {
    expect(parsePageRange("1,3,2-3", 10)).toEqual([0, 1, 2]);
  });

  it.each(["0", "5-2", "abc", "1,,3", "3.5", "3abc", "-3", "1-", "", " "])(
    "rejects malformed segment %j with INVALID_INPUT",
    async (input) => {
      const err = await catchPdfError(() => parsePageRange(input, 10));
      expect(err.code).toBe("INVALID_INPUT");
    },
  );

  it("rejects an out-of-bounds single page with PAGE_OUT_OF_RANGE", async () => {
    const err = await catchPdfError(() => parsePageRange("11", 10));
    expect(err.code).toBe("PAGE_OUT_OF_RANGE");
  });

  it("rejects an out-of-bounds range with PAGE_OUT_OF_RANGE", async () => {
    const err = await catchPdfError(() => parsePageRange("8-12", 10));
    expect(err.code).toBe("PAGE_OUT_OF_RANGE");
  });
});

describe("validatePdfPath", () => {
  it("rejects a non-.pdf extension with NOT_A_PDF", async () => {
    const err = await catchPdfError(() => validatePdfPath("C:/tmp/file.txt"));
    expect(err.code).toBe("NOT_A_PDF");
  });

  it("rejects a missing .pdf file with FILE_NOT_FOUND", async () => {
    const err = await catchPdfError(() =>
      validatePdfPath("C:/tmp/does-not-exist-xyz.pdf"),
    );
    expect(err.code).toBe("FILE_NOT_FOUND");
  });
});

describe("validateImagePath", () => {
  it("rejects an unsupported image format with UNSUPPORTED_FORMAT", async () => {
    const err = await catchPdfError(() =>
      validateImagePath("C:/tmp/image.gif"),
    );
    expect(err.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("rejects a missing supported image with FILE_NOT_FOUND", async () => {
    const err = await catchPdfError(() =>
      validateImagePath("C:/tmp/does-not-exist-xyz.png"),
    );
    expect(err.code).toBe("FILE_NOT_FOUND");
  });
});

describe("validateFontPath", () => {
  it("rejects a non-font extension with UNSUPPORTED_FORMAT", async () => {
    const err = await catchPdfError(() => validateFontPath("C:/tmp/font.pdf"));
    expect(err.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("rejects a missing font with FILE_NOT_FOUND", async () => {
    const err = await catchPdfError(() =>
      validateFontPath("C:/tmp/does-not-exist-xyz.ttf"),
    );
    expect(err.code).toBe("FILE_NOT_FOUND");
  });
});

describe("formatBytes (ERR-3 unit scaling)", () => {
  it("reports raw bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales to KB", () => {
    expect(formatBytes(12_300)).toBe("12.0 KB");
  });

  it("scales to MB instead of huge KB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("scales to GB for very large files", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("validateOutputPath", () => {
  it("rejects a non-.pdf output with INVALID_INPUT", async () => {
    const err = await catchPdfError(() => validateOutputPath("C:/tmp/out.txt"));
    expect(err.code).toBe("INVALID_INPUT");
  });

  it("rejects a missing parent directory with INVALID_INPUT", async () => {
    const err = await catchPdfError(() =>
      validateOutputPath("C:/no-such-dir-xyz/sub/out.pdf"),
    );
    expect(err.code).toBe("INVALID_INPUT");
  });
});
