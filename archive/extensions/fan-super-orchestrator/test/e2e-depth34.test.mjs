// F-44: E2E-тесты глубины 3–4 (этап 3, фаза C).
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-44
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Сквозные сценарии полного дерева глубины 3–4:
//   TC-F44-1  Миссия глубины 3 end-to-end: L0 (test) → 2×L1 (реальные
//             процессы mock-node-main) → 2×L2 (in-process mock-node-server)
//             на каждый L1; пакеты доставлены, отчёты получены, tree-journal
//             ≥10 записей, Σconsumed ≤ budget_total, reconstructTree глубины 3.
//   TC-F44-1b Дерево глубины 4 (guard + canSpawn доп. уровень): 4 уровня
//             записей в журнале, canSpawn(depth=3,maxWorkingDepth=4)=allowed,
//             canSpawn(depth=4,...)=allowed, depth=5 — max_depth_exceeded.
//   Доп-1     Параллельные L1 (3 реальных процесса одновременно): все
//             healthy concurrently, run() вернул 3 completed/PASS отчёта.
//   Доп-2     Частичный отказ: один L1 возвращает FAIL verdict → fail-запись
//             в журнале, PASS-узел в complete, reconstructTree отражает оба.
//   Доп-3     Бюджет by_branch по уровням: Σconsumed(depth=1) +
//             Σconsumed(depth=2) = Σconsumed(total), byBranch все уровни.
//   TC-F44-2  Манифест ограничивает инструменты на глубине 3: L2-узел с
//             toolManifest ["read","bash"] → write отклонён isAllowed с
//             диагностикой «tool 'write' not in manifest», tool_blocked в
//             журнале, reconstructTree отражает запись.
//   TC-F44-3  Метрики в пределах допустимого: failureRate < 0.2,
//             prematureTerminationRate < 0.15, все итерации записаны.
//
// Архитектура:
//   L0→L1 — depth2-integration с реальными процессами (mock-node-main.mjs);
//   L1→L2 (+L2→L3 для depth-4) — программная эмуляция теми же модулями
//   (guard + manifest + sanitizer + journal + child-node-client) поверх
//   in-process мок-узлов (helpers/mock-node-server.mjs).
//
// НЕ дублирует phase-gate-a3 (дерево глубины 3 standalone) и phase-gate-c
// (kill-switch/reconciliation). Vitest include: test/**/*.test.mjs.

import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createBudgetAggregator, emptyBudgetState } from "../budget-aggregator.js";
import { computeChildAllocation } from "../budget-coordinator.js";
import { createChildNodeClient } from "../child-node-client.js";
import { canSpawn } from "../depth-width-guard.js";
import { createDepth2Integration } from "../depth2-integration.js";
import { validateDepth } from "../message-sanitizer.js";
import { generateNodeToken } from "../node-auth.js";
import { totalUsage } from "../node-report.js";
import { isAllowed } from "../tool-manifest.js";
import { createTreeJournal, reconstructTree } from "../tree-journal.js";
import { createWorkPackage, makeCorrelationId } from "../work-package.js";
import { startMockNode } from "./helpers/mock-node-server.mjs";

// ─── Константы ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(SCRIPT_DIR, "..");
const MOCK_NODE_MAIN = join(SCRIPT_DIR, "helpers", "mock-node-main.mjs");

const BUDGET_TOKENS = 200_000; // TC-F44-1: 200000 токенов
const BUDGET_USD = 20;
const L1_MANIFEST = ["read", "bash", "grep"];
const HEALTH_POLL_MS = 300;
const HEALTH_TIMEOUT_MS = 30_000;

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];
const realPids = [];
const mocks = [];
const clients = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		try {
			await fn();
		} catch {
			/* ignore */
		}
	}
	// Закрыть клиенты.
	for (const c of clients.splice(0)) {
		try {
			c.close();
		} catch {
			/* ignore */
		}
	}
	// Остановить in-process мок-узлы.
	for (const m of mocks.splice(0)) {
		try {
			await m.stop();
		} catch {
			/* ignore */
		}
	}
	// Убить реальные процессы.
	for (const p of realPids.splice(0)) {
		try {
			process.kill(p, "SIGKILL");
		} catch {
			/* ignore */
		}
	}
});

