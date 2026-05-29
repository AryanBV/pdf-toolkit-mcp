import { describe, it, expect } from "vitest";
import { layoutToMarkdown } from "../../src/tools/markdown-from-layout.js";
import type { PageTextLayout, PositionedTextItem } from "../../src/types.js";

/**
 * These are CHARACTERIZATION tests: they assert on heading LEVEL, block COUNT
 * (split on blank lines), and RELATIVE reading order of substrings — never on
 * exact bytes — so the layout heuristics can evolve without brittle churn.
 */

interface ItemSpec {
  str: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
}

/** Build a positioned-text item; width defaults to ~0.5em per character. */
function item(spec: ItemSpec): PositionedTextItem {
  const fontSize = spec.fontSize ?? 12;
  const width = spec.width ?? spec.str.length * fontSize * 0.5;
  return {
    str: spec.str,
    x: spec.x,
    y: spec.y,
    width,
    height: spec.height ?? fontSize,
    fontSize,
  };
}

/** Wrap a list of item specs into a single-page layout. */
function page(specs: ItemSpec[], width = 612, height = 792): PageTextLayout {
  return { page: 1, width, height, items: specs.map(item) };
}

function md(specs: ItemSpec[]): string {
  return layoutToMarkdown([page(specs)]);
}

/** Markdown blocks = runs separated by a blank line. */
function blocks(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Heading level of the first line of a block, or 0 if not a heading. */
function headingLevel(block: string): number {
  const m = /^(#{1,6})\s/.exec(block);
  return m ? m[1].length : 0;
}

/** Index of the first block whose text contains `needle`. */
function blockIndexOf(bs: string[], needle: string): number {
  return bs.findIndex((b) => b.includes(needle));
}

describe("layoutToMarkdown — heading-scale boundary", () => {
  // Body size 10 (carries the most characters). A title at 10 * 1.15 = 11.5
  // clears the threshold; one at 10 * 1.14 = 11.4 does not.
  const body = (y: number, str: string): ItemSpec => ({
    str,
    x: 50,
    y,
    fontSize: 10,
  });

  it("promotes a line at body*1.15 to a heading", () => {
    const result = md([
      { str: "Big Title", x: 50, y: 700, fontSize: 11.5 },
      body(680, "Lorem ipsum dolor sit amet consectetur body copy."),
      body(665, "More plentiful body text that anchors the modal size."),
      body(650, "Yet more body copy so ten point clearly dominates."),
    ]);
    const bs = blocks(result);
    expect(headingLevel(bs[0])).toBe(1);
    expect(bs[0]).toContain("Big Title");
  });

  it("keeps a line at body*1.14 as a paragraph (no heading)", () => {
    const result = md([
      { str: "Almost A Title", x: 50, y: 700, fontSize: 11.4 },
      body(680, "Lorem ipsum dolor sit amet consectetur body copy."),
      body(665, "More plentiful body text that anchors the modal size."),
      body(650, "Yet more body copy so ten point clearly dominates."),
    ]);
    const bs = blocks(result);
    const idx = blockIndexOf(bs, "Almost A Title");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(headingLevel(bs[idx])).toBe(0);
  });
});

describe("layoutToMarkdown — same-line merge vs split", () => {
  it("merges fragments sharing a baseline into one line", () => {
    // Two fragments at the same y, close in x: one logical line "Hello World".
    const result = md([
      { str: "Hello", x: 50, y: 700, fontSize: 12 },
      { str: "World", x: 120, y: 700, fontSize: 12 },
    ]);
    expect(result).toContain("Hello World");
    expect(blocks(result).length).toBe(1);
  });

  it("keeps a small superscript on the same line as a large run (mixed-font)", () => {
    // A large run (size 14) with a tiny superscript ref (size 7) just above its
    // baseline. The tolerance is keyed to the line's DOMINANT size, so the
    // superscript is NOT split onto its own line.
    const result = md([
      { str: "Important claim", x: 50, y: 700, fontSize: 14 },
      { str: "1", x: 150, y: 705, fontSize: 7 },
    ]);
    const bs = blocks(result);
    expect(bs.length).toBe(1);
    expect(bs[0]).toContain("Important claim");
    expect(bs[0]).toContain("1");
  });

  it("splits items on clearly different baselines into separate lines", () => {
    const result = md([
      { str: "First line of text here", x: 50, y: 700, fontSize: 12 },
      { str: "Second line of text here", x: 50, y: 680, fontSize: 12 },
    ]);
    // Same paragraph (regular leading), but the order must be preserved.
    expect(result.indexOf("First line")).toBeLessThan(
      result.indexOf("Second line"),
    );
  });
});

describe("layoutToMarkdown — paragraph gap block split", () => {
  it("splits two paragraphs separated by a large vertical gap", () => {
    // Regular leading ~16; a ~48 gap (3x) between the two paragraphs.
    const result = md([
      { str: "Para one line A.", x: 50, y: 700, fontSize: 12 },
      { str: "Para one line B.", x: 50, y: 684, fontSize: 12 },
      { str: "Para two line A.", x: 50, y: 636, fontSize: 12 },
      { str: "Para two line B.", x: 50, y: 620, fontSize: 12 },
    ]);
    const bs = blocks(result);
    expect(bs.length).toBe(2);
    expect(bs[0]).toContain("Para one line A.");
    expect(bs[0]).toContain("Para one line B.");
    expect(bs[1]).toContain("Para two line A.");
  });
});

describe("layoutToMarkdown — two-column ordering", () => {
  it("reads the left column fully before the right column", () => {
    // Body char width ~6 (12pt * 0.5). Gutter threshold = 6 * 12 = 72. The
    // left column sits near x=50 (right edge ~140); the right column starts at
    // x=330, a ~190 gap — well past threshold.
    const left = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 50,
      y,
      fontSize: 12,
    });
    const right = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 330,
      y,
      fontSize: 12,
    });
    const result = md([
      left(700, "Left top sentence here."),
      left(684, "Left mid sentence here."),
      left(668, "Left low sentence here."),
      right(700, "Right top sentence here."),
      right(684, "Right mid sentence here."),
      right(668, "Right low sentence here."),
    ]);
    // Every left line must precede every right line in the output.
    const lastLeft = result.lastIndexOf("Left low");
    const firstRight = result.indexOf("Right top");
    expect(lastLeft).toBeGreaterThanOrEqual(0);
    expect(firstRight).toBeGreaterThanOrEqual(0);
    expect(lastLeft).toBeLessThan(firstRight);
  });

  it("asymmetric two-column (unequal column lengths) keeps left column before right", () => {
    // A real two-column page where the left column is much longer than the
    // right: 6 left rows (x=50), but only the top 2 baselines are paired with a
    // right-column row (x=330). `both` (rows with text on both sides) is only 2
    // out of 6 rows, so a majority gate would reject the gutter and collapse the
    // page to interleaved single-column. The gutter must still be accepted, and
    // all LEFT content must precede all RIGHT content.
    const left = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 50,
      y,
      fontSize: 12,
    });
    const right = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 330,
      y,
      fontSize: 12,
    });
    const result = md([
      left(700, "Left row one of body text."),
      left(684, "Left row two of body text."),
      left(668, "Left row three of body text."),
      left(652, "Left row four of body text."),
      left(636, "Left row five of body text."),
      left(620, "Left row six of body text."),
      // Only the top two baselines carry a right-column row.
      right(700, "Right row one of body text."),
      right(684, "Right row two of body text."),
    ]);
    expect(result.indexOf("Left")).toBeGreaterThanOrEqual(0);
    expect(result.indexOf("Right")).toBeGreaterThanOrEqual(0);
    // All left content precedes all right content (not interleaved).
    expect(result.lastIndexOf("Left")).toBeLessThan(result.indexOf("Right"));
  });
});

