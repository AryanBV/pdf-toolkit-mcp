import React from "react";
import type { ReactElement, ReactNode } from "react";
import type ReactPDF from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type {
  Root,
  RootContent,
  PhrasingContent,
  Heading,
  List,
  ListItem,
  Table,
  TableRow,
  Code,
  Blockquote,
  Paragraph,
} from "mdast";

// ── react-pdf module shape (lazy-loaded) ─────────────────────────────────
// @react-pdf/renderer ships a CJS `export = ReactPDF` namespace. A dynamic
// import resolves to that namespace; `typeof ReactPDF` gives the static surface
// (Document, Page, View, Text, StyleSheet, renderToBuffer, …) we use.
type ReactPdfModule = typeof ReactPDF;

// Props/element types derived from the module so we never reference the
// `export =` namespace as a value (which TS rejects in type position).
type DocumentProps = React.ComponentProps<ReactPdfModule["Document"]>;
type DocumentElement = ReactElement<DocumentProps>;

export type { DocumentElement };

const h = React.createElement;

// ── Lazy module cache (keeps cold-start fast) ─────────────────────────────

let reactPdfPromise: Promise<ReactPdfModule> | undefined;

async function loadReactPdf(): Promise<ReactPdfModule> {
  if (!reactPdfPromise) {
    // `export = ReactPDF` interop: the full surface (Document, Page, View, Text,
    // StyleSheet, renderToBuffer, …) lives on the module namespace itself. The
    // `.default` only carries a partial set, so use the module record directly.
    reactPdfPromise = import("@react-pdf/renderer").then(
      (mod) => mod as unknown as ReactPdfModule,
    );
  }
  return reactPdfPromise;
}

interface RemarkStack {
  parse: (markdown: string) => Root;
}

let remarkPromise: Promise<RemarkStack> | undefined;

async function loadRemark(): Promise<RemarkStack> {
  if (!remarkPromise) {
    remarkPromise = (async () => {
      const [{ unified }, remarkParse, remarkGfm] = await Promise.all([
        import("unified"),
        import("remark-parse"),
        import("remark-gfm"),
      ]);
      const processor = unified()
        .use(remarkParse.default)
        .use(remarkGfm.default);
      return {
        parse: (markdown: string): Root =>
          processor.parse(markdown) as unknown as Root,
      };
    })();
  }
  return remarkPromise;
}

// ── Public types ──────────────────────────────────────────────────────────

export interface CreateFromMarkdownOptions {
  pageSize?: "A4" | "LETTER" | "LEGAL";
  title?: string;
  author?: string;
}

const PRODUCER = "@aryanbv/pdf-toolkit-mcp";

// ── Shared palette / metrics ──────────────────────────────────────────────

const COLOR_TEXT = "#1a1a1a";
const COLOR_MUTED = "#555555";
const COLOR_LINK = "#1a5fb4";
const COLOR_CODE_BG = "#f4f4f5";
const COLOR_CODE_TEXT = "#363636";
const COLOR_BORDER = "#d0d0d0";
const COLOR_HEADER_BG = "#f0f0f0";
const COLOR_QUOTE_BAR = "#cccccc";

// ── Markdown StyleSheet ────────────────────────────────────────────────────