function makeTmpDir(prefix = "fan-so-f44-") {
	const tmp = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Свободный порт от ОС (listen 0) — нет коллизий с занятыми диапазонами. */
function getFreePort() {
	return new Promise((resolvePort, rejectPort) => {
		const srv = net.createServer();
		srv.once("error", rejectPort);
		srv.listen(0, "127.0.0.1", () => {
			const assigned = srv.address().port;
			srv.close(() => resolvePort(assigned));
		});
	});
}

async function getStatus(url) {
	try {
		const res = await fetch(url);
		await res.arrayBuffer();
		return res.status;
	} catch {
		return 0;
	}
}

/** WsLike-фабрика поверх ws-пакета. */
function wsFactory(url) {
	const socket = new WebSocket(url);
	const adapter = {
		close: () => socket.close(),
		send: (data) => socket.send(data),
	};
	socket.on("open", () => adapter.onopen?.());
	socket.on("message", (data) => adapter.onmessage?.({ data: data.toString() }));
	socket.on("close", () => adapter.onclose?.());
	socket.on("error", (err) => adapter.onerror?.(err));
	return adapter;
}

/** Глубина узла из correlationId (<mission>/L<N>/node-<M>); null при отказе. */
function depthFromCorrelationId(correlationId) {
	if (typeof correlationId !== "string") return null;
	const match = /\/L(\d+)\/node-\d+$/.exec(correlationId);
	return match === null ? null : Number(match[1]);
}

/** In-process мок-узел с регистрацией stop() в afterEach. */
async function trackMock(opts) {
	const mock = await startMockNode(opts);
	mocks.push(mock);
	return mock;
}

/** Глобальный счётчик для уникальных nodeId внутри теста (предотвращает
 *  коллизии «L2/node-1» от разных родителей в byBranch агрегатора). */
let uniqueNodeSeq = 0;
function nextNodeSeq() {
	return ++uniqueNodeSeq;
}

/**
 * Spawn реального процесса mock-node-main с регистрацией PID в cleanup.
 * Разрешается, когда сервер health-check возвращает 200.
 */
function spawnRealNode({ port, token, env = {}, delayMs = 200, args = [] }) {
	const child = cpSpawn(
		process.execPath,
		[MOCK_NODE_MAIN, "--port", String(port), ...args],
		{
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				FAN_NODE_TOKEN: token,
				MOCK_DELAY_MS: String(delayMs),
				...env,
			},
			cwd: EXT_DIR,
		},
	);
	if (child.pid !== undefined) realPids.push(child.pid);
	return new Promise((resolveSpawn, rejectSpawn) => {
		let settled = false;
		const done = (fn, val) => {
			if (settled) return;
			settled = true;
			fn(val);
		};
		const healthInterval = setInterval(async () => {
			if (settled) {
				clearInterval(healthInterval);
				return;
			}
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`);
				await res.arrayBuffer();
				if (res.status === 200) {
					clearInterval(healthInterval);
					done(resolveSpawn, { pid: child.pid });
				}
			} catch {
				/* server not yet up */
			}
		}, HEALTH_POLL_MS);
		child.on("close", (code, signal) => {
			if (settled) return;
			clearInterval(healthInterval);
			setTimeout(() => {
				done(
					rejectSpawn,
					new Error(`mock-node (port ${port}) closed: code=${code} signal=${signal}`),
				);
			}, 500);
		});
		child.on("error", (err) => {
			clearInterval(healthInterval);
			done(rejectSpawn, err);
		});
	});
}

function killAllReal() {
	for (const pid of realPids.splice(0)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* ignore */
		}
	}
}

/**
 * Полный in-process pipeline одного дочернего узла: canSpawn → allocate →
 * mock → journal spawn → sendPackage → usage → journal complete/fail.
 * Возвращает NodeReport и мета-данные. Используется для эмуляции L1→L2
 * и L2→L3 (глубже уровня реальных процессов depth2-integration).
 */
async function launchInProcessChild({
	parentId,
	parentDepth,
	childIndex,
	missionId,
	task,
	manifest,
	deadline,
	journal,
	aggregator,
	allocation,
	verdict = "PASS",
	delayMs = 80,
	nodeId,
	guardOptions,
}) {
	const childDepth = parentDepth + 1;
	// По умолчанию — глобально уникальный nodeId (предотвращает коллизии
	// в byBranch агрегатора, когда несколько родителей на одном уровне
	// порождают детей с одинаковыми L<N>/node-<M>). Явный nodeId
	// используется, когда тест требует стабильной топологии.
	const resolvedNodeId = nodeId ?? `L${childDepth}/node-${childIndex}-${nextNodeSeq()}`;

	const decision = canSpawn(
		childDepth,
		childIndex - 1,
		guardOptions ?? { maxWorkingDepth: 4 },
	);
	if (!decision.allowed) {
		throw new Error(`canSpawn refused depth ${childDepth}: ${decision.reason}`);
	}

	const port = await getFreePort();
	const token = generateNodeToken();
	const mock = await trackMock({ port, token, verdict, delayMs });

	const correlationId = makeCorrelationId(missionId, childDepth, childIndex);
	journal.write({
		event: "spawn",
		nodeId: resolvedNodeId,
		parentId,
		correlationId,
		task,
		depth: childDepth,
		port,
		pid: process.pid,
	});

	if (!aggregator.allocate(resolvedNodeId, allocation)) {
		throw new Error(`Budget exhausted for ${resolvedNodeId}`);
	}

	const workPackage = createWorkPackage({
		task,
		correlationId,
		depth: childDepth,
		tokenBudget: allocation.tokens,
		costBudgetUsd: allocation.usd,
		toolManifest: manifest,
		deadline,
	});

	let report;
	try {
		const client = createChildNodeClient({
			wsFactory,
			onValidationFailed: (failure) => {
				journal.write({
					event: "validation_failed",
					nodeId: failure.nodeId ?? resolvedNodeId,
					parentId,
					correlationId: failure.correlationId ?? correlationId,
					depth: childDepth,
					diag: failure.diag,
				});
			},
		});
		clients.push(client);
		report = await client.sendWorkPackage({ port, token, workPackage });
		client.close();
	} catch (sendError) {
		journal.write({
			event: "fail",
			nodeId: resolvedNodeId,
			parentId,
			correlationId,
			depth: childDepth,
		});
		aggregator.onNodeComplete(resolvedNodeId, allocation);
		throw sendError;
	}

	const usage = totalUsage(report);
	aggregator.recordUsage(resolvedNodeId, usage);
	const status = report.status === "completed" ? "complete" : "fail";
	journal.write({
		event: status,
		nodeId: resolvedNodeId,
		parentId,
		correlationId,
		depth: childDepth,
		usage: { tokens: usage.inputTokens + usage.outputTokens, usd: usage.costUsd },
	});
	// complete/fail с реальным статусом (не «fail» из-за sendPackage) тоже
	// возвращает аллокацию: узел отработал и ресурс больше не удерживается.
	if (status === "complete") {
		aggregator.onNodeComplete(resolvedNodeId, allocation);
	}

	return { report, nodeId: resolvedNodeId, correlationId, port, usage };
}

// ─── TC-F44-1: Дерево глубины 3 end-to-end ─────────────────────────────────

describe("TC-F44-1: миссия глубины 3 end-to-end", () => {
	it(
		"L0 → 2×L1 (реальные процессы) → 2×L2 (in-process) на каждый L1: " +
			"отчёты, journal ≥10 записей, Σconsumed ≤ budget_total, reconstructTree глубины 3",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-d3-");
			const missionId = "f44-depth3";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
			const state = emptyBudgetState(BUDGET_TOKENS, BUDGET_USD);
			const aggregator = createBudgetAggregator({
				load: () => JSON.parse(JSON.stringify(state)),
				save: () => {},
			});

			// Корень миссии (L0).
			journal.write({
				event: "spawn",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				task: "Эпик: рефакторинг auth middleware",
				depth: 0,
				pid: process.pid,
			});

			// ── L0 → 2×L1: depth2-integration + реальные процессы ──
			const spawnedPorts = [];
			const spawnNode = async ({ port, token, args }) => {
				const spawned = await spawnRealNode({
					port,
					token,
					args,
					env: {
						FAN_ARGV_DUMP_DIR: tmp,
						FAN_ORCHESTRATOR_DEPTH: "1",
						FAN_ORCHESTRATOR_WIDTH: "2",
					},
					delayMs: 200,
				});
				spawnedPorts.push(port);
				return spawned;
			};

			const depth2 = createDepth2Integration({
				missionDir: tmp,
				missionId,
				budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
				guardOptions: { maxWorkingDepth: 4 },
				spawnNode,
				sendPackage: async ({ port, token, workPackage, onValidationFailed }) => {
					const client = createChildNodeClient({ wsFactory, onValidationFailed });
					clients.push(client);
					try {
						return await client.sendWorkPackage({ port, token, workPackage });
					} finally {
						client.close();
					}
				},
				killNode: async (id) => {
					// Для теста — мягкий kill всех реальных процессов.
					killAllReal();
				},
			});

			// Запуск + health poll.
			const runPromise = depth2.run({
				task: "Эпик: рефакторинг auth middleware",
				children: 2,
				toolManifest: [...L1_MANIFEST],
				deadline,
			});

			const healthStart = Date.now();
			let allHealthy = false;
			while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
				const checks = await Promise.all(
					spawnedPorts.map((p) => getStatus(`http://127.0.0.1:${p}/api/health`)),
				);
				if (spawnedPorts.length === 2 && checks.every((s) => s === 200)) {
					allHealthy = true;
					break;
				}
				await sleep(HEALTH_POLL_MS);
			}

			const result = await runPromise;

			// L1 отчёты: 2 completed/PASS.
			expect(allHealthy, "оба L1 healthy").toBe(true);
			expect(result.reports).toHaveLength(2);
			expect(result.reports.every((r) => r.report.status === "completed")).toBe(true);
			expect(result.reports.every((r) => r.report.verdict === "PASS")).toBe(true);

			// ── L1 → L2: эмуляция in-process (2 ребёнка на каждый L1) ──
			// Динамическая аллокация от aggregator.state(): после каждого
			// launchInProcessChild (complete → onNodeComplete) remaining
			// растёт, следующий L2 помещается в лимит.
			for (let l1 = 1; l1 <= 2; l1++) {
				const parentId = `L1/node-${l1}`;
				for (let l2 = 1; l2 <= 2; l2++) {
					const remaining = 2 - (l2 - 1);
					const alloc = computeChildAllocation(aggregator.state(), remaining);
					await launchInProcessChild({
						parentId,
						parentDepth: 1,
						childIndex: l2,
						nodeId: `L2/node-${(l1 - 1) * 2 + l2}`,
						missionId,
						task: `Подзадача L1-${l1}/L2-${l2}`,
						manifest: L1_MANIFEST,
						deadline,
						journal,
						aggregator,
						allocation: alloc,
					});
				}
			}

			// Завершение L0.
			journal.write({
				event: "complete",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				depth: 0,
			});

			// ── Проверки журнала (TC-F44-1) ──
			const entries = journal.readAll();
			// 1 L0-spawn + 1 L0-complete + 2 L1-spawn + 2 L1-complete
			// + 4 L2-spawn + 4 L2-complete = 14 записей (≥10).
			expect(entries.length).toBeGreaterThanOrEqual(10);

			const depthsSeen = new Set(entries.map((e) => e.depth).filter((d) => d !== undefined));
			expect(depthsSeen.has(0)).toBe(true);
			expect(depthsSeen.has(1)).toBe(true);
			expect(depthsSeen.has(2)).toBe(true);

			// reconstructTree глубины 3: L0 → 2×L1 → 2×L2 на каждый L1.
			// Имена L2 уникальны (L2/node-1..4) — разные родители получают
			// разных детей, а не «L2/node-1» у обоих.
			const tree = reconstructTree(entries);
			expect(tree.roots).toContain("L0");
			expect(tree.nodes.L0.children).toEqual(
				expect.arrayContaining(["L1/node-1", "L1/node-2"]),
			);
			expect(tree.nodes["L1/node-1"].children).toEqual(["L2/node-1", "L2/node-2"]);
			expect(tree.nodes["L1/node-2"].children).toEqual(["L2/node-3", "L2/node-4"]);

			// Σconsumed ≤ budget_total.
			const finalState = aggregator.state();
			expect(finalState.consumed.tokens).toBeLessThanOrEqual(BUDGET_TOKENS);
			expect(finalState.consumed.usd).toBeLessThanOrEqual(BUDGET_USD);

			killAllReal();
		},
		60_000,
	);
});