describe("layoutToMarkdown — three-column over-segmentation guard", () => {
  it("collapses a 3-column page to single-column reading order (no col2+col3 interleave)", () => {
    // detectColumns reconstructs at most 2 content columns. A genuine 3-column
    // page (x=50, x=250, x=450; ~200px gaps, well past the ~72 threshold)
    // fragments the column body into 3 x-clusters, tripping the `clusters > 2`
    // guard, so it must fall back to honest single-column reading order rather
    // than interleaving columns 2 and 3.
    const c1 = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 50,
      y,
      fontSize: 12,
    });
    const c2 = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 250,
      y,
      fontSize: 12,
    });
    const c3 = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 450,
      y,
      fontSize: 12,
    });
    const result = md([
      c1(700, "Col one row one text."),
      c1(684, "Col one row two text."),
      c1(668, "Col one row three text."),
      c2(700, "Col two row one text."),
      c2(684, "Col two row two text."),
      c2(668, "Col two row three text."),
      c3(700, "Col three row one text."),
      c3(684, "Col three row two text."),
      c3(668, "Col three row three text."),
    ]);
    // Single-column fallback reads strictly top-to-bottom, then left-to-right
    // within a baseline: the three columns interleave PER ROW (col1, col2, col3
    // of row one, then row two, ...). The pathological failure mode this guard
    // prevents is reconstructing col2 fully then col3 fully (col2-before-col3
    // block interleave). Assert col three's LAST row does not all sort after
    // col two's content as a separate block: in reading order, col three row one
    // precedes col two row two (same-baseline left-to-right beats next baseline).
    expect(result.indexOf("Col three row one")).toBeLessThan(
      result.indexOf("Col two row two"),
    );
    // And the whole thing is one contiguous reading-order block: col one row
    // one is first, col three row three is last.
    expect(result.indexOf("Col one row one")).toBeLessThan(
      result.indexOf("Col three row three"),
    );
    expect(result.indexOf("Col three row three")).toBe(
      result.lastIndexOf("Col three row three"),
    );
  });
});