function buildMarkdownStyles(StyleSheet: ReactPdfModule["StyleSheet"]) {
  return StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 56,
      paddingHorizontal: 48,
      fontSize: 11,
      lineHeight: 1.5,
      color: COLOR_TEXT,
      fontFamily: "Helvetica",
    },
    h1: {
      fontSize: 24,
      fontFamily: "Helvetica-Bold",
      marginTop: 4,
      marginBottom: 10,
    },
    h2: {
      fontSize: 19,
      fontFamily: "Helvetica-Bold",
      marginTop: 14,
      marginBottom: 8,
    },
    h3: {
      fontSize: 16,
      fontFamily: "Helvetica-Bold",
      marginTop: 12,
      marginBottom: 6,
    },
    h4: {
      fontSize: 13,
      fontFamily: "Helvetica-Bold",
      marginTop: 10,
      marginBottom: 5,
    },
    h5: {
      fontSize: 12,
      fontFamily: "Helvetica-Bold",
      marginTop: 8,
      marginBottom: 4,
    },
    h6: {
      fontSize: 11,
      fontFamily: "Helvetica-Bold",
      marginTop: 8,
      marginBottom: 4,
      color: COLOR_MUTED,
    },
    paragraph: { marginBottom: 8 },
    bold: { fontFamily: "Helvetica-Bold" },
    italic: { fontFamily: "Helvetica-Oblique" },
    boldItalic: { fontFamily: "Helvetica-BoldOblique" },
    strikethrough: { textDecoration: "line-through" },
    inlineCode: {
      fontFamily: "Courier",
      fontSize: 10,
      backgroundColor: COLOR_CODE_BG,
      color: COLOR_CODE_TEXT,
    },
    link: { color: COLOR_LINK, textDecoration: "underline" },
    listBlock: { marginBottom: 8, paddingLeft: 6 },
    listItem: { flexDirection: "row", marginBottom: 3 },
    listMarker: { width: 18, fontSize: 11 },
    listItemBody: { flex: 1 },
    codeBlock: {
      fontFamily: "Courier",
      fontSize: 9.5,
      backgroundColor: COLOR_CODE_BG,
      color: COLOR_CODE_TEXT,
      padding: 8,
      marginBottom: 10,
      borderRadius: 3,
      lineHeight: 1.4,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: COLOR_QUOTE_BAR,
      borderLeftStyle: "solid",
      paddingLeft: 10,
      marginBottom: 8,
      color: COLOR_MUTED,
    },
    hr: {
      borderBottomWidth: 1,
      borderBottomColor: COLOR_BORDER,
      borderBottomStyle: "solid",
      marginVertical: 10,
    },
    table: {
      marginBottom: 10,
      borderWidth: 1,
      borderColor: COLOR_BORDER,
      borderStyle: "solid",
    },
    tableRow: { flexDirection: "row" },
    tableHeaderRow: { flexDirection: "row", backgroundColor: COLOR_HEADER_BG },
    tableCell: {
      flex: 1,
      padding: 5,
      fontSize: 10,
      borderRightWidth: 1,
      borderRightColor: COLOR_BORDER,
      borderRightStyle: "solid",
      borderBottomWidth: 1,
      borderBottomColor: COLOR_BORDER,
      borderBottomStyle: "solid",
    },
    tableHeaderCell: { fontFamily: "Helvetica-Bold" },
    image: { marginVertical: 8, maxWidth: "100%" },
  });
}

type MarkdownStyles = ReturnType<typeof buildMarkdownStyles>;

// ── Inline (phrasing) rendering ────────────────────────────────────────────

interface InlineContext {
  rp: ReactPdfModule;
  styles: MarkdownStyles;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

function inlineStyleFor(ctx: InlineContext): Style | undefined {
  let base: Style | undefined;
  if (ctx.bold && ctx.italic) base = ctx.styles.boldItalic;
  else if (ctx.bold) base = ctx.styles.bold;
  else if (ctx.italic) base = ctx.styles.italic;
  // Strikethrough must combine with bold/italic and propagate to nested Text,
  // since react-pdf does not reliably inherit textDecoration across nesting.
  if (ctx.strike) return { ...(base ?? {}), textDecoration: "line-through" };
  return base;
}

function renderPhrasing(
  nodes: PhrasingContent[],
  ctx: InlineContext,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    const key = `${keyPrefix}-${i}`;
    out.push(renderInlineNode(node, ctx, key));
  });
  return out;
}

