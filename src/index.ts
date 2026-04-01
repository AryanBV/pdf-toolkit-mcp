#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerManipulateTools } from "./tools/manipulate.js";
import { registerCreateTools } from "./tools/create.js";
import { registerPrompts } from "./prompts/index.js";

const server = new McpServer({
  name: "pdf-toolkit-mcp",
  version: "0.2.2",
});

registerReadTools(server);
registerManipulateTools(server);
registerCreateTools(server);
registerPrompts(server);

const transport = new StdioServerTransport();

(async () => {
  await server.connect(transport);
})().catch((error: unknown) => {
  console.error("Fatal error starting pdf-toolkit-mcp:", error);
  process.exit(1);
});
