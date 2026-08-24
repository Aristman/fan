// R1: RECURRING.md infrastructure tests.
//
// Covers:
// - parseRecurringItems: interval parsing (30s/15m/2h/7d, default, invalid, multiple markers, case-insensitive)
// - text without interval marker
// - readRecurring: missing file → []
// - recurringItemHash: stability + normalization
// - readRecurringState / writeRecurringState: roundtrip + atomicity
// - isRecurringDue: due / not due / never run
// - markRecurringRun: immutability
// - initMission: creates RECURRING.md and .gitignore

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_RECUR_INTERVAL_MS,
	initMission,
	isRecurringDue,
	markRecurringRun,
	parseRecurringItems,
	readRecurring,
	readRecurringState,
	recurringItemHash,
	writeRecurringState,
} from "../file-state-manager.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-recur-infra-"));
}

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = freshBaseDir();
	missionDir = await initMission("recur-infra-test", { baseDir });
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── parseRecurringItems ────────────────────────────────────────────────────

describe("parseRecurringItems", () => {
	it("parses 30s interval", () => {
		const raw = "- [ ] Check health (interval: 30s)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Check health");
		expect(items[0].intervalMs).toBe(30_000);
	});

	it("parses 15m interval", () => {
		const raw = "- [ ] Check email (interval: 15m)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Check email");
		expect(items[0].intervalMs).toBe(15 * 60_000);
	});

	it("parses 2h interval", () => {
		const raw = "- [ ] Sync data (interval: 2h)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].intervalMs).toBe(2 * 3_600_000);
	});

	it("parses 7d interval", () => {
		const raw = "- [ ] Weekly report (interval: 7d)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].intervalMs).toBe(7 * 86_400_000);
	});

	it("missing interval → DEFAULT_RECUR_INTERVAL_MS", () => {
		const raw = "- [ ] Task without interval";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Task without interval");
		expect(items[0].intervalMs).toBe(DEFAULT_RECUR_INTERVAL_MS);
	});

	it("invalid interval → DEFAULT_RECUR_INTERVAL_MS", () => {
		const raw = "- [ ] Task (interval: abc)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Task");
		expect(items[0].intervalMs).toBe(DEFAULT_RECUR_INTERVAL_MS);
	});

	it("multiple markers → last one wins", () => {
		const raw = "- [ ] Task (interval: 1h) extra (interval: 30m)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Task (interval: 1h) extra");
		expect(items[0].intervalMs).toBe(30 * 60_000);
	});

	it("case-insensitive interval marker", () => {
		const raw = "- [ ] Task (INTERVAL: 2H)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Task");
		expect(items[0].intervalMs).toBe(2 * 3_600_000);
	});

	it("text field has no interval marker", () => {
		const raw = "- [ ] Do something important (interval: 5m)";
		const items = parseRecurringItems(raw);
		expect(items[0].text).toBe("Do something important");
	});

	it("skips checked items", () => {
		const raw = "- [x] Done task (interval: 5m)\n- [ ] Active task (interval: 10m)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Active task");
	});

	it("skips non-checkbox lines", () => {
		const raw = "# Heading\nSome text\n- [ ] Task (interval: 1h)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
	});

	it("supports * marker", () => {
		const raw = "* [ ] Star task (interval: 30s)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Star task");
		expect(items[0].intervalMs).toBe(30_000);
	});

	it("empty content → empty array", () => {
		expect(parseRecurringItems("")).toEqual([]);
	});

	it("rawText is the trimmed line", () => {
		const raw = "  - [ ] Spaced task (interval: 1m)  ";
		const items = parseRecurringItems(raw);
		expect(items[0].rawText).toBe("- [ ] Spaced task (interval: 1m)");
	});

	it("index is 0-based line number", () => {
		const raw = "# Header\n\n- [ ] Task (interval: 5m)";
		const items = parseRecurringItems(raw);
		expect(items[0].index).toBe(2);
	});

	it("zero interval → DEFAULT", () => {
		const raw = "- [ ] Task (interval: 0m)";
		const items = parseRecurringItems(raw);
		expect(items[0].intervalMs).toBe(DEFAULT_RECUR_INTERVAL_MS);
	});

	it("negative interval → DEFAULT", () => {
		// regex requires \d+ so negative won't match
		const raw = "- [ ] Task (interval: -5m)";
		const items = parseRecurringItems(raw);
		expect(items[0].intervalMs).toBe(DEFAULT_RECUR_INTERVAL_MS);
	});
});

