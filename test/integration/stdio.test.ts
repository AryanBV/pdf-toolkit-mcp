import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);

// The canonical tool surface. This list is the contract: any tool that fails to
// register (e.g. the outputSchema-drops-tools bug) makes this test fail.
const EXPECTED_TOOLS = [
  "pdf_extract_text",
  "pdf_get_metadata",
  "pdf_get_form_fields",
  "pdf_merge",
  "pdf_split",
  "pdf_rotate_pages",
  "pdf_encrypt",
  "pdf_add_page_numbers",
  "pdf_embed_qr_code",
  "pdf_reorder_pages",
  "pdf_create",
  "pdf_fill_form",
  "pdf_add_watermark",
  "pdf_embed_image",
  "pdf_create_from_markdown",
  "pdf_create_from_template",
  "pdf_render_pages",
].sort();

describe("MCP stdio transport", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: "pipe",
    });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("exposes exactly the expected tools (guards against registration drops)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("every tool declares a non-empty description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description, `${t.name} is missing a description`).toBeTruthy();
    }
  });
});

describe("stdout protocol hygiene", () => {
  it("emits only valid JSON-RPC frames on stdout (no console.log pollution)", async () => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines: string[] = [];
    let buf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });

    const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + "\n");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    };

    // The server loads modules for ~2-3s before its stdin reader is active;
    // resend initialize until the first response frame arrives (robust to
    // variable startup time on slow CI machines).
    for (let i = 0; i < 40 && lines.length === 0; i++) {
      send(initialize);
      await sleep(400);
    }
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await sleep(800);
    proc.kill();

    const frames = lines.filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    for (const line of frames) {
      // JSON.parse throws if a stray console.log polluted the channel.
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe("2.0");
    }
  });
});
