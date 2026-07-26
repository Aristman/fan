import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskConfig } from "./config-loader.js";
import {
	defaultPendingQueuePath,
	getAgentDir,
	loadPendingTasks,
	loadPendingTasksDetailed,
	PENDING_QUEUE_FILENAME,
	PENDING_QUEUE_VERSION,
	savePendingTasks,
} from "./persistent-storage.js";

function makeTask(name: string): TaskConfig {
	return {
		name,
		schedule: "*/5 * * * *",
		workspace: `/workspaces/${name}`,
		message: `run ${name}`,
		budget_limit: null,
		timeout: 3600,
	};
}

let tmpRoot: string;
let filePath: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["FAN_CODING_AGENT_DIR", "FAN_SCHEDULER_PENDING_FILE"] as const;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "fan-scheduler-persist-"));
	filePath = join(tmpRoot, "state", PENDING_QUEUE_FILENAME);
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	// Silence structured logging; keep spies for warning assertions.
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** Returns all structured log entries written to stderr (warn/error). */
function stderrEntries(): Array<Record<string, unknown>> {
	const spy = vi.mocked(console.error);
	return spy.mock.calls
		.map((call) => call[0])
		.filter((arg): arg is string => typeof arg === "string")
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return { message: line };
			}
		});
}

describe("path resolution", () => {
	it("getAgentDir defaults to ~/.fan/agent", () => {
		expect(getAgentDir()).toBe(join(homedir(), ".fan", "agent"));
	});

	it("getAgentDir honors FAN_CODING_AGENT_DIR (incl. ~ expansion)", () => {
		process.env.FAN_CODING_AGENT_DIR = "/custom/agent";
		expect(getAgentDir()).toBe("/custom/agent");

		process.env.FAN_CODING_AGENT_DIR = "~";
		expect(getAgentDir()).toBe(homedir());

		process.env.FAN_CODING_AGENT_DIR = "~/fan-test";
		// Mirrors packages/agent/src/paths.ts: string concat, not path.join.
		expect(getAgentDir()).toBe(`${homedir()}/fan-test`);
	});

	it("defaultPendingQueuePath uses the agent dir by default", () => {
		expect(defaultPendingQueuePath()).toBe(join(getAgentDir(), PENDING_QUEUE_FILENAME));
	});

	it("defaultPendingQueuePath honors FAN_SCHEDULER_PENDING_FILE override", () => {
		process.env.FAN_SCHEDULER_PENDING_FILE = "/tmp/override-pending.json";
		expect(defaultPendingQueuePath()).toBe("/tmp/override-pending.json");
	});
});

