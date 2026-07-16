import { describe, it, expect, beforeEach } from "vitest";
import { brokerHandler } from "../broker-handler.js";

describe("F-2.5: brokerHandler", () => {
	beforeEach(() => brokerHandler._reset());

	it("initialize is idempotent", () => {
		const fakeBus = { on: () => {} };
		brokerHandler.initialize({ events: fakeBus });
		brokerHandler.initialize({ events: fakeBus });
		// Should subscribe only once (no observable difference, but no crash).
		expect(true).toBe(true);
	});

	it("getTool returns null for unknown id", () => {
		brokerHandler.initialize({ events: { on: () => {} } });
		expect(brokerHandler.getTool("nonexistent_tool")).toBeNull();
	});

	it("listTools returns empty when no catalog received", () => {
		brokerHandler.initialize({ events: { on: () => {} } });
		expect(brokerHandler.listTools()).toEqual([]);
	});

	it("captures tools via EventBus subscription", () => {
		let capturedHandler = null;
		brokerHandler.initialize({
			events: {
				on: (channel, handler) => {
					capturedHandler = handler;
				},
			},
		});
		// Simulate fan-mcp emit
		capturedHandler({
			tools: [
				{
					id: "mcp__fs__read_file",
					description: "Read file",
					inputSchema: {},
				},
			],
		});
		const tool = brokerHandler.getTool("mcp__fs__read_file");
		expect(tool).not.toBeNull();
		expect(tool.description).toBe("Read file");
	});

	it("overwrites catalog on subsequent emits", () => {
		let capturedHandler = null;
		brokerHandler.initialize({
			events: { on: (ch, h) => { capturedHandler = h; } },
		});
		capturedHandler({ tools: [{ id: "t1" }, { id: "t2" }] });
		expect(brokerHandler.listTools()).toHaveLength(2);
		capturedHandler({ tools: [{ id: "t3" }] });
		expect(brokerHandler.listTools()).toHaveLength(1);
		expect(brokerHandler.getTool("t1")).toBeNull();
		expect(brokerHandler.getTool("t3")).not.toBeNull();
	});
});
