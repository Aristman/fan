// F-1: Role-aware process spawn — RED-фаза TDD.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §Этап 1, F-1
// Спека: docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-1
//
// Тесты проверяют role-aware spawn в process-manager:
//   • Worker spawn (default, role не указан) НЕ содержит FAN_NODE_ROLE в env
//   • SO spawn (role=super-orchestrator) содержит FAN_NODE_ROLE, FAN_NODE_ROLE_PROFILE,
//     FAN_PARENT_NODE_URL, FAN_PARENT_NODE_TOKEN
//   • buildSpawnEnv/launch включает FAN_NODE_ROLE только при role=super-orchestrator
//
// RED-фаза: TC-F1-2 и TC-F1-3 должны FAIL, т.к. текущий код:
//   • SpawnOptions не имеет полей role/roleProfile/parentUrl/parentToken
//   • buildSpawnEnv (node-auth.ts) не обрабатывает role
//   • launch() не добавляет FAN_NODE_ROLE/FAN_NODE_ROLE_PROFILE/FAN_PARENT_NODE_URL/FAN_PARENT_NODE_TOKEN

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let createProcessManager;

beforeAll(async () => {
	const mod = await import("../process-manager.js");
	createProcessManager = mod.createProcessManager;
});

// ─── Хелперы (из process-manager.test.mjs) ─────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Tempdir с путями portsFile/pidDir + регистрация cleanup. */
function makeTmp() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-role-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return {
		tmp,
		portsFile: join(tmp, "child-ports.json"),
		pidDir: join(tmp, "pids"),
	};
}

/** FakeChild, эмулирующий child_process.ChildProcess. */
function makeFakeChild(pid) {
	const handlers = new Map();
	const child = {
		pid,
		exited: false,
		kill: vi.fn((_signal) => true),
		on: vi.fn((event, cb) => {
			handlers.set(event, cb);
			return child;
		}),
		emitExit(code = 0, signal = null) {
			child.exited = true;
			const cb = handlers.get("exit");
			if (cb) {
				cb(code, signal);
			}
		},
	};
	return child;
}

/** DI-spawn: записывает каждый вызов, возвращает FakeChild. */
function makeSpawnHarness() {
	const children = [];
	const spawn = vi.fn((cmd, args, opts) => {
		const child = makeFakeChild(4000 + children.length + 1);
		child.cmd = cmd;
		child.args = args;
		child.opts = opts;
		children.push(child);
		return child;
	});
	return { spawn, children };
}

/** Здоровый healthFetch (HTTP 200). */
function makeHealthyFetch() {
	return vi.fn(async (_url) => ({ status: 200 }));
}

/** Создать PM + автоматический stopHealthChecks в cleanup. */
function makePM(opts) {
	const pm = createProcessManager(opts);
	cleanups.push(() => {
		try {
			pm.stopHealthChecks();
		} catch {
			/* ignore */
		}
	});
	return pm;
}

// ─── TC-F1-1: Worker spawn (default) НЕ содержит FAN_NODE_ROLE ──────────────

describe("TC-F1-1: Worker spawn (default) НЕ содержит FAN_NODE_ROLE в env", () => {
	it("spawn без role → env НЕ содержит FAN_NODE_ROLE, но FAN_NODE_TOKEN/FAN_NO_AUTH/FAN_ORCHESTRATOR_DEPTH присутствуют", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		// SpawnOptions БЕЗ поля role (default worker behavior)
		await pm.spawn({
			id: "L1/worker-1",
			token: "test-token-abc",
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		const env = children[0].opts.env;

		// FAN_NODE_ROLE НЕ должен присутствовать для worker spawn
		expect(env.FAN_NODE_ROLE).toBeUndefined();

		// Существующие env vars должны присутствовать (back-compat)
		expect(env.FAN_NODE_TOKEN).toBe("test-token-abc");
		expect(String(env.FAN_NO_AUTH)).toBe("0");
		expect(env.FAN_ORCHESTRATOR_DEPTH).toBeDefined();
	});
});

// ─── TC-F1-2: SO spawn содержит role env vars ───────────────────────────────

describe("TC-F1-2: SO spawn содержит FAN_NODE_ROLE=super-orchestrator + role env vars", () => {
	it("spawn с role=super-orchestrator → env содержит FAN_NODE_ROLE, FAN_NODE_ROLE_PROFILE, FAN_PARENT_NODE_URL, FAN_PARENT_NODE_TOKEN", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		// SpawnOptions С role=super-orchestrator + role-specific поля
		await pm.spawn({
			id: "L1/so-1",
			role: "super-orchestrator",
			roleProfile: "pm",
			parentUrl: "http://127.0.0.1:7001",
			parentToken: "parent-tok-xyz",
			token: "child-tok-abc",
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		const env = children[0].opts.env;

		// FAN_NODE_ROLE должен быть "super-orchestrator"
		expect(env.FAN_NODE_ROLE).toBe("super-orchestrator");

		// FAN_NODE_ROLE_PROFILE должен быть "pm"
		expect(env.FAN_NODE_ROLE_PROFILE).toBe("pm");

		// FAN_PARENT_NODE_URL должен быть URL родителя
		expect(env.FAN_PARENT_NODE_URL).toBe("http://127.0.0.1:7001");

		// FAN_PARENT_NODE_TOKEN должен быть токен родителя
		expect(env.FAN_PARENT_NODE_TOKEN).toBe("parent-tok-xyz");

		// Существующие env vars тоже присутствуют (back-compat)
		expect(env.FAN_NODE_TOKEN).toBe("child-tok-abc");
		expect(String(env.FAN_NO_AUTH)).toBe("0");
		expect(env.FAN_ORCHESTRATOR_DEPTH).toBeDefined();
	});
});

// ─── TC-F1-3: FAN_NODE_ROLE только при role=super-orchestrator ──────────────

describe("TC-F1-3: FAN_NODE_ROLE включается только для role=super-orchestrator", () => {
	it("role=undefined → env БЕЗ FAN_NODE_ROLE", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/worker-default", token: "tok-1" });

		const env = children[0].opts.env;
		expect(env.FAN_NODE_ROLE).toBeUndefined();
	});

	it("role='worker' → env БЕЗ FAN_NODE_ROLE", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/worker-explicit", role: "worker", token: "tok-2" });

		const env = children[0].opts.env;
		expect(env.FAN_NODE_ROLE).toBeUndefined();
	});

	it("role='super-orchestrator' → env С FAN_NODE_ROLE=super-orchestrator", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({
			id: "L1/so-explicit",
			role: "super-orchestrator",
			roleProfile: "pm",
			parentUrl: "http://127.0.0.1:7001",
			parentToken: "parent-tok",
			token: "child-tok",
		});

		const env = children[0].opts.env;
		// Этот тест должен FAIL в Red-фазе: текущий код не добавляет FAN_NODE_ROLE
		expect(env.FAN_NODE_ROLE).toBe("super-orchestrator");
	});
});