describe("layoutToMarkdown — all-caps heading detection", () => {
  it("promotes an isolated all-caps body-size line after a big gap to level 1", () => {
    // Body 12pt with NO larger-than-body sizes, so deepestFontHeading is 0 and
    // the all-caps fallback level is exactly 1. A "SECTION HEADING" line at the
    // SAME size, isolated by a large vertical gap, is promoted by the same-size
    // all-caps tie-breaker.
    const result = md([
      { str: "Some ordinary leading body paragraph text.", x: 50, y: 700 },
      { str: "It continues normally on a second line.", x: 50, y: 684 },
      { str: "SECTION HEADING", x: 50, y: 624, fontSize: 12 },
      { str: "Body text that follows the heading line.", x: 50, y: 608 },
    ]);
    const bs = blocks(result);
    const idx = blockIndexOf(bs, "SECTION HEADING");
    expect(idx).toBeGreaterThanOrEqual(0);
    // No font-size headings on the page → fallback level is exactly 1.
    expect(headingLevel(bs[idx])).toBe(1);
  });

  it("caps the all-caps promotion at level 3 when there are >=3 distinct heading sizes", () => {
    // Three distinct larger-than-body sizes (24, 20, 16 over body 12) saturate
    // the font-size heading depth at 3, so the all-caps fallback would compute
    // min(3 + 1, 3) = 3 — never level 4. The promoted all-caps line, isolated by
    // a big gap and set at body size, must land at exactly level 3.
    const result = md([
      { str: "Document Title At Top", x: 50, y: 760, fontSize: 24 },
      { str: "Major Section One", x: 50, y: 720, fontSize: 20 },
      { str: "Minor Subsection A", x: 50, y: 690, fontSize: 16 },
      {
        str: "Plenty of body copy that anchors the modal size here.",
        x: 50,
        y: 670,
        fontSize: 12,
      },
      {
        str: "More body text so twelve point clearly dominates.",
        x: 50,
        y: 654,
        fontSize: 12,
      },
      {
        str: "Still more body copy to keep twelve the modal size.",
        x: 50,
        y: 638,
        fontSize: 12,
      },
      // All-caps label at body size, isolated by a big vertical gap above it.
      { str: "ALL CAPS FALLBACK HEADING", x: 50, y: 578, fontSize: 12 },
      {
        str: "Body text that follows the fallback heading line.",
        x: 50,
        y: 562,
        fontSize: 12,
      },
    ]);
    const bs = blocks(result);
    const idx = blockIndexOf(bs, "ALL CAPS FALLBACK HEADING");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(headingLevel(bs[idx])).toBe(3);
  });

  it("does NOT promote an acronym embedded in ordinary body text", () => {
    // A normal sentence containing an acronym, ending with a period — guardrails
    // keep it as body text even after a gap.
    const result = md([
      { str: "Some ordinary leading body paragraph text.", x: 50, y: 700 },
      { str: "It continues normally on a second line.", x: 50, y: 684 },
      { str: "Please send the PDF to the team today.", x: 50, y: 624 },
    ]);
    const bs = blocks(result);
    const idx = blockIndexOf(bs, "send the PDF");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(headingLevel(bs[idx])).toBe(0);
  });
});

