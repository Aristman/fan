import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidCron, loadTasks } from "./config-loader.js";

let dir: string;

function writeConfig(content: string): string {
	const path = join(dir, "config.yaml");
	writeFileSync(path, content, "utf8");
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fan-scheduler-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("TC-F-4.1-1: example config.yaml loads", () => {
	it("parses the package example config with one task", () => {
		const examplePath = fileURLToPath(new URL("../config.yaml", import.meta.url));
		const tasks = loadTasks(examplePath);
		expect(tasks).toHaveLength(1);
		const [task] = tasks;
		expect(task.name).toBe("daily-code-review");
		expect(task.schedule).toBe("0 9 * * *");
		expect(task.workspace).toBe("/data/repos/my-project");
		expect(typeof task.message).toBe("string");
		expect(task.message.length).toBeGreaterThan(0);
	});
});

describe("TC-F-4.1-2: valid YAML → TaskConfig[] with defaults", () => {
	it("applies config values and defaults for missing optional fields", () => {
		const path = writeConfig(`tasks:
  - name: full-task
    schedule: "*/15 * * * *"
    workspace: /data/repos/a
    message: "Do everything"
    budget_limit: 500
    timeout: 120
  - name: minimal-task
    schedule: "0 0 * * 0"
    workspace: /data/repos/b
    message: "Do the minimum"
`);
		const tasks = loadTasks(path);
		expect(tasks).toHaveLength(2);

		expect(tasks[0]).toEqual({
			name: "full-task",
			schedule: "*/15 * * * *",
			workspace: "/data/repos/a",
			message: "Do everything",
			budget_limit: 500,
			timeout: 120,
		});

		expect(tasks[1].name).toBe("minimal-task");
		expect(tasks[1].budget_limit).toBeNull();
		expect(tasks[1].timeout).toBe(3600);
	});
});

describe("TC-F-4.1-3: invalid YAML throws descriptive error", () => {
	it("includes line number in the error message", () => {
		const path = writeConfig("tasks:\n  - name: broken\n    schedule: [unclosed\n");
		expect(() => loadTasks(path)).toThrowError(/Invalid YAML.*line \d+/i);
	});

	it("reports unreadable file", () => {
		expect(() => loadTasks(join(dir, "does-not-exist.yaml"))).toThrowError(/Failed to read config file/);
	});

	it("rejects config without tasks array", () => {
		const path = writeConfig("not_tasks: 42\n");
		expect(() => loadTasks(path)).toThrowError(/"tasks" must be an array/);
	});
});

describe("validation: required fields and cron", () => {
	it("rejects invalid cron with the task name in the message", () => {
		const path = writeConfig(`tasks:
  - name: bad-cron-task
    schedule: "not a cron"
    workspace: /w
    message: "m"
`);
		expect(() => loadTasks(path)).toThrowError(/task "bad-cron-task" has invalid cron schedule/);
	});

	it("rejects out-of-range cron values", () => {
		const path = writeConfig(`tasks:
  - name: out-of-range
    schedule: "99 * * * *"
    workspace: /w
    message: "m"
`);
		expect(() => loadTasks(path)).toThrowError(/task "out-of-range" has invalid cron schedule/);
	});

	it.each(["name", "schedule", "workspace", "message"])("rejects task missing required field %s", (field) => {
		const task: Record<string, string> = {
			name: "t",
			schedule: "* * * * *",
			workspace: "/w",
			message: "m",
		};
		delete task[field];
		const entry = Object.entries(task)
			.map(([k, v]) => `    ${k}: "${v}"`)
			.join("\n");
		const path = writeConfig(`tasks:\n  -\n${entry}\n`);
		expect(() => loadTasks(path)).toThrowError(new RegExp(`missing required field "${field}"`));
	});

	it("rejects invalid budget_limit and timeout types", () => {
		const path = writeConfig(`tasks:
  - name: bad-budget
    schedule: "* * * * *"
    workspace: /w
    message: "m"
    budget_limit: "lots"
`);
		expect(() => loadTasks(path)).toThrowError(/task "bad-budget" has invalid "budget_limit"/);
	});
});

describe("isValidCron", () => {
	it.each([
		"* * * * *",
		"0 9 * * *",
		"*/15 * * * *",
		"0 0 1 1 0",
		"1,2,3 4-6 1-15/2 * 0-7",
		"30 4 1 * 7",
	])("accepts %s", (expr) => {
		expect(isValidCron(expr)).toBe(true);
	});

	it.each([
		"",
		"* * * *",
		"* * * * * *",
		"60 * * * *",
		"* 24 * * *",
		"* * 0 * *",
		"* * * 13 *",
		"* * * * 8",
		"a * * * *",
		"5-2 * * * *",
		"*/0 * * * *",
		"1/2/3 * * * *",
	])("rejects %s", (expr) => {
		expect(isValidCron(expr)).toBe(false);
	});
});
