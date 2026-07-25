import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, resolveHost, resolvePort } from "../src/cli/server-config.js";

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

describe("resolveHost (F-0.2)", () => {
	const originalHost = process.env.HOST;

	afterEach(() => {
		if (originalHost === undefined) {
			delete process.env.HOST;
		} else {
			process.env.HOST = originalHost;
		}
	});

	test("TC-F-0.2-1: HOST env overrides default when no --host flag", () => {
		process.env.HOST = "0.0.0.0";
		expect(resolveHost(undefined)).toBe("0.0.0.0");
	});

	test("TC-F-0.2-2: non-numeric HOST string is passed through unchanged", () => {
		process.env.HOST = "localhost.localdomain";
		expect(resolveHost(undefined)).toBe("localhost.localdomain");
	});

	test("CLI --host flag beats HOST env", () => {
		process.env.HOST = "0.0.0.0";
		expect(resolveHost("127.0.0.1")).toBe("127.0.0.1");
	});

	test("falls back to default localhost when neither CLI flag nor HOST env", () => {
		delete process.env.HOST;
		expect(resolveHost(undefined)).toBe("localhost");
	});

	test("empty HOST falls back to default localhost", () => {
		process.env.HOST = "";
		expect(resolveHost(undefined)).toBe("localhost");
	});

	test("whitespace-only HOST falls back to default localhost", () => {
		process.env.HOST = "   ";
		expect(resolveHost(undefined)).toBe("localhost");
	});

	test("HOST value is trimmed", () => {
		process.env.HOST = "  0.0.0.0  ";
		expect(resolveHost(undefined)).toBe("0.0.0.0");
	});

	test("DEFAULT_SERVER_HOST is localhost", () => {
		expect(DEFAULT_SERVER_HOST).toBe("localhost");
	});
});
