import { describe, expect, it } from "vitest";
import type {
	RpcRemoteToolCancel,
	RpcRemoteToolCatalog,
	RpcRemoteToolRequest,
	RpcRemoteToolResponse,
	RpcToolDescriptor,
} from "../src/modes/rpc/rpc-types.js";

describe("F-2.1: RpcRemoteTool* types", () => {
	it("RpcRemoteToolRequest serializes and preserves discriminator", () => {
		const req: RpcRemoteToolRequest = {
			type: "remote_tool_request",
			id: "inv-001",
			toolId: "mcp__fs__read_file",
			args: { path: "/tmp/x" },
		};
		const json = JSON.parse(JSON.stringify(req));
		expect(json.type).toBe("remote_tool_request");
		expect(json.id).toBe("inv-001");
		expect(json.args.path).toBe("/tmp/x");
	});

	it("RpcRemoteToolResponse success variant", () => {
		const res: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-001",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
		};
		const json = JSON.parse(JSON.stringify(res));
		expect(json.isError).toBe(false);
	});

	it("RpcRemoteToolResponse error variant", () => {
		const res: RpcRemoteToolResponse = {
			type: "remote_tool_response",
			id: "inv-001",
			content: [{ type: "text", text: "MCP tool call failed: timeout" }],
			isError: true,
			errorMessage: "timeout",
		};
		expect(res.isError).toBe(true);
		expect(res.errorMessage).toBe("timeout");
	});

	it("RpcRemoteToolCancel roundtrip", () => {
		const c: RpcRemoteToolCancel = { type: "remote_tool_cancel", id: "inv-001" };
		const json = JSON.parse(JSON.stringify(c));
		expect(json.type).toBe("remote_tool_cancel");
	});

	it("RpcRemoteToolCatalog empty", () => {
		const c: RpcRemoteToolCatalog = { type: "remote_tool_catalog", tools: [] };
		expect(c.tools).toEqual([]);
	});

	it("RpcToolDescriptor with annotations", () => {
		const d: RpcToolDescriptor = {
			id: "mcp__fs__read_file",
			label: "Read File",
			description: "Read a file from disk",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
			serverName: "filesystem",
			annotations: { readOnly: true },
		};
		const json = JSON.parse(JSON.stringify(d));
		expect(json.annotations?.readOnly).toBe(true);
	});
});

describe("F-2.1: discriminated union exhaustiveness check (compile-time)", () => {
	// Compile-time test: switch over RpcRemoteToolResponse variants
	function checkResponse(res: RpcRemoteToolResponse): string {
		switch (res.isError) {
			case true:
				return `err: ${res.errorMessage ?? res.content[0]?.text ?? "?"}`;
			case false:
				return res.content.length.toString();
		}
	}

	it("switch exhaustiveness covers both isError variants", () => {
		expect(
			checkResponse({
				type: "remote_tool_response",
				id: "x",
				content: [{ type: "text", text: "y" }],
				isError: false,
			}),
		).toBe("1");

		expect(
			checkResponse({
				type: "remote_tool_response",
				id: "x",
				content: [{ type: "text", text: "err" }],
				isError: true,
				errorMessage: "fail",
			}),
		).toBe("err: fail");
	});
});
