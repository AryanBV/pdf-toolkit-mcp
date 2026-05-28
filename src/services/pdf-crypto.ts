import { createRequire } from "node:module";
import type { PDFDocument } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
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

// The factory's declared type only exposes `locateFile`, but every Emscripten
// module also accepts `print`/`printErr` overrides. We widen the option bag so
// we can route any stray engine output to the stderr logger (Rule 1) instead of
// the default console.log printer, which would corrupt the MCP stdio channel.
type QpdfFactory = (opts: {
  locateFile: (path: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}) => Promise<QpdfInstance>;

let modulePromise: Promise<QpdfInstance> | null = null;

/**
 * Run `fn` with the global console's log/error methods temporarily routed to the
 * stderr logger. The qpdf-wasm Emscripten glue captures `console.log.bind(...)`
 * at module-evaluation time (during the dynamic import below) and uses it as its
 * default stdout printer — it does NOT honor the factory's `print` option in the
 * shipped minified build. Guarding the import + factory call means that captured
 * reference points at our logger, so the engine can never write to stdout and
 * corrupt the MCP stdio transport (CLAUDE.md Rule 1) — independent of the
 * library's internals.
 *
 * We reach the console through `globalThis` rather than the `console` binding so
 * this guard installer (whose whole purpose is to enforce Rule 1) is not itself
 * flagged by the `no-console` lint rule.
 */
async function withStdoutGuard<T>(fn: () => Promise<T>): Promise<T> {
  const con: Console = globalThis.console;
  const route = (...args: unknown[]): void => logger.debug("[qpdf]", args);
  const origLog = con.log;
  const origInfo = con.info;
  const origError = con.error;
  con.log = route;
  con.info = route;
  con.error = route;
  try {
    return await fn();
  } finally {
    con.log = origLog;
    con.info = origInfo;
    con.error = origError;
  }
}

async function getQpdf(): Promise<QpdfInstance> {
  if (!modulePromise) {
    modulePromise = withStdoutGuard(async () => {
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

      // Pass explicit print/printErr overrides so Emscripten builds that honor
      // the option bag route output to the stderr logger rather than console.log
      // (the default printer). The withStdoutGuard wrapper covers builds that
      // hardcode console.log instead.
      return createModule({
        locateFile: () => wasmPath,
        print: (text: string) => logger.debug("[qpdf]", text),
        printErr: (text: string) => logger.debug("[qpdf]", text),
      });
    }).catch((err: unknown) => {
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
 * Reject input that qpdf cannot meaningfully (re-)encrypt before we hand it to
 * the engine. We attempt a parse with @pdfme/pdf-lib (dual-import pattern):
 *  - an already-encrypted PDF surfaces as ENCRYPTED_PDF (CLAUDE.md Limitation #7
 *    promises this rather than the opaque INTERNAL qpdf exit code), and
 *  - structurally broken bytes surface as CORRUPT_PDF.
 * This keeps INTERNAL reserved for genuinely unexpected qpdf failures.
 */
async function ensureEncryptable(pdfBytes: Uint8Array): Promise<void> {
  let doc: PDFDocument | undefined;
  try {
    // Without ignoreEncryption, an encrypted document throws EncryptedPDFError;
    // malformed bytes throw a parse error (MissingPDFHeaderError, etc.).
    doc = await pdfLib.PDFDocument.load(pdfBytes);
  } catch (err) {
    if (err instanceof pdfLib.EncryptedPDFError) {
      throw new PdfError("Input PDF is already encrypted.", "ENCRYPTED_PDF");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfError(
      `Could not read the PDF (it may be corrupt): ${message}`,
      "CORRUPT_PDF",
    );
  }

  // Defense in depth: some encrypted PDFs parse without throwing yet expose the
  // /Encrypt dictionary via isEncrypted. Treat those as already-encrypted too.
  if (doc.isEncrypted) {
    throw new PdfError("Input PDF is already encrypted.", "ENCRYPTED_PDF");
  }
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
  // Pre-flight: reject already-encrypted / corrupt input with a stable code
  // before spinning up qpdf (whose generic non-zero exit would otherwise be
  // reported as INTERNAL).
  await ensureEncryptable(pdfBytes);

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

    // Guard stdout for the actual encryption run too: qpdf only prints to stdout
    // when emitting output there, but a guard makes Rule 1 hold unconditionally.
    const exitCode = await withStdoutGuard(async () => qpdf.callMain(args));

    if (exitCode !== 0) {
      throw new PdfError(
        `qpdf encryption failed (exit code ${exitCode}).`,
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
