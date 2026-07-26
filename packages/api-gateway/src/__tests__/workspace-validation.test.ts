import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isWithinRoot, logCwdRejection, resolveAllowedRoots, validateCwd } from "../workspace-validation.js";

// ============================================================================
// Unit tests — validateCwd / isWithinRoot / resolveAllowedRoots (F-1.13)
// ============================================================================

describe("validateCwd", () => {
	it("TC-F-1.13-1a: path inside the whitelist is valid", () => {
		expect(validateCwd("/data/repos/my-project", ["/data/repos"])).toEqual({ valid: true });
		// the root itself is inside the whitelist
		expect(validateCwd("/data/repos", ["/data/repos"])).toEqual({ valid: true });
	});

	it("TC-F-1.13-1b: empty whitelist bypasses validation (local mode)", () => {
		expect(validateCwd("/any/path/at/all", [])).toEqual({ valid: true });
		expect(validateCwd("/etc/passwd", [])).toEqual({ valid: true });
	});

	it("TC-F-1.13-2: path outside the whitelist is rejected with a reason", () => {
		const result = validateCwd("/etc/passwd", ["/data/repos"]);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("path outside allowed roots");
	});

	it("boundary: /data/repos2 is NOT inside root /data/repos (segment boundary)", () => {
		const result = validateCwd("/data/repos2", ["/data/repos"]);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("path outside allowed roots");
		// ...while a real subdirectory passes
		expect(validateCwd("/data/repos/2", ["/data/repos"]).valid).toBe(true);
	});

	it("traversal via .. segments is normalized away and rejected", () => {
		const result = validateCwd("/data/repos/../../etc/passwd", ["/data/repos"]);
		expect(result.valid).toBe(false);
	});

	it("empty path is rejected", () => {
		const result = validateCwd("   ", ["/data/repos"]);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("empty path");
	});

	it("non-existent path inside the whitelist is valid (future projects)", () => {
		const result = validateCwd("/data/repos/not-yet-cloned/repo", ["/data/repos"]);
		expect(result).toEqual({ valid: true });
	});

	it("non-existent path outside the whitelist is invalid", () => {
		const result = validateCwd("/data/other/not-yet-cloned", ["/data/repos"]);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("path outside allowed roots");
	});

	describe("with a real filesystem (symlink traversal)", () => {
		let tmp: string;
		let root: string;
		let outside: string;

		beforeAll(() => {
			tmp = mkdtempSync(path.join(tmpdir(), "fan-wv-"));
			root = path.join(tmp, "repos");
			outside = path.join(tmp, "outside");
			mkdirSync(root, { recursive: true });
			mkdirSync(outside, { recursive: true });
		});

		afterAll(() => {
			rmSync(tmp, { recursive: true, force: true });
		});

		it("existing directory inside the whitelist is valid (realpath-safe)", () => {
			// Works even when tmpdir itself is behind a symlink (macOS /var):
			// roots are canonicalized with realpath too.
			expect(validateCwd(root, [root])).toEqual({ valid: true });
			expect(validateCwd(outside, [root]).valid).toBe(false);
		});

		it("TC-F-1.13-3: symlink pointing outside the whitelist is rejected", () => {
			const link = path.join(root, "link-to-outside");
			// 'junction' works without admin rights on Windows; 'dir' elsewhere
			symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
			const result = validateCwd(link, [root]);
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("symlink traversal detected");
		});
	});
});

describe("isWithinRoot", () => {
	it("matches the root itself and direct descendants", () => {
		expect(isWithinRoot("/data/repos", "/data/repos")).toBe(true);
		expect(isWithinRoot("/data/repos/a/b", "/data/repos")).toBe(true);
	});

	it("rejects prefix collisions and other paths", () => {
		expect(isWithinRoot("/data/repos2", "/data/repos")).toBe(false);
		expect(isWithinRoot("/data/repo", "/data/repos")).toBe(false);
		expect(isWithinRoot("/etc", "/data/repos")).toBe(false);
	});
});

describe("resolveAllowedRoots", () => {
	const originalRoot = process.env.FAN_WORKSPACE_ROOT;

	afterEach(() => {
		if (originalRoot === undefined) delete process.env.FAN_WORKSPACE_ROOT;
		else process.env.FAN_WORKSPACE_ROOT = originalRoot;
	});

	it("returns an empty whitelist (bypass) when FAN_WORKSPACE_ROOT is unset", () => {
		delete process.env.FAN_WORKSPACE_ROOT;
		expect(resolveAllowedRoots()).toEqual([]);
	});

	it("returns [FAN_WORKSPACE_ROOT] when set", () => {
		process.env.FAN_WORKSPACE_ROOT = "/data/repos";
		expect(resolveAllowedRoots()).toEqual(["/data/repos"]);
	});

	it("ignores empty/whitespace-only values (bypass)", () => {
		expect(resolveAllowedRoots("")).toEqual([]);
		expect(resolveAllowedRoots("   ")).toEqual([]);
	});

	it("trims the value", () => {
		expect(resolveAllowedRoots("  /data/repos  ")).toEqual(["/data/repos"]);
	});
});