function renderInlineNode(
  node: PhrasingContent,
  ctx: InlineContext,
  key: string,
): ReactNode {
  const { Text, Link } = ctx.rp;

  switch (node.type) {
    case "text":
      return node.value;
    case "strong":
      return h(
        Text,
        { key, style: { ...inlineStyleFor({ ...ctx, bold: true }) } },
        ...renderPhrasing(node.children, { ...ctx, bold: true }, key),
      );
    case "emphasis":
      return h(
        Text,
        { key, style: { ...inlineStyleFor({ ...ctx, italic: true }) } },
        ...renderPhrasing(node.children, { ...ctx, italic: true }, key),
      );
    case "delete":
      return h(
        Text,
        { key, style: ctx.styles.strikethrough },
        ...renderPhrasing(node.children, { ...ctx, strike: true }, key),
      );
    case "inlineCode":
      return h(Text, { key, style: ctx.styles.inlineCode }, node.value);
    case "link":
      return h(
        Link,
        { key, src: node.url, style: ctx.styles.link },
        ...renderPhrasing(node.children, ctx, key),
      );
    case "break":
      return "\n";
    case "image":
      // Inline images are uncommon in flowing text; surface the alt text.
      return node.alt ? `[${node.alt}]` : "";
    default:
      // Unknown / unsupported phrasing (e.g. footnoteReference, html) — degrade
      // to any plain text value the node may carry.
      return "value" in node && typeof node.value === "string"
        ? node.value
        : "";
  }
}

// ── Block rendering ────────────────────────────────────────────────────────

interface BlockContext {
  rp: ReactPdfModule;
  styles: MarkdownStyles;
}

const HEADING_STYLE_KEYS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function renderHeading(
  node: Heading,
  ctx: BlockContext,
  key: string,
): ReactNode {
  const { Text } = ctx.rp;
  const styleKey = HEADING_STYLE_KEYS[node.depth - 1] ?? "h6";
  return h(
    Text,
    { key, style: ctx.styles[styleKey] },
    ...renderPhrasing(node.children, { rp: ctx.rp, styles: ctx.styles }, key),
  );
}

function renderParagraph(
  node: Paragraph,
  ctx: BlockContext,
  key: string,
): ReactNode {
  const { Text } = ctx.rp;
  return h(
    Text,
    { key, style: ctx.styles.paragraph },
    ...renderPhrasing(node.children, { rp: ctx.rp, styles: ctx.styles }, key),
  );
}

function renderCode(node: Code, ctx: BlockContext, key: string): ReactNode {
  const { View, Text } = ctx.rp;
  return h(
    View,
    { key, style: ctx.styles.codeBlock, wrap: true },
    h(Text, {}, node.value),
  );
}

function renderBlockquote(
  node: Blockquote,
  ctx: BlockContext,
  key: string,
): ReactNode {
  const { View } = ctx.rp;
  const children = renderBlockChildren(
    node.children as RootContent[],
    ctx,
    key,
  );
  return h(View, { key, style: ctx.styles.blockquote }, ...children);
}

function renderListItem(
  item: ListItem,
  ctx: BlockContext,
  marker: string,
  key: string,
): ReactNode {
  const { View, Text } = ctx.rp;
  const body = renderBlockChildren(item.children as RootContent[], ctx, key);
  return h(
    View,
    { key, style: ctx.styles.listItem, wrap: false },
    h(Text, { style: ctx.styles.listMarker }, marker),
    h(View, { style: ctx.styles.listItemBody }, ...body),
  );
}

function renderList(node: List, ctx: BlockContext, key: string): ReactNode {
  const { View } = ctx.rp;
  const ordered = node.ordered === true;
  const start = typeof node.start === "number" ? node.start : 1;

  const items = node.children.map((child, i) => {
    const marker = ordered ? `${start + i}.` : "•";
    return renderListItem(child, ctx, marker, `${key}-${i}`);
  });

  return h(View, { key, style: ctx.styles.listBlock }, ...items);
}

