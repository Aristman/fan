/**
 * MCP tool execution & result mapping (F-1.7).
 *
 * Converts MCP CallToolResult responses into FAN AgentToolResult objects,
 * supporting text/image content, isError passthrough via details, structuredContent,
 * and fallback for unsupported content types.
 *
 * Key exports:
 * - mapCallToolResult(result) — pure mapping from MCP result shape → AgentToolResult
 * - executeMcpTool(callTool, name, args, signal, onUpdate, timeoutMs) — execute + map + timeout + progress forwarding
 * - throttleProgress(fn, ms) — throttle helper for high-frequency progress events
 */

import type { AgentToolResult } from "@seaagents/fan-agent-core";

// ──────────────────────────────────────────────────
// Throttle helper for high-frequency progress events
// ──────────────────────────────────────────────────

/**
 * Throttle a callback to fire at most once every `ms` milliseconds.
 *
 * High-frequency events (e.g. MCP progress notifications) are batched:
 * - First call fires immediately.
 * - Subsequent calls within the throttle window are coalesced.
 * - After the window expires, the latest coalesced value is emitted.
 *
 * @param fn - Callback to throttle
 * @param ms - Throttle window in milliseconds (default 50)
 */
export function throttleProgress<T>(fn: (data: T) => void, ms: number = 50): (data: T) => void {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingData: T | undefined;

	return (data: T) => {
		const now = Date.now();
		const elapsed = now - lastCall;

		if (elapsed >= ms) {
			lastCall = now;
			fn(data);
		} else {
			pendingData = data;
			if (timer === undefined) {
				timer = setTimeout(() => {
					timer = undefined;
					lastCall = Date.now();
					if (pendingData !== undefined) {
						fn(pendingData);
						pendingData = undefined;
					}
				}, ms - elapsed);
			}
		}
	};
}

// Local content type definitions (matching @seaagents/fan-ai TextContent/ImageContent).
// Defined locally to avoid pulling @seaagents/fan-ai runtime into the extension.
export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	mimeType: string;
	data: string;
}

// ──────────────────────────────────────────────────
// Structural types (SDK-independent, avoids coupling)
// ──────────────────────────────────────────────────

/**
 * MCP SDK CallToolResult content block — minimal structural typing.
 *
 * We define this rather than importing @modelcontextprotocol/sdk directly
 * to keep this module decoupled and easily testable.
 */
interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/**
 * MCP CallToolResult shape, matching the SDK's CallToolResult interface.
 *
 * https://github.com/modelcontextprotocol/typescript-sdk
 */
export interface McpCallResult {
	content?: McpContentBlock[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

// ──────────────────────────────────────────────────
// Result mapping
// ──────────────────────────────────────────────────

/**
 * Map MCP CallToolResult to FAN AgentToolResult.
 *
 * Supported content types:
 * - "text" → TextContent
 * - "image" → ImageContent
 *
 * Other types (audio, resource, resource_link, embedded_resource) are
 * replaced with a text fallback: `[Unsupported content types: ...]`.
 * This ensures the agent never receives unrenderable content blocks.
 *
 * isError is placed in details.isError (AgentToolResult has no top-level isError).
 * structuredContent, if present, is surfaced as details.structuredContent.
 */
export function mapCallToolResult(
	result: McpCallResult,
): AgentToolResult<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
	const content: (TextContent | ImageContent)[] = [];
	const unsupported: string[] = [];

	for (const block of result.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			content.push({ type: "image", mimeType: block.mimeType, data: block.data });
		} else {
			unsupported.push(block.type);
		}
	}

	if (unsupported.length > 0) {
		content.push({
			type: "text",
			text: `[Unsupported content types: ${unsupported.join(", ")}]`,
		});
	}

	const details: { isError?: boolean; structuredContent?: Record<string, unknown> } = {};

	if (result.isError === true) {
		details.isError = true;
	}

	if (result.structuredContent != null) {
		details.structuredContent = result.structuredContent;
	}

	return { content, details };
}

// ──────────────────────────────────────────────────
// Tool execution with timeout & signal linking
// ──────────────────────────────────────────────────

/**
 * Execute an MCP tool call and map the result to AgentToolResult.
 *
 * Features:
 * - Timeout: aborts the call after `timeoutMs` (default 60s)
 * - Signal linking: combines the caller's abort signal with the timeout signal
 * - Error wrapping: MCP transport/execution errors → AgentToolResult with isError=true
 * - Progress forwarding: MCP progress notifications batched via throttle → onUpdate callback
 *
 * @param callTool - Function that calls an MCP tool (e.g. client.callTool)
 * @param name - MCP tool name
 * @param args - Tool arguments
 * @param signal - Optional external abort signal from the agent runtime
 * @param onUpdate - Optional callback for streaming partial execution updates (FAN AgentToolUpdateCallback)
 * @param timeoutMs - Timeout in milliseconds (default 60,000)
 */
export async function executeMcpTool(
	callTool: (
		args: { name: string; arguments: Record<string, unknown> },
		options?: {
			signal?: AbortSignal;
			onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
		},
	) => Promise<McpCallResult>,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate?: (data: { type: "text"; text: string }) => void,
	timeoutMs: number = 60_000,
): Promise<AgentToolResult<{ isError?: boolean; structuredContent?: Record<string, unknown> }>> {
	const timeoutController = new AbortController();
	const linkedSignal = signal ? linkSignals([signal, timeoutController.signal]) : timeoutController.signal;

	const timer = setTimeout(() => {
		timeoutController.abort(new Error("MCP tool call timed out"));
	}, timeoutMs);

	// Build throttled progress handler if onUpdate is provided
	const throttledUpdate = onUpdate
		? throttleProgress((data: { progress: number; total?: number; message?: string }) => {
				const text = data.message
					? `[progress ${data.progress}${data.total !== undefined ? `/${data.total}` : ""}] ${data.message}`
					: `[progress ${data.progress}${data.total !== undefined ? `/${data.total}` : ""}]`;
				onUpdate({ type: "text", text });
			}, 50)
		: undefined;

	try {
		const options: {
			signal?: AbortSignal;
			onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
		} = { signal: linkedSignal };
		if (throttledUpdate) {
			options.onprogress = throttledUpdate;
		}
		const result = await callTool({ name, arguments: args }, options);
		return mapCallToolResult(result);
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text", text: `MCP tool call failed: ${message}` }],
			details: { isError: true },
		};
	} finally {
		clearTimeout(timer);
	}
}

// ──────────────────────────────────────────────────
// Signal linking helper
// ──────────────────────────────────────────────────

/**
 * Combine multiple AbortSignals into one.
 *
 * Uses AbortSignal.any() if available (Node 20+, modern runtimes),
 * otherwise falls back to manual listener propagation.
 */
function linkSignals(signals: AbortSignal[]): AbortSignal {
	if (typeof (AbortSignal as any).any === "function") {
		return (AbortSignal as any).any(signals);
	}

	const controller = new AbortController();
	for (const s of signals) {
		if (s.aborted) {
			controller.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}
