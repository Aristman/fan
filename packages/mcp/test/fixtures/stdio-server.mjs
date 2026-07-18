import process from "node:process";

process.stdin.on("data", (chunk) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "echo", version: "0.0.1" },
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (msg.method === "notifications/initialized") {
        // ignore
      } else {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch {
      // ignore malformed JSON
    }
  }
});
