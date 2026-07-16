/**
 * Realistic MCP fixture server that does actual work.
 *
 * Supports:
 * - `read_file({ path })` → returns file contents
 * - `write_file({ path, content })` → writes file, returns confirmation
 * - `delete_file({ path })` → deletes file
 * - `list_dir({ path })` → lists directory contents
 * - `echo({ text })` → echoes back text (no side effects)
 * - `slow_op({ delay })` → delayed response (for timeout tests)
 *
 * Usage:
 *   node fixtures/realistic-server.mjs
 *
 * Protocol: stdio, MCP JSON-RPC 2.0
 * Each line is a complete JSON message (\n delimited).
 */

import process from "node:process";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── Safety: restrict file operations to allowlist ──────────────────

const ALLOWED_DIRS = process.env.MCP_ALLOWED_DIRS
  ? process.env.MCP_ALLOWED_DIRS.split(";")
  : [];

function isPathAllowed(targetPath) {
  if (ALLOWED_DIRS.length === 0) return true; // No restriction
  for (const dir of ALLOWED_DIRS) {
    if (targetPath.startsWith(dir)) return true;
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────────

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── Tool handlers ──────────────────────────────────────────────────

const toolHandlers = {
  async read_file(args) {
    const path = args?.path;
    if (!path) return { content: [{ type: "text", text: "Missing path" }], isError: true };
    if (!isPathAllowed(path)) return { content: [{ type: "text", text: `Access denied: ${path}` }], isError: true };
    try {
      const content = await readFile(path, "utf8");
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error reading file: ${e.message}` }], isError: true };
    }
  },

  async write_file(args) {
    const path = args?.path;
    const content = args?.content ?? "";
    if (!path) return { content: [{ type: "text", text: "Missing path" }], isError: true };
    if (!isPathAllowed(path)) return { content: [{ type: "text", text: `Access denied: ${path}` }], isError: true };
    try {
      await writeFile(path, content, "utf8");
      return { content: [{ type: "text", text: `Written ${content.length} bytes to ${path}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error writing file: ${e.message}` }], isError: true };
    }
  },

  async delete_file(args) {
    const path = args?.path;
    if (!path) return { content: [{ type: "text", text: "Missing path" }], isError: true };
    if (!isPathAllowed(path)) return { content: [{ type: "text", text: `Access denied: ${path}` }], isError: true };
    try {
      await unlink(path);
      return { content: [{ type: "text", text: `Deleted ${path}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error deleting file: ${e.message}` }], isError: true };
    }
  },

  async list_dir(args) {
    const path = args?.path ?? ".";
    if (!isPathAllowed(path)) return { content: [{ type: "text", text: `Access denied: ${path}` }], isError: true };
    try {
      const entries = await readdir(path);
      return { content: [{ type: "text", text: entries.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error listing dir: ${e.message}` }], isError: true };
    }
  },

  async echo(args) {
    const text = args?.text ?? "";
    return { content: [{ type: "text", text }] };
  },

  async slow_op(args) {
    const delay = args?.delay ?? 1000;
    await new Promise((r) => setTimeout(r, delay));
    return { content: [{ type: "text", text: `done after ${delay}ms` }] };
  },
};

// ── Tool definitions ───────────────────────────────────────────────

const tools = Object.keys(toolHandlers).map((name) => {
  const schemas = {
    read_file: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    write_file: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    delete_file: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    list_dir: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    echo: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    slow_op: {
      type: "object",
      properties: { delay: { type: "number" } },
    },
  };

  return {
    name,
    description: `${name} operation`,
    inputSchema: schemas[name] ?? { type: "object", properties: {} },
  };
});

// ── Inbound processing ─────────────────────────────────────────────

process.stdin.on("data", (chunk) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);

      if (msg.method === "initialize") {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "realistic", version: "1.0.0" },
          },
        });
      } else if (msg.method === "notifications/initialized") {
        // ignore
      } else if (msg.method === "tools/list") {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools },
        });
      } else if (msg.method === "tools/call") {
        const toolName = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        const handler = toolHandlers[toolName];

        if (handler) {
          handler(args)
            .then((result) => {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result,
              });
            })
            .catch((e) => {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32603, message: e.message },
              });
            });
        } else {
          sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          });
        }
      } else {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
    } catch {
      // ignore malformed JSON
    }
  }
});
