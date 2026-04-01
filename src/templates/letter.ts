export function buildLetter(data: Record<string, unknown>): Record<string, unknown> {
  const senderName = String(data.senderName ?? "");
  const senderAddress = String(data.senderAddress ?? "");
  const senderTitle = String(data.senderTitle ?? "");
  const recipientName = String(data.recipientName ?? "Recipient");
  const recipientAddress = String(data.recipientAddress ?? "");
  const date = String(data.date ?? new Date().toISOString().slice(0, 10));
  const subject = String(data.subject ?? "");
  const body = String(data.body ?? "");
  const closing = String(data.closing ?? "Sincerely");
  const signatureName = String(data.signatureName ?? senderName);

  const bodyParagraphs = body.split("\n").filter((p) => p.trim() !== "");

  const content: unknown[] = [
    // Sender letterhead
    ...(senderName
      ? [
          { text: senderName, fontSize: 16, bold: true, color: "#2c3e50" },
          ...(senderAddress
            ? [{ text: senderAddress, fontSize: 9, color: "#666666", margin: [0, 2, 0, 0] }]
            : []),
          ...(senderTitle
            ? [{ text: senderTitle, fontSize: 9, color: "#666666", margin: [0, 2, 0, 0] }]
            : []),
          {
            canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" }],
            margin: [0, 10, 0, 20],
          },
        ]
      : []),
    // Date
    { text: date, fontSize: 11, margin: [0, 0, 0, 20] },
    // Recipient block
    { text: recipientName, fontSize: 11, bold: true },
    ...(recipientAddress
      ? [{ text: recipientAddress, fontSize: 11, color: "#666666", margin: [0, 2, 0, 0] }]
      : []),
    { text: "", margin: [0, 0, 0, 20] },
    // Subject line
    ...(subject
      ? [{ text: `Re: ${subject}`, fontSize: 11, bold: true, margin: [0, 0, 0, 20] }]
      : []),
    // Body paragraphs
    ...bodyParagraphs.map((paragraph, idx) => ({
      text: paragraph,
      fontSize: 11,
      lineHeight: 1.5,
      margin: [0, idx > 0 ? 10 : 0, 0, 0],
    })),
    // Closing
    { text: "", margin: [0, 0, 0, 30] },
    { text: `${closing},`, fontSize: 11 },
    { text: "", margin: [0, 0, 0, 40] },
    // Signature
    { text: signatureName, fontSize: 11, bold: true },
    ...(senderTitle
      ? [{ text: senderTitle, fontSize: 10, color: "#666666", margin: [0, 2, 0, 0] }]
      : []),
  ];

  return {
    content,
    defaultStyle: { fontSize: 11 },
    info: { producer: "@aryanbv/pdf-toolkit-mcp" },
  };
}