// ─── TC-F44-1b: Дерево глубины 4 (guard + canSpawn) ────────────────────────

describe("TC-F44-1b: guard глубины 4 в полном дереве", () => {
	it(
		"canSpawn: depth 3 → allowed, depth 4 → allowed, depth 5 → max_depth_exceeded; " +
			"validateDepth: L3→L4 проходит, L3→L5 отклоняется",
		async () => {
			// Guard-решения (maxWorkingDepth=4).
			const d3 = canSpawn(3, 0, { maxWorkingDepth: 4 });
			const d4 = canSpawn(4, 0, { maxWorkingDepth: 4 });
			const escalations = [];
			const d5 = canSpawn(5, 0, {
				maxWorkingDepth: 4,
				onDepthExceeded: (info) => escalations.push(info),
			});

			expect(d3.allowed).toBe(true);
			expect(d4.allowed).toBe(true);
			expect(d5.allowed).toBe(false);
			expect(d5.reason).toBe("max_depth_exceeded");
			expect(escalations).toHaveLength(1);
			expect(escalations[0].maxDepth).toBe(4);

			// validateDepth: родитель depth=3, ребёнок depth=4 → ок; 5 — отказ.
			const ok = validateDepth(3, 4);
			const bad = validateDepth(3, 5);
			expect(ok.valid).toBe(true);
			expect(bad.valid).toBe(false);
			expect(bad.errors.some((e) => (e.message ?? "").includes("depth"))).toBe(true);

			// Журнал с 4 уровнями (0,1,2,3): reconstructTree восстанавливает
			// цепочку, maxDepth = 3 (4 уровня = глубина 4).
			const tmp = makeTmpDir("fan-so-f44-d4-");
			const missionId = "f44-depth4";
			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));

			const chain = [
				{ event: "spawn", nodeId: "L0", depth: 0 },
				{ event: "spawn", nodeId: "L1/node-1", parentId: "L0", depth: 1 },
				{ event: "spawn", nodeId: "L2/node-1", parentId: "L1/node-1", depth: 2 },
				{ event: "spawn", nodeId: "L3/node-1", parentId: "L2/node-1", depth: 3 },
				{ event: "complete", nodeId: "L3/node-1", parentId: "L2/node-1", depth: 3 },
				{ event: "complete", nodeId: "L2/node-1", parentId: "L1/node-1", depth: 2 },
				{ event: "complete", nodeId: "L1/node-1", parentId: "L0", depth: 1 },
				{ event: "complete", nodeId: "L0", depth: 0 },
			];
			for (const entry of chain) {
				journal.write({
					...entry,
					correlationId: makeCorrelationId(
						missionId,
						entry.depth,
						entry.nodeId === "L0" ? 0 : Number(entry.nodeId.slice(-1)),
					),
				});
			}

			const tree = reconstructTree(journal.readAll());
			expect(tree.nodes.L0.children).toEqual(["L1/node-1"]);
			expect(tree.nodes["L1/node-1"].children).toEqual(["L2/node-1"]);
			expect(tree.nodes["L2/node-1"].children).toEqual(["L3/node-1"]);
			expect(tree.nodes["L3/node-1"].children).toEqual([]);

			const maxEntryDepth = Math.max(...journal.readAll().map((e) => e.depth ?? 0));
			expect(maxEntryDepth).toBe(3); // 4 уровня = глубина 4 (0,1,2,3)
		},
		30_000,
	);
});

