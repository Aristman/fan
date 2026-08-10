/**
 * F-04 Loop Detector.
 *
 * Source of truth:
 *  - docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-04
 *  - docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2, §6.1
 *
 * The loop detector is a runtime guard that watches tool execution and aborts
 * the session when the *same* tool, *with the same arguments*, produces the
 * *same error* twice in a row.  It must:
 *
 *  - emit a `loop_detected` diagnostic event with `{ reason: "loop_detected",
 *    tool, error, count }` when the threshold is reached,
 *  - reset the counter on a successful call with the same tool+args,
 *  - treat different tool names, different argument sets, or different error
 *    messages as *distinct* signatures (no false positives),
 *  - be configurable via settings (`loopDetector.threshold`, default = 2),
 *  - be disable-able via settings (`loopDetector.enabled = false`).
 *
 * The detector is deterministic — it does *not* depend on time — so the F-04
 * tests do *not* use `vi.useFakeTimers()`.
 *
 * Coverage (mapped to TC-F04-* in roadmap.md):
 *  - TC-F04-1:  Loop detector finds a repeated error (same tool + args + error)
 *  - TC-F04-2:  A successful call after an error resets the detector
 *  - TC-F04-3:  Different arguments is *not* a loop
 *  - TC-F04-4:  Different tools with the same error is *not* a loop
 *  - TC-F04-5:  Same tool with different errors is *not* a loop
 *  - TC-F04-6:  Loop detector threshold is configurable (default 2)
 *  - TC-F04-7:  Three identical errors at threshold=2 fire on the 2nd
 *  - TC-F04-8:  Threshold=3 needs three identical errors before firing
 *  - TC-F04-9:  Disabled loop detector never fires
 *  - TC-F04-10: Default loop detector threshold is 2
 *  - TC-F04-11: Diagnostic event format (reason / tool / error / count)
 *  - TC-F04-12: Loop detector resets between prompts without extensions (proba B)
 */

import type { AgentTool, AgentToolResult } from "@seaagents/fan-agent-core";
import type { AssistantMessage } from "@seaagents/fan-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { createHarness, type Harness } from "./test-harness.js";

// ============================================================================
// Test helpers
// ============================================================================

/** Cast helper to detect a loop_detected diagnostic event. */
function isLoopDetected(event: AgentSessionEvent): boolean {
	return (event as { type?: string }).type === "loop_detected";
}

/**
 * Extract the textual error message from a `tool_execution_end` event.
 * The agent-loop wraps any thrown error message into `result.content[0].text`.
 */
function getErrorText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "tool_execution_end") return undefined;
	const r = event.result as AgentToolResult<any> | undefined;
	if (!r || !Array.isArray(r.content)) return undefined;
	const textBlock = r.content.find((c: { type?: string }) => c.type === "text") as
		| { type: "text"; text: string }
		| undefined;
	return textBlock?.text;
}

/**
 * Build a tool that throws a fixed error message on every call.
 * Used to drive the loop detector with a deterministic error signature.
 */
