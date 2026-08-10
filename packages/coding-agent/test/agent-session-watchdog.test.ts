/**
 * F-03 Watchdog.
 *
 * Source of truth:
 *  - docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-03
 *  - docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2, §6.1
 *
 * The watchdog is a per-toolCall runtime guard: on `tool_execution_start` a
 * timer for `watchdogTimeoutMs` (default 720000 ms = 12 min) is armed; every
 * `tool_execution_update` resets it; `tool_execution_end` cancels it; if it
 * ever fires the session must emit a `watchdog_timeout` interrupt diagnostic
 * and abort the in-flight generation.
 *
 * Each tool call gets its own independent timer (keyed by toolCallId) so
 * parallel tool executions do not interfere with each other.
 *
 * Coverage (mapped to TC-F03-* in roadmap.md):
 *  - TC-F03-1: Watchdog interrupts a hung tool call after watchdogTimeoutMs
 *  - TC-F03-2: tool_execution_update resets the timer (long-but-alive tools survive)
 *  - TC-F03-3: tool_execution_end cancels the timer (no leaked timers)
 *  - TC-F03-4: boundary — update right before the timeout cancels the trigger
 *  - TC-F03-5: default watchdogTimeoutMs is 720000 ms
 *  - TC-F03-6: watchdogTimeoutMs is configurable through settings
 *  - TC-F03-7: watchdog can be disabled
 *  - TC-F03-8: parallel tool calls — one completes, other's watchdog still fires
 *  - TC-F03-9: update from tool A does not extend tool B's timer
 */

import type { AgentTool } from "@seaagents/fan-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { createHarness, type Harness } from "./test-harness.js";

// ============================================================================
// Test helpers
// ============================================================================

/** Cast helper to detect the watchdog diagnostic event. */
function isWatchdogTimeout(event: AgentSessionEvent): boolean {
	return (event as { type?: string }).type === "watchdog_timeout";
}

/**
 * Build a tool whose behaviour is fully driven by the test.
 *
 *   - `mode: "hang"`           → never resolves on its own, listens to abort signal
 *   - `mode: "alive"`          → resolves immediately
 *   - `mode: "aliveWithTicks"` → emits N partial updates spaced `tickMs` apart,
 *                                then resolves
 */
function makeTool(
	name: string,
	mode: "hang" | "alive" | "aliveWithTicks",
	options: { tickCount?: number; tickMs?: number } = {},
): AgentTool {
	const { tickCount = 3, tickMs = 100 } = options;
	return {
		name,
		label: name,
		description: `tool for watchdog tests (${mode})`,
		parameters: Type.Object({}),
		execute: async (_id, _args, signal, onUpdate) => {
			if (mode === "hang") {
				return await new Promise<never>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted before start"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("aborted by watchdog")));
				});
			}
			if (mode === "alive") {
				return { content: [{ type: "text", text: "done" }], details: {} };
			}
			// aliveWithTicks: emit partialResult updates before completing.
			for (let i = 0; i < tickCount; i++) {
				await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
				onUpdate?.({
					content: [{ type: "text", text: `tick-${i}` }],
					details: { tick: i },
				});
			}
			return { content: [{ type: "text", text: "alive-complete" }], details: {} };
		},
	};
}

/**
 * Microtask-only polling helper — safe to call under `vi.useFakeTimers()`.
 * Drains microtasks until the predicate matches or `maxIterations` elapses.
 * Returns the matched event, or undefined if not found.
 */
async function waitForEvent(
	events: AgentSessionEvent[],
	predicate: (e: AgentSessionEvent) => boolean,
	maxIterations = 1000,
): Promise<AgentSessionEvent | undefined> {
	for (let i = 0; i < maxIterations; i++) {
		const found = events.find(predicate);
		if (found) return found;
		await Promise.resolve();
	}
	return events.find(predicate);
}