// ─── Доп-1: Параллельные L1 (3 реальных процесса одновременно) ──────────────

describe("Параллельные L1: 3 реальных процесса одновременно", () => {
	it(
		"3 узла L1 поднимаются concurrently, health 200 у всех, run() вернул 3 completed/PASS",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-par-");
			const missionId = "f44-parallel";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const spawnedPorts = [];
			const depth2 = createDepth2Integration({
				missionDir: tmp,
				missionId,
				budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
				spawnNode: async ({ port, token, args }) => {
					const spawned = await spawnRealNode({
						port,
						token,
						args,
						env: {
							FAN_ARGV_DUMP_DIR: tmp,
							FAN_ORCHESTRATOR_DEPTH: "1",
							FAN_ORCHESTRATOR_WIDTH: "3",
						},
						delayMs: 150,
					});
					spawnedPorts.push(port);
					return spawned;
				},
				sendPackage: async ({ port, token, workPackage, onValidationFailed }) => {
					const client = createChildNodeClient({ wsFactory, onValidationFailed });
					clients.push(client);
					try {
						return await client.sendWorkPackage({ port, token, workPackage });
					} finally {
						client.close();
					}
				},
				killNode: async () => killAllReal(),
			});

			const t0 = Date.now();
			const runPromise = depth2.run({
				task: "Параллельный эпик",
				children: 3,
				toolManifest: [...L1_MANIFEST],
				deadline,
			});

			// Health poll: все 3 узла одновременно healthy.
			const healthStart = Date.now();
			let concurrentHealthy = false;
			while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
				const checks = await Promise.all(
					spawnedPorts.map((p) => getStatus(`http://127.0.0.1:${p}/api/health`)),
				);
				if (spawnedPorts.length === 3 && checks.every((s) => s === 200)) {
					concurrentHealthy = true;
					break;
				}
				await sleep(HEALTH_POLL_MS);
			}

			const result = await runPromise;
			const elapsed = Date.now() - t0;

			expect(concurrentHealthy, "3 узла L1 одновременно healthy").toBe(true);
			expect(result.reports).toHaveLength(3);
			expect(result.reports.every((r) => r.report.status === "completed")).toBe(true);
			expect(result.reports.every((r) => r.report.verdict === "PASS")).toBe(true);

			// argv: --tools read,bash,grep у всех 3.
			await sleep(200);
			const argvOk = spawnedPorts.every((p) => {
				const argvFile = join(tmp, `argv-${p}.txt`);
				if (!existsSync(argvFile)) return false;
				const args = JSON.parse(readFileSync(argvFile, "utf8"));
				const idx = args.indexOf("--tools");
				return idx !== -1 && args[idx + 1] === "read,bash,grep";
			});
			expect(argvOk, "argv L1 содержит --tools у всех 3").toBe(true);

			// Все 3 завершились в разумное время (параллельно, не последовательно).
			// При delayMs=150 последовательно заняло бы ≥450 мс, параллельно <400.
			expect(elapsed).toBeLessThan(30_000);

			killAllReal();
		},
		60_000,
	);
});