// ─── readRecurring ──────────────────────────────────────────────────────────

describe("readRecurring", () => {
	it("missing file → empty array", () => {
		// Remove RECURRING.md if it exists
		const path = join(missionDir, "RECURRING.md");
		if (existsSync(path)) rmSync(path);
		expect(readRecurring(missionDir)).toEqual([]);
	});

	it("reads and parses existing file", () => {
		writeFileSync(join(missionDir, "RECURRING.md"), "- [ ] Task A (interval: 10m)\n- [ ] Task B (interval: 1h)\n", "utf8");
		const items = readRecurring(missionDir);
		expect(items).toHaveLength(2);
		expect(items[0].text).toBe("Task A");
		expect(items[0].intervalMs).toBe(10 * 60_000);
		expect(items[1].text).toBe("Task B");
		expect(items[1].intervalMs).toBe(3_600_000);
	});
});

// ─── recurringItemHash ──────────────────────────────────────────────────────

describe("recurringItemHash", () => {
	it("returns 12 hex chars", () => {
		const hash = recurringItemHash("some task");
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("stable: same input → same hash", () => {
		expect(recurringItemHash("Check email")).toBe(recurringItemHash("Check email"));
	});

	it("normalizes whitespace", () => {
		expect(recurringItemHash("Check   email")).toBe(recurringItemHash("Check email"));
	});

	it("case-insensitive", () => {
		expect(recurringItemHash("CHECK EMAIL")).toBe(recurringItemHash("check email"));
	});

	it("trims whitespace", () => {
		expect(recurringItemHash("  check email  ")).toBe(recurringItemHash("check email"));
	});

	it("different texts → different hashes", () => {
		expect(recurringItemHash("task A")).not.toBe(recurringItemHash("task B"));
	});
});

// ─── readRecurringState / writeRecurringState ───────────────────────────────

describe("readRecurringState / writeRecurringState", () => {
	it("missing file → empty object", () => {
		const statePath = join(missionDir, ".recurring-state.json");
		if (existsSync(statePath)) rmSync(statePath);
		expect(readRecurringState(missionDir)).toEqual({});
	});

	it("roundtrip: write then read", () => {
		const state = { abc123: 1000, def456: 2000 };
		writeRecurringState(missionDir, state);
		const read = readRecurringState(missionDir);
		expect(read).toEqual(state);
	});

	it("atomic write: file is valid JSON after write", () => {
		writeRecurringState(missionDir, { key: 42 });
		const raw = readFileSync(join(missionDir, ".recurring-state.json"), "utf8");
		expect(JSON.parse(raw)).toEqual({ key: 42 });
	});

	it("overwrite: second write replaces first", () => {
		writeRecurringState(missionDir, { a: 1 });
		writeRecurringState(missionDir, { b: 2 });
		expect(readRecurringState(missionDir)).toEqual({ b: 2 });
	});

	it("corrupt file → empty object", () => {
		writeFileSync(join(missionDir, ".recurring-state.json"), "not json", "utf8");
		expect(readRecurringState(missionDir)).toEqual({});
	});
});

// ─── isRecurringDue ─────────────────────────────────────────────────────────

describe("isRecurringDue", () => {
	const item = { index: 0, text: "Check email", intervalMs: 60_000, rawText: "- [ ] Check email (interval: 1m)" };

	it("never run → due", () => {
		expect(isRecurringDue(item, {}, 1000)).toBe(true);
	});

	it("just ran → not due", () => {
		const hash = recurringItemHash("Check email");
		const state = { [hash]: 1000 };
		expect(isRecurringDue(item, state, 1000)).toBe(false);
	});

	it("interval elapsed → due", () => {
		const hash = recurringItemHash("Check email");
		const state = { [hash]: 1000 };
		expect(isRecurringDue(item, state, 1000 + 60_000)).toBe(true);
	});

	it("interval not yet elapsed → not due", () => {
		const hash = recurringItemHash("Check email");
		const state = { [hash]: 1000 };
		expect(isRecurringDue(item, state, 1000 + 59_999)).toBe(false);
	});
});

// ─── markRecurringRun ───────────────────────────────────────────────────────

describe("markRecurringRun", () => {
	it("returns new state with updated hash", () => {
		const item = { index: 0, text: "Task", intervalMs: 1000, rawText: "- [ ] Task" };
		const state = { other: 100 };
		const newState = markRecurringRun(state, item, 5000);
		const hash = recurringItemHash("Task");
		expect(newState[hash]).toBe(5000);
		expect(newState.other).toBe(100);
	});

	it("immutable: original state unchanged", () => {
		const item = { index: 0, text: "Task", intervalMs: 1000, rawText: "- [ ] Task" };
		const state = { other: 100 };
		const before = { ...state };
		markRecurringRun(state, item, 5000);
		expect(state).toEqual(before);
	});
});

// ─── initMission: RECURRING.md + .gitignore ─────────────────────────────────

describe("initMission: RECURRING.md and .gitignore", () => {
	it("creates RECURRING.md", () => {
		expect(existsSync(join(missionDir, "RECURRING.md"))).toBe(true);
	});

	it("RECURRING.md contains header", () => {
		const content = readFileSync(join(missionDir, "RECURRING.md"), "utf8");
		expect(content).toContain("# Recurring tasks");
	});

	it("creates .gitignore", () => {
		expect(existsSync(join(missionDir, ".gitignore"))).toBe(true);
	});

	it(".gitignore contains .recurring-state.json", () => {
		const content = readFileSync(join(missionDir, ".gitignore"), "utf8");
		expect(content).toContain(".recurring-state.json");
	});

	it(".gitignore contains .mission-loop.json and .mission-loop.lock", () => {
		const content = readFileSync(join(missionDir, ".gitignore"), "utf8");
		expect(content).toContain(".mission-loop.json");
		expect(content).toContain(".mission-loop.lock");
	});
});

// ─── Header-формат (толерантный парсинг) ───────────────────────────────────

describe("parseRecurringItems: header format", () => {
	it("parses '## Text (interval: 15m)' — interval extracted, text without marker", () => {
		const raw = "## Прогон gmail-watch (interval: 15m)\n\nПроцедура: прочитай почту и ответь.\n";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Прогон gmail-watch");
		expect(items[0].intervalMs).toBe(15 * 60_000);
	});

	it("body under the heading is NOT part of the item", () => {
		const raw = "## Watch feed (interval: 30m)\nStep 1: do this\nStep 2: do that\n";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Watch feed");
		expect(items[0].rawText).toBe("## Watch feed (interval: 30m)");
	});

	it("mixed file: checklist + header → both parsed", () => {
		const raw = "- [ ] Check email (interval: 10m)\n\n## Weekly report (interval: 7d)\nDetails here\n";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(2);
		expect(items[0].text).toBe("Check email");
		expect(items[0].intervalMs).toBe(10 * 60_000);
		expect(items[1].text).toBe("Weekly report");
		expect(items[1].intervalMs).toBe(7 * 86_400_000);
	});

	it("heading without (interval:) marker → ignored (structure)", () => {
		const raw = "# Recurring tasks\n\n## Процедура дежурства\n\nТекст процедуры\n";
		expect(parseRecurringItems(raw)).toEqual([]);
	});

	it("supports # and ### levels with marker", () => {
		const raw = "# Top (interval: 1h)\n### Deep (interval: 30s)\n";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(2);
		expect(items[0].text).toBe("Top");
		expect(items[0].intervalMs).toBe(3_600_000);
		expect(items[1].text).toBe("Deep");
		expect(items[1].intervalMs).toBe(30_000);
	});

	it("header with invalid interval → DEFAULT_RECUR_INTERVAL_MS", () => {
		const raw = "## Task (interval: abc)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Task");
		expect(items[0].intervalMs).toBe(DEFAULT_RECUR_INTERVAL_MS);
	});

	it("header marker is case-insensitive", () => {
		const raw = "## Task (INTERVAL: 2H)";
		const items = parseRecurringItems(raw);
		expect(items).toHaveLength(1);
		expect(items[0].intervalMs).toBe(2 * 3_600_000);
	});
});

// ─── readRecurring: warn при молчаливой деградации ─────────────────────────

describe("readRecurring: silent-degradation warn", () => {
	it("non-empty file without parseable items → console.warn", () => {
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n\nПрогон gmail-watch каждые 15 минут\n",
			"utf8",
		);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readRecurring(missionDir)).toEqual([]);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][0]).toContain("no parseable recurring items");
		} finally {
			spy.mockRestore();
		}
	});

	it("file with parseable items → no warn", () => {
		writeFileSync(join(missionDir, "RECURRING.md"), "- [ ] Task (interval: 10m)\n", "utf8");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readRecurring(missionDir)).toHaveLength(1);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("fresh template (header + comments only) → no warn", () => {
		// initMission уже создал RECURRING.md из шаблона (beforeEach)
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readRecurring(missionDir)).toEqual([]);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