describe("save/load roundtrip (TC-F-4.13-1 primitives)", () => {
	it("saves 2 tasks and restores them in order", () => {
		const tasks = [makeTask("alpha"), makeTask("beta")];
		savePendingTasks(filePath, tasks);

		const restored = loadPendingTasks(filePath);
		expect(restored).toHaveLength(2);
		expect(restored.map((t) => t.name)).toEqual(["alpha", "beta"]);
		expect(restored).toEqual(tasks);
	});

	it("writes the versioned file format { version: 1, tasks: [...] }", () => {
		savePendingTasks(filePath, [makeTask("alpha")]);

		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(parsed.version).toBe(PENDING_QUEUE_VERSION);
		expect(Array.isArray(parsed.tasks)).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
	});

	it("creates missing parent directories", () => {
		expect(existsSync(join(tmpRoot, "state"))).toBe(false);
		savePendingTasks(filePath, []);
		expect(existsSync(filePath)).toBe(true);
	});

	it("overwrites an existing file atomically (no .tmp left behind)", () => {
		savePendingTasks(filePath, [makeTask("old")]);
		savePendingTasks(filePath, [makeTask("new-1"), makeTask("new-2")]);

		expect(loadPendingTasks(filePath).map((t) => t.name)).toEqual(["new-1", "new-2"]);
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it("does not mutate the caller's array (stores a copy)", () => {
		const tasks = [makeTask("alpha")];
		savePendingTasks(filePath, tasks);
		tasks.push(makeTask("beta"));
		expect(loadPendingTasks(filePath)).toHaveLength(1);
	});
});

describe("empty queue (TC-F-4.13-2)", () => {
	it("saving an empty queue writes an empty tasks array (no stale tasks)", () => {
		// File exists with old data...
		savePendingTasks(filePath, [makeTask("stale-1"), makeTask("stale-2")]);
		expect(loadPendingTasks(filePath)).toHaveLength(2);

		// ...then the queue drains to empty and persists the empty state.
		savePendingTasks(filePath, []);

		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; tasks: unknown[] };
		expect(parsed.version).toBe(PENDING_QUEUE_VERSION);
		expect(parsed.tasks).toEqual([]);
		expect(loadPendingTasks(filePath)).toEqual([]);
	});
});

describe("load failure modes", () => {
	it("missing file → empty queue, silently (no warning)", () => {
		expect(loadPendingTasks(join(tmpRoot, "does-not-exist.json"))).toEqual([]);
		expect(stderrEntries()).toHaveLength(0);
	});

	it("corrupt JSON → empty queue + warning, no crash", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, "{ not valid json !!!", "utf8");

		expect(loadPendingTasks(filePath)).toEqual([]);
		const warnings = stderrEntries();
		expect(warnings.some((e) => e.event === "pending_file_corrupt" && e.level === "warn")).toBe(true);
	});

	it("unexpected root shape → empty queue + warning", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, JSON.stringify([makeTask("alpha")]), "utf8");

		expect(loadPendingTasks(filePath)).toEqual([]);
		expect(stderrEntries().some((e) => e.event === "pending_file_corrupt")).toBe(true);
	});

	it("version mismatch → file ignored + warning", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, JSON.stringify({ version: 99, tasks: [makeTask("alpha")] }), "utf8");

		expect(loadPendingTasks(filePath)).toEqual([]);
		expect(stderrEntries().some((e) => e.event === "pending_version_mismatch")).toBe(true);
	});

	it("missing tasks array → empty queue + warning", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, JSON.stringify({ version: PENDING_QUEUE_VERSION }), "utf8");

		expect(loadPendingTasks(filePath)).toEqual([]);
		expect(stderrEntries().some((e) => e.event === "pending_file_corrupt")).toBe(true);
	});

	it("malformed task entries are skipped with a warning, valid ones kept", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				version: PENDING_QUEUE_VERSION,
				tasks: [makeTask("good"), { name: 42 }, "junk", makeTask("also-good")],
			}),
			"utf8",
		);

		const restored = loadPendingTasks(filePath);
		expect(restored.map((t) => t.name)).toEqual(["good", "also-good"]);
		expect(stderrEntries().filter((e) => e.event === "pending_task_skipped")).toHaveLength(2);
	});

	// P2-2: numeric fields must be validated on load.
	it("skips entries with a non-number timeout", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				version: PENDING_QUEUE_VERSION,
				tasks: [
					makeTask("good"),
					{ name: "bad-timeout", schedule: "* * * * *", workspace: "/w", message: "m", timeout: "3600" },
				],
			}),
			"utf8",
		);

		const restored = loadPendingTasks(filePath);
		expect(restored.map((t) => t.name)).toEqual(["good"]);
		expect(stderrEntries().filter((e) => e.event === "pending_task_skipped")).toHaveLength(1);
	});

	it("skips entries with a non-number, non-null budget_limit", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				version: PENDING_QUEUE_VERSION,
				tasks: [
					makeTask("good"),
					{ name: "bad-budget", schedule: "* * * * *", workspace: "/w", message: "m", budget_limit: "500" },
				],
			}),
			"utf8",
		);

		const restored = loadPendingTasks(filePath);
		expect(restored.map((t) => t.name)).toEqual(["good"]);
		expect(stderrEntries().filter((e) => e.event === "pending_task_skipped")).toHaveLength(1);
	});

	it("keeps entries with budget_limit explicitly set to null", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		const task = makeTask("null-budget");
		(task as Record<string, unknown>).budget_limit = null;
		writeFileSync(filePath, JSON.stringify({ version: PENDING_QUEUE_VERSION, tasks: [task] }), "utf8");

		const restored = loadPendingTasks(filePath);
		expect(restored.map((t) => t.name)).toEqual(["null-budget"]);
		expect(restored[0].budget_limit).toBeNull();
	});
});

describe("loadPendingTasksDetailed (F-4.14 degraded flag)", () => {
	it("missing file → corrupt=false (first run is healthy)", () => {
		expect(loadPendingTasksDetailed(join(tmpRoot, "does-not-exist.json"))).toEqual({ tasks: [], corrupt: false });
	});

	it("valid file → tasks restored, corrupt=false", () => {
		savePendingTasks(filePath, [makeTask("alpha")]);
		expect(loadPendingTasksDetailed(filePath)).toEqual({ tasks: [makeTask("alpha")], corrupt: false });
	});

	it("corrupt JSON → corrupt=true (TC-F-4.14-2 source flag)", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, "{ not valid json !!!", "utf8");
		expect(loadPendingTasksDetailed(filePath)).toEqual({ tasks: [], corrupt: true });
	});

	it("version mismatch → corrupt=true", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(filePath, JSON.stringify({ version: 99, tasks: [] }), "utf8");
		expect(loadPendingTasksDetailed(filePath).corrupt).toBe(true);
	});

	it("skipped malformed entries → corrupt=true but valid tasks kept", () => {
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({ version: PENDING_QUEUE_VERSION, tasks: [makeTask("good"), { name: 42 }] }),
			"utf8",
		);
		const result = loadPendingTasksDetailed(filePath);
		expect(result.tasks.map((t) => t.name)).toEqual(["good"]);
		expect(result.corrupt).toBe(true);
	});
});

describe("save failure handling", () => {
	it("save failure is logged, not thrown", () => {
		// A directory occupying the target path makes renameSync fail.
		mkdirSync(join(tmpRoot, "state"), { recursive: true });
		mkdirSync(filePath);

		expect(() => savePendingTasks(filePath, [makeTask("alpha")])).not.toThrow();
		expect(stderrEntries().some((e) => e.event === "pending_save_failed" && e.level === "error")).toBe(true);
		// Best-effort tmp cleanup.
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
	});
});
