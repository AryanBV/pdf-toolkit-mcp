import { createRequire } from "node:module";
import { PdfError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// qpdf compiled to WASM is an Emscripten CLI port. Its initialization (compiling
// + instantiating the ~megabyte .wasm) costs hundreds of ms, so it is loaded
// lazily on first encrypt and cached as a single shared instance promise. On a
// transient init failure the cache is reset so a later call can retry cleanly —
// the same pattern src/services/pdf-renderer.ts uses for PDFium.

// The package's bundled .d.ts is incomplete (its EmscriptenFS omits writeFile,
// readFile's return, and unlink), so we declare the minimal surface we rely on.
interface QpdfFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

interface QpdfInstance {
  callMain(args: string[]): number;
  FS: QpdfFS;
}

type QpdfFactory = (opts: {
  locateFile: (path: string) => string;
}) => Promise<QpdfInstance>;

let modulePromise: Promise<QpdfInstance> | null = null;

async function getQpdf(): Promise<QpdfInstance> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Dynamic import INSIDE the function so the WASM module is only resolved
      // and instantiated when an encryption is actually requested.
      const imported = (await import("@neslinesli93/qpdf-wasm")) as unknown as {
        default: QpdfFactory;
      };
      const createModule = imported.default;

      // Resolve the bundled qpdf.wasm next to the package's dist/qpdf.js entry so
      // Emscripten's locateFile finds it regardless of the current working dir.
      const require = createRequire(import.meta.url);
      const wasmPath =
        require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm");

      return createModule({
        locateFile: () => wasmPath,
      });
    })().catch((err: unknown) => {
      // Reset so a transient failure does not poison every future call.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

const INPUT_PATH = "/in.pdf";
const OUTPUT_PATH = "/out.pdf";

export interface EncryptOptions {
  userPassword: string;
  ownerPassword?: string;
  keyLength?: 256 | 128;
}

/**
 * Encrypt a PDF with AES (256-bit by default) using qpdf-wasm. The owner
 * password defaults to the user password when omitted. Returns the encrypted
 * PDF bytes.
 */
export async function encryptPdf(
  pdfBytes: Uint8Array,
  opts: EncryptOptions,
): Promise<Uint8Array> {
  let qpdf: QpdfInstance;
  try {
    qpdf = await getQpdf();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Failed to initialize the PDF encryption engine (qpdf WASM): ${message}`,
      "WASM_LOAD_FAILED",
    );
  }

  const keyLength = opts.keyLength ?? 256;
  // An empty owner password tells qpdf "no owner password", which silently
  // removes permission protection — treat it (and undefined) as "reuse the user
  // password" so the document is never weaker than the caller intended.
  const ownerPassword =
    opts.ownerPassword && opts.ownerPassword.length > 0
      ? opts.ownerPassword
      : opts.userPassword;

  const { FS } = qpdf;

  try {
    FS.writeFile(INPUT_PATH, pdfBytes);

    // qpdf CLI: <infile> --encrypt <user> <owner> <bits> -- <outfile>
    // The bare "--" terminates the --encrypt sub-option list. With bits=256 qpdf
    // uses AES-256 (the /AESV3 crypt filter, V=5/R=6). 128-bit uses RC4, which
    // qpdf refuses to emit unless --allow-weak-crypto is passed; we add it only
    // for the explicitly-requested legacy path so the default stays strong.
    const args = [INPUT_PATH];
    if (keyLength === 128) {
      args.push("--allow-weak-crypto");
    }
    args.push(
      "--encrypt",
      opts.userPassword,
      ownerPassword,
      String(keyLength),
      "--",
      OUTPUT_PATH,
    );

    const exitCode = qpdf.callMain(args);

    if (exitCode !== 0) {
      throw new PdfError(
        `qpdf encryption failed (exit code ${exitCode}). The input may be corrupt or already encrypted.`,
        "INTERNAL",
      );
    }

    const encrypted = FS.readFile(OUTPUT_PATH);
    // Copy out of the WASM heap-backed view before the FS files are unlinked so
    // the returned bytes are not invalidated by later FS activity.
    return new Uint8Array(encrypted);
  } catch (err) {
    if (err instanceof PdfError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(`PDF encryption failed: ${message}`, "INTERNAL");
  } finally {
    for (const path of [INPUT_PATH, OUTPUT_PATH]) {
      try {
        FS.unlink(path);
      } catch (err) {
        // The output file may not exist if callMain failed before writing it;
        // a failed cleanup is non-fatal.
        logger.debug(`qpdf FS cleanup skipped for ${path}`, err);
      }
    }
  }
}
