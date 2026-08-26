// Тесты для per-mission runagent_timeout_min (resolveRunAgentTimeoutMs + wiring).
//
// Запуск: npx vitest run bundles/fan-mission/extensions/fan-mission/runagent-timeout.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRunAgentTimeoutMs, DEFAULT_TIMEOUT_MS } from "./default-run-agent.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

const dirs: string[] = [];

function makeMissionDir(frontmatterExtra = ""): string {
	const dir = join(tmpdir(), `fan-mission-timeout-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	writeFileSync(
		join(dir, "MISSION.md"),
		`---
mission_id: test-timeout
created: 2026-08-26T00:00:00.000Z
status: active
metric_type: test_pass_rate
metric_command: npm test
${frontmatterExtra}
---

# Test Mission
`,
		"utf8",
	);
	return dir;
}

afterEach(() => {
	for (const d of dirs) {
		try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
	dirs.length = 0;
});

// ─── resolveRunAgentTimeoutMs unit tests ────────────────────────────────────

describe("resolveRunAgentTimeoutMs", () => {
	it("valid 90 min → 90 * 60_000 ms", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: 90 })).toBe(90 * 60_000);
	});

	it("valid 1 min → 60_000 ms", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: 1 })).toBe(60_000);
	});

	it("valid 480 min → 480 * 60_000 ms", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: 480 })).toBe(480 * 60_000);
	});

	it("invalid 0 → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: 0 })).toBe(DEFAULT_TIMEOUT_MS);
	});

	it("invalid 1000 (> 480) → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: 1000 })).toBe(DEFAULT_TIMEOUT_MS);
	});

	it("non-number 'abc' → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: "abc" as unknown as number })).toBe(DEFAULT_TIMEOUT_MS);
	});

	it("missing field → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
	});

	it("negative value → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: -5 })).toBe(DEFAULT_TIMEOUT_MS);
	});

	it("Infinity → default 0 (infinite)", () => {
		expect(resolveRunAgentTimeoutMs({ runagent_timeout_min: Infinity })).toBe(DEFAULT_TIMEOUT_MS);
	});
});

// ─── Regex MISSION.md parsing (mirrors index.ts attachMission logic) ───────

describe("MISSION.md runagent_timeout_min regex", () => {
	it("parses runagent_timeout_min: 90 from frontmatter", () => {
		const dir = makeMissionDir("runagent_timeout_min: 90\n");
		const raw = readFileSync(join(dir, "MISSION.md"), "utf8");
		const m = raw.match(/^runagent_timeout_min\s*:\s*(\d+)\s*$/m);
		expect(m).not.toBeNull();
		expect(Number(m![1])).toBe(90);
	});

	it("does not match commented line", () => {
		const dir = makeMissionDir("# runagent_timeout_min: 90\n");
		const raw = readFileSync(join(dir, "MISSION.md"), "utf8");
		const m = raw.match(/^runagent_timeout_min\s*:\s*(\d+)\s*$/m);
		expect(m).toBeNull();
	});

	it("does not match when field absent", () => {
		const dir = makeMissionDir("");
		const raw = readFileSync(join(dir, "MISSION.md"), "utf8");
		const m = raw.match(/^runagent_timeout_min\s*:\s*(\d+)\s*$/m);
		expect(m).toBeNull();
	});

	it("tolerates whitespace around colon and value", () => {
		const dir = makeMissionDir("runagent_timeout_min:  45  \n");
		const raw = readFileSync(join(dir, "MISSION.md"), "utf8");
		const m = raw.match(/^runagent_timeout_min\s*:\s*(\d+)\s*$/m);
		expect(m).not.toBeNull();
		expect(Number(m![1])).toBe(45);
	});
});

// ─── createDefaultRunAgent: timeoutMs=0 → no setTimeout ────────────────────

describe("createDefaultRunAgent with timeoutMs=0", () => {
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});
	afterEach(() => {
		setTimeoutSpy.mockRestore();
	});

	it("DEFAULT_TIMEOUT_MS is 0 (infinite, no timer)", () => {
		expect(DEFAULT_TIMEOUT_MS).toBe(0);
	});

	it("timeoutMs=0 does NOT call setTimeout when runAgent is invoked", async () => {
		// Minimal mock ExtensionAPI that captures the followUp prompt.
		let sentPrompt: string | null = null;
		const fan = {
			on: () => {},
			sendUserMessage: (prompt: string) => { sentPrompt = prompt; },
		} as any;

		const { createDefaultRunAgent } = await import("./default-run-agent.js");
		const handle = createDefaultRunAgent(fan, { timeoutMs: 0 });

		// Fire runAgent — it sends the prompt and waits for agent_end.
		// We don't resolve agent_end, but we can check setTimeout was NOT called.
		const resultPromise = handle.runAgent("test prompt");

		// setTimeout should NOT have been called for the timeout.
		// (sendUserMessage doesn't use setTimeout in our mock)
		expect(setTimeoutSpy).not.toHaveBeenCalled();

		// Clean up — settle the pending waiter so the test doesn't hang.
		handle.settle("test cleanup");
		await resultPromise; // resolve the promise
	});

	it("timeoutMs>0 DOES call setTimeout (guard doesn't break explicit timeouts)", async () => {
		const fan = {
			on: () => {},
			sendUserMessage: () => {},
		} as any;

		const { createDefaultRunAgent } = await import("./default-run-agent.js");
		const handle = createDefaultRunAgent(fan, { timeoutMs: 60_000 });

		const resultPromise = handle.runAgent("test");
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

		handle.settle("test cleanup");
		await resultPromise;
	});
});
