// Smoke test: recursive-orchestrator-spawn (F-1..F-6 happy path).
//
// 7 sub-tests covering the full feature in ≤2s:
//   1. Smoke-spawn-role:        SO spawn → env содержит 4 role vars
//   2. Smoke-spawn-worker:      Worker spawn → env НЕ содержит role vars (back-compat)
//   3. Smoke-role-config:       DEFAULT_ROLE_CONFIG excluded/required для SO
//   4. Smoke-effective-extensions: getEffectiveExtensions для SO и worker
//   5. Smoke-endpoint-mock:     Mini HTTP POST /api/mission-delegate → 200
//   6. Smoke-endpoint-validation: 400 для bad payload, 401 для bad token
//   7. Smoke-tree-journal-via:  TreeJournalEntry.via для spawn и http_delegate
//
// Constraints: inline mocks, no external fixtures, ≤2s total.

import { createServer, request as httpRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ─── Dynamic imports (production modules under test) ─────────────────────────

let createProcessManager;
let DEFAULT_ROLE_CONFIG;
let getEffectiveExtensions;
let getRoleProfile;
let loadRoleCatalog;
let createTreeJournal;

beforeAll(async () => {
	const pm = await import("../process-manager.js");
	createProcessManager = pm.createProcessManager;

	const rc = await import("../role-config.js");
	DEFAULT_ROLE_CONFIG = rc.DEFAULT_ROLE_CONFIG;

	const rl = await import("../role-loader.js");
	getEffectiveExtensions = rl.getEffectiveExtensions;
	getRoleProfile = rl.getRoleProfile;
	loadRoleCatalog = rl.loadRoleCatalog;

	const tj = await import("../tree-journal.js");
	createTreeJournal = tj.createTreeJournal;
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmp() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-smoke-spawn-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return { tmp, portsFile: join(tmp, "child-ports.json"), pidDir: join(tmp, "pids") };
}

function makeFakeChild(pid) {
	const handlers = new Map();
	const child = {
		pid,
		kill: vi.fn(() => true),
		on: vi.fn((event, cb) => {
			handlers.set(event, cb);
			return child;
		}),
	};
	return child;
}

function makeSpawnHarness() {
	const children = [];
	const spawn = vi.fn((_cmd, _args, opts) => {
		const child = makeFakeChild(5000 + children.length + 1);
		child.opts = opts;
		children.push(child);
		return child;
	});
	return { spawn, children };
}

function makeHealthyFetch() {
	return vi.fn(async () => ({ status: 200 }));
}

function makePM(opts) {
	const pm = createProcessManager(opts);
	cleanups.push(() => {
		try { pm.stopHealthChecks(); } catch { /* ignore */ }
	});
	return pm;
}

// ─── Inline auth/validation (mirrors api-gateway for smoke test) ─────────────
// Мы не можем импортировать из @fan/api-gateway (нет зависимости), поэтому
// инлайним минимальные копии verifyNodeToken и validateMissionDelegatePayload.
// Семантика идентична продакшн-коду (extract F-3).

function inlineVerifyNodeToken(authHeader, expectedToken) {
	if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
		return { ok: false, error: "missing_token" };
	}
	const provided = authHeader.slice("Bearer ".length);
	if (!expectedToken || expectedToken.length === 0 || provided.length === 0) {
		return { ok: false, error: "invalid_token" };
	}
	const pBuf = Buffer.from(provided, "utf8");
	const eBuf = Buffer.from(expectedToken, "utf8");
	if (pBuf.length !== eBuf.length) {
		return { ok: false, error: "invalid_token" };
	}
	return timingSafeEqual(pBuf, eBuf) ? { ok: true } : { ok: false, error: "invalid_token" };
}

function inlineValidatePayload(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, field: "body" };
	}
	if (typeof body.parentReportId !== "string" || body.parentReportId.length === 0) {
		return { ok: false, field: "parentReportId" };
	}
	if (!Array.isArray(body.packages)) {
		return { ok: false, field: "packages" };
	}
	return { ok: true, payload: body };
}

/** Создать mini HTTP server, эмулирующий POST /api/mission-delegate. */
function makeDelegateServer(nodeToken) {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/api/mission-delegate") {
			let raw = "";
			req.on("data", (chunk) => { raw += chunk; });
			req.on("end", () => {
				// Auth check
				const auth = inlineVerifyNodeToken(req.headers.authorization, nodeToken);
				if (!auth.ok) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: auth.error }));
					return;
				}
				// Parse + validate
				let body;
				try { body = JSON.parse(raw); } catch { body = null; }
				const validation = inlineValidatePayload(body);
				if (!validation.ok) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `invalid_field: ${validation.field}` }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "queued", parentReportId: validation.payload.parentReportId }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return server;
}

