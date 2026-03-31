export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  pageCount: number;
  keywords?: string;
}

export interface PageText {
  page: number;
  text: string;
}

export interface FormField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radiogroup" | "button" | "signature";
  value: string | boolean;
  required: boolean;
}

export type ParsedPageRange = number[];
