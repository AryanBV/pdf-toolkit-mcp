#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerManipulateTools } from "./tools/manipulate.js";
import { registerCreateTools } from "./tools/create.js";
import { registerRenderTools } from "./tools/render.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { createRequire } from "node:module";

// Single source of truth for the version — resolved from package.json at runtime
// so it can never drift from the published package version.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "pdf-toolkit-mcp",
  version,
});

registerReadTools(server);
registerManipulateTools(server);
registerCreateTools(server);
registerRenderTools(server);
registerPrompts(server);
registerResources(server);

const transport = new StdioServerTransport();

(async () => {
  await server.connect(transport);
})().catch((error: unknown) => {
  console.error("Fatal error starting pdf-toolkit-mcp:", error);
  process.exit(1);
});
