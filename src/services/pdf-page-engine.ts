import type { PDFDocument, PDFDict, PDFArray, PDFRef } from "@pdfme/pdf-lib";
import pdfLib from "@pdfme/pdf-lib";
import { logger } from "../utils/logger.js";

const {
  PDFDict: PDFDictCtor,
  PDFArray: PDFArrayCtor,
  PDFName,
  PDFRef: PDFRefCtor,
} = pdfLib;

/**
 * Result of a form-preserving page copy.
 * - `preserved`: number of top-level AcroForm fields registered into `dest`.
 * - `renamed`: original names of fields renamed to avoid colliding with fields
 *   already present in `dest` (the new name is `<prefix>.<original>`).
 * - `dropped`: names of fields that could not be preserved and fell back to
 *   plain copied (non-interactive) content.
 */
export interface FormCopyReport {
  preserved: number;
  renamed: string[];
  dropped: string[];
}

interface CopyOptions {
  /** Prefix used to namespace fields whose names collide with dest fields. */
  namespacePrefix?: string;
}

/** Decode an AcroForm field name (`/T`), which may be a PDFString or PDFHexString. */
function decodeFieldName(value: unknown): string | undefined {
  if (
    value instanceof pdfLib.PDFString ||
    value instanceof pdfLib.PDFHexString
  ) {
    try {
      return value.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Collect the partial names (`/T`) of every top-level field currently in `dest`. */
function existingDestFieldNames(dest: PDFDocument): Set<string> {
  const names = new Set<string>();
  try {
    const acro = dest.getForm().acroForm;
    const fields = acro.dict.lookupMaybe(PDFName.of("Fields"), PDFArrayCtor);
    if (!fields) return names;
    for (let i = 0; i < fields.size(); i++) {
      const field = dest.context.lookupMaybe(fields.get(i), PDFDictCtor);
      if (!field) continue;
      const name = decodeFieldName(field.get(PDFName.of("T")));
      if (name) names.add(name);
    }
  } catch {
    /* no form yet */
  }
  return names;
}

/**
 * Walk up the `/Parent` chain from a widget annotation to the top-level field
 * dict (a field whose `/Parent` is not a reference). Returns the top-level
 * field's reference, or undefined if the widget itself is a non-field annotation
 * (e.g. a link) with neither `/Parent` nor field keys.
 */
function topLevelFieldRef(
  dest: PDFDocument,
  widgetRef: PDFRef,
): PDFRef | undefined {
  let currentRef: PDFRef = widgetRef;
  let dict = dest.context.lookupMaybe(currentRef, PDFDictCtor);
  if (!dict) return undefined;

  // Climb to the root of the field tree.
  let parent = dict.get(PDFName.of("Parent"));
  let guard = 0;
  while (parent instanceof PDFRefCtor && guard < 64) {
    currentRef = parent;
    const parentDict = dest.context.lookupMaybe(currentRef, PDFDictCtor);
    if (!parentDict) break;
    dict = parentDict;
    parent = dict.get(PDFName.of("Parent"));
    guard++;
  }

  // A genuine form field has either a field type (/FT) or a name (/T), or it is
  // a non-terminal node with /Kids. Plain link/popup annotations have none.
  const isField =
    dict.has(PDFName.of("FT")) ||
    dict.has(PDFName.of("T")) ||
    dict.has(PDFName.of("Kids"));
  return isField ? currentRef : undefined;
}

/**
 * Map every widget annotation ref present on the surviving pages to the page ref
 * that hosts it, and collect the top-level field refs they belong to (in
 * deterministic first-seen order). The widget→page map is the source of truth
 * for which widgets are "live" — after `copyPages` a widget's own `/P` may still
 * point at the un-added intermediate page copy, so it cannot be trusted.
 */
function scanSurvivingWidgets(
  dest: PDFDocument,
  pages: { node: PDFDict; pageRef: PDFRef }[],
): { topFields: PDFRef[]; liveWidgetToPage: Map<string, PDFRef> } {
  const seen = new Set<string>();
  const topFields: PDFRef[] = [];
  const liveWidgetToPage = new Map<string, PDFRef>();

  for (const { node, pageRef } of pages) {
    const annots = node.lookupMaybe(PDFName.of("Annots"), PDFArrayCtor);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotRef = annots.get(i);
      if (!(annotRef instanceof PDFRefCtor)) continue;
      liveWidgetToPage.set(annotRef.toString(), pageRef);

      const topRef = topLevelFieldRef(dest, annotRef);
      if (!topRef) continue;
      const key = topRef.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      topFields.push(topRef);
    }
  }
  return { topFields, liveWidgetToPage };
}

/** Set or rename a field's partial name (`/T`), preserving the source encoding. */
function setFieldName(field: PDFDict, name: string): void {
  field.set(PDFName.of("T"), pdfLib.PDFHexString.fromText(name));
}

/**
 * Filter a field's `/Kids` so only widgets that survived the copy (present in
 * `liveWidgetToPage`) remain, recursing into non-terminal kids. Surviving
 * widgets get their `/P` repointed to the correct surviving page. Returns true
 * if the field still has at least one live widget/kid, false if it became empty
 * (caller should drop it).
 */
function pruneFieldKids(
  dest: PDFDocument,
  fieldRef: PDFRef,
  liveWidgetToPage: Map<string, PDFRef>,
): boolean {
  const field = dest.context.lookupMaybe(fieldRef, PDFDictCtor);
  if (!field) return false;

  const kids = field.lookupMaybe(PDFName.of("Kids"), PDFArrayCtor);
  if (!kids) {
    // Terminal field that is itself a widget (no /Kids): keep it only if it is
    // one of the live widgets, and fix its /P.
    const pageRef = liveWidgetToPage.get(fieldRef.toString());
    if (!pageRef) return false;
    field.set(PDFName.of("P"), pageRef);
    return true;
  }

  const survivors: PDFRef[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const kidRef = kids.get(i);
    if (!(kidRef instanceof PDFRefCtor)) continue;
    const kid = dest.context.lookupMaybe(kidRef, PDFDictCtor);
    if (!kid) continue;

    const isNonTerminal = kid.has(PDFName.of("Kids"));
    if (isNonTerminal) {
      if (pruneFieldKids(dest, kidRef, liveWidgetToPage))
        survivors.push(kidRef);
      continue;
    }

    // Terminal widget kid: keep only if it is a live widget on a surviving page.
    const pageRef = liveWidgetToPage.get(kidRef.toString());
    if (pageRef) {
      kid.set(PDFName.of("P"), pageRef);
      survivors.push(kidRef);
    }
  }

  if (survivors.length === 0) return false;

  // Rebuild the /Kids array with only the survivors.
  const newKids = dest.context.obj([]) as PDFArray;
  for (const ref of survivors) newKids.push(ref);
  field.set(PDFName.of("Kids"), newKids);
  return true;
}

/** Merge the source AcroForm's /DR (default resources) into dest's /DR. */
function mergeDefaultResources(destAcro: PDFDict, srcAcro: PDFDict): void {
  const srcDR = srcAcro.lookupMaybe(PDFName.of("DR"), PDFDictCtor);
  if (!srcDR) return;

  let destDR = destAcro.lookupMaybe(PDFName.of("DR"), PDFDictCtor);
  if (!destDR) {
    destDR = destAcro.context.obj({}) as PDFDict;
    destAcro.set(PDFName.of("DR"), destDR);
  }

  for (const [key, value] of srcDR.entries()) {
    const existing = destDR.get(key);
    if (existing === undefined) {
      destDR.set(key, value);
      continue;
    }
    // Both have this resource category (e.g. /Font): merge sub-entries.
    const existingDict =
      existing instanceof PDFRefCtor
        ? destDR.context.lookupMaybe(existing, PDFDictCtor)
        : existing instanceof PDFDictCtor
          ? existing
          : undefined;
    const incomingDict = destDR.context.lookupMaybe(value, PDFDictCtor);
    if (existingDict && incomingDict) {
      for (const [subKey, subValue] of incomingDict.entries()) {
        if (existingDict.get(subKey) === undefined) {
          existingDict.set(subKey, subValue);
        }
      }
    }
  }
}

/**
 * Copy `pageIndices` from `src` into `dest` (appended in the given order) while
 * preserving AcroForm form fields. Pure: operates on in-memory documents only.
 *
 * Strategy (see CLAUDE.md Rule 8 / Known Limitation 1):
 * 1. `copyPages` brings page content + widget annotations across, and because the
 *    copier follows `/Parent` references it also copies the parent field dicts —
 *    but it does NOT register them in the dest `/AcroForm /Fields`, so they are
 *    orphaned and rendered non-interactive.
 * 2. We force a dest AcroForm (`dest.getForm()`), then for every widget on the
 *    copied pages we walk `/Parent` to the top-level field and register that
 *    field's ref into `/AcroForm /Fields` exactly once.
 * 3. Name collisions against fields already in dest are namespaced by prefixing
 *    `/T` so two merged docs do not collapse into one shared field.
 * 4. `/Kids` are pruned to widgets whose pages survived (matters for split/delete);
 *    a field with no surviving widgets is dropped.
 * 5. The source `/DR`/`/DA` are merged and `NeedAppearances` is set so fields
 *    render their values in viewers.
 *
 * Never throws from form handling: on any failure the pages remain copied (just
 * without interactive fields) and the affected field names are reported as
 * `dropped`.
 */
export async function copyPagesPreservingForms(
  dest: PDFDocument,
  src: PDFDocument,
  pageIndices: number[],
  opts: CopyOptions = {},
): Promise<FormCopyReport> {
  const report: FormCopyReport = { preserved: 0, renamed: [], dropped: [] };

  // 1. Copy pages first (always succeeds; this is the baseline guarantee).
  const copiedPages = await dest.copyPages(src, pageIndices);
  const pages: { node: PDFDict; pageRef: PDFRef }[] = [];
  for (const page of copiedPages) {
    dest.addPage(page);
    pages.push({ node: page.node, pageRef: page.ref });
  }

  // Fast path: source has no form → plain copy, nothing to preserve.
  let srcHasForm = false;
  try {
    srcHasForm = src.getForm().getFields().length > 0;
  } catch {
    srcHasForm = false;
  }
  if (!srcHasForm) return report;

  // 2. Re-register the copied fields. Any failure degrades to "dropped".
  const candidateNames: string[] = [];
  try {
    const destForm = dest.getForm();
    const destAcro = destForm.acroForm.dict;
    const ctx = dest.context;

    // Ensure /Fields exists on the dest AcroForm.
    let destFields = destAcro.lookupMaybe(PDFName.of("Fields"), PDFArrayCtor);
    if (!destFields) {
      destFields = ctx.obj([]) as PDFArray;
      destAcro.set(PDFName.of("Fields"), destFields);
    }

    const usedNames = existingDestFieldNames(dest);
    const { topFields, liveWidgetToPage } = scanSurvivingWidgets(dest, pages);

    for (const fieldRef of topFields) {
      const field = ctx.lookupMaybe(fieldRef, PDFDictCtor);
      if (!field) continue;

      const originalName =
        decodeFieldName(field.get(PDFName.of("T"))) ?? "field";
      candidateNames.push(originalName);

      // Prune widgets/kids whose pages did not survive (split/delete case).
      const stillLive = pruneFieldKids(dest, fieldRef, liveWidgetToPage);
      if (!stillLive) {
        report.dropped.push(originalName);
        continue;
      }

      // Namespace on collision so two sources don't share one field.
      let finalName = originalName;
      if (usedNames.has(finalName)) {
        const prefix = opts.namespacePrefix ?? "dup";
        let candidate = `${prefix}.${originalName}`;
        let n = 2;
        while (usedNames.has(candidate)) {
          candidate = `${prefix}${n}.${originalName}`;
          n++;
        }
        finalName = candidate;
        setFieldName(field, finalName);
        report.renamed.push(originalName);
      }
      usedNames.add(finalName);

      // Top-level fields must not carry a /Parent (would orphan them again).
      field.delete(PDFName.of("Parent"));

      destFields.push(fieldRef);
      report.preserved++;
    }

    // 3. Merge default resources/appearance and force appearance regeneration.
    try {
      const srcAcro = src.getForm().acroForm.dict;
      mergeDefaultResources(destAcro, srcAcro);
      if (!destAcro.has(PDFName.of("DA"))) {
        const srcDA = srcAcro.get(PDFName.of("DA"));
        if (srcDA !== undefined) destAcro.set(PDFName.of("DA"), srcDA);
      }
    } catch (err) {
      logger.warn("Failed to merge AcroForm default resources", err);
    }
    destAcro.set(PDFName.of("NeedAppearances"), pdfLib.PDFBool.True);
  } catch (err) {
    // 4. Graceful fallback: pages are already copied; report all fields dropped.
    logger.warn(
      "Form preservation failed; pages copied without interactive fields",
      err,
    );
    const dropped = candidateNames.length > 0 ? candidateNames : ["(unknown)"];
    return {
      preserved: 0,
      renamed: [],
      dropped: [...new Set([...report.dropped, ...dropped])],
    };
  }

  return report;
}
