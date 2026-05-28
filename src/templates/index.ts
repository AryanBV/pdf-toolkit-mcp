import type { z } from "zod";
import type { TemplateName } from "../types.js";
import type { DocumentElement } from "../services/pdf-creator.js";
import { invoiceSchema, buildInvoice } from "./invoice.js";
import { reportSchema, buildReport } from "./report.js";
import { letterSchema, buildLetter } from "./letter.js";

export interface TemplateEntry<S extends z.ZodTypeAny> {
  schema: S;
  build: (data: z.infer<S>) => Promise<DocumentElement>;
}

// A single registry mapping each template name to its Zod schema + builder.
// The tool validates incoming `data` with `schema` before calling `build`.
export const templateRegistry = {
  invoice: { schema: invoiceSchema, build: buildInvoice },
  report: { schema: reportSchema, build: buildReport },
  letter: { schema: letterSchema, build: buildLetter },
} satisfies Record<TemplateName, TemplateEntry<z.ZodTypeAny>>;

export type { TemplateName };
