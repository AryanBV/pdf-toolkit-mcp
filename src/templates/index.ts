import type { TemplateName } from "../types.js";
import { buildInvoice } from "./invoice.js";
import { buildReport } from "./report.js";
import { buildLetter } from "./letter.js";

type TemplateBuilder = (data: Record<string, unknown>) => Record<string, unknown>;

export const templateRegistry: Record<TemplateName, TemplateBuilder> = {
  invoice: buildInvoice,
  report: buildReport,
  letter: buildLetter,
};
