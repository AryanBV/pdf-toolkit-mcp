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

export const reportSchema = z
  .object({
    title: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
    subtitle: z.string().optional(),
    sections: z
      .array(
        z.object({
          heading: z.string().optional(),
          body: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strip();

export type ReportData = z.infer<typeof reportSchema>;

export async function buildReport(data: ReportData): Promise<DocumentElement> {
  const rp = await getReactPdf();
  const { Document, Page, View, Text, StyleSheet } = rp;

  const title = data.title ?? "Report";
  const author = data.author ?? "";
  const date = data.date ?? new Date().toISOString().slice(0, 10);
  const subtitle = data.subtitle ?? "";
  const sections = (data.sections ?? []).map((s) => ({
    heading: s.heading ?? "Section",
    body: s.body ?? "",
  }));

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
    titlePage: {
      paddingTop: 56,
      paddingBottom: 64,
      paddingHorizontal: 56,
      fontFamily: "Helvetica",
      justifyContent: "center",
      alignItems: "center",
    },
    title: {
      fontSize: 32,
      fontFamily: "Helvetica-Bold",
      color: "#2c3e50",
      textAlign: "center",
    },
    subtitle: {
      fontSize: 16,
      color: "#666666",
      textAlign: "center",
      marginTop: 10,
    },
    meta: { fontSize: 12, color: "#888888", textAlign: "center", marginTop: 6 },
    metaBlock: { marginTop: 40, alignItems: "center" },
    sectionHeading: {
      fontSize: 18,
      fontFamily: "Helvetica-Bold",
      color: "#2c3e50",
      marginBottom: 10,
    },
    sectionBody: { fontSize: 11, lineHeight: 1.5, marginBottom: 16 },
    // Non-final paragraphs of a multi-paragraph section body: same type style,
    // a smaller gap between paragraphs than the section's trailing margin.
    sectionParagraph: { fontSize: 11, lineHeight: 1.5, marginBottom: 8 },
    header: {
      position: "absolute",
      top: 24,
      left: 56,
      right: 56,
      fontSize: 8,
      color: "#888888",
      textAlign: "center",
    },
    footer: {
      position: "absolute",
      bottom: 28,
      left: 56,
      right: 56,
      fontSize: 9,
      color: "#888888",
      textAlign: "center",
    },
  });

  const sectionNodes = sections.map((section, idx) => {
    // Render each paragraph of the body as its own Text node. A single
    // paragraph produces exactly one node with styles.sectionBody — identical
    // to before. The last paragraph keeps the section's trailing margin.
    const paragraphs = splitParagraphs(section.body);
    const bodyNodes =
      paragraphs.length > 0
        ? paragraphs.map((paragraph, pIdx) =>
            h(
              Text,
              {
                key: `sec-${idx}-p-${pIdx}`,
                style:
                  pIdx === paragraphs.length - 1
                    ? styles.sectionBody
                    : styles.sectionParagraph,
              },
              paragraph,
            ),
          )
        : [h(Text, { key: `sec-${idx}-p-0`, style: styles.sectionBody }, "")];
    return h(
      View,
      { key: `sec-${idx}`, style: idx > 0 ? { marginTop: 8 } : {}, wrap: true },
      h(
        Text,
        { style: styles.sectionHeading },
        `${idx + 1}. ${section.heading}`,
      ),
      ...bodyNodes,
    );
  });

  const footerRender = (props: {
    pageNumber: number;
    totalPages: number;
  }): React.ReactNode => `Page ${props.pageNumber} of ${props.totalPages}`;

  return h(
    Document,
    {
      producer: PRODUCER,
      title,
      author: author || undefined,
      creationDate: FIXED_CREATION_DATE,
      modificationDate: FIXED_CREATION_DATE,
    },
    // Title page
    h(
      Page,
      { size: "A4", style: styles.titlePage },
      h(Text, { style: styles.title }, title),
      subtitle ? h(Text, { style: styles.subtitle }, subtitle) : null,
      h(
        View,
        { style: styles.metaBlock },
        author ? h(Text, { style: styles.meta }, `Author: ${author}`) : null,
        h(Text, { style: styles.meta }, `Date: ${date}`),
      ),
    ),
    // Body pages with running header + page-number footer
    h(
      Page,
      { size: "A4", style: styles.page, wrap: true },
      h(Text, { style: styles.header, fixed: true }, title),
      h(Text, { style: styles.footer, fixed: true, render: footerRender }),
      ...sectionNodes,
    ),
  ) as DocumentElement;
}