function makeErrorTool(name: string, errorMessage: string): AgentTool {
	return {
		name,
		label: name,
		description: `error tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error(errorMessage);
		},
	};
}

/**
 * Microtask-only polling helper — safe to call without fake timers.
 * Drains microtasks until the predicate matches or `maxIterations` elapses.
 * Returns the matched event, or undefined if not found.
 */
async function waitForEvent(
	events: AgentSessionEvent[],
	predicate: (e: AgentSessionEvent) => boolean,
	maxIterations = 2000,
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

/**
 * Build a `LoopDetectorDiagnostic`-shaped cast — the production code must
 * emit an event with this exact shape; the test only verifies the runtime
 * contract, not the TypeScript type.
 */
type LoopDetectorDiagnostic = {
	type: "loop_detected";
	reason: "loop_detected";
	tool: string;
	error: string;
	count: number;
};

// ============================================================================
// Tests
// ============================================================================

describe("F-04 Loop Detector", () => {
	let harnesses: Harness[] = [];

	beforeEach(() => {
		harnesses = [];
	});

	afterEach(() => {
		// Force-release any hanging tool promises *before* tearing down the
		// session.  Otherwise an unresolved promise leaks into the next test
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

	it("TC-F04-1: detects a repeated error — same tool + same args + same error twice", async () => {
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash");

		// Wait for loop_detected event — filter INSIDE the wait loop.
		await waitForEvent(harness.events, isLoopDetected);

		// Wait for agent_end — the abort propagation is async.
		for (let i = 0; i < 2000 && !harness.events.some((e) => e.type === "agent_end"); i++) {
			await Promise.resolve();
		}

		const loopEvents = harness.events.filter(isLoopDetected);
		expect(loopEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = loopEvents[0] as unknown as LoopDetectorDiagnostic;
		expect(diagnostic.reason).toBe("loop_detected");
		expect(diagnostic.tool).toBe("bash");
		expect(diagnostic.error).toBe("EACCES");
		expect(diagnostic.count).toBeGreaterThanOrEqual(2);

		// The session must have been aborted on loop detection.
		expect(harness.events.some((e) => e.type === "agent_end")).toBe(true);

		// Verify that the "final" text response was NOT consumed after loop
		// detection.  Without the loop detector the agent would naturally
		// finish all 3 responses (2 tool calls + "final").  With the
		// detector + abort signal check, the "final" response must never
		// appear in the event stream.
		const loopDetectedIdx = harness.events.findIndex(isLoopDetected);
		expect(loopDetectedIdx).toBeGreaterThanOrEqual(0);
		const eventsAfterLoop = harness.events.slice(loopDetectedIdx + 1);
		const hasFinalMessage = eventsAfterLoop.some((e) => {
			if (e.type !== "message_end") return false;
			const msg = (e as { message: AssistantMessage }).message;
			if (msg.role !== "assistant") return false;
			const textBlocks = (msg.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text");
			return textBlocks.some((c) => c.text === "final");
		});
		expect(hasFinalMessage).toBe(false);

		await promptPromise.catch(() => {});
	});

	it("TC-F04-2: a successful call with same tool+args after an error resets the detector", async () => {
		// The tool throws on the first call, succeeds on the second.
		let calls = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "alternating bash tool",
			parameters: Type.Object({}),
			execute: async () => {
				calls++;
				if (calls === 1) {
					throw new Error("EACCES");
				}
				return {
					content: [{ type: "text", text: "ok" }],
					details: {},
				};
			},
		};

		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [bashTool],
			baseToolsOverride: { bash: bashTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash");

		// Wait for both tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_end").length).toBeGreaterThanOrEqual(2);

		// The second call must have succeeded (isError: false).
		const errorEnds = harness.events.filter((e) => e.type === "tool_execution_end");
		expect((errorEnds[0] as { isError: boolean }).isError).toBe(true);
		expect((errorEnds[1] as { isError: boolean }).isError).toBe(false);

		// Drain microtasks so the detector has a chance to fire.
		for (let i = 0; i < 100; i++) await Promise.resolve();

		// Loop detector must NOT fire — the successful call (same tool+args)
		// reset the counter.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		// No `loop_detected` reason should appear.
		const abortEvents = harness.events.filter(
			(e) => e.type === "agent_end" && (e as { reason?: string }).reason !== undefined,
		);
		expect(abortEvents.some((e) => (e as unknown as LoopDetectorDiagnostic).reason === "loop_detected")).toBe(false);

		await promptPromise.catch(() => {});
	});

	it("TC-F04-3: different arguments is NOT a loop", async () => {
		// Same tool, same error, but different arguments → no loop.
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test --fix" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash twice");

		// Wait for both tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_end").length).toBeGreaterThanOrEqual(2);

		// Drain microtasks.
		for (let i = 0; i < 100; i++) await Promise.resolve();

		// Loop detector must NOT fire — different args = different paramsHash.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		await promptPromise.catch(() => {});
	});

	it("TC-F04-4: different tools with the same error is NOT a loop", async () => {
		// Different tool, same error → no loop.
		const errBash = makeErrorTool("bash", "EACCES");
		const errLint = makeErrorTool("lint", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "lint", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errBash, errLint],
			baseToolsOverride: { bash: errBash, lint: errLint },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run two tools");

		// Wait for both tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_end").length).toBeGreaterThanOrEqual(2);

		// Drain microtasks.
		for (let i = 0; i < 100; i++) await Promise.resolve();

		// Loop detector must NOT fire — different tools = different signatures.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		await promptPromise.catch(() => {});
	});

	it("TC-F04-5: same tool with different errors is NOT a loop", async () => {
		// Same tool, same args, but alternating error messages → no loop
		// (the counter resets whenever the signature changes).
		let callIdx = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "alternating-error bash tool",
			parameters: Type.Object({}),
			execute: async () => {
				callIdx++;
				if (callIdx === 1) {
					throw new Error("EACCES");
				}
				throw new Error("EPERM");
			},
		};

		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [bashTool],
			baseToolsOverride: { bash: bashTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash twice");

		// Wait for both tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_end").length).toBeGreaterThanOrEqual(2);

		// Both errors must be different.
		const errorTexts = harness.events.filter((e) => e.type === "tool_execution_end").map(getErrorText);
		expect(errorTexts[0]).toBe("EACCES");
		expect(errorTexts[1]).toBe("EPERM");

		// Drain microtasks.
		for (let i = 0; i < 100; i++) await Promise.resolve();

		// Loop detector must NOT fire — different errors = different signatures.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		await promptPromise.catch(() => {});
	});

	it("TC-F04-6: loop detector threshold is configurable (default 2)", () => {
		// Probes the public settings surface to verify the threshold can be
		// overridden via settings.  Mirrors the F-03 TC-F03-5/6 pattern.
		const probe = (h: { settingsManager: unknown }): number | undefined => {
			const sm = h.settingsManager as {
				getLoopDetectorThreshold?: () => number;
				settings?: { loopDetector?: { threshold?: number } };
			};
			return sm.getLoopDetectorThreshold?.() ?? sm.settings?.loopDetector?.threshold;
		};

		const harness = createHarness({
			responses: ["hello"],
			settings: {
				loopDetector: { threshold: 5, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		expect(probe(harness)).toBe(5);
	});

	it("TC-F04-7: three identical errors at threshold=2 fire on the 2nd error", async () => {
		// The detector must fire as soon as the threshold is reached — it does
		// not wait for a missing third call.  After the 2nd identical error
		// the event must already be present.
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash three times");

		// Wait for at least one `loop_detected` event.
		await waitForEvent(harness.events, isLoopDetected);

		const loopEvents = harness.events.filter(isLoopDetected);
		expect(loopEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = loopEvents[0] as unknown as LoopDetectorDiagnostic;
		expect(diagnostic.count).toBeGreaterThanOrEqual(2);
		expect(diagnostic.tool).toBe("bash");
		expect(diagnostic.error).toBe("EACCES");

		await promptPromise.catch(() => {});
	});

	it("TC-F04-8: threshold=3 needs three identical errors before firing", async () => {
		// With threshold=3, the first two identical errors must NOT trigger
		// the loop detector.  The third identical error must trigger it.
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 3, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash three times");

		// Wait for exactly 2 tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		// Snapshot at exactly 2 — do NOT let the 3rd event arrive yet.
		const twoEnds = harness.events.filter((e) => e.type === "tool_execution_end");
		expect(twoEnds.length).toBe(2);

		// Drain microtasks.
		for (let i = 0; i < 50; i++) await Promise.resolve();

		// After 2 errors at threshold=3 the detector must NOT have fired yet.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		// Wait for the 3rd tool_execution_end + the loop_detected event.
		await waitForEvent(harness.events, isLoopDetected);

		const loopEvents = harness.events.filter(isLoopDetected);
		expect(loopEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = loopEvents[0] as unknown as LoopDetectorDiagnostic;
		expect(diagnostic.count).toBeGreaterThanOrEqual(3);
		expect(diagnostic.tool).toBe("bash");
		expect(diagnostic.error).toBe("EACCES");

		await promptPromise.catch(() => {});
	});

	it("TC-F04-9: disabled loop detector never fires", async () => {
		const errTool = makeErrorTool("silent", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "silent", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "silent", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { silent: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: false },
			} as never,
		});
		harnesses.push(harness);

		const _promptPromise = schedulePrompt(harness, "run silent");

		// Wait for both tool_execution_end events — filter INSIDE the wait loop.
		for (let i = 0; i < 2000 && harness.events.filter((e) => e.type === "tool_execution_end").length < 2; i++) {
			await Promise.resolve();
		}
		expect(harness.events.filter((e) => e.type === "tool_execution_end").length).toBeGreaterThanOrEqual(2);

		// Drain microtasks.
		for (let i = 0; i < 100; i++) await Promise.resolve();

		// Disabled detector must NOT fire.
		expect(harness.events.filter(isLoopDetected)).toHaveLength(0);

		// The session must NOT have been aborted by the loop detector.
		expect(harness.events.some((e) => (e as unknown as LoopDetectorDiagnostic).reason === "loop_detected")).toBe(
			false,
		);
	});

	it("TC-F04-10: default loop detector threshold is 2", () => {
		// Without any override, the detector must default to a threshold of 2.
		const probe = (h: { settingsManager: unknown }): number | undefined => {
			const sm = h.settingsManager as {
				getLoopDetectorThreshold?: () => number;
				settings?: { loopDetector?: { threshold?: number } };
			};
			return sm.getLoopDetectorThreshold?.() ?? sm.settings?.loopDetector?.threshold;
		};

		const harness = createHarness({ responses: ["hello"] });
		harnesses.push(harness);

		// Default = 2 (per roadmap §F-04 "порог = 2").
		expect(probe(harness)).toBe(2);
	});

	it("TC-F04-12: loop detector resets between prompts in sessions without extensions (proba B)", async () => {
		// In sessions WITHOUT extensions, the loop detector must reset
		// between prompts so it can fire again on a second loop.
		// Previously the reset was gated behind `if (!this._extensionRunner) return;`
		// making the detector one-shot for the entire session.
		//
		// Note: The faux stream function's call counter does NOT reset between
		// prompts, so prompt 2 continues from wherever prompt 1 left off.
		// Prompt 1 consumes 2 responses (both tool calls) before abort, so
		// prompt 2 starts at index 2. We need tool calls at indices 2-3 too.
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] }, // 0: prompt 1
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] }, // 1: prompt 1, loop fires
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] }, // 2: prompt 2
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] }, // 3: prompt 2, loop fires
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		// Prompt 1: trigger loop_detected
		const prompt1Promise = schedulePrompt(harness, "run bash first time");
		await waitForEvent(harness.events, isLoopDetected);

		// Wait for agent_end after first loop
		for (let i = 0; i < 2000 && !harness.events.some((e) => e.type === "agent_end"); i++) {
			await Promise.resolve();
		}

		const loopEventsAfterPrompt1 = harness.events.filter(isLoopDetected);
		expect(loopEventsAfterPrompt1.length).toBeGreaterThanOrEqual(1);

		// Wait for session to be fully idle (isStreaming = false).
		// agent_end is emitted before finishRun() clears isStreaming,
		// so we need to wait for the agent run to fully settle.
		for (let i = 0; i < 2000 && harness.session.isStreaming; i++) {
			await Promise.resolve();
		}

		// Prompt 2: trigger loop_detected AGAIN (detector must have been reset)
		const prompt2Promise = schedulePrompt(harness, "run bash second time");

		// Wait for second loop_detected
		const initialLoopCount = loopEventsAfterPrompt1.length;
		for (let i = 0; i < 4000 && harness.events.filter(isLoopDetected).length <= initialLoopCount; i++) {
			await Promise.resolve();
		}

		const allLoopEvents = harness.events.filter(isLoopDetected);
		expect(allLoopEvents.length).toBeGreaterThan(initialLoopCount);

		// Verify both diagnostics have correct shape
		for (const le of allLoopEvents) {
			const diag = le as unknown as LoopDetectorDiagnostic;
			expect(diag.reason).toBe("loop_detected");
			expect(diag.tool).toBe("bash");
			expect(diag.error).toBe("EACCES");
		}

		await prompt1Promise.catch(() => {});
		await prompt2Promise.catch(() => {});
	});

	it("TC-F04-11: diagnostic event format includes reason, tool, error, count", async () => {
		// The diagnostic event must contain exactly the fields promised by
		// roadmap §F-04 ("Прерывание I1 с `{ reason: 'loop_detected', tool,
		// error, count: 2 }`").  This is the public contract that the
		// mission contour will rely on.
		const errTool = makeErrorTool("bash", "EACCES");
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				{ toolCalls: [{ name: "bash", args: { cmd: "npm test" } }] },
				"final",
			],
			tools: [errTool],
			baseToolsOverride: { bash: errTool },
			settings: {
				loopDetector: { threshold: 2, enabled: true },
			} as never,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash");

		await waitForEvent(harness.events, isLoopDetected);

		const loopEvents = harness.events.filter(isLoopDetected);
		expect(loopEvents.length).toBeGreaterThanOrEqual(1);

		const diagnostic = loopEvents[0] as unknown as LoopDetectorDiagnostic;
		// Required fields.
		expect(diagnostic.type).toBe("loop_detected");
		expect(diagnostic.reason).toBe("loop_detected");
		expect(typeof diagnostic.tool).toBe("string");
		expect(diagnostic.tool.length).toBeGreaterThan(0);
		expect(typeof diagnostic.error).toBe("string");
		expect(diagnostic.error.length).toBeGreaterThan(0);
		expect(typeof diagnostic.count).toBe("number");
		expect(diagnostic.count).toBeGreaterThanOrEqual(2);

		// Tool and error must match the actual call.
		expect(diagnostic.tool).toBe("bash");
		expect(diagnostic.error).toBe("EACCES");

		await promptPromise.catch(() => {});
	});
});