describe("logCwdRejection", () => {
	it("writes a structured audit line to console.warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		logCwdRejection({ cwd: "/etc/passwd", reason: "path outside allowed roots", allowedRoots: ["/data/repos"] });
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0][0] as string;
		expect(line).toContain("[api-gateway][audit]");
		const payload = JSON.parse(line.slice(line.indexOf("{")));
		expect(payload.event).toBe("cwd_rejected");
		expect(payload.cwd).toBe("/etc/passwd");
		expect(payload.reason).toBe("path outside allowed roots");
		expect(payload.allowedRoots).toEqual(["/data/repos"]);
		expect(typeof payload.timestamp).toBe("string");
		warn.mockRestore();
	});
});

// ============================================================================
// HTTP integration — POST /api/sessions whitelist enforcement (F-1.13)
// ============================================================================

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls
const { mockClientToken, mockQueryRawUnsafe } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
	mockQueryRawUnsafe: vi.fn(),
}));

const mockModelManager = {
	getAllModelSettings: vi.fn().mockResolvedValue([]),
	setModelSetting: vi.fn().mockResolvedValue(undefined),
	getModelSetting: vi.fn().mockReturnValue(null),
	getBudgetStatus: vi.fn().mockResolvedValue([]),
	configureBudget: vi.fn().mockResolvedValue(undefined),
	getRoutingRules: vi.fn().mockResolvedValue([]),
};

const mockSessionAdapter = {
	listSessions: vi.fn().mockResolvedValue([]),
	getSession: vi.fn().mockResolvedValue(null),
	createSession: vi.fn().mockResolvedValue({ id: "s1", title: "Test" }),
	deleteSession: vi.fn().mockResolvedValue(false),
	sendMessage: vi.fn().mockResolvedValue(true),
	subscribeToSession: vi.fn().mockReturnValue(() => {}),
	getAvailableModels: vi.fn().mockResolvedValue([]),
	bindSessionExtensions: vi.fn().mockResolvedValue(undefined),
	listProjects: vi.fn().mockResolvedValue([]),
	getActiveSessionId: vi.fn().mockReturnValue(null),
};

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
		$queryRawUnsafe: mockQueryRawUnsafe,
	}),
}));

// Bypass token auth in tests
process.env.FAN_NO_AUTH = "1";

import type { ModelManager } from "@fan/model-manager";
import { createApp } from "../http-server.js";

describe("POST /api/sessions — whitelist enforcement", () => {
	// Real tmp dir so realpath-based checks behave exactly like in production
	let tmp: string;
	let root: string;
	let outside: string;
	const originalRootEnv = process.env.FAN_WORKSPACE_ROOT;

	beforeAll(() => {
		tmp = mkdtempSync(path.join(tmpdir(), "fan-wv-http-"));
		root = path.join(tmp, "repos");
		outside = path.join(tmp, "outside");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
		if (originalRootEnv === undefined) delete process.env.FAN_WORKSPACE_ROOT;
		else process.env.FAN_WORKSPACE_ROOT = originalRootEnv;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockSessionAdapter.createSession.mockResolvedValue({ id: "s1", title: "Test" });
		delete process.env.FAN_WORKSPACE_ROOT;
	});

	function postSession(app: unknown, cwd: string) {
		return (app as { request: (input: string, init?: RequestInit) => Promise<Response> }).request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd }),
		});
	}

	it("TC-F-1.13-1 (HTTP): cwd inside the whitelist → 201, session created", async () => {
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter, {
			allowedRoots: [root],
		});
		const res = await postSession(app, path.join(root, "my-project"));
		expect(res.status).toBe(201);
		expect(mockSessionAdapter.createSession).toHaveBeenCalledTimes(1);
	});

	it("TC-F-1.13-2 (HTTP): cwd outside the whitelist → 403 + audit log, session NOT created", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter, {
			allowedRoots: [root],
		});
		const res = await postSession(app, outside);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("FORBIDDEN");
		expect(body.error).toContain("path outside allowed roots");
		expect(mockSessionAdapter.createSession).not.toHaveBeenCalled();
		// audit log entry written
		expect(warn.mock.calls.some((c) => String(c[0]).includes("[api-gateway][audit]"))).toBe(true);
		warn.mockRestore();
	});

	it("TC-F-1.13-3 (HTTP): symlink traversal → 403, session NOT created", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const link = path.join(root, "link-to-outside");
		symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter, {
			allowedRoots: [root],
		});
		const res = await postSession(app, link);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("symlink traversal detected");
		expect(mockSessionAdapter.createSession).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("empty whitelist (no option, no env) → bypass, any cwd accepted", async () => {
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter);
		const res = await postSession(app, outside);
		expect(res.status).toBe(201);
		expect(mockSessionAdapter.createSession).toHaveBeenCalledTimes(1);
	});

	it("env fallback: FAN_WORKSPACE_ROOT provides the whitelist when no option is passed", async () => {
		process.env.FAN_WORKSPACE_ROOT = root;
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter);
		const okRes = await postSession(app, path.join(root, "proj"));
		expect(okRes.status).toBe(201);
		const badRes = await postSession(app, outside);
		expect(badRes.status).toBe(403);
	});

	it("non-existent path inside the whitelist → 201 (future project)", async () => {
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter, {
			allowedRoots: [root],
		});
		const res = await postSession(app, path.join(root, "not-yet-cloned", "repo"));
		expect(res.status).toBe(201);
	});

	it("boundary: sibling prefix of the root (repos2) → 403", async () => {
		const sibling = `${root}2`; // e.g. /tmp/x/repos2 vs root /tmp/x/repos
		const app = await createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter, {
			allowedRoots: [root],
		});
		const res = await postSession(app, sibling);
		expect(res.status).toBe(403);
	});
});
