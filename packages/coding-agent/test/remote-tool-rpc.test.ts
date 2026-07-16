import { describe, expect, it } from "vitest";
import type { RpcRemoteToolResponse } from "../src/modes/rpc/rpc-types.js";

// Mirror the correlation map pattern from rpc-mode.ts (without spinning RPC mode).
// We test the data structure, not the actual stdin/stdout loop.

function makeCorrelationMap() {
	return new Map<string, { resolve: (v: RpcRemoteToolResponse) => void; reject: (e: Error) => void }>();
}

function registerRequest(
	map: ReturnType<typeof makeCorrelationMap>,
	id: string,
	timeoutMs = 1000,
): Promise<RpcRemoteToolResponse> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			map.delete(id);
			reject(new Error(`timeout ${id}`));
		}, timeoutMs);
		map.set(id, {
			resolve: (v: RpcRemoteToolResponse) => {
				clearTimeout(timer);
				resolve(v);
			},
			reject: (e: Error) => {
				clearTimeout(timer);
				reject(e);
			},
		});
	});
}

describe("F-2.2: pendingRemoteToolRequests correlation map", () => {
	it("resolves pending promise on matching remote_tool_response", () => {
		const map = makeCorrelationMap();
		const promise = registerRequest(map, "inv-001", 1000);
		expect(map.has("inv-001")).toBe(true);

		const response: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-001",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		};

		const pending = map.get(response.id);
		expect(pending).toBeDefined();
		map.delete(response.id);
		pending!.resolve(response);

		return expect(promise).resolves.toEqual(response);
	});

	it("rejects on timeout", async () => {
		const map = makeCorrelationMap();
		const promise = registerRequest(map, "inv-002", 50);
		await expect(promise).rejects.toThrow(/timeout/);
		expect(map.has("inv-002")).toBe(false);
	});

	it("unknown id in response is ignored (no-op)", () => {
		const map = makeCorrelationMap();
		map.get("unknown-id"); // returns undefined — no error
		expect(map.has("unknown-id")).toBe(false);
	});

	it("multiple concurrent requests tracked independently", async () => {
		const map = makeCorrelationMap();
		const p1 = registerRequest(map, "inv-1", 1000);
		const p2 = registerRequest(map, "inv-2", 1000);

		const r2: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-2",
			content: [{ type: "text", text: "r2" }],
			isError: false,
		};
		const r1: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-1",
			content: [{ type: "text", text: "r1" }],
			isError: false,
		};

		const pend2 = map.get("inv-2")!;
		map.delete("inv-2");
		pend2.resolve(r2);
		const pend1 = map.get("inv-1")!;
		map.delete("inv-1");
		pend1.resolve(r1);

		await Promise.all([expect(p1).resolves.toEqual(r1), expect(p2).resolves.toEqual(r2)]);
		expect(map.size).toBe(0);
	});

	it("error response (isError:true) does not throw — propagates as result", async () => {
		const map = makeCorrelationMap();
		const promise = registerRequest(map, "inv-err", 1000);

		const errRes: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-err",
			content: [{ type: "text", text: "MCP tool call failed: timeout" }],
			isError: true,
			errorMessage: "timeout",
		};
		const pend = map.get("inv-err")!;
		map.delete("inv-err");
		pend.resolve(errRes);

		const result = await promise;
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("timeout");
	});
});
