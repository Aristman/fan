/**
 * MCP fixture server that advertises listChanged capability and sends
 * `notifications/tools/list_changed` notifications.
 *
 * Supports:
 * - tools/list → returns current tool list
 * - /trigger-list-change → sends tools/list_changed notification (for integration tests)
 * - Auto-sends notification after N seconds (via query param on connect)
 *
 * Usage:
 *   node fixtures/notify-server.mjs
 *
 * Protocol: stdio, MCP JSON-RPC 2.0
 * Each line is a complete JSON message (\\n delimited).
 */

import process from "node:process";

// ── Tool state ─────────────────────────────────────────────────────

const tools = [
  {
    name: "greet",
    description: "Say hello to someone",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "math_add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
];

/** Count how many list_tools requests we've answered (for state transitions). */
let listToolsCount = 0;
let notified = false;

// ── Helpers ────────────────────────────────────────────────────────

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendNotification(method) {
  sendMessage({ jsonrpc: "2.0", method });
}

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
            capabilities: {
              tools: {
                listChanged: true, // Advertise listChanged capability
              },
            },
            serverInfo: { name: "notify-test", version: "0.1.0" },
          },
        });
      } else if (msg.method === "notifications/initialized") {
        // After initialized, send a delayed list_changed notification
        // (for integration tests that expect a notification after connect)
        setTimeout(() => {
          if (!notified) {
            notified = true;
            sendNotification("notifications/tools/list_changed");
          }
        }, 1000);
      } else if (msg.method === "tools/list") {
        listToolsCount++;

        let currentTools;

        if (listToolsCount === 1) {
          // First call: return initial tools
          currentTools = [...tools];
        } else if (listToolsCount === 2) {
          // Second call: return modified tools (add one, remove one)
          currentTools = [
            {
              name: "greet",
              description: "Say hello to someone (updated)",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  greeting: { type: "string" },
                },
                required: ["name"],
              },
            },
            // math_add removed
            {
              name: "weather",
              description: "Get weather for a city",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
                required: ["city"],
              },
            },
          ];
        } else {
          // Subsequent calls: stable after change
          currentTools = [
            {
              name: "greet",
              description: "Say hello to someone (updated)",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  greeting: { type: "string" },
                },
                required: ["name"],
              },
            },
            {
              name: "weather",
              description: "Get weather for a city",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
                required: ["city"],
              },
            },
          ];
        }

        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: currentTools,
          },
        });
      } else {
        // Unknown method
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
