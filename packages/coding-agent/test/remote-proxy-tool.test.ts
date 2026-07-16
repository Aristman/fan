import { describe, expect, it, vi } from "vitest";
import { createRemoteProxyTool, type RemoteToolPendingRegistry } from "../src/modes/rpc/remote-proxy-tool.js";
import type { RpcRemoteToolRequest, RpcToolDescriptor } from "../src/modes/rpc/rpc-types.js";

function makeRegistry(): { registry: RemoteToolPendingRegistry; resolve: (id: string, r: any) => void } {
	const map = new Map<string, any>();
	const resolve = (id: string, r: any) => {
		const e = map.get(id);
		if (e) {
			map.delete(id);
			e.resolve(r);
			return true;
		}
		return false;
	};
	return {
		registry: {
			register(id, r, rj, timeoutMs) {
				const timer = setTimeout(() => {
					map.delete(id);
					rj(new Error("timeout"));
				}, timeoutMs) as any;
				map.set(id, { resolve: r, reject: rj, timer });
			},
			resolve,
		},
		resolve,
	};
}

const sampleDescriptor: RpcToolDescriptor = {
	id: "mcp__fs__read_file",
	label: "Read File",
	description: "Read a file from disk",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
	serverName: "filesystem",
};

// Helper to call execute with only the three required args (pad rest with undefined)
function callExecute(
	tool: ReturnType<typeof createRemoteProxyTool>,
	params: Record<string, unknown>,
	signal: AbortSignal,
): any {
	return tool.execute("call-id", params, signal, undefined, undefined as any);
}

describe("F-2.6: createRemoteProxyTool", () => {
	it("ToolDefinition has correct shape", () => {
		const { registry } = makeRegistry();
		const output = vi.fn();
		const tool = createRemoteProxyTool(sampleDescriptor, { output, pendingRegistry: registry });
		expect(tool.name).toBe("mcp__fs__read_file");
		expect(tool.label).toBe("Read File");
		expect(tool.description).toBe("Read a file from disk");
		expect(typeof tool.execute).toBe("function");
	});

	it("execute() sends remote_tool_request and awaits response", async () => {
		const { registry, resolve } = makeRegistry();
		const output = vi.fn();
		const tool = createRemoteProxyTool(sampleDescriptor, { output, pendingRegistry: registry, timeoutMs: 1000 });

		const promise = callExecute(tool, { path: "/tmp/x" }, new AbortController().signal);

		// Verify output was called with request
		expect(output).toHaveBeenCalledTimes(1);
		const sentMsg = output.mock.calls[0][0] as RpcRemoteToolRequest;
		expect(sentMsg.type).toBe("remote_tool_request");
		expect(sentMsg.toolId).toBe("mcp__fs__read_file");
		expect(sentMsg.args).toEqual({ path: "/tmp/x" });
		expect(sentMsg.id).toBeDefined();

		// Simulate parent response
		setTimeout(
			() =>
				resolve(sentMsg.id, {
					type: "remote_tool_response",
					id: sentMsg.id,
					content: [{ type: "text", text: "file contents" }],
					isError: false,
				}),
			50,
		);

		const result = await promise;
		expect((result as any).content[0].text).toBe("file contents");
	});

	it("execute() times out after timeoutMs", async () => {
		const { registry } = makeRegistry();
		const output = vi.fn();
		const tool = createRemoteProxyTool(sampleDescriptor, { output, pendingRegistry: registry, timeoutMs: 50 });

		await expect(callExecute(tool, {}, new AbortController().signal)).rejects.toThrow(/timeout/);
	});

	it("execute() rejects if AbortSignal already aborted", async () => {
		const { registry } = makeRegistry();
		const output = vi.fn();
		const tool = createRemoteProxyTool(sampleDescriptor, { output, pendingRegistry: registry });

		const controller = new AbortController();
		controller.abort(new Error("test abort"));

		await expect(callExecute(tool, {}, controller.signal)).rejects.toThrow(/test abort/);
		expect(output).not.toHaveBeenCalled();
	});
});
