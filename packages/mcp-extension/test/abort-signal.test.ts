/**
 * F-1.12: AbortSignal → MCP callTool cancel propagation
 *
 * Integration test verifying that aborting an AbortController rejects
 * client.callTool with an AbortError (or similar cancellation error).
 *
 * Uses the slow-server.mjs fixture which takes 5s to respond to
 * tools/call, giving the abort signal plenty of time to fire.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("F-1.12: AbortSignal → MCP cancel propagation", () => {
	it("aborting signal rejects callTool with AbortError", async () => {
		const transport = new StdioClientTransport({
			command: process.execPath, // node
			args: [path.join(__dirname, "fixtures", "slow-server.mjs")],
		});
		const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} as any });
		await client.connect(transport);

		const controller = new AbortController();
		const promise = client.callTool({ name: "slow_op", arguments: {} }, undefined, { signal: controller.signal });

		// Abort well before the 5s server response
		setTimeout(() => controller.abort(), 100);

		await expect(promise).rejects.toThrow();
		await client.close();
		await transport.close();
	}, 15_000);
});
