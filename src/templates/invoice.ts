import React from "react";
import { z } from "zod";
import {
  getReactPdf,
  PRODUCER,
  FIXED_CREATION_DATE,
  type DocumentElement,
} from "../services/pdf-creator.js";
import { splitParagraphs } from "./text.js";

const h = React.createElement;

// Accepts the create-invoice prompt shape:
//   { companyName, clientName, invoiceNumber, invoiceDate, items:[{description,quantity,unitPrice}] }
// plus optional address / tax / terms fields. Numbers are coerced so callers
// may send them as strings.
// LLMs often send "" for an unspecified numeric field. z.coerce.number() turns
// "" into 0, which would silently produce a $0 line item or 0% tax instead of
// letting the builder's defaults apply — so map empty/null to undefined first.
const emptyToUndefined = (v: unknown): unknown =>
  v === "" || v === null ? undefined : v;

// Maps common ISO 4217 currency codes to their display symbol. The `currency`
// field accepts either a known code (e.g. "EUR", "INR") or a raw symbol/string
// (e.g. "€", "kr") — anything not in this table is rendered verbatim, so any
// currency is supported even if it isn't listed here.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  RUB: "₽",
  KRW: "₩",
  BRL: "R$",
  CAD: "$",
  AUD: "$",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  ZAR: "R",
  TRY: "₺",
  MXN: "$",
  SGD: "$",
  HKD: "$",
  NZD: "$",
  THB: "฿",
  AED: "د.إ",
};

// The invoice renders in Helvetica (WinAnsi), so only ASCII plus a few WinAnsi
// currency glyphs can be drawn; a non-WinAnsi symbol (₹ ₩ ₺ ₽ ฿ zł د.إ …) would
// throw "WinAnsi cannot encode" at render time. These are the safe non-ASCII ones.
const WINANSI_SAFE_SYMBOLS = new Set(["€", "£", "¥", "¢"]);

function currencySymbol(currency: string): string {
  const trimmed = currency.trim();
  const candidate = CURRENCY_SYMBOLS[trimmed.toUpperCase()] ?? trimmed;
  const renderable = [...candidate].every(
    (ch) => ch.charCodeAt(0) <= 0x7f || WINANSI_SAFE_SYMBOLS.has(ch),
  );
  if (renderable) return candidate;
  // Non-WinAnsi symbol (e.g. ₹/₩/₺): fall back to the ASCII ISO code so the
  // invoice renders (e.g. "INR 37.01") instead of throwing. Strip any residual
  // non-ASCII so a raw non-WinAnsi symbol passed directly is also safe.
  return trimmed.toUpperCase().replace(/[^\x20-\x7E]/g, "");
}

export const invoiceSchema = z
  .object({
    companyName: z.string().optional(),
    companyAddress: z.string().optional(),
    clientName: z.string().optional(),
    clientAddress: z.string().optional(),
    invoiceNumber: z.string().optional(),
    invoiceDate: z.string().optional(),
    dueDate: z.string().optional(),
    notes: z.string().optional(),
    paymentTerms: z.string().optional(),
    currency: z
      .string()
      .max(16)
      .optional()
      .describe(
        'Currency as an ISO code (e.g. "USD", "EUR", "INR") or a raw symbol (e.g. "€"). Defaults to "USD" ($).',
      ),
    taxRate: z.preprocess(
      emptyToUndefined,
      z.coerce.number().min(0).max(100).optional(),
    ),
    items: z
      .array(
        z.object({
          description: z.string().optional(),
          quantity: z.preprocess(
            emptyToUndefined,
            z.coerce.number().optional(),
          ),
          unitPrice: z.preprocess(
            emptyToUndefined,
            z.coerce.number().optional(),
          ),
        }),
      )
      .optional(),
  })
  .strip();

export type InvoiceData = z.infer<typeof invoiceSchema>;

