import process from "node:process";

process.stdin.on("data", (chunk) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "slow", version: "0.0.1" } }
        }) + "\n");
      } else if (msg.method === "notifications/initialized") {
        // ignore
      } else if (msg.method === "tools/list") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { tools: [{ name: "slow_op", description: "Takes 5s", inputSchema: { type: "object", properties: {} } }] }
        }) + "\n");
      } else if (msg.method === "tools/call") {
        // Respond after 5s to allow abort signal to win
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { content: [{ type: "text", text: "done" }] }
          }) + "\n");
        }, 5000);
      }
    } catch {
      // ignore malformed JSON
    }
  }
});
