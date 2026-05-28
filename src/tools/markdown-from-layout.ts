import type { PageTextLayout, PositionedTextItem } from "../types.js";

// A run of items on the same baseline, ordered left-to-right.
interface Line {
  x: number; // left edge of the first item
  y: number; // baseline (PDF user space: larger y = higher on the page)
  text: string;
  fontSize: number; // representative (max) font size on the line
}

interface Column {
  minX: number;
  maxX: number;
  items: PositionedTextItem[];
}

const HEADING_SCALE_RATIO = 1.15; // a line must be ≥ this × body size to be a heading
const PARAGRAPH_GAP_RATIO = 1.6; // vertical gap (× line height) that splits paragraphs
const SAME_LINE_RATIO = 0.6; // items within this × font size of each other share a line
const COLUMN_GAP_RATIO = 3; // horizontal gap (× median char width) that splits columns

const BULLET_RE = /^[-•*‣◦·]\s+/;
const NUMBERED_RE = /^(\d{1,3})[.)]\s+/;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Detect columns by clustering item x-positions. We sort items by their left
 * edge and split into a new column wherever a horizontal gap between the running
 * column's right edge and the next item exceeds a multiple of the typical glyph
 * width. Single-column documents collapse to one column.
 */
function detectColumns(items: PositionedTextItem[]): Column[] {
  if (items.length === 0) return [];

  const charWidth =
    median(
      items
        .filter((i) => i.str.length > 0)
        .map((i) => i.width / Math.max(i.str.length, 1)),
    ) || median(items.map((i) => i.fontSize)) * 0.5;
  const gapThreshold = charWidth * COLUMN_GAP_RATIO * 4;

  const byX = [...items].sort((a, b) => a.x - b.x);
  const columns: Column[] = [];
  let current: Column | null = null;

  for (const item of byX) {
    const right = item.x + item.width;
    if (current === null || item.x - current.maxX > gapThreshold) {
      current = { minX: item.x, maxX: right, items: [item] };
      columns.push(current);
    } else {
      current.items.push(item);
      if (right > current.maxX) current.maxX = right;
    }
  }

  // Guard against over-segmentation: if columns are narrow and numerous relative
  // to the content, a single-column reading order is safer than fragmenting.
  if (columns.length > 3) {
    return [
      {
        minX: byX[0].x,
        maxX: Math.max(...byX.map((i) => i.x + i.width)),
        items,
      },
    ];
  }

  return columns;
}

/**
 * Group a column's items into lines by baseline proximity, then order lines
 * top-to-bottom. Items sharing a baseline (within a fraction of font size) are
 * merged left-to-right with single spaces between fragments.
 */
function groupLines(items: PositionedTextItem[]): Line[] {
  if (items.length === 0) return [];

  // Sort top-to-bottom (descending y in PDF space), then left-to-right.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  let bucket: PositionedTextItem[] = [];
  let bucketY = sorted[0].y;

  const flush = (): void => {
    if (bucket.length === 0) return;
    const ordered = [...bucket].sort((a, b) => a.x - b.x);
    const fontSize = Math.max(...ordered.map((i) => i.fontSize));
    const text = ordered
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) {
      lines.push({ x: ordered[0].x, y: bucketY, text, fontSize });
    }
    bucket = [];
  };

  for (const item of sorted) {
    const tolerance = item.fontSize * SAME_LINE_RATIO;
    if (bucket.length === 0 || Math.abs(item.y - bucketY) <= tolerance) {
      bucket.push(item);
      // Track the topmost baseline of the bucket for stable ordering.
      bucketY = bucket.length === 1 ? item.y : bucketY;
    } else {
      flush();
      bucket.push(item);
      bucketY = item.y;
    }
  }
  flush();

  return lines;
}

/**
 * Map a line's font size to a Markdown heading level relative to the document's
 * body font size. The three largest distinct sizes above the body size become
 * #, ##, ### respectively; everything else stays a paragraph.
 */
function headingLevelFor(
  fontSize: number,
  bodySize: number,
  headingSizes: number[],
): number {
  if (bodySize <= 0) return 0;
  if (fontSize < bodySize * HEADING_SCALE_RATIO) return 0;
  const idx = headingSizes.findIndex((s) => Math.abs(s - fontSize) < 0.5);
  if (idx === -1) return 0;
  return Math.min(idx + 1, 3);
}

function renderLine(
  line: Line,
  level: number,
): { md: string; isList: boolean } {
  const text = line.text;

  const bullet = BULLET_RE.exec(text);
  if (bullet) {
    return { md: `- ${text.slice(bullet[0].length).trim()}`, isList: true };
  }
  const numbered = NUMBERED_RE.exec(text);
  if (numbered) {
    return {
      md: `${numbered[1]}. ${text.slice(numbered[0].length).trim()}`,
      isList: true,
    };
  }
  if (level > 0) {
    return { md: `${"#".repeat(level)} ${text}`, isList: false };
  }
  return { md: text, isList: false };
}

/**
 * Reconstruct reading-order Markdown from a single page's positioned text.
 */
function pageToMarkdown(layout: PageTextLayout): string {
  if (layout.items.length === 0) return "";

  // Body font size = the most common (modal) size, approximated by the median.
  const bodySize = median(layout.items.map((i) => i.fontSize)) || 0;

  // Distinct heading sizes, largest first, that exceed the body size.
  const headingSizes = [
    ...new Set(
      layout.items
        .map((i) => Math.round(i.fontSize * 2) / 2)
        .filter((s) => s >= bodySize * HEADING_SCALE_RATIO),
    ),
  ].sort((a, b) => b - a);

  const columns = detectColumns(layout.items).sort((a, b) => a.minX - b.minX);

  const blocks: string[] = [];

  for (const column of columns) {
    const lines = groupLines(column.items);
    if (lines.length === 0) continue;

    // Median baseline gap → paragraph-break threshold for this column.
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      gaps.push(lines[i - 1].y - lines[i].y);
    }
    const medianGap = median(gaps);

    let paragraph: string[] = [];
    let prevWasList = false;

    const flushParagraph = (): void => {
      if (paragraph.length === 0) return;
      blocks.push(paragraph.join(" "));
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const level = headingLevelFor(line.fontSize, bodySize, headingSizes);
      const { md, isList } = renderLine(line, level);

      const gapAbove = i > 0 ? lines[i - 1].y - line.y : 0;
      const bigGap =
        i > 0 && medianGap > 0 && gapAbove > medianGap * PARAGRAPH_GAP_RATIO;

      if (level > 0) {
        // Headings are always their own block.
        flushParagraph();
        blocks.push(md);
        prevWasList = false;
        continue;
      }

      if (isList) {
        flushParagraph();
        blocks.push(md);
        prevWasList = true;
        continue;
      }

      if (prevWasList || bigGap) {
        flushParagraph();
      }
      paragraph.push(md);
      prevWasList = false;
    }
    flushParagraph();
  }

  return blocks.join("\n\n").trim();
}

/**
 * Convert multi-page positioned layouts into a single Markdown document.
 * Pages are separated by a thematic break (`---`).
 */
export function layoutToMarkdown(layouts: PageTextLayout[]): string {
  const pages = layouts
    .map((layout) => pageToMarkdown(layout))
    .filter((md) => md.length > 0);
  return pages.join("\n\n---\n\n");
}
