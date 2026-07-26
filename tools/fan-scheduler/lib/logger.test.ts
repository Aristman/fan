import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, logger } from "./logger.js";

/**
 * F-4.11: structured JSON logging.
 * stdout (console.log) receives info/debug; stderr (console.error) receives
 * warn/error. Each call produces exactly one JSON line.
 */

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Parses every captured stdout line as JSON. */
function stdoutEntries(): Record<string, unknown>[] {
	return logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

/** Parses every captured stderr line as JSON. */
function stderrEntries(): Record<string, unknown>[] {
	return errorSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("TC-F-4.11-1: a log line is a valid JSON object with the required keys", () => {
	it("logger.info produces parseable JSON with timestamp/level/module/event/message", () => {
		logger.info("test_event", "test message");

		expect(logSpy).toHaveBeenCalledTimes(1);
		const line = String(logSpy.mock.calls[0][0]);
		// Single physical line (JSONL).
		expect(line).not.toContain("\n");
		const entry = JSON.parse(line) as Record<string, unknown>;

		expect(entry).toMatchObject({
			level: "info",
			module: "scheduler",
			event: "test_event",
			message: "test message",
		});
		expect(typeof entry.timestamp).toBe("string");
		// ISO 8601 timestamp that round-trips through Date.parse.
		expect(Date.parse(String(entry.timestamp))).not.toBeNaN();
		expect(String(entry.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("supports all four levels and binds the module per logger instance", () => {
		vi.stubEnv("LOG_LEVEL", "debug");
		const log = createLogger("queue");
		log.debug("e", "d");
		log.info("e", "i");
		log.warn("e", "w");
		log.error("e", "x");

		expect(stdoutEntries().map((e) => e.level)).toEqual(["debug", "info"]);
		expect(stderrEntries().map((e) => e.level)).toEqual(["warn", "error"]);
		for (const entry of [...stdoutEntries(), ...stderrEntries()]) {
			expect(entry.module).toBe("queue");
		}
	});

	it("routes info/debug to stdout and warn/error to stderr", () => {
		vi.stubEnv("LOG_LEVEL", "debug");
		const log = createLogger("executor");
		log.info("e", "to stdout");
		log.debug("e", "to stdout too");
		log.warn("e", "to stderr");
		log.error("e", "to stderr too");

		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledTimes(2);
	});
});

describe("TC-F-4.11-2: LOG_LEVEL filters verbosity (default info)", () => {
	it("LOG_LEVEL=warn suppresses debug/info and keeps warn/error", () => {
		vi.stubEnv("LOG_LEVEL", "warn");
		const log = createLogger("scheduler");

		log.debug("e", "skip this");
		log.info("e", "skip this too");
		log.warn("e", "keep this");
		log.error("e", "keep this too");

		expect(logSpy).not.toHaveBeenCalled();
		expect(stderrEntries().map((e) => e.message)).toEqual(["keep this", "keep this too"]);
	});

	it("LOG_LEVEL=error keeps only error entries", () => {
		vi.stubEnv("LOG_LEVEL", "error");
		const log = createLogger("scheduler");

		log.debug("e", "no");
		log.info("e", "no");
		log.warn("e", "no");
		log.error("e", "yes");

		expect(logSpy).not.toHaveBeenCalled();
		expect(stderrEntries().map((e) => e.message)).toEqual(["yes"]);
	});

	it("LOG_LEVEL=debug prints everything", () => {
		vi.stubEnv("LOG_LEVEL", "debug");
		const log = createLogger("scheduler");

		log.debug("e", "d");
		log.info("e", "i");
		log.warn("e", "w");
		log.error("e", "x");

		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledTimes(2);
	});

	it("defaults to info when LOG_LEVEL is unset or invalid", () => {
		const log = createLogger("scheduler");

		log.debug("e", "hidden by default");
		expect(logSpy).not.toHaveBeenCalled();

		vi.stubEnv("LOG_LEVEL", "verbose"); // unknown value → info fallback
		log.debug("e", "still hidden");
		log.info("e", "visible");
		expect(stdoutEntries().map((e) => e.message)).toEqual(["visible"]);
	});
});

describe("error stack traces and taskId", () => {
	it("error level includes the stack trace when an Error is passed", () => {
		const log = createLogger("queue");
		const err = new Error("boom");

		log.error("task_failed", "task failed: boom", { taskId: "t1", error: err });

		const entry = stderrEntries()[0];
		expect(entry.taskId).toBe("t1");
		expect(typeof entry.stack).toBe("string");
		expect(String(entry.stack)).toContain("Error: boom");
	});

	it("stack traces are NOT included below the error level", () => {
		vi.stubEnv("LOG_LEVEL", "debug");
		const log = createLogger("queue");
		const err = new Error("boom");

		log.warn("task_retry", "retrying", { taskId: "t1", error: err });
		log.info("e", "info with error", { error: err });
		log.debug("e", "debug with error", { error: err });

		for (const entry of [...stdoutEntries(), ...stderrEntries()]) {
			expect(entry.stack).toBeUndefined();
		}
	});

	it("taskId and arbitrary structured fields are merged into the entry", () => {
		const log = createLogger("executor");

		log.info("budget_monitor", "budget monitor", { taskId: "t9", project: "/proj", used: 10, limit: 100 });

		const entry = stdoutEntries()[0];
		expect(entry).toMatchObject({
			module: "executor",
			event: "budget_monitor",
			taskId: "t9",
			project: "/proj",
			used: 10,
			limit: 100,
		});
	});

	it("taskId is omitted when not provided", () => {
		logger.info("scheduler_started", "started");

		const entry = stdoutEntries()[0];
		expect("taskId" in entry).toBe(false);
	});
});
