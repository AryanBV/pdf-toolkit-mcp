import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import pdfLib from "@pdfme/pdf-lib";

// Integration coverage for the pdf-crypto service via the real stdio server.
// Owned by the CRYPTO agent — exercises:
//   ENC-1: an already-encrypted input yields a coded ENCRYPTED_PDF error
//          (not the opaque INTERNAL it produced before pre-flight detection).
//   AES-256: encrypted output carries the /AESV3 crypt filter.
// The stdout-pollution regression (ENC-2) is covered globally by stdio.test.ts;
// here we assert no error response ever leaks a stack frame.

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);

interface ToolResultLike {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function textOf(result: ToolResultLike): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

const NO_STACK = /\bat .*\(.*:\d+:\d+\)/;

async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (const line of lines) {
    const page = doc.addPage([300, 400]);
    page.drawText(line, { x: 20, y: 360, size: 12 });
  }
  return doc.save();
}

describe("pdf_encrypt service (AES-256 + already-encrypted detection)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({
      name: "crypto-service-test-client",
      version: "0.0.0",
    });
    await client.connect(transport);
    workDir = await mkdtemp(join(tmpdir(), "pdf-crypto-svc-test-"));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ── ENC-1 happy path: produces genuine AES-256 output ────────────────
  it("produces AES-256 encrypted output (verifiable in the bytes)", async () => {
    const inputPath = join(workDir, "plain.pdf");
    const outputPath = join(workDir, "enc.pdf");
    await writeFile(inputPath, await makePdf(["Top secret"]));

    const result = (await client.callTool({
      name: "pdf_encrypt",
      arguments: { filePath: inputPath, outputPath, userPassword: "hunter2" },
    })) as ToolResultLike;

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.encryption).toBe("AES-256");
    expect(payload.fileSize).toMatch(/KB$/);

    // AES-256 is the /AESV3 crypt filter (V=5/R=6) inside an /Encrypt dict.
    const asLatin1 = Buffer.from(await readFile(outputPath)).toString("latin1");
    expect(asLatin1).toContain("/Encrypt");
    expect(asLatin1).toContain("/AESV3");
  }, 30_000);

  // ── ENC-1: feeding an encrypted PDF back in yields ENCRYPTED_PDF ─────
  it("returns a coded ENCRYPTED_PDF error for an already-encrypted input", async () => {
    const plainPath = join(workDir, "plain-for-double.pdf");
    const encryptedPath = join(workDir, "already-encrypted.pdf");
    const reEncryptPath = join(workDir, "re-encrypt-out.pdf");
    await writeFile(plainPath, await makePdf(["Encrypt me once"]));

    // Step 1: produce a genuinely AES-256 encrypted PDF via the tool itself.
    const first = (await client.callTool({
      name: "pdf_encrypt",
      arguments: {
        filePath: plainPath,
        outputPath: encryptedPath,
        userPassword: "firstpass",
      },
    })) as ToolResultLike;
    expect(first.isError).toBeFalsy();

    // Step 2: feed the encrypted output back in — pre-flight detection must
    // surface a stable ENCRYPTED_PDF code, NOT the opaque INTERNAL qpdf path.
    const second = (await client.callTool({
      name: "pdf_encrypt",
      arguments: {
        filePath: encryptedPath,
        outputPath: reEncryptPath,
        userPassword: "secondpass",
      },
    })) as ToolResultLike;

    expect(second.isError).toBe(true);
    const text = textOf(second);
    expect(text).toContain("ENCRYPTED_PDF");
    expect(text).toMatch(/already encrypted/i);
    expect(text).not.toContain("INTERNAL");
    expect(text).not.toMatch(NO_STACK); // no leaked stack frames
  }, 30_000);

  // ── corrupt input maps to a clean coded error, never a stack ─────────
  it("returns a clean CORRUPT_PDF error for garbage bytes", async () => {
    const garbagePath = join(workDir, "garbage.pdf");
    await writeFile(garbagePath, "this is not a pdf at all\n");

    const result = (await client.callTool({
      name: "pdf_encrypt",
      arguments: {
        filePath: garbagePath,
        outputPath: join(workDir, "garbage-out.pdf"),
        userPassword: "x",
      },
    })) as ToolResultLike;

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("CORRUPT_PDF");
    expect(text).not.toMatch(NO_STACK);
  }, 30_000);
});
