import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_SERVER_PORT, resolvePort } from "../src/cli/server-config.js";

describe("resolvePort (F-0.1)", () => {
	const originalPort = process.env.PORT;

	afterEach(() => {
		if (originalPort === undefined) {
			delete process.env.PORT;
		} else {
			process.env.PORT = originalPort;
		}
	});

	test("TC-F-0.1-1: PORT env overrides default when no --port flag", () => {
		process.env.PORT = "9999";
		expect(resolvePort(undefined)).toBe(9999);
	});

	test("TC-F-0.1-2: CLI --port flag beats PORT env", () => {
		process.env.PORT = "9999";
		expect(resolvePort(7777)).toBe(7777);
	});

	test("falls back to default 3456 when neither CLI flag nor PORT env", () => {
		delete process.env.PORT;
		expect(resolvePort(undefined)).toBe(3456);
	});

	test("invalid PORT (not a number) falls back to default 3456, not NaN", () => {
		process.env.PORT = "not-a-port";
		expect(resolvePort(undefined)).toBe(3456);
		expect(resolvePort(undefined)).not.toBeNaN();
	});

	test("empty PORT falls back to default", () => {
		process.env.PORT = "";
		expect(resolvePort(undefined)).toBe(3456);
	});

	test("invalid PORT is ignored when CLI flag is present", () => {
		process.env.PORT = "not-a-port";
		expect(resolvePort(7777)).toBe(7777);
	});

	test("DEFAULT_SERVER_PORT is 3456", () => {
		expect(DEFAULT_SERVER_PORT).toBe(3456);
	});

	test("out-of-range PORT values fall back to default 3456", () => {
		process.env.PORT = "-1";
		expect(resolvePort(undefined)).toBe(3456);
		process.env.PORT = "70000";
		expect(resolvePort(undefined)).toBe(3456);
		process.env.PORT = "0";
		expect(resolvePort(undefined)).toBe(3456);
	});

	test("non-integer PORT values fall back to default 3456", () => {
		process.env.PORT = "3.14";
		expect(resolvePort(undefined)).toBe(3456);
		process.env.PORT = "Infinity";
		expect(resolvePort(undefined)).toBe(3456);
	});

	test("whitespace-only PORT falls back to default 3456", () => {
		process.env.PORT = "   ";
		expect(resolvePort(undefined)).toBe(3456);
	});

	test("valid numeric string PORT within range resolves correctly", () => {
		process.env.PORT = "8080";
		expect(resolvePort(undefined)).toBe(8080);
	});
});
