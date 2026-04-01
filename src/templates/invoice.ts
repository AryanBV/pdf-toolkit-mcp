interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export function buildInvoice(data: Record<string, unknown>): Record<string, unknown> {
  const companyName = String(data.companyName ?? "Company Name");
  const companyAddress = String(data.companyAddress ?? "");
  const clientName = String(data.clientName ?? "Client Name");
  const clientAddress = String(data.clientAddress ?? "");
  const invoiceNumber = String(data.invoiceNumber ?? "INV-001");
  const invoiceDate = String(data.invoiceDate ?? new Date().toISOString().slice(0, 10));
  const dueDate = String(data.dueDate ?? "");
  const notes = String(data.notes ?? "");
  const taxRate = Number(data.taxRate ?? 0);
  const paymentTerms = String(data.paymentTerms ?? "");

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items: InvoiceItem[] = rawItems.map((item: unknown) => {
    const obj = item as Record<string, unknown>;
    return {
      description: String(obj.description ?? ""),
      quantity: Number(obj.quantity ?? 1),
      unitPrice: Number(obj.unitPrice ?? 0),
    };
  });

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const tableBody: unknown[][] = [
    [
      { text: "Description", bold: true, fillColor: "#f0f0f0" },
      { text: "Qty", bold: true, alignment: "center", fillColor: "#f0f0f0" },
      { text: "Unit Price", bold: true, alignment: "right", fillColor: "#f0f0f0" },
      { text: "Total", bold: true, alignment: "right", fillColor: "#f0f0f0" },
    ],
    ...items.map((item) => [
      item.description,
      { text: String(item.quantity), alignment: "center" },
      { text: `$${item.unitPrice.toFixed(2)}`, alignment: "right" },
      { text: `$${(item.quantity * item.unitPrice).toFixed(2)}`, alignment: "right" },
    ]),
  ];

  const content: unknown[] = [
    { text: companyName, fontSize: 22, bold: true, color: "#333333" },
    ...(companyAddress ? [{ text: companyAddress, fontSize: 9, color: "#666666", margin: [0, 2, 0, 20] }] : [{ text: "", margin: [0, 0, 0, 20] }]),
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "INVOICE", fontSize: 28, bold: true, color: "#2c3e50" },
            { text: `#${invoiceNumber}`, fontSize: 12, color: "#666666", margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: `Date: ${invoiceDate}`, fontSize: 10, alignment: "right" },
            ...(dueDate ? [{ text: `Due: ${dueDate}`, fontSize: 10, alignment: "right", margin: [0, 4, 0, 0] }] : []),
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },
    {
      stack: [
        { text: "Bill To:", fontSize: 10, bold: true, color: "#666666" },
        { text: clientName, fontSize: 12, bold: true, margin: [0, 4, 0, 0] },
        ...(clientAddress ? [{ text: clientAddress, fontSize: 10, color: "#666666" }] : []),
      ],
      margin: [0, 0, 0, 20],
    },
    {
      table: {
        headerRows: 1,
        widths: ["*", 50, 80, 80],
        body: tableBody,
      },
      layout: "lightHorizontalLines",
      margin: [0, 0, 0, 10],
    },
    {
      columns: [
        { width: "*", text: "" },
        {
          width: "auto",
          stack: [
            {
              columns: [
                { text: "Subtotal:", width: 80, alignment: "right", bold: true },
                { text: `$${subtotal.toFixed(2)}`, width: 80, alignment: "right" },
              ],
            },
            ...(taxRate > 0
              ? [
                  {
                    columns: [
                      { text: `Tax (${taxRate}%):`, width: 80, alignment: "right", bold: true },
                      { text: `$${tax.toFixed(2)}`, width: 80, alignment: "right" },
                    ],
                    margin: [0, 4, 0, 0],
                  },
                ]
              : []),
            {
              canvas: [{ type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 1 }],
              margin: [0, 8, 0, 8],
            },
            {
              columns: [
                { text: "Total:", width: 80, alignment: "right", bold: true, fontSize: 14 },
                { text: `$${total.toFixed(2)}`, width: 80, alignment: "right", bold: true, fontSize: 14 },
              ],
            },
          ],
        },
      ],
      margin: [0, 10, 0, 20],
    },
    ...(paymentTerms ? [{ text: "Payment Terms", bold: true, fontSize: 10, margin: [0, 10, 0, 4] }, { text: paymentTerms, fontSize: 10, color: "#666666" }] : []),
    ...(notes ? [{ text: "Notes", bold: true, fontSize: 10, margin: [0, 10, 0, 4] }, { text: notes, fontSize: 10, color: "#666666" }] : []),
  ];

  return {
    content,
    defaultStyle: { fontSize: 11 },
    info: { producer: "@aryanbv/pdf-toolkit-mcp" },
  };
}
