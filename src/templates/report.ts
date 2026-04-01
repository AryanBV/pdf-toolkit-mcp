interface ReportSection {
  heading: string;
  body: string;
}

export function buildReport(data: Record<string, unknown>): Record<string, unknown> {
  const title = String(data.title ?? "Report");
  const author = String(data.author ?? "");
  const date = String(data.date ?? new Date().toISOString().slice(0, 10));
  const subtitle = String(data.subtitle ?? "");

  const rawSections = Array.isArray(data.sections) ? data.sections : [];
  const sections: ReportSection[] = rawSections.map((s: unknown) => {
    const obj = s as Record<string, unknown>;
    return {
      heading: String(obj.heading ?? "Section"),
      body: String(obj.body ?? ""),
    };
  });

  const content: unknown[] = [
    // Title page
    { text: "", margin: [0, 0, 0, 100] },
    { text: title, fontSize: 32, bold: true, alignment: "center", color: "#2c3e50" },
    ...(subtitle ? [{ text: subtitle, fontSize: 16, alignment: "center", color: "#666666", margin: [0, 10, 0, 0] }] : []),
    { text: "", margin: [0, 0, 0, 40] },
    ...(author ? [{ text: `Author: ${author}`, fontSize: 12, alignment: "center", color: "#888888" }] : []),
    { text: `Date: ${date}`, fontSize: 12, alignment: "center", color: "#888888", margin: [0, 4, 0, 0] },
    { text: "", pageBreak: "after" },
    // Sections
    ...sections.flatMap((section, idx) => [
      {
        text: `${idx + 1}. ${section.heading}`,
        fontSize: 18,
        bold: true,
        color: "#2c3e50",
        margin: [0, idx > 0 ? 20 : 0, 0, 10],
      },
      {
        text: section.body,
        fontSize: 11,
        lineHeight: 1.5,
        margin: [0, 0, 0, 10],
      },
    ]),
  ];

  return {
    content,
    defaultStyle: { fontSize: 11 },
    header: (currentPage: number) => {
      if (currentPage === 1) return null;
      return {
        text: title,
        alignment: "center",
        fontSize: 8,
        color: "#888888",
        margin: [40, 10, 40, 0],
      };
    },
    footer: (currentPage: number, pageCount: number) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      alignment: "center",
      fontSize: 9,
      color: "#888888",
      margin: [0, 10, 0, 0],
    }),
    info: {
      title,
      author: author || undefined,
      producer: "@aryanbv/pdf-toolkit-mcp",
    },
  };
}