describe("layoutToMarkdown — wrapped list item re-attachment", () => {
  it("appends a wrapped continuation line to the previous list item", () => {
    // Marker "- " at x=50 (textStart ~ 50 + 2*12*0.5 = 62). The continuation
    // line is indented to x=62 to align with the item text, with normal
    // leading — it should be appended, not become a separate paragraph.
    const result = md([
      {
        str: "- First list item that is long enough to wrap onto",
        x: 50,
        y: 700,
        fontSize: 12,
      },
      {
        str: "a second visual line of the same bullet.",
        x: 62,
        y: 684,
        fontSize: 12,
      },
      {
        str: "- Second list item entirely on one line.",
        x: 50,
        y: 668,
        fontSize: 12,
      },
    ]);
    const bs = blocks(result);
    // Both list bullets render; the wrapped continuation joins the first item.
    const firstItem = bs.find((b) => b.includes("First list item"));
    expect(firstItem).toBeDefined();
    expect(firstItem).toContain("second visual line");
    // The continuation must NOT appear as its own stray paragraph block.
    const strayIdx = bs.findIndex(
      (b) =>
        b.startsWith("a second visual line") || b === "a second visual line",
    );
    expect(strayIdx).toBe(-1);
    // Two list items total.
    expect(bs.filter((b) => b.startsWith("- ")).length).toBe(2);
  });
});

describe("layoutToMarkdown — full-width title does not collapse two columns", () => {
  it("orders a spanning title before both columns and keeps columns separate", () => {
    // A full-width title spanning the gutter at the top, then a clean
    // two-column body. The title must not interleave the columns.
    const left = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 50,
      y,
      fontSize: 12,
    });
    const right = (y: number, s: string): ItemSpec => ({
      str: s,
      x: 330,
      y,
      fontSize: 12,
    });
    const result = md([
      // Spanning title: a single wide run crossing the gutter (x 50 → 520).
      {
        str: "FULL WIDTH SPANNING TITLE",
        x: 50,
        y: 740,
        width: 470,
        fontSize: 16,
      },
      left(700, "Left column line one of body."),
      left(684, "Left column line two of body."),
      left(668, "Left column line three of body."),
      right(700, "Right column line one of body."),
      right(684, "Right column line two of body."),
      right(668, "Right column line three of body."),
    ]);
    const idxTitle = result.indexOf("FULL WIDTH SPANNING TITLE");
    const idxLeftFirst = result.indexOf("Left column line one");
    const idxLeftLast = result.lastIndexOf("Left column line three");
    const idxRightFirst = result.indexOf("Right column line one");
    expect(idxTitle).toBeGreaterThanOrEqual(0);
    // Title comes first.
    expect(idxTitle).toBeLessThan(idxLeftFirst);
    expect(idxTitle).toBeLessThan(idxRightFirst);
    // Columns stay separated: ALL left lines precede the first right line.
    expect(idxLeftLast).toBeLessThan(idxRightFirst);
  });
});
