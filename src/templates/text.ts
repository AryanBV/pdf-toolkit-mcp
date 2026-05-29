/**
 * Split a multi-line text body into separate paragraphs: break on newlines,
 * trim each line, and drop empties. A single-line body yields one entry, so
 * callers render it identically to today. Shared by the letter, report, and
 * invoice templates so multi-paragraph fields render as distinct Text nodes.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}