export async function buildInvoice(
  data: InvoiceData,
): Promise<DocumentElement> {
  const rp = await getReactPdf();
  const { Document, Page, View, Text, StyleSheet } = rp;

  const companyName = data.companyName ?? "Company Name";
  const companyAddress = data.companyAddress ?? "";
  const clientName = data.clientName ?? "Client Name";
  const clientAddress = data.clientAddress ?? "";
  const invoiceNumber = data.invoiceNumber ?? "INV-001";
  const invoiceDate = data.invoiceDate ?? new Date().toISOString().slice(0, 10);
  const dueDate = data.dueDate ?? "";
  const notes = data.notes ?? "";
  const paymentTerms = data.paymentTerms ?? "";
  const taxRate = data.taxRate ?? 0;

  // Round each line total to cents BEFORE summing so the displayed line
  // amounts always reconcile with the subtotal/total. Without this, sub-cent
  // unit prices (e.g. 0.005) make the rounded per-line displays not add up to
  // a raw quantity*unitPrice subtotal. `lineTotal` is the single rounded base
  // used for both display and the subtotal.
  const roundCents = (n: number): number => Math.round(n * 100) / 100;

  const items = (data.items ?? []).map((item) => {
    const quantity = item.quantity ?? 1;
    const unitPrice = item.unitPrice ?? 0;
    return {
      description: item.description ?? "",
      quantity,
      unitPrice,
      lineTotal: roundCents(quantity * unitPrice),
    };
  });

  const subtotal = roundCents(items.reduce((s, it) => s + it.lineTotal, 0));
  const tax = roundCents(subtotal * (taxRate / 100));
  const total = roundCents(subtotal + tax);
  const symbol = currencySymbol(data.currency ?? "USD");
  // A single-glyph symbol ($ € £ ¥) sits flush against the amount; a multi-char
  // symbol or ISO-code fallback (CHF, kr, R$, INR) reads better with a space.
  const moneySep = symbol.length > 1 ? " " : "";
  const money = (n: number): string => `${symbol}${moneySep}${n.toFixed(2)}`;

  const styles = StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 56,
      paddingHorizontal: 48,
      fontSize: 11,
      fontFamily: "Helvetica",
      color: "#1a1a1a",
    },
    company: { fontSize: 22, fontFamily: "Helvetica-Bold", color: "#333333" },
    companyAddress: { fontSize: 9, color: "#666666", marginTop: 2 },
    headerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginTop: 24,
    },
    invoiceTitle: {
      fontSize: 28,
      fontFamily: "Helvetica-Bold",
      color: "#2c3e50",
    },
    invoiceNumber: { fontSize: 12, color: "#666666", marginTop: 4 },
    dateLine: { fontSize: 10, textAlign: "right" },
    billTo: { marginTop: 24 },
    billToLabel: {
      fontSize: 10,
      fontFamily: "Helvetica-Bold",
      color: "#666666",
    },
    clientName: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 4 },
    clientAddress: { fontSize: 10, color: "#666666", marginTop: 2 },
    table: { marginTop: 24 },
    tableHeader: {
      flexDirection: "row",
      backgroundColor: "#f0f0f0",
      borderBottomWidth: 1,
      borderBottomColor: "#cccccc",
      borderBottomStyle: "solid",
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderBottomColor: "#e0e0e0",
      borderBottomStyle: "solid",
    },
    th: { padding: 6, fontSize: 10, fontFamily: "Helvetica-Bold" },
    td: { padding: 6, fontSize: 10 },
    colDesc: { flex: 1 },
    colQty: { width: 50, textAlign: "center" },
    colPrice: { width: 80, textAlign: "right" },
    colTotal: { width: 80, textAlign: "right" },
    totals: { marginTop: 16, alignItems: "flex-end" },
    totalRow: { flexDirection: "row", marginTop: 4 },
    totalLabel: { width: 90, textAlign: "right", fontFamily: "Helvetica-Bold" },
    totalValue: { width: 90, textAlign: "right" },
    rule: {
      width: 180,
      borderBottomWidth: 1,
      borderBottomColor: "#333333",
      borderBottomStyle: "solid",
      marginVertical: 8,
    },
    grandLabel: {
      width: 90,
      textAlign: "right",
      fontFamily: "Helvetica-Bold",
      fontSize: 14,
    },
    grandValue: {
      width: 90,
      textAlign: "right",
      fontFamily: "Helvetica-Bold",
      fontSize: 14,
    },
    sectionTitle: {
      fontSize: 10,
      fontFamily: "Helvetica-Bold",
      marginTop: 20,
      marginBottom: 4,
    },
    sectionBody: { fontSize: 10, color: "#666666" },
    // Non-final paragraphs of a multi-paragraph section: same type style with a
    // small gap so paragraphs read as distinct blocks.
    sectionParagraph: { fontSize: 10, color: "#666666", marginBottom: 6 },
  });

  // Render a multi-paragraph body as separate Text nodes. A single-paragraph
  // body yields exactly one Text with styles.sectionBody — identical to before.
  const sectionBodyNodes = (
    text: string,
    keyPrefix: string,
  ): React.ReactNode[] => {
    const paragraphs = splitParagraphs(text);
    if (paragraphs.length === 0) {
      return [
        h(Text, { key: `${keyPrefix}-0`, style: styles.sectionBody }, ""),
      ];
    }
    return paragraphs.map((paragraph, i) =>
      h(
        Text,
        {
          key: `${keyPrefix}-${i}`,
          style:
            i === paragraphs.length - 1
              ? styles.sectionBody
              : styles.sectionParagraph,
        },
        paragraph,
      ),
    );
  };

  const itemRows = items.map((item, i) =>
    h(
      View,
      { key: `item-${i}`, style: styles.tableRow, wrap: false },
      h(Text, { style: [styles.td, styles.colDesc] }, item.description),
      h(Text, { style: [styles.td, styles.colQty] }, String(item.quantity)),
      h(Text, { style: [styles.td, styles.colPrice] }, money(item.unitPrice)),
      h(Text, { style: [styles.td, styles.colTotal] }, money(item.lineTotal)),
    ),
  );

  return h(
    Document,
    {
      producer: PRODUCER,
      title: `Invoice ${invoiceNumber}`,
      author: companyName,
      creationDate: FIXED_CREATION_DATE,
      modificationDate: FIXED_CREATION_DATE,
    },
    h(
      Page,
      { size: "A4", style: styles.page, wrap: true },
      h(Text, { style: styles.company }, companyName),
      companyAddress
        ? h(Text, { style: styles.companyAddress }, companyAddress)
        : null,
      h(
        View,
        { style: styles.headerRow },
        h(
          View,
          {},
          h(Text, { style: styles.invoiceTitle }, "INVOICE"),
          h(Text, { style: styles.invoiceNumber }, `#${invoiceNumber}`),
        ),
        h(
          View,
          {},
          h(Text, { style: styles.dateLine }, `Date: ${invoiceDate}`),
          dueDate
            ? h(
                Text,
                { style: [styles.dateLine, { marginTop: 4 }] },
                `Due: ${dueDate}`,
              )
            : null,
        ),
      ),
      h(
        View,
        { style: styles.billTo },
        h(Text, { style: styles.billToLabel }, "Bill To:"),
        h(Text, { style: styles.clientName }, clientName),
        clientAddress
          ? h(Text, { style: styles.clientAddress }, clientAddress)
          : null,
      ),
      h(
        View,
        { style: styles.table },
        h(
          View,
          { style: styles.tableHeader },
          h(Text, { style: [styles.th, styles.colDesc] }, "Description"),
          h(Text, { style: [styles.th, styles.colQty] }, "Qty"),
          h(Text, { style: [styles.th, styles.colPrice] }, "Unit Price"),
          h(Text, { style: [styles.th, styles.colTotal] }, "Total"),
        ),
        ...itemRows,
      ),
      h(
        View,
        { style: styles.totals },
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.totalLabel }, "Subtotal:"),
          h(Text, { style: styles.totalValue }, money(subtotal)),
        ),
        taxRate > 0
          ? h(
              View,
              { style: styles.totalRow },
              h(Text, { style: styles.totalLabel }, `Tax (${taxRate}%):`),
              h(Text, { style: styles.totalValue }, money(tax)),
            )
          : null,
        h(View, { style: styles.rule }),
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.grandLabel }, "Total:"),
          h(Text, { style: styles.grandValue }, money(total)),
        ),
      ),
      paymentTerms
        ? h(
            View,
            {},
            h(Text, { style: styles.sectionTitle }, "Payment Terms"),
            ...sectionBodyNodes(paymentTerms, "terms"),
          )
        : null,
      notes
        ? h(
            View,
            {},
            h(Text, { style: styles.sectionTitle }, "Notes"),
            ...sectionBodyNodes(notes, "notes"),
          )
        : null,
    ),
  ) as DocumentElement;
}