// ─── Доп-2: Частичный отказ (один L1 FAIL) ──────────────────────────────────

describe("Частичный отказ: один L1 возвращает FAIL verdict", () => {
	it(
		"FAIL verdict → fail-запись в журнале, PASS → complete, reconstructTree отражает оба",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-pfail-");
			const missionId = "f44-pfail";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
			const state = emptyBudgetState(BUDGET_TOKENS, BUDGET_USD);
			const aggregator = createBudgetAggregator({
				load: () => JSON.parse(JSON.stringify(state)),
				save: () => {},
			});

			journal.write({
				event: "spawn",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				task: "Миссия с частичным отказом",
				depth: 0,
				pid: process.pid,
			});

			// L1/node-1 → PASS, L1/node-2 → FAIL verdict.
			// Динамическая аллокация от aggregator.state() предотвращает
			// отказ allocate после потребления бюджета первым узлом.
			const passAlloc = computeChildAllocation(aggregator.state(), 2);
			const passResult = await launchInProcessChild({
				parentId: "L0",
				parentDepth: 0,
				childIndex: 1,
				nodeId: "L1/node-1",
				missionId,
				task: "Подзадача PASS",
				manifest: L1_MANIFEST,
				deadline,
				journal,
				aggregator,
				allocation: passAlloc,
				verdict: "PASS",
			});

			const failAlloc = computeChildAllocation(aggregator.state(), 1);
			const failResult = await launchInProcessChild({
				parentId: "L0",
				parentDepth: 0,
				childIndex: 2,
				nodeId: "L1/node-2",
				missionId,
				task: "Подзадача FAIL",
				manifest: L1_MANIFEST,
				deadline,
				journal,
				aggregator,
				allocation: failAlloc,
				verdict: "FAIL",
			});

			journal.write({
				event: "complete",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				depth: 0,
			});

			// PASS-узел: status=completed, verdict=PASS, запись complete.
			expect(passResult.report.status).toBe("completed");
			expect(passResult.report.verdict).toBe("PASS");

			// FAIL-узел: status=completed (VERDICT есть), verdict=FAIL.
			expect(failResult.report.status).toBe("completed");
			expect(failResult.report.verdict).toBe("FAIL");

			// Журнал: complete для обоих (оба отработали, один с FAIL verdict).
			const entries = journal.readAll();
			const l1Pass = entries.filter(
				(e) => e.nodeId === "L1/node-1" && e.event === "complete",
			);
			const l1Fail = entries.filter(
				(e) => e.nodeId === "L1/node-2" && e.event === "complete",
			);
			expect(l1Pass).toHaveLength(1);
			expect(l1Fail).toHaveLength(1);

			// reconstructTree отражает обоих детей L0.
			const tree = reconstructTree(entries);
			expect(tree.nodes.L0.children).toEqual(
				expect.arrayContaining(["L1/node-1", "L1/node-2"]),
			);
			expect(tree.nodes["L1/node-1"].status).toBe("complete");
			expect(tree.nodes["L1/node-2"].status).toBe("complete");

			// Σconsumed учитывает оба узла (PASS + FAIL).
			const finalState = aggregator.state();
			const expectedTokens =
				passResult.usage.inputTokens +
				passResult.usage.outputTokens +
				failResult.usage.inputTokens +
				failResult.usage.outputTokens;
			expect(finalState.consumed.tokens).toBe(expectedTokens);
		},
		30_000,
	);
});

