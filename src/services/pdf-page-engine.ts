import type {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFObject,
} from "@pdfme/pdf-lib";
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
 *
 * `sharedWidgetFields` collects the top-level field refs that own a widget seen
 * on MORE THAN ONE surviving page. This happens only when a single source page
 * carrying form widgets is duplicated in the requested order (e.g.
 * `pdf_reorder_pages` with `[0,0]`): pdf-lib's copier caches by source ref, so
 * both page copies reference the SAME widget ref. A `Map<widgetRef→pageRef>`
 * cannot represent a widget that lives on two pages — the second occurrence
 * overwrites the first and the field's `/P` ends up pointing at only one page.
 * Rather than report such a field as truthfully `preserved`, the caller drops it.
 */
function scanSurvivingWidgets(
  dest: PDFDocument,
  pages: { node: PDFDict; pageRef: PDFRef }[],
): {
  topFields: PDFRef[];
  liveWidgetToPage: Map<string, PDFRef>;
  sharedWidgetFields: Set<string>;
} {
  const seen = new Set<string>();
  const topFields: PDFRef[] = [];
  const liveWidgetToPage = new Map<string, PDFRef>();
  const widgetPageCount = new Map<string, number>();
  const sharedWidgetFields = new Set<string>();

  for (const { node, pageRef } of pages) {
    const annots = node.lookupMaybe(PDFName.of("Annots"), PDFArrayCtor);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotRef = annots.get(i);
      if (!(annotRef instanceof PDFRefCtor)) continue;
      const widgetKey = annotRef.toString();

      // A widget ref reached from two different surviving pages means the same
      // source page was duplicated — the widget cannot belong to both copies.
      const prevCount = widgetPageCount.get(widgetKey) ?? 0;
      widgetPageCount.set(widgetKey, prevCount + 1);
      const topRef = topLevelFieldRef(dest, annotRef);
      if (prevCount > 0 && topRef) {
        sharedWidgetFields.add(topRef.toString());
      }

      liveWidgetToPage.set(widgetKey, pageRef);

      if (!topRef) continue;
      const key = topRef.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      topFields.push(topRef);
    }
  }
  return { topFields, liveWidgetToPage, sharedWidgetFields };
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

/**
 * Merge the source AcroForm's /DR (default resources) into dest's /DR.
 *
 * Source `/DR` entries are values/refs that live in the SOURCE document's
 * context. Writing them straight into the dest AcroForm would leak a cross-
 * context reference (a dest object pointing at a ref that only exists in the
 * source's object table) — invalid PDF. Every source value is therefore copied
 * into the dest context via `PDFObjectCopier` before being set.
 */
function mergeDefaultResources(
  dest: PDFDocument,
  src: PDFDocument,
  destAcro: PDFDict,
  srcAcro: PDFDict,
): void {
  const srcDR = srcAcro.lookupMaybe(PDFName.of("DR"), PDFDictCtor);
  if (!srcDR) return;

  const copier = pdfLib.PDFObjectCopier.for(src.context, dest.context);
  const intoDest = <T extends PDFObject>(value: T): T => copier.copy(value);

  let destDR = destAcro.lookupMaybe(PDFName.of("DR"), PDFDictCtor);
  if (!destDR) {
    destDR = dest.context.obj({}) as PDFDict;
    destAcro.set(PDFName.of("DR"), destDR);
  }

  for (const [key, value] of srcDR.entries()) {
    const existing = destDR.get(key);
    if (existing === undefined) {
      // Copy the whole resource category (e.g. /Font dict) into dest first.
      destDR.set(key, intoDest(value));
      continue;
    }
    // Both have this resource category (e.g. /Font): merge sub-entries.
    const existingDict =
      existing instanceof PDFRefCtor
        ? dest.context.lookupMaybe(existing, PDFDictCtor)
        : existing instanceof PDFDictCtor
          ? existing
          : undefined;
    // Resolve the incoming category dict in the SOURCE context (it may be a ref).
    const incomingDict = src.context.lookupMaybe(value, PDFDictCtor);
    if (existingDict && incomingDict) {
      for (const [subKey, subValue] of incomingDict.entries()) {
        if (existingDict.get(subKey) === undefined) {
          existingDict.set(subKey, intoDest(subValue));
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
    const { topFields, liveWidgetToPage, sharedWidgetFields } =
      scanSurvivingWidgets(dest, pages);

    for (const fieldRef of topFields) {
      const field = ctx.lookupMaybe(fieldRef, PDFDictCtor);
      if (!field) continue;

      const originalName =
        decodeFieldName(field.get(PDFName.of("T"))) ?? "field";
      candidateNames.push(originalName);

      // A field whose widget appears on a duplicated page cannot be safely
      // preserved: a single widget ref cannot point its `/P` at two distinct
      // page copies. Report it honestly as dropped rather than counting it as
      // preserved while it renders on only one of the duplicates (Rule 8).
      if (sharedWidgetFields.has(fieldRef.toString())) {
        report.dropped.push(
          `${originalName} (field on a duplicated page cannot be safely preserved)`,
        );
        continue;
      }

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
      mergeDefaultResources(dest, src, destAcro, srcAcro);
      if (!destAcro.has(PDFName.of("DA"))) {
        const srcDA = srcAcro.get(PDFName.of("DA"));
        // /DA is typically a PDFString literal, but copy it into the dest
        // context regardless so no source-context ref leaks across.
        if (srcDA !== undefined) {
          const copier = pdfLib.PDFObjectCopier.for(src.context, dest.context);
          destAcro.set(PDFName.of("DA"), copier.copy(srcDA));
        }
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
