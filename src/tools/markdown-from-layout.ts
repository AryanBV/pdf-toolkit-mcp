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
const COLUMN_GAP_RATIO = 12; // horizontal gap (× median char width) that splits columns

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
 * Body font size = the MODAL (most frequent) size on the page, weighted by the
 * amount of TEXT set at each size (character count), not by item count. This is
 * far more robust than the median for heading inference: a document that is
 * mostly headings (e.g. a table of contents or a slide) would have a *heading*
 * size as its median, so real headings would not clear the heading threshold
 * and body text could be misclassified. The size carrying the most characters
 * is the true body text by definition. Ties resolve to the smaller size, since
 * body copy is generally smaller than the headings that punctuate it.
 */
function modalFontSize(items: PositionedTextItem[]): number {
  if (items.length === 0) return 0;

  // Bucket by half-point so near-identical glyph sizes (anti-aliasing /
  // sub-pixel matrix noise) collapse to one body size.
  const weightBySize = new Map<number, number>();
  for (const item of items) {
    const bucket = Math.round(item.fontSize * 2) / 2;
    const weight = Math.max(item.str.length, 1);
    weightBySize.set(bucket, (weightBySize.get(bucket) ?? 0) + weight);
  }

  let bestSize = 0;
  let bestWeight = -1;
  for (const [size, weight] of weightBySize) {
    if (weight > bestWeight || (weight === bestWeight && size < bestSize)) {
      bestWeight = weight;
      bestSize = size;
    }
  }
  return bestSize;
}

/** Group items into rough rows by baseline proximity (top-to-bottom). */
function clusterRows(items: PositionedTextItem[]): PositionedTextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: PositionedTextItem[][] = [];
  let bucket: PositionedTextItem[] = [];
  let bucketY = sorted.length > 0 ? sorted[0].y : 0;
  let bucketFontSize = sorted.length > 0 ? sorted[0].fontSize : 0;

  for (const item of sorted) {
    const dominant = Math.max(bucketFontSize, item.fontSize);
    const tolerance = dominant * SAME_LINE_RATIO;
    if (bucket.length === 0) {
      bucket = [item];
      bucketY = item.y;
      bucketFontSize = item.fontSize;
    } else if (Math.abs(item.y - bucketY) <= tolerance) {
      bucket.push(item);
      bucketFontSize = dominant;
    } else {
      rows.push(bucket);
      bucket = [item];
      bucketY = item.y;
      bucketFontSize = item.fontSize;
    }
  }
  if (bucket.length > 0) rows.push(bucket);
  return rows;
}

/** A whole-page column spanning a body of items, plus its vertical extent. */
function makeColumn(items: PositionedTextItem[]): Column {
  return {
    minX: Math.min(...items.map((i) => i.x)),
    maxX: Math.max(...items.map((i) => i.x + i.width)),
    items,
  };
}

/**
 * Detect columns with a whitespace-river approach. We find candidate vertical
 * gutters from horizontal x-gaps, then accept a gutter only if it stays empty
 * across the MAJORITY of text rows. Rows that cross the gutter (e.g. a spanning
 * title or footer) are emitted as full-width bands rather than collapsing the
 * two-column detection. The reading order is band-aware: title band → left
 * column → right column → footer band. A genuinely single-column page returns
 * exactly one column (byte-identical to the prior behavior). A page that
 * fragments into more than 2 content columns falls back to honest
 * single-column reading order (over-segmentation guard) rather than
 * interleaving columns this 2-column model cannot represent.
 */
