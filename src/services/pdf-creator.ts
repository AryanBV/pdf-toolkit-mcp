import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { marked } from "marked";
import { JSDOM } from "jsdom";
import pdfLib from "@pdfme/pdf-lib";
import { getFileSize } from "../utils/file-utils.js";

// ── pdfmake CJS setup (Rule 15) ────────────────────────────────────────
// pdfmake and html-to-pdfmake are CJS packages — use createRequire()
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pdfMake: PdfMakeStatic = require("pdfmake/build/pdfmake");
const pdfFonts: Record<string, string> = require("pdfmake/build/vfs_fonts");
const htmlToPdfmake: HtmlToPdfmakeFn = require("html-to-pdfmake");

pdfMake.addVirtualFileSystem(pdfFonts);

// ── Internal types for CJS interop ──────────────────────────────────────

interface PdfMakeStatic {
  addVirtualFileSystem: (vfs: Record<string, string>) => void;
  createPdf: (docDefinition: PdfDocDefinition) => {
    getBuffer: () => Promise<Uint8Array>;
  };
}

type HtmlToPdfmakeFn = (
  html: string,
  options: { window: unknown }
) => unknown[];

// Loose doc definition that works with html-to-pdfmake's dynamic output
interface PdfDocDefinition {
  content: unknown;
  pageSize?: string;
  styles?: Record<string, Record<string, unknown>>;
  defaultStyle?: Record<string, unknown>;
  info?: Record<string, unknown>;
  header?: unknown;
  footer?: unknown;
}

// ── Public types ────────────────────────────────────────────────────────

export interface CreateFromMarkdownOptions {
  markdown: string;
  outputPath: string;
  pageSize?: "A4" | "LETTER" | "LEGAL";
  title?: string;
  author?: string;
  pageNumbers?: boolean;
  headerText?: string;
  footerText?: string;
}

export interface CreateResult {
  outputPath: string;
  pageCount: number;
  fileSize: string;
}

// ── Default styles for Markdown content ─────────────────────────────────

const DEFAULT_STYLES: Record<string, Record<string, unknown>> = {
  "html-h1": { fontSize: 24, bold: true, marginBottom: 8, marginTop: 16 },
  "html-h2": { fontSize: 20, bold: true, marginBottom: 6, marginTop: 14 },
  "html-h3": { fontSize: 16, bold: true, marginBottom: 4, marginTop: 12 },
  "html-h4": { fontSize: 14, bold: true, marginBottom: 4, marginTop: 10 },
  "html-h5": { fontSize: 12, bold: true, marginBottom: 2, marginTop: 8 },
  "html-h6": { fontSize: 10, bold: true, marginBottom: 2, marginTop: 6 },
  "html-code": { font: "Roboto", fontSize: 9, color: "#333333", background: "#f5f5f5" },
  "html-pre": { font: "Roboto", fontSize: 9, color: "#333333", background: "#f5f5f5", margin: [0, 8, 0, 8] },
};

// ── Public API ──────────────────────────────────────────────────────────

export async function createFromMarkdown(
  options: CreateFromMarkdownOptions
): Promise<CreateResult> {
  const {
    markdown,
    outputPath,
    pageSize = "A4",
    title,
    author,
    pageNumbers = false,
    headerText,
    footerText,
  } = options;

  const html = await marked.parse(markdown);

  const { window } = new JSDOM("");
  try {
    const content = htmlToPdfmake(html, { window });

    const docDefinition: PdfDocDefinition = {
      content,
      pageSize,
      styles: DEFAULT_STYLES,
      defaultStyle: { fontSize: 11, lineHeight: 1.4 },
      info: {
        title: title ?? undefined,
        author: author ?? undefined,
        producer: "@aryanbv/pdf-toolkit-mcp",
      },
    };

    if (pageNumbers || footerText) {
      docDefinition.footer = (currentPage: number, pageCount: number) => {
        const parts: Record<string, unknown>[] = [];
        if (footerText) {
          parts.push({
            text: footerText,
            alignment: "center",
            fontSize: 8,
            color: "#888888",
            margin: [0, 0, 0, 2],
          });
        }
        if (pageNumbers) {
          parts.push({
            text: `Page ${currentPage} of ${pageCount}`,
            alignment: "center",
            fontSize: 9,
            color: "#888888",
          });
        }
        return { stack: parts, margin: [40, 10, 40, 0] };
      };
    }

    if (headerText) {
      docDefinition.header = () => ({
        text: headerText,
        alignment: "center",
        fontSize: 8,
        color: "#888888",
        margin: [40, 10, 40, 0],
      });
    }

    return await renderDocDefinition(docDefinition, outputPath);
  } finally {
    window.close();
  }
}

export async function renderDocDefinition(
  docDefinition: PdfDocDefinition,
  outputPath: string
): Promise<CreateResult> {
  // Ensure producer metadata (Rule 18)
  if (!docDefinition.info) {
    docDefinition.info = {};
  }
  docDefinition.info.producer = "@aryanbv/pdf-toolkit-mcp";

  const doc = pdfMake.createPdf(docDefinition);
  const buffer = await doc.getBuffer();

  await writeFile(outputPath, buffer);

  // Get page count by loading with @pdfme/pdf-lib
  const pdfDoc = await pdfLib.PDFDocument.load(buffer);
  const pageCount = pdfDoc.getPageCount();

  const fileSize = await getFileSize(outputPath);

  return { outputPath, pageCount, fileSize };
}
