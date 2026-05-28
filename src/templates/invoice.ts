import React from "react";
import { z } from "zod";
import {
  getReactPdf,
  PRODUCER,
  type DocumentElement,
} from "../services/pdf-creator.js";

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

  const items = (data.items ?? []).map((item) => ({
    description: item.description ?? "",
    quantity: item.quantity ?? 1,
    unitPrice: item.unitPrice ?? 0,
  }));

  const subtotal = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const money = (n: number): string => `$${n.toFixed(2)}`;

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
  });

  const itemRows = items.map((item, i) =>
    h(
      View,
      { key: `item-${i}`, style: styles.tableRow, wrap: false },
      h(Text, { style: [styles.td, styles.colDesc] }, item.description),
      h(Text, { style: [styles.td, styles.colQty] }, String(item.quantity)),
      h(Text, { style: [styles.td, styles.colPrice] }, money(item.unitPrice)),
      h(
        Text,
        { style: [styles.td, styles.colTotal] },
        money(item.quantity * item.unitPrice),
      ),
    ),
  );

  return h(
    Document,
    {
      producer: PRODUCER,
      title: `Invoice ${invoiceNumber}`,
      author: companyName,
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
            h(Text, { style: styles.sectionBody }, paymentTerms),
          )
        : null,
      notes
        ? h(
            View,
            {},
            h(Text, { style: styles.sectionTitle }, "Notes"),
            h(Text, { style: styles.sectionBody }, notes),
          )
        : null,
    ),
  ) as DocumentElement;
}
