/**
 * Tests for F-3.1: progress forwarding MCP → FAN onUpdate.
 *
 * Verifies:
 * - throttleProgress helper batches high-frequency calls
 * - onUpdate flows from executeMcpTool into callTool's onprogress option
 * - onprogress payload is formatted as { type: "text", text: "[progress] ..." }
 */

import { describe, expect, it, vi } from "vitest";
import { executeMcpTool, throttleProgress } from "../src/executor.js";

// ──────────────────────────────────────────────────
// throttleProgress helper
// ──────────────────────────────────────────────────

describe("throttleProgress", () => {
	it("emits first call immediately", () => {
		const fn = vi.fn();
		const t = throttleProgress(fn, 50);

		t("a");

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");
	});

	it("batches subsequent calls within throttle window", async () => {
		const fn = vi.fn();
		const t = throttleProgress(fn, 50);

		t("a");
		t("b");
		t("c");
		t("d");

		// Immediate call: "a"
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");

		// Wait for throttle window to expire
		await new Promise((r) => setTimeout(r, 60));

		// Now the latest coalesced value ("d") should have fired
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenLastCalledWith("d");
	});

	it("fires each call spaced beyond throttle window", async () => {
		const fn = vi.fn();
		const t = throttleProgress(fn, 30);

		t("first");
		await new Promise((r) => setTimeout(r, 40));
		t("second");
		await new Promise((r) => setTimeout(r, 40));
		t("third");

		expect(fn).toHaveBeenCalledTimes(3);
		expect(fn).toHaveBeenNthCalledWith(1, "first");
		expect(fn).toHaveBeenNthCalledWith(2, "second");
		expect(fn).toHaveBeenNthCalledWith(3, "third");
	});
});

// ──────────────────────────────────────────────────
// Progress forwarding through executeMcpTool
// ──────────────────────────────────────────────────

describe("executeMcpTool progress forwarding", () => {
	it("passes onprogress option to callTool when onUpdate is provided", async () => {
		const _onprogressCalls: Array<{ progress: number; total?: number; message?: string }> = [];

		const fakeClient = vi.fn().mockImplementation(
			(
				_args: { name: string; arguments: Record<string, unknown> },
				opts?: {
					signal?: AbortSignal;
					onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
				},
			) => {
				// Simulate MCP progress notifications
				if (opts?.onprogress) {
					opts.onprogress({ progress: 1, total: 3, message: "step one" });
					opts.onprogress({ progress: 2, total: 3, message: "step two" });
					opts.onprogress({ progress: 3, total: 3, message: "step three" });
				}
				return Promise.resolve({ content: [{ type: "text", text: "done" }] });
			},
		);

		const onUpdate = vi.fn();

		await executeMcpTool(
			(args, opts) => fakeClient(args, opts) as any,
			"test_tool",
			{ input: "hello" },
			undefined,
			onUpdate,
		);

		// callTool was invoked with onprogress
		expect(fakeClient).toHaveBeenCalled();
		const callArgs = fakeClient.mock.calls[0];
		expect(callArgs[1].onprogress).toBeDefined();
		expect(typeof callArgs[1].onprogress).toBe("function");
	});

	it("forwards throttled progress via onUpdate as { type, text }", async () => {
		const fakeClient = vi.fn().mockImplementation(
			(
				_args: { name: string; arguments: Record<string, unknown> },
				opts?: {
					signal?: AbortSignal;
					onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
				},
			) => {
				if (opts?.onprogress) {
					opts.onprogress({ progress: 1, total: 5, message: "analyzing" });
					opts.onprogress({ progress: 2, total: 5, message: "processing" });
				}
				return Promise.resolve({ content: [{ type: "text", text: "result" }] });
			},
		);

		const onUpdate = vi.fn();

		await executeMcpTool(
			(args, opts) => fakeClient(args, opts) as any,
			"test_tool",
			{ input: "hello" },
			undefined,
			onUpdate,
		);

		// Immediately at least one progress should have been fired
		expect(onUpdate).toHaveBeenCalled();

		const firstCall = onUpdate.mock.calls[0][0];
		expect(firstCall).toHaveProperty("type", "text");
		expect(firstCall.text).toContain("[progress");
		expect(firstCall.text).toContain("analyzing");
	});

	it("does not pass onprogress when onUpdate is undefined", async () => {
		const fakeClient = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "done" }],
		});

		await executeMcpTool((args, opts) => fakeClient(args, opts) as any, "test_tool", {}, undefined);

		const callArgs = fakeClient.mock.calls[0];
		expect(callArgs[1].onprogress).toBeUndefined();
	});
});
