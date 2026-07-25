import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	installFileLogger,
	resolveFileLoggerConfig,
	resolveLogLevel,
	resolveMaxFiles,
	resolveMaxSize,
	rotateIfNeeded,
} from "../src/utils/file-logger.js";

describe("file-logger (F-0.10)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fan-test-file-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("config resolution", () => {
		test("returns undefined when LOG_DIR is unset or empty", () => {
			expect(resolveFileLoggerConfig({})).toBeUndefined();
			expect(resolveFileLoggerConfig({ LOG_DIR: "   " })).toBeUndefined();
		});

		test("uses defaults for level/size/files", () => {
			const config = resolveFileLoggerConfig({ LOG_DIR: tempDir });
			expect(config).toEqual({
				dir: tempDir,
				fileName: "app.log",
				level: "info",
				maxSizeBytes: 10 * 1024 * 1024,
				maxFiles: 5,
			});
		});

		test("resolveLogLevel parses valid levels, falls back to info", () => {
			expect(resolveLogLevel("debug")).toBe("debug");
			expect(resolveLogLevel("WARN")).toBe("warn");
			expect(resolveLogLevel(" error ")).toBe("error");
			expect(resolveLogLevel("nonsense")).toBe("info");
			expect(resolveLogLevel(undefined)).toBe("info");
		});

		test("resolveMaxSize parses bytes and k/m/g suffixes", () => {
			expect(resolveMaxSize("1024")).toBe(1024);
			expect(resolveMaxSize("512k")).toBe(512 * 1024);
			expect(resolveMaxSize("10M")).toBe(10 * 1024 * 1024);
			expect(resolveMaxSize("1g")).toBe(1024 ** 3);
			expect(resolveMaxSize("nope")).toBe(10 * 1024 * 1024);
			expect(resolveMaxSize(undefined)).toBe(10 * 1024 * 1024);
		});

		test("resolveMaxFiles parses positive integers", () => {
			expect(resolveMaxFiles("3")).toBe(3);
			expect(resolveMaxFiles("0")).toBe(5);
			expect(resolveMaxFiles("x")).toBe(5);
			expect(resolveMaxFiles(undefined)).toBe(5);
		});
	});

	describe("installFileLogger", () => {
		test("is a no-op when LOG_DIR is not set", () => {
			const spy = vi.fn();
			const fakeConsole = { error: spy, warn: spy, log: spy, info: spy, debug: spy };
			expect(installFileLogger({}, fakeConsole)).toBeUndefined();
			fakeConsole.log("hello");
			expect(existsSync(join(tempDir, "app.log"))).toBe(false);
			expect(spy).toHaveBeenCalledWith("hello");
		});

		test("writes entries with ISO timestamp and passes through to console", () => {
			const spy = vi.fn();
			const fakeConsole = { error: spy, warn: spy, log: spy, info: spy, debug: spy };
			const uninstall = installFileLogger({ LOG_DIR: tempDir, LOG_LEVEL: "debug" }, fakeConsole);
			expect(uninstall).toBeTypeOf("function");

			fakeConsole.log("server started on port %d", 3456);

			const content = readFileSync(join(tempDir, "app.log"), "utf8");
			expect(content).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] server started on port 3456\n$/,
			);
			// passthrough: original console method still received the raw args
			expect(spy).toHaveBeenCalledWith("server started on port %d", 3456);

			uninstall!();
			fakeConsole.log("after uninstall");
			expect(readFileSync(join(tempDir, "app.log"), "utf8")).not.toContain("after uninstall");
		});

		test("creates the log directory recursively", () => {
			const nested = join(tempDir, "a", "b", "logs");
			const fakeConsole = { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
			installFileLogger({ LOG_DIR: nested }, fakeConsole);
			fakeConsole.warn("hi");
			expect(readFileSync(join(nested, "app.log"), "utf8")).toContain("[WARN] hi");
		});

		test("LOG_LEVEL filters file verbosity but not console passthrough", () => {
			const spy = vi.fn();
			const fakeConsole = { error: spy, warn: spy, log: spy, info: spy, debug: spy };
			installFileLogger({ LOG_DIR: tempDir, LOG_LEVEL: "warn" }, fakeConsole);

			fakeConsole.debug("dbg");
			fakeConsole.log("info-msg");
			fakeConsole.warn("warn-msg");
			fakeConsole.error("err-msg");

			const content = readFileSync(join(tempDir, "app.log"), "utf8");
			expect(content).not.toContain("dbg");
			expect(content).not.toContain("info-msg");
			expect(content).toContain("[WARN] warn-msg");
			expect(content).toContain("[ERROR] err-msg");
			// passthrough is unaffected by the level filter
			expect(spy).toHaveBeenCalledTimes(4);
		});

		test("LOG_LEVEL=debug includes debug entries (TC-F-0.10-1)", () => {
			const fakeConsole = { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
			installFileLogger({ LOG_DIR: tempDir, LOG_LEVEL: "debug" }, fakeConsole);
			fakeConsole.debug("verbose detail");
			const content = readFileSync(join(tempDir, "app.log"), "utf8");
			expect(content).toContain("[DEBUG] verbose detail");
			expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("rotation", () => {
		test("rotateIfNeeded renames app.log to app.log.1 when size exceeded", () => {
			const logPath = join(tempDir, "app.log");
			writeFileSync(logPath, "x".repeat(100));

			expect(rotateIfNeeded(logPath, 50, 3)).toBe(true);
			expect(existsSync(logPath)).toBe(false);
			expect(statSync(`${logPath}.1`).size).toBe(100);
		});

		test("rotateIfNeeded does nothing below the threshold or when missing", () => {
			const logPath = join(tempDir, "app.log");
			writeFileSync(logPath, "x".repeat(10));
			expect(rotateIfNeeded(logPath, 50, 3)).toBe(false);
			expect(statSync(logPath).size).toBe(10);
			expect(rotateIfNeeded(join(tempDir, "missing.log"), 50, 3)).toBe(false);
		});

		test("rotation shifts files and drops the oldest beyond maxFiles", () => {
			const logPath = join(tempDir, "app.log");
			writeFileSync(logPath, "x".repeat(100));
			for (let i = 0; i < 4; i++) {
				expect(rotateIfNeeded(logPath, 50, 2)).toBe(true);
				writeFileSync(logPath, "y".repeat(100));
			}
			expect(existsSync(`${logPath}.1`)).toBe(true);
			expect(existsSync(`${logPath}.2`)).toBe(true);
			expect(existsSync(`${logPath}.3`)).toBe(false);
		});

		test("logger rotates app.log once it exceeds LOG_MAX_SIZE", () => {
			const fakeConsole = { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
			installFileLogger({ LOG_DIR: tempDir, LOG_MAX_SIZE: "200", LOG_MAX_FILES: "2" }, fakeConsole);

			for (let i = 0; i < 20; i++) {
				fakeConsole.log("line", i, "padding-padding-padding");
			}

			const logPath = join(tempDir, "app.log");
			expect(existsSync(`${logPath}.1`)).toBe(true);
			// active log restarted after rotation and stays bounded
			expect(statSync(logPath).size).toBeLessThan(300);
			expect(existsSync(`${logPath}.3`)).toBe(false);
		});
	});
});