/** POST JSON to a local server, return { status, body }. */
function postJson(port, path, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
			(res) => {
				let raw = "";
				res.on("data", (c) => { raw += c; });
				res.on("end", () => {
					let parsed;
					try { parsed = JSON.parse(raw); } catch { parsed = raw; }
					resolve({ status: res.statusCode, body: parsed });
				});
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-test 1: Smoke-spawn-role — SO spawn → env содержит 4 role vars
// ═════════════════════════════════════════════════════════════════════════════

describe("smoke-recursive-spawn", () => {
	it("1. spawn-role: SO spawn → env содержит FAN_NODE_ROLE + 3 optional vars", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({
			id: "L1/so-smoke",
			role: "super-orchestrator",
			roleProfile: "pm",
			parentUrl: "http://127.0.0.1:7001",
			parentToken: "parent-tok-smoke",
			token: "child-tok-smoke",
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		const env = children[0].opts.env;

		// 4 role vars
		expect(env.FAN_NODE_ROLE).toBe("super-orchestrator");
		expect(env.FAN_NODE_ROLE_PROFILE).toBe("pm");
		expect(env.FAN_PARENT_NODE_URL).toBe("http://127.0.0.1:7001");
		expect(env.FAN_PARENT_NODE_TOKEN).toBe("parent-tok-smoke");

		// Back-compat vars тоже на месте
		expect(env.FAN_NODE_TOKEN).toBe("child-tok-smoke");
		expect(String(env.FAN_NO_AUTH)).toBe("0");
		expect(env.FAN_ORCHESTRATOR_DEPTH).toBeDefined();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 2: Smoke-spawn-worker — Worker spawn → env БЕЗ role vars
	// ═══════════════════════════════════════════════════════════════════════════

	it("2. spawn-worker: Worker spawn (no role) → env НЕ содержит role vars", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/worker-smoke", token: "worker-tok" });

		expect(spawn).toHaveBeenCalledTimes(1);
		const env = children[0].opts.env;

		// Role vars НЕ должны присутствовать (back-compat)
		expect(env.FAN_NODE_ROLE).toBeUndefined();
		expect(env.FAN_NODE_ROLE_PROFILE).toBeUndefined();
		expect(env.FAN_PARENT_NODE_URL).toBeUndefined();
		expect(env.FAN_PARENT_NODE_TOKEN).toBeUndefined();

		// Back-compat vars
		expect(env.FAN_NODE_TOKEN).toBe("worker-tok");
		expect(String(env.FAN_NO_AUTH)).toBe("0");
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 3: Smoke-role-config — DEFAULT_ROLE_CONFIG
	// ═══════════════════════════════════════════════════════════════════════════

	it("3. role-config: DEFAULT_ROLE_CONFIG содержит excluded=[store_search, store_install], required=[delegate_task]", () => {
		// excluded extensions для spawn
		expect(DEFAULT_ROLE_CONFIG.spawn.excluded_extensions).toEqual(["store_search", "store_install"]);

		// required extensions для super-orchestrator
		expect(DEFAULT_ROLE_CONFIG.role["super-orchestrator"].required_extensions).toEqual(["delegate_task"]);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 4: Smoke-effective-extensions — getEffectiveExtensions
	// ═══════════════════════════════════════════════════════════════════════════

	it("4. effective-extensions: SO получает required, worker — без required", () => {
		// Инлайн-роль (без YAML, т.к. smoke — только happy path)
		const soRole = {
			id: "pm",
			name: "PM",
			description: "PM role",
			allowed_depths: [1],
			default_extensions: ["mission", "scheduler", "store_search", "delegate_task"],
		};

		// SO: excluded убирает store_search, required добавляет delegate_task (dedup — уже есть)
		const soResult = getEffectiveExtensions(soRole, {
			excluded: ["store_search", "store_install"],
			roleType: "super-orchestrator",
			required: ["delegate_task"],
		});
		expect(soResult).not.toContain("store_search");
		expect(soResult).not.toContain("store_install");
		expect(soResult).toContain("mission");
		expect(soResult).toContain("scheduler");
		expect(soResult).toContain("delegate_task");
		// Dedup: delegate_task уже был в default_extensions → не дублируется
		const delegateCount = soResult.filter((e) => e === "delegate_task").length;
		expect(delegateCount).toBe(1);

		// Worker: excluded убирает store_search, required НЕ добавляется (roleType !== super-orchestrator)
		const workerResult = getEffectiveExtensions(soRole, {
			excluded: ["store_search"],
			roleType: "worker",
		});
		expect(workerResult).not.toContain("store_search");
		expect(workerResult).toContain("mission");
		expect(workerResult).toContain("scheduler");
		// delegate_task остаётся (он был в default_extensions), но required не добавляются
		expect(workerResult).toContain("delegate_task");
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 5: Smoke-endpoint-mock — Mini HTTP POST /api/mission-delegate
	// ═══════════════════════════════════════════════════════════════════════════

	it("5. endpoint-mock: POST /api/mission-delegate с валидным token → 200 queued", async () => {
		const nodeToken = "smoke-node-token-abc";
		const server = makeDelegateServer(nodeToken);

		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		cleanups.push(() => server.close());

		const res = await postJson(port, "/api/mission-delegate", {
			parentReportId: "rpt-001",
			packages: [{ id: "pkg-1", task: "do something" }],
		}, {
			Authorization: `Bearer ${nodeToken}`,
		});

		expect(res.status).toBe(200);
		expect(res.body.status).toBe("queued");
		expect(res.body.parentReportId).toBe("rpt-001");
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 6: Smoke-endpoint-validation — 400/401
	// ═══════════════════════════════════════════════════════════════════════════

	it("6. endpoint-validation: 401 для bad token, 400 для invalid payload", async () => {
		const nodeToken = "smoke-token-validation";
		const server = makeDelegateServer(nodeToken);

		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		cleanups.push(() => server.close());

		// 401: неверный token
		const res401 = await postJson(port, "/api/mission-delegate", {
			parentReportId: "rpt-002",
			packages: [],
		}, {
			Authorization: "Bearer wrong-token-xxxxx",
		});
		expect(res401.status).toBe(401);
		expect(res401.body.error).toBe("invalid_token");

		// 401: отсутствует Authorization header
		const res401no = await postJson(port, "/api/mission-delegate", {
			parentReportId: "rpt-003",
			packages: [],
		});
		expect(res401no.status).toBe(401);
		expect(res401no.body.error).toBe("missing_token");

		// 400: невалидный payload (нет parentReportId)
		const res400 = await postJson(port, "/api/mission-delegate", {
			packages: [{ id: "pkg" }],
		}, {
			Authorization: `Bearer ${nodeToken}`,
		});
		expect(res400.status).toBe(400);
		expect(res400.body.error).toContain("parentReportId");

		// 400: packages не массив
		const res400b = await postJson(port, "/api/mission-delegate", {
			parentReportId: "rpt-004",
			packages: "not-an-array",
		}, {
			Authorization: `Bearer ${nodeToken}`,
		});
		expect(res400b.status).toBe(400);
		expect(res400b.body.error).toContain("packages");
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Sub-test 7: Smoke-tree-journal-via — TreeJournalEntry.via
	// ═══════════════════════════════════════════════════════════════════════════

	it("7. tree-journal-via: via='spawn' и via='http_delegate' записываются и читаются", () => {
		const { tmp } = makeTmp();
		const journalPath = join(tmp, "tree-journal.jsonl");
		const journal = createTreeJournal(journalPath);

		// Запись spawn (локальный child_process.spawn)
		const e1 = journal.write({
			event: "spawn",
			nodeId: "node-spawn-1",
			parentId: "root",
			depth: 1,
			via: "spawn",
		});
		expect(e1.via).toBe("spawn");
		expect(e1.nodeId).toBe("node-spawn-1");

		// Запись http_delegate (HTTP POST delegation)
		const e2 = journal.write({
			event: "spawn",
			nodeId: "node-http-1",
			parentId: "node-spawn-1",
			depth: 2,
			via: "http_delegate",
		});
		expect(e2.via).toBe("http_delegate");
		expect(e2.nodeId).toBe("node-http-1");

		// readAll roundtrip
		const entries = journal.readAll();
		expect(entries).toHaveLength(2);
		expect(entries[0].via).toBe("spawn");
		expect(entries[1].via).toBe("http_delegate");

		// via — опциональное поле: запись без via тоже валидна
		const e3 = journal.write({
			event: "complete",
			nodeId: "node-spawn-1",
		});
		expect(e3.via).toBeUndefined();

		const allEntries = journal.readAll();
		expect(allEntries).toHaveLength(3);
		expect(allEntries[2].via).toBeUndefined();
	});
});
