/**
 * Split a multi-line text body into separate paragraphs: break on blank lines
 * (a run of two or more consecutive newlines), collapse any remaining single
 * newlines within each paragraph to a space, trim, and drop empties. A body
 * with no blank line yields one soft-wrapping paragraph (rendered identically
 * to a plain single-line body). Shared by the letter, report, and invoice
 * templates so multi-paragraph fields render as distinct Text nodes.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p !== "");
}