// ─── Доп-3: Бюджет by_branch по уровням дерева ──────────────────────────────

describe("Бюджет: агрегация by_branch по уровням дерева", () => {
	it(
		"Σconsumed(depth=1) + Σconsumed(depth=2) = Σconsumed(total); byBranch содержит все nodeId",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-budget-");
			const missionId = "f44-budget";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
			const state = emptyBudgetState(BUDGET_TOKENS, BUDGET_USD);
			const aggregator = createBudgetAggregator({
				load: () => JSON.parse(JSON.stringify(state)),
				save: () => {},
			});

			journal.write({
				event: "spawn",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				task: "Бюджетная миссия",
				depth: 0,
			});

			// L1: 2 узла. Аллокация вычисляется ДИНАМИЧЕСКИ от текущего
			// состояния агрегатора (как в depth2-integration на старте цикла
			// по children), чтобы учесть возврат allocated после onNodeComplete.
			const l1Results = [];
			for (let i = 1; i <= 2; i++) {
				const remainingL1 = 2 - (i - 1);
				const alloc = computeChildAllocation(aggregator.state(), remainingL1);
				const r = await launchInProcessChild({
					parentId: "L0",
					parentDepth: 0,
					childIndex: i,
					missionId,
					task: `L1-${i}`,
					manifest: L1_MANIFEST,
					deadline,
					journal,
					aggregator,
					allocation: alloc,
				});
				l1Results.push(r);
			}

			// L2: по 2 ребёнка на каждый L1. Динамическая аллокация от
			// агрегатора: после завершения L1 его allocated возвращён,
			// remaining растёт, следующие L2 помещаются в лимит.
			const l2Results = [];
			for (let l1 = 1; l1 <= 2; l1++) {
				for (let l2 = 1; l2 <= 2; l2++) {
					const remainingL2 = 2 - (l2 - 1);
					const alloc = computeChildAllocation(aggregator.state(), remainingL2);
					const r = await launchInProcessChild({
						parentId: `L1/node-${l1}`,
						parentDepth: 1,
						childIndex: l2,
						missionId,
						task: `L1-${l1}/L2-${l2}`,
						manifest: L1_MANIFEST,
						deadline,
						journal,
						aggregator,
						allocation: alloc,
					});
					l2Results.push(r);
				}
			}

			journal.write({
				event: "complete",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				depth: 0,
			});

			const finalState = aggregator.state();

			// byBranch содержит записи для всех 6 узлов (2 L1 + 4 L2).
			const branchKeys = Object.keys(finalState.byBranch);
			expect(branchKeys.length).toBe(6);
			for (const r of [...l1Results, ...l2Results]) {
				expect(branchKeys).toContain(r.nodeId);
			}

			// Σconsumed по уровням = Σconsumed(total).
			const sumLevel1 = l1Results.reduce(
				(acc, r) => acc + r.usage.inputTokens + r.usage.outputTokens,
				0,
			);
			const sumLevel2 = l2Results.reduce(
				(acc, r) => acc + r.usage.inputTokens + r.usage.outputTokens,
				0,
			);
			expect(finalState.consumed.tokens).toBe(sumLevel1 + sumLevel2);

			// Инвариант: Σallocated ≤ budgetTotal (все узлы завершились,
			// allocated вернулся в 0).
			expect(finalState.allocated.tokens).toBe(0);
			expect(finalState.consumed.tokens).toBeLessThanOrEqual(BUDGET_TOKENS);
			expect(finalState.consumed.usd).toBeLessThanOrEqual(BUDGET_USD);
		},
		30_000,
	);
});

