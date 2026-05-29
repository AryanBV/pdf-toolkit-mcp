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

export const letterSchema = z
  .object({
    senderName: z.string().optional(),
    senderAddress: z.string().optional(),
    senderTitle: z.string().optional(),
    recipientName: z.string().optional(),
    recipientAddress: z.string().optional(),
    date: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    closing: z.string().optional(),
    signatureName: z.string().optional(),
  })
  .strip();

export type LetterData = z.infer<typeof letterSchema>;

export async function buildLetter(data: LetterData): Promise<DocumentElement> {
  const rp = await getReactPdf();
  const { Document, Page, View, Text, StyleSheet } = rp;

  const senderName = data.senderName ?? "";
  const senderAddress = data.senderAddress ?? "";
  const senderTitle = data.senderTitle ?? "";
  const recipientName = data.recipientName ?? "Recipient";
  const recipientAddress = data.recipientAddress ?? "";
  const date = data.date ?? new Date().toISOString().slice(0, 10);
  const subject = data.subject ?? "";
  const body = data.body ?? "";
  const closing = data.closing ?? "Sincerely";
  const signatureName = data.signatureName ?? senderName;

  const bodyParagraphs = splitParagraphs(body);

  const styles = StyleSheet.create({
    page: {
      paddingTop: 56,
      paddingBottom: 64,
      paddingHorizontal: 56,
      fontSize: 11,
      lineHeight: 1.5,
      fontFamily: "Helvetica",
      color: "#1a1a1a",
    },
    senderName: {
      fontSize: 16,
      fontFamily: "Helvetica-Bold",
      color: "#2c3e50",
    },
    senderLine: { fontSize: 9, color: "#666666", marginTop: 2 },
    letterhead: {
      borderBottomWidth: 0.5,
      borderBottomColor: "#cccccc",
      borderBottomStyle: "solid",
      paddingBottom: 10,
      marginBottom: 20,
    },
    date: { marginBottom: 20 },
    recipientName: { fontFamily: "Helvetica-Bold" },
    recipientLine: { color: "#666666", marginTop: 2 },
    subject: { fontFamily: "Helvetica-Bold", marginTop: 20, marginBottom: 20 },
    paragraph: { marginTop: 10 },
    closing: { marginTop: 30 },
    signature: { fontFamily: "Helvetica-Bold", marginTop: 40 },
    signatureTitle: { fontSize: 10, color: "#666666", marginTop: 2 },
  });

  return h(
    Document,
    {
      producer: PRODUCER,
      title: subject || `Letter to ${recipientName}`,
      author: senderName || undefined,
      creationDate: FIXED_CREATION_DATE,
      modificationDate: FIXED_CREATION_DATE,
    },
    h(
      Page,
      { size: "A4", style: styles.page, wrap: true },
      senderName
        ? h(
            View,
            { style: styles.letterhead },
            h(Text, { style: styles.senderName }, senderName),
            senderAddress
              ? h(Text, { style: styles.senderLine }, senderAddress)
              : null,
            senderTitle
              ? h(Text, { style: styles.senderLine }, senderTitle)
              : null,
          )
        : null,
      h(Text, { style: styles.date }, date),
      h(Text, { style: styles.recipientName }, recipientName),
      recipientAddress
        ? h(Text, { style: styles.recipientLine }, recipientAddress)
        : null,
      subject ? h(Text, { style: styles.subject }, `Re: ${subject}`) : null,
      ...bodyParagraphs.map((paragraph, idx) =>
        h(
          Text,
          { key: `p-${idx}`, style: idx > 0 ? styles.paragraph : {} },
          paragraph,
        ),
      ),
      h(Text, { style: styles.closing }, `${closing},`),
      h(Text, { style: styles.signature }, signatureName),
      senderTitle
        ? h(Text, { style: styles.signatureTitle }, senderTitle)
        : null,
    ),
  ) as DocumentElement;
}
