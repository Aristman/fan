/**
 * F-2.6: RemoteProxyTool — local proxy tool that forwards MCP tool calls back
 * to the parent orchestrator via the `remote_tool_request` JSONL message.
 * Resolves when parent's `remote_tool_response` arrives on stdin.
 *
 * Implements ToolDefinition interface (compatible with `registerCustomTools`).
 */

import type { ToolDefinition } from "../../core/extensions/types.js";
import type {
	RpcRemoteToolCancel,
	RpcRemoteToolRequest,
	RpcRemoteToolResponse,
	RpcToolDescriptor,
} from "./rpc-types.js";

/** Function to emit a JSONL message to the parent over stdout. */
export type RpcOutputFn = (obj: object) => void;

/** Promise registrar for awaiting remote_tool_response. */
export interface RemoteToolPendingRegistry {
	register(id: string, resolve: (r: RpcRemoteToolResponse) => void, reject: (e: Error) => void, timeoutMs: number): void;
	resolve(id: string, response: RpcRemoteToolResponse): boolean;
}

export interface RemoteProxyToolDeps {
	output: RpcOutputFn;
	pendingRegistry: RemoteToolPendingRegistry;
	/** Optional default timeout for tool execution (ms). */
	timeoutMs?: number;
}

export function createRemoteProxyTool(
	descriptor: RpcToolDescriptor,
	deps: RemoteProxyToolDeps,
): ToolDefinition {
	const { output, pendingRegistry } = deps;
	const timeoutMs = deps.timeoutMs ?? 60_000;

	return {
		name: descriptor.id,
		label: descriptor.label ?? descriptor.id,
		description: descriptor.description,
		parameters: descriptor.inputSchema as any, // JSON Schema compatible for LLM
		execute: async (
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) => {
			const id = crypto.randomUUID();

			return new Promise((resolve, reject) => {
				let aborted = false;

				const onAbort = () => {
					aborted = true;
					const reason = signal?.reason;
					if (reason) {
						try {
							const cancelMsg: RpcRemoteToolCancel = { type: "remote_tool_cancel", id };
							output(cancelMsg);
						} catch {}
						reject(reason);
					} else {
						reject(new Error("Aborted"));
					}
				};

				if (signal && signal.aborted) {
					// Pre-aborted — reject immediately, no need to emit cancel since request was never sent
					reject(signal.reason ?? new Error("Aborted"));
					return;
				}

				pendingRegistry.register(
					id,
					(response) => {
						signal?.removeEventListener("abort", onAbort);
						resolve(response as any);
					},
					(err) => {
						signal?.removeEventListener("abort", onAbort);
						reject(err);
					},
					timeoutMs,
				);

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				const requestMsg: RpcRemoteToolRequest = {
					type: "remote_tool_request",
					id,
					toolId: descriptor.id,
					args: params,
				};
				output(requestMsg);
			});
		},
	};
}
