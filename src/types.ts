export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: (TextContent | ImageContent)[];
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
  fileSize?: string;
}

export interface PageText {
  page: number;
  text: string;
}

/** A single positioned text fragment extracted from a PDF page. */
export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/** Positioned text for one page, including the page's media-box dimensions. */
export interface PageTextLayout {
  page: number;
  width: number;
  height: number;
  items: PositionedTextItem[];
}

export interface FormField {
  name: string;
  type:
    | "text"
    | "checkbox"
    | "dropdown"
    | "listbox"
    | "radiogroup"
    | "button"
    | "signature";
  value: string | boolean;
  required: boolean;
}

export type ParsedPageRange = number[];

export type TemplateName = "invoice" | "report" | "letter";