function detectColumns(items: PositionedTextItem[]): Column[] {
  if (items.length === 0) return [];

  const charWidth =
    median(
      items
        .filter((i) => i.str.length > 0)
        .map((i) => i.width / Math.max(i.str.length, 1)),
    ) || median(items.map((i) => i.fontSize)) * 0.5;
  const gapThreshold = charWidth * COLUMN_GAP_RATIO;

  const singleColumn: Column[] = [makeColumn(items)];

  const rows = clusterRows(items);
  if (rows.length === 0) return singleColumn;

  // Whitespace-river gutter detection. Each row contributes the empty x-gaps
  // BETWEEN its consecutive items (gaps wider than the column threshold). A
  // real gutter is one whose river is shared by many rows — unlike a single
  // spanning title, which simply contributes no gap. This is robust to a
  // full-width line that would otherwise bridge a naive left-to-right maxX
  // sweep and collapse the two columns.
  const candidateGaps: { start: number; end: number }[] = [];
  for (const row of rows) {
    const sortedRow = [...row].sort((a, b) => a.x - b.x);
    let runningRight = sortedRow[0].x + sortedRow[0].width;
    for (let i = 1; i < sortedRow.length; i++) {
      const left = sortedRow[i].x;
      if (left - runningRight > gapThreshold) {
        candidateGaps.push({ start: runningRight, end: left });
      }
      runningRight = Math.max(
        runningRight,
        sortedRow[i].x + sortedRow[i].width,
      );
    }
  }
  if (candidateGaps.length === 0) return singleColumn;

  // The dominant gutter is the candidate x (gap midpoint) that the most rows
  // keep clear AND that has text on both sides; pick the one with the broadest
  // row support, breaking ties toward the widest river.
  const intrudes = (row: PositionedTextItem[], x: number): boolean =>
    row.some((i) => i.x < x && i.x + i.width > x);
  let gutterStart = 0;
  let gutterEnd = 0;
  let bestScore = -1;
  for (const gap of candidateGaps) {
    const mid = (gap.start + gap.end) / 2;
    let clear = 0;
    let both = 0;
    for (const row of rows) {
      if (intrudes(row, mid)) continue;
      clear++;
      const hasLeft = row.some((i) => i.x + i.width <= mid);
      const hasRight = row.some((i) => i.x >= mid);
      if (hasLeft && hasRight) both++;
    }
    // A candidate gutter must be shared by at least one baseline that has text
    // on BOTH sides — otherwise it is just a margin/alignment gap, not a column
    // boundary. We deliberately do NOT require a majority here: a real
    // two-column page can be ASYMMETRIC (e.g. 6 left rows but only 2 paired
    // with a right-column row), where `both` is far below half of `rows.length`.
    // The actual two-column gate is downstream — the `columnRows <= crossingRows`
    // check, which rejects a spurious one-off gap because such a page's rows
    // mostly CROSS the divider (full-width body lines with a lone right-aligned
    // page number have crossingRows >= columnRows).
    if (both === 0) continue;
    const score = clear * 1000 + (gap.end - gap.start);
    if (score > bestScore) {
      bestScore = score;
      gutterStart = gap.start;
      gutterEnd = gap.end;
    }
  }
  if (bestScore < 0) return singleColumn;
  // The gutter "river" is the empty x-interval (gutterStart, gutterEnd); its
  // midpoint divides left from right. A row keeps the river clear when no item
  // intrudes into that interval — two separate column items (one ending at/
  // before gutterStart, one starting at/after gutterEnd) do NOT cross it.
  const gutterX = (gutterStart + gutterEnd) / 2;

  // A row "crosses" (is a full-width band) only when some item STRADDLES the
  // dividing line at gutterX — the same boundary used to partition left/right
  // below. An ordinary two-column row has text on BOTH sides at the same
  // baseline but no single item spans the divider, so it does not cross.
  // Testing against gutterX (not the full [gutterStart, gutterEnd] river,
  // which is pinned to whichever row had the shortest left line) keeps a
  // slightly longer column line that merely pokes past gutterStart from being
  // mis-flagged as a spanning band and collapsing the columns.
  const rowCrosses = (row: PositionedTextItem[]): boolean =>
    row.some((i) => i.x < gutterX && i.x + i.width > gutterX);

  // Validate the gutter against the rows: a gutter is real only if it stays
  // empty (no crossing) across the MAJORITY of rows.
  let columnRows = 0;
  let crossingRows = 0;
  for (const row of rows) {
    if (rowCrosses(row)) crossingRows++;
    else columnRows++;
  }

  // Partition non-crossing rows into left/right PER ITEM (a single row can feed
  // both columns), and collect crossing rows as full-width bands. Track the
  // bottom of the column body so a crossing row below it is a footer band.
  const leftItems: PositionedTextItem[] = [];
  const rightItems: PositionedTextItem[] = [];
  const columnRowYs: number[] = [];
  const crossing: PositionedTextItem[][] = [];

  for (const row of rows) {
    if (rowCrosses(row)) {
      crossing.push(row);
      continue;
    }
    columnRowYs.push(Math.max(...row.map((i) => i.y)));
    for (const i of row) {
      if (i.x + i.width <= gutterX) leftItems.push(i);
      else rightItems.push(i);
    }
  }

  // Majority of rows must respect the gutter, and both columns must carry text.
  if (
    columnRows <= crossingRows ||
    leftItems.length === 0 ||
    rightItems.length === 0
  ) {
    return singleColumn;
  }

  // Over-segmentation guard: detectColumns reconstructs at most 2 content
  // columns (plus full-width bands). If the column-body items themselves
  // fragment into more than 2 x-clusters, the page is a genuine 3-column (or
  // finer) layout that this 2-column model can only interleave — so an honest
  // single-column reading order is safer than fragmenting. Crossing (full-width)
  // rows are excluded so a spanning title does not inflate the count.
  const columnItems = [...leftItems, ...rightItems].sort((a, b) => a.x - b.x);
  let clusters = 0;
  let clusterRight = -Infinity;
  for (const i of columnItems) {
    if (i.x - clusterRight > gapThreshold) clusters++;
    clusterRight = Math.max(clusterRight, i.x + i.width);
  }
  if (clusters > 2) return singleColumn;

  const bottomY = columnRowYs.length > 0 ? Math.min(...columnRowYs) : -Infinity;

  const titleItems: PositionedTextItem[] = [];
  const footerItems: PositionedTextItem[] = [];
  for (const row of crossing) {
    const y = Math.max(...row.map((i) => i.y));
    // Crossing rows below the column body are footers; everything else is
    // treated as a leading/title band (the common spanning-header case).
    if (y < bottomY) footerItems.push(...row);
    else titleItems.push(...row);
  }

  const ordered: Column[] = [];
  if (titleItems.length > 0) ordered.push(makeColumn(titleItems));
  if (leftItems.length > 0) ordered.push(makeColumn(leftItems));
  if (rightItems.length > 0) ordered.push(makeColumn(rightItems));
  if (footerItems.length > 0) ordered.push(makeColumn(footerItems));

  return ordered.length > 0 ? ordered : singleColumn;
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
  // Dominant (max) font size seen so far in the open bucket. The same-line
  // tolerance is keyed to this, not to each item's own size, so a small
  // superscript / footnote-ref sitting next to a large run is not wrongly
  // split onto its own line. The bucket baseline (bucketY) stays frozen to
  // the topmost item so ordering is stable.
  let bucketFontSize = sorted[0].fontSize;

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
    // Tolerance keys to the DOMINANT (max) font size of the bucket including
    // this candidate, so a large run joining a small seed (or vice versa) is
    // admitted — a small superscript / footnote-ref next to a large run is not
    // wrongly split onto its own line. The baseline stays frozen to the
    // topmost item (bucketY) for stable ordering.
    const dominant = Math.max(bucketFontSize, item.fontSize);
    const tolerance = dominant * SAME_LINE_RATIO;
    if (bucket.length === 0) {
      bucket.push(item);
      bucketY = item.y;
      bucketFontSize = item.fontSize;
    } else if (Math.abs(item.y - bucketY) <= tolerance) {
      bucket.push(item);
      bucketFontSize = dominant;
    } else {
      flush();
      bucket.push(item);
      bucketY = item.y;
      bucketFontSize = item.fontSize;
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

/**
 * Heuristic for an all-caps heading: short, no terminal sentence punctuation,
 * majority-alphabetic, and every cased letter is uppercase (Latin-1/extended
 * aware via toLowerCase/toUpperCase round-trips). This is only used as a
 * SAME-SIZE tie-breaker — font size remains the primary heading signal — so the
 * guardrails below keep ordinary acronyms embedded in body text from
 * false-positiving (e.g. "The PDF spec." or "Send via HTTP, then wait").
 */
function isAllCapsHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // No terminal sentence punctuation — headings rarely end in . ! ? : ;.
  if (/[.!?:;]$/.test(trimmed)) return false;

  // Short: a heading is a label, not a sentence. Cap at 8 words.
  const words = trimmed.split(/\s+/);
  if (words.length > 8) return false;

  // Majority of characters must be alphabetic (rejects mostly-numeric/symbol
  // runs like "12.5%" or "$1,200 — TOTAL").
  let alpha = 0;
  let upper = 0;
  let cased = 0;
  for (const ch of trimmed) {
    const lower = ch.toLowerCase();
    const up = ch.toUpperCase();
    const isLetter = lower !== up;
    if (isLetter) {
      alpha++;
      cased++;
      // A cased letter that equals its own uppercase form is upper-case.
      if (ch === up) upper++;
    }
  }
  if (cased === 0) return false;
  if (alpha * 2 < trimmed.replace(/\s+/g, "").length) return false;

  // Every cased letter must be uppercase.
  if (upper !== cased) return false;

  // Guardrail: a lone acronym-ish single word (e.g. "HTTP", "PDF") is too weak
  // a signal on its own; require either ≥2 words or a longer single token so a
  // stray uppercase term doesn't become a heading.
  if (words.length === 1 && trimmed.length < 5) return false;

  return true;
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
  // Drop whitespace-only items before any layout analysis. pdf.js frequently
  // emits a single space run that spans a multi-column gutter (e.g. x=76 w=284
  // reaching from the left column's edge to the right column); its width would
  // otherwise bridge the gap in detectColumns and collapse two columns into one,
  // interleaving the rows. groupLines re-inserts single spaces between fragments,
  // so dropping these carries no content loss.
  const items = layout.items.filter((i) => i.str.trim().length > 0);
  if (items.length === 0) return "";

  // Body font size = the most common (modal) size, weighted by character count.
  // The modal size is robust on heading-heavy pages where the median would land
  // on a heading size and break heading inference.
  const bodySize = modalFontSize(items);

  // Distinct heading sizes, largest first, that exceed the body size.
  const headingSizes = [
    ...new Set(
      items
        .map((i) => Math.round(i.fontSize * 2) / 2)
        .filter((s) => s >= bodySize * HEADING_SCALE_RATIO),
    ),
  ].sort((a, b) => b - a);

  // All-caps fallback heading level = one below the deepest font-size-derived
  // heading. If the page has no larger-than-body sizes, the deepest is treated
  // as 0 so an isolated all-caps line becomes a level-1 heading. Capped at 3 to
  // match headingLevelFor (the font-size path maxes at level 3), so the all-caps
  // fallback never emits a level the font-size path cannot.
  const deepestFontHeading = Math.min(headingSizes.length, 3);
  const allCapsLevel = Math.min(deepestFontHeading + 1, 3);

  // detectColumns already returns columns/bands in final reading order
  // (title → left → right → footer); do NOT re-sort by minX, which would
  // interleave full-width bands back into the column flow.
  const columns = detectColumns(items);

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
    // Index into `blocks` of the most recent list item emitted in this column,
    // its indent level (left edge), and the x where its TEXT (not the marker)
    // begins. A following continuation line is appended to it (change 3).
    let lastListBlockIdx = -1;
    let lastListLevelX = 0;
    let lastListTextStartX = 0;

    const flushParagraph = (): void => {
      if (paragraph.length === 0) return;
      blocks.push(paragraph.join(" "));
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let level = headingLevelFor(line.fontSize, bodySize, headingSizes);

      const gapAbove = i > 0 ? lines[i - 1].y - line.y : 0;
      const bigGap =
        i > 0 && medianGap > 0 && gapAbove > medianGap * PARAGRAPH_GAP_RATIO;

      // Same-size tie-breaker: a body-size line that is isolated by a big
      // vertical gap and reads like an all-caps label is promoted to a heading
      // one level below the deepest font-size-derived heading. Font size stays
      // the primary signal — this only fires when font size alone said "body".
      // Known limitation: promotion requires a big gap ABOVE the line, which
      // needs i > 0 — so it never fires for the FIRST line of a column/band
      // (an all-caps section header that opens a column stays a paragraph).
      if (level === 0 && bigGap && isAllCapsHeading(line.text)) {
        level = allCapsLevel;
      }

      const { md, isList } = renderLine(line, level);

      // Marker width estimate so we know where the list item's TEXT starts.
      const markerMatch =
        BULLET_RE.exec(line.text) ?? NUMBERED_RE.exec(line.text);
      const textStartX = markerMatch
        ? line.x + markerMatch[0].length * line.fontSize * 0.5
        : line.x;

      if (level > 0) {
        // Headings are always their own block.
        flushParagraph();
        blocks.push(md);
        prevWasList = false;
        lastListBlockIdx = -1;
        continue;
      }

      if (isList) {
        flushParagraph();
        blocks.push(md);
        prevWasList = true;
        lastListBlockIdx = blocks.length - 1;
        lastListLevelX = line.x;
        lastListTextStartX = textStartX;
        continue;
      }

      // Wrapped list-item continuation (change 3): a non-list, body-size line
      // with no big vertical gap, on the same flat level (not dedented left of
      // the marker), whose left edge is at or past the previous item's
      // text-start (minus half a glyph of slack) is the second visual line of
      // that list item — append it rather than emit a stray paragraph.
      // Conservative gate: requires an immediately preceding list item, no
      // intervening paragraph, and the continuation must align with the item's
      // text (not be more deeply indented — we do NOT model nested lists).
      const sameFlatLevel = line.x >= lastListLevelX - line.fontSize * 0.5;
      const alignsWithText =
        line.x >= lastListTextStartX - line.fontSize * 0.5 &&
        line.x <= lastListTextStartX + line.fontSize * 1.5;
      if (
        lastListBlockIdx >= 0 &&
        prevWasList &&
        !bigGap &&
        paragraph.length === 0 &&
        sameFlatLevel &&
        alignsWithText
      ) {
        blocks[lastListBlockIdx] = `${blocks[lastListBlockIdx]} ${md}`.replace(
          /\s+/g,
          " ",
        );
        prevWasList = true;
        continue;
      }

      if (prevWasList || bigGap) {
        flushParagraph();
      }
      paragraph.push(md);
      prevWasList = false;
      lastListBlockIdx = -1;
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
