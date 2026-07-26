import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	applyAuthPolicy,
	DEFAULT_SERVER_HOST,
	DEFAULT_SERVER_PORT,
	isPublicMode,
	resolveHost,
	resolvePort,
	resolveWorkspaceRoot,
} from "../src/cli/server-config.js";

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

describe("isPublicMode (F-0.3)", () => {
	const originalPublic = process.env.FAN_PUBLIC;

	afterEach(() => {
		if (originalPublic === undefined) {
			delete process.env.FAN_PUBLIC;
		} else {
			process.env.FAN_PUBLIC = originalPublic;
		}
	});

	test("returns false when FAN_PUBLIC is not set", () => {
		delete process.env.FAN_PUBLIC;
		expect(isPublicMode()).toBe(false);
	});

	test("treats 1/true/yes/on (case/space insensitive) as public mode", () => {
		for (const value of ["1", "true", "TRUE", "True", "yes", "YES", "on", " 1 ", " true "]) {
			expect(isPublicMode(value)).toBe(true);
		}
	});

	test("treats 0/false/no/off/empty/undefined as local mode", () => {
		for (const value of ["0", "false", "FALSE", "no", "off", "", "   "]) {
			expect(isPublicMode(value)).toBe(false);
		}
		expect(isPublicMode(undefined)).toBe(false);
	});

	test("treats unrecognized non-empty values as public mode (fail-closed) and warns", () => {
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			for (const value of ["2", "enbale", "yes please"]) {
				expect(isPublicMode(value)).toBe(true);
				expect(stderrWrite).toHaveBeenCalledWith(
					expect.stringContaining(`FAN_PUBLIC имеет нераспознанное значение ${JSON.stringify(value)}`),
				);
			}
		} finally {
			stderrWrite.mockRestore();
		}
	});

	test("explicit env argument takes precedence over process.env", () => {
		delete process.env.FAN_PUBLIC;
		expect(isPublicMode("1")).toBe(true);
	});
});

describe("resolveWorkspaceRoot (F-1.11)", () => {
	const originalRoot = process.env.FAN_WORKSPACE_ROOT;

	afterEach(() => {
		if (originalRoot === undefined) {
			delete process.env.FAN_WORKSPACE_ROOT;
		} else {
			process.env.FAN_WORKSPACE_ROOT = originalRoot;
		}
	});

	test("TC-F-1.11-1: without FAN_WORKSPACE_ROOT the default is <homedir>/projects", () => {
		delete process.env.FAN_WORKSPACE_ROOT;
		expect(resolveWorkspaceRoot(undefined)).toBe(join(homedir(), "projects"));
	});

	test("TC-F-1.11-2: FAN_WORKSPACE_ROOT overrides the default", () => {
		process.env.FAN_WORKSPACE_ROOT = "/data/custom";
		expect(resolveWorkspaceRoot(undefined)).toBe("/data/custom");
	});

	test("empty FAN_WORKSPACE_ROOT falls back to the default", () => {
		expect(resolveWorkspaceRoot("")).toBe(join(homedir(), "projects"));
	});

	test("whitespace-only FAN_WORKSPACE_ROOT falls back to the default", () => {
		expect(resolveWorkspaceRoot("   ")).toBe(join(homedir(), "projects"));
	});

	test("FAN_WORKSPACE_ROOT value is trimmed", () => {
		expect(resolveWorkspaceRoot("  /data/repos  ")).toBe("/data/repos");
	});

	test("relative FAN_WORKSPACE_ROOT is passed through as-is", () => {
		expect(resolveWorkspaceRoot("repos")).toBe("repos");
	});

	test("home parameter is injectable (default base for the fallback)", () => {
		expect(resolveWorkspaceRoot(undefined, "/home/testuser")).toBe(join("/home/testuser", "projects"));
	});

	test("reads process.env.FAN_WORKSPACE_ROOT by default", () => {
		process.env.FAN_WORKSPACE_ROOT = "/data/from-env";
		expect(resolveWorkspaceRoot()).toBe("/data/from-env");
	});
});

describe("applyAuthPolicy (F-0.3)", () => {
	const originalPublic = process.env.FAN_PUBLIC;
	const originalNoAuth = process.env.FAN_NO_AUTH;

	afterEach(() => {
		if (originalPublic === undefined) {
			delete process.env.FAN_PUBLIC;
		} else {
			process.env.FAN_PUBLIC = originalPublic;
		}
		if (originalNoAuth === undefined) {
			delete process.env.FAN_NO_AUTH;
		} else {
			process.env.FAN_NO_AUTH = originalNoAuth;
		}
	});

	test("TC-F-0.3-1: FAN_PUBLIC=1 + FAN_NO_AUTH=1 → FAN_NO_AUTH is removed (auth mandatory)", () => {
		process.env.FAN_PUBLIC = "1";
		process.env.FAN_NO_AUTH = "1";
		applyAuthPolicy();
		expect(process.env.FAN_NO_AUTH).toBeUndefined();
	});

	test("TC-F-0.3-2: without FAN_PUBLIC → FAN_NO_AUTH=1 is set automatically (legacy behavior)", () => {
		delete process.env.FAN_PUBLIC;
		delete process.env.FAN_NO_AUTH;
		applyAuthPolicy();
		expect(process.env.FAN_NO_AUTH).toBe("1");
	});

	test("TC-F-0.3-3: only FAN_PUBLIC=1 → FAN_NO_AUTH is not set (token required)", () => {
		process.env.FAN_PUBLIC = "1";
		delete process.env.FAN_NO_AUTH;
		applyAuthPolicy();
		expect(process.env.FAN_NO_AUTH).toBeUndefined();
	});

	test("without FAN_PUBLIC, pre-set FAN_NO_AUTH is preserved", () => {
		delete process.env.FAN_PUBLIC;
		process.env.FAN_NO_AUTH = "true";
		applyAuthPolicy();
		expect(process.env.FAN_NO_AUTH).toBe("true");
	});

	test("operates on the provided env object instead of process.env", () => {
		const env: NodeJS.ProcessEnv = { FAN_PUBLIC: "1", FAN_NO_AUTH: "1" };
		applyAuthPolicy(env);
		expect(env.FAN_NO_AUTH).toBeUndefined();

		const localEnv: NodeJS.ProcessEnv = {};
		applyAuthPolicy(localEnv);
		expect(localEnv.FAN_NO_AUTH).toBe("1");
	});
});