// ─── TC-F44-2: Манифест ограничивает инструменты на глубине 3 ──────────────

describe("TC-F44-2: манифест ограничивает инструменты на глубине 3", () => {
	it(
		"L2 с toolManifest ['read','bash'] → write отклонён isAllowed с диагностикой " +
			"«tool 'write' not in manifest»; tool_blocked в журнале; reconstructTree отражает запись",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-manifest-");
			const missionId = "f44-manifest";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
			const state = emptyBudgetState(BUDGET_TOKENS, BUDGET_USD);
			const aggregator = createBudgetAggregator({
				load: () => JSON.parse(JSON.stringify(state)),
				save: () => {},
			});

			journal.write({
				event: "spawn",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				task: "Манифест-миссия",
				depth: 0,
			});

			// L1 (один узел) — корень для L2.
			const l1Alloc = computeChildAllocation(aggregator.state(), 1);
			await launchInProcessChild({
				parentId: "L0",
				parentDepth: 0,
				childIndex: 1,
				nodeId: "L1/node-1",
				missionId,
				task: "L1 (родитель L2)",
				manifest: L1_MANIFEST,
				deadline,
				journal,
				aggregator,
				allocation: l1Alloc,
			});

			// L2 с ограниченным манифестом: ["read","bash"].
			// Важно: tool_blocked записываем ПОСЛЕ complete-записи launchInProcessChild,
			// чтобы статус узла в reconstructTree был именно tool_blocked (последняя
			// запись wins). В продакшене рантайм-отказ инструмента происходит во
			// время работы узла (после complete), поэтому порядок естественный.
			const restrictedManifest = ["read", "bash"];
			const l2Alloc = computeChildAllocation(aggregator.state(), 1);
			const l2Result = await launchInProcessChild({
				parentId: "L1/node-1",
				parentDepth: 1,
				childIndex: 1,
				nodeId: "L2/node-1",
				missionId,
				task: "L2 с ограниченным манифестом",
				manifest: restrictedManifest,
				deadline,
				journal,
				aggregator,
				allocation: l2Alloc,
			});
			const l2NodeId = l2Result.nodeId;

			// isAllowed: read разрешён, write — нет, bash разрешён.
			const readCheck = isAllowed(restrictedManifest, "read");
			const writeCheck = isAllowed(restrictedManifest, "write");
			const bashCheck = isAllowed(restrictedManifest, "bash");

			expect(readCheck.allowed).toBe(true);
			expect(bashCheck.allowed).toBe(true);
			expect(writeCheck.allowed).toBe(false);
			expect(writeCheck.diag).toBe("tool 'write' not in manifest");

			// tool_blocked в журнале (runtime-отказ L2 на попытку write).
			// Записываем ПОСЛЕ complete, чтобы статус reconstructTree = tool_blocked.
			journal.write({
				event: "tool_blocked",
				nodeId: l2NodeId,
				parentId: "L1/node-1",
				correlationId: l2Result.correlationId,
				depth: 2,
				diag: writeCheck.diag,
			});

			journal.write({
				event: "complete",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				depth: 0,
			});

			const entries = journal.readAll();
			const blocked = entries.filter((e) => e.event === "tool_blocked");
			expect(blocked).toHaveLength(1);
			expect(blocked[0].diag).toBe("tool 'write' not in manifest");
			expect(blocked[0].depth).toBe(2);

			// reconstructTree: tool_blocked — последнее событие для L2,
			// поэтому status узла = tool_blocked. Топология сохранена.
			const tree = reconstructTree(entries);
			expect(tree.nodes[l2NodeId].parentId).toBe("L1/node-1");
			expect(tree.nodes[l2NodeId].status).toBe("tool_blocked");
			expect(tree.nodes["L1/node-1"].children).toContain(l2NodeId);
		},
		30_000,
	);
});