function renderTable(node: Table, ctx: BlockContext, key: string): ReactNode {
  const { View, Text } = ctx.rp;
  const rows = node.children as TableRow[];

  const renderRow = (row: TableRow, rowIdx: number): ReactNode => {
    const isHeader = rowIdx === 0;
    const rowStyle = isHeader ? ctx.styles.tableHeaderRow : ctx.styles.tableRow;
    const cells = row.children.map((cell, colIdx) => {
      const cellStyle: Style[] = [ctx.styles.tableCell];
      if (isHeader) cellStyle.push(ctx.styles.tableHeaderCell);
      return h(
        Text,
        { key: `${key}-r${rowIdx}-c${colIdx}`, style: cellStyle },
        ...renderPhrasing(
          cell.children,
          { rp: ctx.rp, styles: ctx.styles },
          `${key}-r${rowIdx}-c${colIdx}`,
        ),
      );
    });
    return h(
      View,
      { key: `${key}-r${rowIdx}`, style: rowStyle, wrap: false },
      ...cells,
    );
  };

  return h(
    View,
    { key, style: ctx.styles.table },
    ...rows.map((row, i) => renderRow(row, i)),
  );
}

function renderBlockNode(
  node: RootContent,
  ctx: BlockContext,
  key: string,
): ReactNode {
  const { View, Image } = ctx.rp;
  switch (node.type) {
    case "heading":
      return renderHeading(node, ctx, key);
    case "paragraph":
      return renderParagraph(node, ctx, key);
    case "list":
      return renderList(node, ctx, key);
    case "table":
      return renderTable(node, ctx, key);
    case "code":
      return renderCode(node, ctx, key);
    case "blockquote":
      return renderBlockquote(node, ctx, key);
    case "thematicBreak":
      return h(View, { key, style: ctx.styles.hr });
    case "image":
      return node.url
        ? h(Image, { key, src: node.url, style: ctx.styles.image })
        : null;
    default:
      // html, definition, footnoteDefinition, yaml, etc. — skip silently rather
      // than crash on a feature we don't render.
      return null;
  }
}

function renderBlockChildren(
  nodes: RootContent[],
  ctx: BlockContext,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    const rendered = renderBlockNode(node, ctx, `${keyPrefix}-b${i}`);
    if (rendered !== null) out.push(rendered);
  });
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Parse Markdown (CommonMark + GFM) into an mdast tree and render it to a PDF
 * via @react-pdf/renderer. Returns the raw PDF bytes.
 */
export async function createFromMarkdown(
  markdown: string,
  opts: CreateFromMarkdownOptions = {},
): Promise<Uint8Array> {
  const [rp, remark] = await Promise.all([loadReactPdf(), loadRemark()]);
  const { Document, Page, StyleSheet, renderToBuffer } = rp;

  const tree = remark.parse(markdown);
  const styles = buildMarkdownStyles(StyleSheet);
  const ctx: BlockContext = { rp, styles };

  const body = renderBlockChildren(tree.children, ctx, "md");

  const pageSize = opts.pageSize ?? "A4";

  const docProps: DocumentProps = { producer: PRODUCER };
  if (opts.title) docProps.title = opts.title;
  if (opts.author) docProps.author = opts.author;

  const element = h(
    Document,
    docProps,
    h(Page, { size: pageSize, style: styles.page, wrap: true }, ...body),
  ) as DocumentElement;

  const buffer = await renderToBuffer(element);
  return new Uint8Array(buffer);
}

/**
 * Render a pre-built react-pdf `<Document>` element to PDF bytes. Templates
 * produce the element; this helper performs the single render step.
 */
export async function renderTemplate(
  element: DocumentElement,
): Promise<Uint8Array> {
  const { renderToBuffer } = await loadReactPdf();
  const buffer = await renderToBuffer(element);
  return new Uint8Array(buffer);
}

/**
 * Lazy accessor for the react-pdf primitives that templates build their trees
 * with. Loading is shared with the markdown pipeline via the module cache.
 */
export async function getReactPdf(): Promise<ReactPdfModule> {
  return loadReactPdf();
}

export { PRODUCER };