/** Schedule a prompt on the next microtask so the caller can race listeners. */
function schedulePrompt(harness: Harness, text: string): Promise<unknown> {
	return new Promise((resolve) => {
		queueMicrotask(() => {
			harness.session.prompt(text).then(
				() => resolve(undefined),
				() => resolve(undefined),
			);
		});
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("F-03 Watchdog", () => {
	let harnesses: Harness[] = [];

	beforeEach(() => {
		harnesses = [];
	});

	afterEach(() => {
		// Force-release any hanging tool promises *before* tearing down the
		// session. Otherwise the unresolved promise leaks into the next test
		// in the same worker.
		for (const h of harnesses) {
			try {
				h.session.agent.abort();
			} catch {
				/* agent may already be disposed */
			}
		}
		vi.useRealTimers();
		for (const h of harnesses) {
			h.cleanup();
		}
		harnesses = [];
	});

	// ------------------------------------------------------------------------

	it("TC-F03-1: watchdog interrupts a hung tool call after watchdogTimeoutMs", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		const hangTool = makeTool("bash", "hang");
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "bash", args: {} }] }, "final"],
			tools: [hangTool],
			baseToolsOverride: { bash: hangTool },
			// Red-phase cast: settings type does not yet expose `watchdog`.
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash");

		// Wait for tool_execution_start to confirm the watchdog timer is armed.
		await waitForEvent(harness.events, (e) => e.type === "tool_execution_start");

		// Advance just before the timeout → watchdog must NOT fire yet.
		await vi.advanceTimersByTimeAsync(900);
		await Promise.resolve();
		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);

		// Advance past the timeout → watchdog must fire.
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();

		const watchdogEvents = harness.events.filter(isWatchdogTimeout);
		expect(watchdogEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = watchdogEvents[0] as unknown as {
			tool: string;
			reason: string;
			elapsedMs: number;
			toolCallId: string;
		};
		expect(diagnostic.tool).toBe("bash");
		expect(diagnostic.reason).toBe("watchdog_timeout");
		expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(1000);
		expect(typeof diagnostic.toolCallId).toBe("string");

		// The agent must have been interrupted (agent_end present).
		expect(harness.events.some((e) => e.type === "agent_end")).toBe(true);

		// The watchdog abort must release the hang tool so the prompt
		// promise settles — if it doesn't, afterEach will force-abort.
		await promptPromise;
	});

	it("TC-F03-2: tool_execution_update resets the timer — long-but-alive tool survives", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		// watchdogTimeoutMs = 1000 ms; tool emits updates every 600 ms for 3 ticks
		// → total elapsed ≥ 1800 ms, but each update resets the timer.
		const tickingTool = makeTool("long", "aliveWithTicks", { tickCount: 3, tickMs: 600 });
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "long", args: {} }] }, "final"],
			tools: [tickingTool],
			baseToolsOverride: { long: tickingTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run long");

		await waitForEvent(harness.events, (e) => e.type === "tool_execution_start");

		// Three update cycles — each individual 600 ms tick is below the
		// 1000 ms threshold, and each update resets the timer.
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(600);
			await waitForEvent(harness.events, (e) => e.type === "tool_execution_update");
		}

		// No watchdog event should have fired — every update reset the timer.
		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);

		// Let the tool finish.
		await vi.advanceTimersByTimeAsync(2000);
		await promptPromise;

		expect(harness.events.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
	});

	it("TC-F03-3: tool_execution_end cancels the timer — no leaked watchdog", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		const fastTool = makeTool("fast", "alive");
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "fast", args: {} }] }, "final"],
			tools: [fastTool],
			baseToolsOverride: { fast: fastTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run fast");

		await waitForEvent(harness.events, (e) => e.type === "tool_execution_end");

		// Advance far past the would-be watchdog window.
		await vi.advanceTimersByTimeAsync(60_000);
		await Promise.resolve();

		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);

		await promptPromise;
	});

	it("TC-F03-4: boundary — tool_execution_update at the last moment cancels the trigger", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		// Two ticks at 900 ms with a 1000 ms timeout → each individual update
		// (900 ms < 1000 ms) cancels the timer, so the watchdog must NOT fire.
		const tickingTool = makeTool("edge", "aliveWithTicks", { tickCount: 2, tickMs: 900 });
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "edge", args: {} }] }, "final"],
			tools: [tickingTool],
			baseToolsOverride: { edge: tickingTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run edge");

		await waitForEvent(harness.events, (e) => e.type === "tool_execution_start");

		// First tick at t=900 ms (just under the 1000 ms threshold).
		await vi.advanceTimersByTimeAsync(900);
		await waitForEvent(harness.events, (e) => e.type === "tool_execution_update");

		// Roll just past the original timeout (would have been t=1000 ms) —
		// the timer was reset by the update at t=900 ms → no trigger.
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);

		// Second tick at t=1800 ms resets again.
		await vi.advanceTimersByTimeAsync(700);
		await waitForEvent(harness.events, (e) => e.type === "tool_execution_update");

		// Wrap up — advance, let tool complete, no watchdog expected.
		await vi.advanceTimersByTimeAsync(2000);
		await promptPromise;

		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);
	});

	it("TC-F03-5: default watchdogTimeoutMs is 720000 ms (12 minutes)", () => {
		// Without any override, the watchdog must default to 720000 ms.
		// The implementation must expose the default either as a method
		// (`getWatchdogTimeoutMs()`) or via the merged settings surface.
		const probe = (h: { settingsManager: unknown }): number | undefined => {
			const sm = h.settingsManager as {
				getWatchdogTimeoutMs?: () => number;
				settings?: { watchdog?: { timeoutMs?: number } };
			};
			return sm.getWatchdogTimeoutMs?.() ?? sm.settings?.watchdog?.timeoutMs;
		};

		const probeHarness = createHarness({ responses: ["hello"] });
		harnesses.push(probeHarness);

		expect(probe(probeHarness)).toBe(720000);
	});

	it("TC-F03-6: watchdogTimeoutMs is configurable through settings", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		const hangTool = makeTool("custom", "hang");
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "custom", args: {} }] }, "final"],
			tools: [hangTool],
			baseToolsOverride: { custom: hangTool },
			// Override watchdogTimeoutMs → 500 ms instead of the 720000 ms default.
			settings: {
				watchdog: { timeoutMs: 500, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run custom");

		await waitForEvent(harness.events, (e) => e.type === "tool_execution_start");

		await vi.advanceTimersByTimeAsync(600);
		await Promise.resolve();

		const watchdogEvents = harness.events.filter(isWatchdogTimeout);
		expect(watchdogEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = watchdogEvents[0] as unknown as {
			tool: string;
			elapsedMs: number;
		};
		expect(diagnostic.tool).toBe("custom");
		expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(500);

		await promptPromise;
	});

	it("TC-F03-7: disabled watchdog never fires (off-switch)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		const hangTool = makeTool("silent", "hang");
		const harness = createHarness({
			responses: [{ toolCalls: [{ name: "silent", args: {} }] }, "final"],
			tools: [hangTool],
			baseToolsOverride: { silent: hangTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: false },
			} as never,
		});
		harnesses.push(harness);

		const _promptPromise = schedulePrompt(harness, "run silent");

		await waitForEvent(harness.events, (e) => e.type === "tool_execution_start");

		// Advance well past the would-be timeout — disabled watchdog must not fire.
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.resolve();

		expect(harness.events.filter(isWatchdogTimeout)).toHaveLength(0);
		// We do NOT await the prompt here — the tool hangs forever because
		// the watchdog is disabled. afterEach will force-abort the agent.
	});

	it("TC-F03-8: parallel tool calls — one completes, other's watchdog still fires", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		// "fast" resolves immediately; "hung" never resolves.
		// Both are started in parallel by the agent (toolExecution: "parallel").
		const fastTool = makeTool("fast", "alive");
		const hungTool = makeTool("hung", "hang");
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ name: "fast", args: {} },
						{ name: "hung", args: {} },
					],
				},
				"final",
			],
			tools: [fastTool, hungTool],
			baseToolsOverride: { fast: fastTool, hung: hungTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run both");

		// Wait until both tool_execution_start events have been emitted.
		for (let i = 0; i < 2000; i++) {
			if (harness.events.filter((e) => e.type === "tool_execution_start").length >= 2) break;
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_start")).toHaveLength(2);

		// Advance past the watchdog timeout. The hung tool's watchdog must fire
		// even though the fast tool already completed and sent tool_execution_end.
		await vi.advanceTimersByTimeAsync(1200);
		await Promise.resolve();

		const watchdogEvents = harness.events.filter(isWatchdogTimeout);
		expect(watchdogEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = watchdogEvents[0] as unknown as {
			tool: string;
			toolCallId: string;
			elapsedMs: number;
		};
		expect(diagnostic.tool).toBe("hung");
		expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(1000);
		expect(typeof diagnostic.toolCallId).toBe("string");

		await promptPromise;
	});

	it("TC-F03-9: update from tool A does not extend tool B's timer", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });

		// "ticking" emits updates every 400 ms (below 1000 ms threshold) and
		// respects the abort signal.  "hung" never resolves and never sends
		// updates.  Both start in parallel.  Ticking's updates must NOT keep
		// hung's watchdog alive — hung's watchdog must fire at ~1000 ms.
		const tickingTool: AgentTool = {
			name: "ticking",
			label: "ticking",
			description: "ticking tool for watchdog test",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal, onUpdate) => {
				for (let i = 0; i < 5; i++) {
					await new Promise<void>((resolve, reject) => {
						const t = setTimeout(resolve, 400);
						signal?.addEventListener("abort", () => {
							clearTimeout(t);
							reject(new Error("aborted"));
						});
					});
					onUpdate?.({
						content: [{ type: "text", text: `tick-${i}` }],
						details: { tick: i },
					});
				}
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const hungTool = makeTool("hung", "hang");
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ name: "ticking", args: {} },
						{ name: "hung", args: {} },
					],
				},
				"final",
			],
			tools: [tickingTool, hungTool],
			baseToolsOverride: { ticking: tickingTool, hung: hungTool },
			settings: {
				watchdog: { timeoutMs: 1000, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		schedulePrompt(harness, "run both");

		// Wait until both tool_execution_start events have been emitted.
		for (let i = 0; i < 2000; i++) {
			if (harness.events.filter((e) => e.type === "tool_execution_start").length >= 2) break;
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_start")).toHaveLength(2);

		// Advance in steps.  The ticking tool will emit updates, but those
		// must not affect the hung tool's independent timer.
		await vi.advanceTimersByTimeAsync(1200);
		await Promise.resolve();

		const hungWatchdogEvents = harness.events.filter(
			(e) => isWatchdogTimeout(e) && (e as unknown as { tool: string }).tool === "hung",
		);
		expect(hungWatchdogEvents.length).toBeGreaterThanOrEqual(1);

		// Let the abort propagate so afterEach cleanup is clean.
		await vi.advanceTimersByTimeAsync(100);
		await Promise.resolve();
	});

	it("TC-F03-10: invalid timeoutMs (NaN) falls back to default 720000 ms", () => {
		const harness = createHarness({
			responses: ["hello"],
			settings: {
				watchdog: { timeoutMs: NaN, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		expect(harness.settingsManager.getWatchdogTimeoutMs()).toBe(720000);
	});

	it("TC-F03-11: invalid timeoutMs (Infinity) falls back to default 720000 ms", () => {
		const harness = createHarness({
			responses: ["hello"],
			settings: {
				watchdog: { timeoutMs: Infinity, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		expect(harness.settingsManager.getWatchdogTimeoutMs()).toBe(720000);
	});

	it("TC-F03-12: invalid timeoutMs (negative) falls back to default 720000 ms", () => {
		const harness = createHarness({
			responses: ["hello"],
			settings: {
				watchdog: { timeoutMs: -100, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		expect(harness.settingsManager.getWatchdogTimeoutMs()).toBe(720000);
	});
});
