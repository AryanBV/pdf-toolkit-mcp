import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { templateRegistry } from "../templates/index.js";

const TEMPLATES_URI = "pdf-toolkit://templates";

// Short human-readable summary of what each template renders. Field names are
// derived from the Zod schema shape; these blurbs add intent the schema can't.
const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  invoice:
    "A billing invoice with company/client details, line items (description, quantity, unitPrice), optional tax, and totals.",
  report:
    "A multi-page report with a title page and numbered sections (heading + body).",
  letter:
    "A formal letter with sender/recipient blocks, subject, body paragraphs, and a closing signature.",
};

interface TemplateInfo {
  name: string;
  description: string;
  fields: string[];
}

/**
 * Best-effort extraction of top-level field names from a Zod object schema.
 * Templates use `.strip()`-wrapped `z.object(...)`, whose underlying shape is
 * exposed via `.shape`. Returns an empty array if the shape is unavailable.
 */
function fieldsFromSchema(schema: z.ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && typeof shape === "object") {
    return Object.keys(shape);
  }
  return [];
}

function buildTemplatesPayload(): { templates: TemplateInfo[] } {
  const templates: TemplateInfo[] = Object.entries(templateRegistry).map(
    ([name, entry]) => ({
      name,
      description: TEMPLATE_DESCRIPTIONS[name] ?? `The "${name}" template.`,
      fields: fieldsFromSchema(entry.schema),
    }),
  );
  return { templates };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "PDF templates",
    TEMPLATES_URI,
    {
      title: "PDF templates",
      description:
        "The templates available to pdf_create_from_template, each with its accepted JSON fields.",
      mimeType: "application/json",
    },
    (uri) => {
      const payload = buildTemplatesPayload();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