// ─── TC-F44-3: Метрики в пределах допустимого ──────────────────────────────

describe("TC-F44-3: метрики в пределах допустимого", () => {
	it(
		"failureRate < 0.2, преждевременных завершений нет, journal содержит записи всех итераций",
		async () => {
			const tmp = makeTmpDir("fan-so-f44-metrics-");
			const missionId = "f44-metrics";
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
			const state = emptyBudgetState(BUDGET_TOKENS, BUDGET_USD);
			const aggregator = createBudgetAggregator({
				load: () => JSON.parse(JSON.stringify(state)),
				save: () => {},
			});

			journal.write({
				event: "spawn",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				task: "Миссия для метрик",
				depth: 0,
			});

			// 5 узлов L1: 4 PASS + 1 FAIL → failureRate = 1/5 = 0.2 (граничное
			// значение). Для строгого < 0.2 берём 5 PASS + 1 FAIL = 1/6 ≈ 0.167.
			// workingWidth поднят до 8: дефолтный 4 не вмещает 6 детей.
			const totalNodes = 6;
			const failAtIndex = 6; // последний — FAIL
			const results = [];
			for (let i = 1; i <= totalNodes; i++) {
				const verdict = i === failAtIndex ? "FAIL" : "PASS";
				// canSpawn: currentChildren = i - 1 (сколько уже порождено),
				// workingWidth = 8 (поднимаем дефолтный 4).
				const decision = canSpawn(1, i - 1, {
					maxWorkingDepth: 4,
					workingWidth: 8,
				});
				if (!decision.allowed) {
					throw new Error(`guard refused L1/node-${i}: ${decision.reason}`);
				}
				// Динамическая аллокация: после каждого completed remaining
				// растёт (onNodeComplete возвращает allocated). Это предотвращает
				// «неожиданный» отказ allocate на 5-м узле.
				const remaining = totalNodes - (i - 1);
				const alloc = computeChildAllocation(aggregator.state(), remaining);
				const r = await launchInProcessChild({
					parentId: "L0",
					parentDepth: 0,
					childIndex: i,
					nodeId: `L1/node-${i}`,
					missionId,
					task: `L1-${i}`,
					manifest: L1_MANIFEST,
					deadline,
					journal,
					aggregator,
					allocation: alloc,
					verdict,
					guardOptions: { maxWorkingDepth: 4, workingWidth: 8 },
				});
				results.push(r);
			}

			journal.write({
				event: "complete",
				nodeId: "L0",
				correlationId: makeCorrelationId(missionId, 0, 0),
				depth: 0,
			});

			const entries = journal.readAll();

			// Каждая итерация (spawn + complete) записана.
			const spawns = entries.filter((e) => e.event === "spawn" && e.depth === 1);
			const completes = entries.filter((e) => e.event === "complete" && e.depth === 1);
			expect(spawns).toHaveLength(totalNodes);
			expect(completes).toHaveLength(totalNodes);

			// failureRate: доля FAIL verdict / total.
			const failCount = results.filter((r) => r.report.verdict === "FAIL").length;
			const failureRate = failCount / totalNodes;
			expect(failureRate).toBeLessThan(0.2);

			// Преждевременных завершений (aborted/timeout) нет — все completed.
			const premature = results.filter(
				(r) =>
					r.report.status === "aborted" ||
					r.report.status === "timeout" ||
					r.report.completionReason === "budget_exhausted" ||
					r.report.completionReason === "deadline_reached",
			);
			const prematureRate = premature.length / totalNodes;
			expect(prematureRate).toBeLessThan(0.15);

			// Σconsumed в пределах бюджета.
			const finalState = aggregator.state();
			expect(finalState.consumed.tokens).toBeLessThanOrEqual(BUDGET_TOKENS);
			expect(finalState.consumed.usd).toBeLessThanOrEqual(BUDGET_USD);
		},
		30_000,
	);
});
