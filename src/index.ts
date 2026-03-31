#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerManipulateTools } from "./tools/manipulate.js";
import { registerCreateTools } from "./tools/create.js";

const server = new McpServer({
  name: "pdf-toolkit-mcp",
  version: "0.1.0",
});

registerReadTools(server);
registerManipulateTools(server);
registerCreateTools(server);

const transport = new StdioServerTransport();

(async () => {
  await server.connect(transport);
})().catch((error: unknown) => {
  console.error("Fatal error starting pdf-toolkit-mcp:", error);
  process.exit(1);
});
