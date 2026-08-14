// PHASE-GATE C (этап 2, финал): сквозной e2e — все критерии приёмки.
//
// Standalone-скрипт (НЕ vitest):
//   cd extensions/fan-super-orchestrator && node test/phase-gate-c.e2e.mjs
//
// Критерии приёмки этапа 2 (один сквозной прогон):
//   ☑ Дерево глубины 2: L0 → 3×L1 на реальных дочерних процессах
//   ☑ Бюджет: Σallocated ≤ budget_total, consumed = Σ usage, by_branch ×3
//   ☑ Kill-switch: всё дерево мертво <10 сек, порты свободны
//   ☑ Startup-reconciliation: orphaned cleaned_dead при старте
//   ☑ by_branch атрибуция расхода
//   ☑ Инвариант Σallocated ≤ budget_total в финале
//   ☑ toolManifest через --tools в argv spawn
//   ☑ Tree-journal: ≥6 записей, reconstructTree, сквозной correlationId
//
// Архитектура:
//   mock-node-main.mjs — standalone spawnable скрипт (in-process mock-node-server);
//   depth2-integration.ts — DI: spawnNode (child_process.spawn), sendPackage
//   (childNodeClient + реальный ws), killNode (SIGTERM → SIGKILL).
//   esbuild бандлит TS-модули расширения во временный каталог.

import { build } from "esbuild";
import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(SCRIPT_DIR, "..");
const MOCK_NODE_MAIN = join(SCRIPT_DIR, "helpers", "mock-node-main.mjs");

const BUDGET_TOKENS = 100_000;
const BUDGET_USD = 10;
const MOCK_TOKENS = 1500; // 1200 in + 300 out per node
const MOCK_USD = 0.05;
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 30_000;
const KILL_BUDGET_MS = 10_000;

// ─── хелперы вывода ─────────────────────────────────────────────────────────

const results = [];

function record(step, ok, detail) {
	results.push({ step, ok, detail });
	console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
	return ok;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
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

/** WsLike-фабрика поверх ws-пакета (как в phase-gate-b). */
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

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── основной сценарий ──────────────────────────────────────────────────────

async function main() {
	const t0 = Date.now();
	console.log("PHASE-GATE C e2e: MVP глубины 2 — все критерии приёмки этапа 2");
	console.log(`ext dir   : ${EXT_DIR}`);

	// 1. Временный каталог: mission-budget.json + tree-journal.jsonl + portsFile + pids
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-gate-c-"));
	console.log(`tmp dir   : ${tmp}`);

	// 2. esbuild: бандлим TS-модули расширения
	const buildDir = join(tmp, "build");
	await build({
		entryPoints: [
			join(EXT_DIR, "node-auth.ts"),
			join(EXT_DIR, "work-package.ts"),
			join(EXT_DIR, "node-report.ts"),
			join(EXT_DIR, "child-node-client.ts"),
			join(EXT_DIR, "budget-aggregator.ts"),
			join(EXT_DIR, "budget-coordinator.ts"),
			join(EXT_DIR, "tree-journal.ts"),
			join(EXT_DIR, "depth-width-guard.ts"),
			join(EXT_DIR, "depth2-integration.ts"),
			join(EXT_DIR, "port-pool.ts"),
			join(EXT_DIR, "startup-reconciliation.ts"),
		],
		outdir: buildDir,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n', "utf8");
	const load = (name) => import(pathToFileURL(join(buildDir, `${name}.js`)));

	const { generateNodeToken } = await load("node-auth");
	const { readMissionBudgetFile } = await load("budget-coordinator");
	const { createTreeJournal, reconstructTree } = await load("tree-journal");
	const { createChildNodeClient } = await load("child-node-client");
	const { totalUsage } = await load("node-report");
		const { createDepth2Integration } = await load("depth2-integration");

	const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
	console.log(`\nНачало: ${(Date.now() - t0) / 1000}s\n`);

	/**
	 * Robust spawnNode: resolves on READY stdout OR health 200 (whichever first).
	 * On Windows, detached child stdio can be unreliable, so health check is
	 * the primary readiness signal; READY is a bonus.
	 */
	function makeSpawnNode(pidsArray, mockDelayMs) {
		return async ({ id, port, token, args }) => {
			const child = cpSpawn(process.execPath, [MOCK_NODE_MAIN, "--port", String(port), ...args], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, FAN_NODE_TOKEN: token, MOCK_DELAY_MS: String(mockDelayMs) },
				cwd: EXT_DIR,
			});
			tokensByNode[id] = token;
			pidsArray.push({ id, pid: child.pid, port });

			return new Promise((resolveSpawn, rejectSpawn) => {
				let settled = false;
				const done = (fn, val) => {
					if (settled) return;
					settled = true;
					fn(val);
				};

				// Health-check poller: if server responds 200, node is ready
				// regardless of stdout buffering.
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
				}, 200);

				// Stdout: READY line (bonus, may arrive before health check).
				child.stdout.on("data", (data) => {
					if (data.toString().includes("READY")) {
						clearInterval(healthInterval);
						done(resolveSpawn, { pid: child.pid });
					}
				});

				// If process dies before we resolve, give health check a grace
				// period then reject.
				child.on("close", (code, signal) => {
					if (settled) return;
					clearInterval(healthInterval);
					// Short grace: health check may still resolve in-flight fetch.
					setTimeout(() => {
						done(rejectSpawn, new Error(
							`mock-node (port ${port}) closed: code=${code} signal=${signal}`,
						));
					}, 500);
				});
				child.on("error", (err) => {
					clearInterval(healthInterval);
					done(rejectSpawn, err);
				});
			});
		};
	}

	function makeKillNode(pidsArray) {
		return async (id) => {
			const entry = pidsArray.find((p) => p.id === id);
			if (!entry) return;
			try {
				process.kill(entry.pid, "SIGTERM");
			} catch {
				return;
			}
			for (let i = 0; i < 30; i++) {
				await sleep(100);
				try {
					process.kill(entry.pid, 0);
				} catch {
					return;
				}
			}
			try {
				process.kill(entry.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		};
	}

	// ═══════════════════════════════════════════════════════════════════════
	// ПРЕДУСЛОВИЕ: Reconciliation (orphaned cleaned_dead)
	// ═══════════════════════════════════════════════════════════════════════
	console.log("── Предусловие: reconciliation ──");

	const portsFile = join(tmp, "child-ports.json");
	const pidDir = join(tmp, "pids");
	mkdirSync(pidDir, { recursive: true });

	const deadPid = 99999999;
	record(
		"dead PID 99999999 не жив",
		!isAlive(deadPid),
		`probe signal 0: ${isAlive(deadPid) ? "жив?!" : "мёртв"}`,
	);
	writeFileSync(portsFile, JSON.stringify({ "L1/orphan-test": 9999 }, null, 2), "utf8");
	writeFileSync(join(pidDir, "child-L1-orphan-test.pid"), String(deadPid), "utf8");

	// ═══════════════════════════════════════════════════════════════════════
	// СЦЕНАРИЙ 1: Happy Path — дерево глубины 2 (L0 → 3×L1)
	// ═══════════════════════════════════════════════════════════════════════
	console.log("\n── Сценарий 1: Happy Path (3 узла, toolManifest) ──");

	const client1 = createChildNodeClient({ wsFactory });
	const pids1 = [];
	const tokensByNode = {};

	const depth2 = createDepth2Integration({
		missionDir: tmp,
		missionId: "gate-c",
		budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
		spawnNode: makeSpawnNode(pids1, 500),
		sendPackage: async ({ port, token, workPackage }) => {
			return client1.sendWorkPackage({ port, token, workPackage });
		},
		killNode: makeKillNode(pids1),
	});

	// ── run: 3 children, toolManifest ──
	const runPromise = depth2.run({
		task: "Эпик: рефакторинг auth middleware",
		children: 3,
		toolManifest: ["read", "write", "edit", "bash"],
		deadline: new Date(Date.now() + 90_000).toISOString(),
	});

	// ── health poll: все 3 узла ──
	const healthStart = Date.now();
	let allHealthy = false;
	while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
		const checks = await Promise.all(
			pids1.map((p) => getStatus(`http://127.0.0.1:${p.port}/api/health`)),
		);
		if (pids1.length === 3 && checks.every((s) => s === 200)) {
			allHealthy = true;
			break;
		}
		await sleep(HEALTH_POLL_MS);
	}
	const healthMs = Date.now() - healthStart;
	record(
		"3 узла подняты, health 200 каждый",
		allHealthy,
		allHealthy
			? `${(healthMs / 1000).toFixed(1)}с`
			: `порты: ${pids1.map((p) => p.port).join(",")}`,
	);

	// ── argv verification (--tools) ──
	await sleep(300); // small delay for argv files to be written
	const argvVerified = pids1.every((p) => {
		const argvFile = join(EXT_DIR, `argv-${p.port}.txt`);
		if (!existsSync(argvFile)) return false;
		const args = JSON.parse(readFileSync(argvFile, "utf8"));
		const toolsIdx = args.indexOf("--tools");
		return toolsIdx !== -1 && args[toolsIdx + 1] === "read,write,edit,bash";
	});
	record("argv spawn содержит --tools read,write,edit,bash", argvVerified);

	// ── дождаться завершения run() ──
	const result = await runPromise;

	// ── reports ──
	record(
		"run() вернул 3 отчёта",
		result.reports.length === 3,
		`reports=${result.reports.length}`,
	);
	const allCompleted =
		result.reports.length === 3 && result.reports.every((r) => r.report.status === "completed");
	const allPass =
		result.reports.length === 3 && result.reports.every((r) => r.report.verdict === "PASS");
	const allUsage =
		result.reports.length === 3 &&
		result.reports.every((r) => {
			const u = totalUsage(r.report);
			return u.inputTokens + u.outputTokens > 0;
		});
	record("status completed у всех", allCompleted);
	record("verdict PASS у всех", allPass);
	record("usage > 0 у всех", allUsage);

	// ── budget: mission-budget.json ──
	const budgetFile = readMissionBudgetFile(join(tmp, "mission-budget.json"));
	const mission = budgetFile?.missions?.["gate-c"];
	record(
		"mission-budget.json: миссия gate-c существует",
		mission !== undefined,
		mission ? `consumed=${JSON.stringify(mission.consumed)}` : "нет миссии",
	);

	const sigmaAlloc = (mission?.allocated?.tokens ?? -1) <= BUDGET_TOKENS;
	record("Σallocated ≤ 100000 в финале", sigmaAlloc, `allocated=${JSON.stringify(mission?.allocated)}`);

	const expectedConsumed = result.reports.reduce(
		(acc, r) => {
			const u = totalUsage(r.report);
			return {
				tokens: acc.tokens + u.inputTokens + u.outputTokens,
				usd: acc.usd + u.costUsd,
			};
		},
		{ tokens: 0, usd: 0 },
	);
	const consumedMatch =
		mission?.consumed?.tokens === expectedConsumed.tokens &&
		Math.abs((mission?.consumed?.usd ?? 0) - expectedConsumed.usd) < 0.001;
	record(
		"consumed = Σ usage",
		consumedMatch,
		`expected=${JSON.stringify(expectedConsumed)} actual=${JSON.stringify(mission?.consumed)}`,
	);

	const branchKeys = Object.keys(mission?.byBranch ?? {});
	record(
		"by_branch: 3 записи",
		branchKeys.length === 3,
		`keys=[${branchKeys.join(", ")}]`,
	);

	// ── tree-journal ──
	const entries = journal.readAll();
	record(
		"tree-journal ≥6 записей (3 spawn + 3 complete)",
		entries.length >= 6,
		`${entries.length} записей: ${entries.map((e) => e.event).join(", ")}`,
	);

	// reconcile для dead PID пишет cleaned_dead (без journal-записи orphan_cleanup,
	// которая только для live orphans). Доказательство: PID-файл удалён
	// (reconcile удаляет его для cleaned_dead), а run() PID-файлы не создаёт.
	const orphanPidFile = join(pidDir, "child-L1-orphan-test.pid");
	const orphanCleaned = !existsSync(orphanPidFile);
	record(
		"reconciliation: PID-файл orphan очищен",
		orphanCleaned,
		`pidFile exists=${existsSync(orphanPidFile)}`,
	);

	const tree = reconstructTree(entries);
	const l0Node = tree.nodes["L0"];
	record(
		"reconstructTree: L0 имеет 3 ребёнка",
		l0Node?.children?.length === 3,
		`children=[${l0Node?.children?.join(", ")}]`,
	);

	const spawnEntries = entries.filter((e) => e.event === "spawn");
	const corrIds = spawnEntries.map((e) => e.correlationId).filter(Boolean);
	const allCorrelated = corrIds.length === 3 && corrIds.every((id) => id.startsWith("gate-c/"));
	record(
		"correlationId сквозной (gate-c/L1/node-N)",
		allCorrelated,
		`ids=[${corrIds.join(", ")}]`,
	);

	// ── duration ──
	record(
		"durationMs < 60с",
		result.durationMs < 60_000,
		`${(result.durationMs / 1000).toFixed(1)}с`,
	);

	// cleanup argv files
	for (const p of pids1) {
		try {
			const f = join(EXT_DIR, `argv-${p.port}.txt`);
			if (existsSync(f)) rmSync(f);
		} catch {
			/* ignore */
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// СЦЕНАРИЙ 2: Kill-Switch — abort всего дерева <10 сек
	// ═══════════════════════════════════════════════════════════════════════
	console.log("\n── Сценарий 2: Kill-Switch ──");

	// Пауза: дать ОС освободить порты и TIME_WAIT после первой сцены.
	console.log("  пауза 2с (освобождение портов)...");
	await sleep(2000);

	// Убедиться, что все процессы первой сцены мертвы.
	for (const p of pids1) {
		if (isAlive(p.pid)) {
			try {
				process.kill(p.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
			await sleep(200);
		}
	}

	const ksPids = [];
	const client2 = createChildNodeClient({ wsFactory });

	const depth2KS = createDepth2Integration({
		missionDir: tmp,
		missionId: "gate-c-ks",
		budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
		spawnNode: makeSpawnNode(ksPids, 15000),
		sendPackage: async ({ port, token, workPackage }) => {
			return client2.sendWorkPackage({ port, token, workPackage });
		},
		killNode: makeKillNode(ksPids),
	});

	// Запуск БЕЗ ожидания (mock delay 15с — отчёты не придут быстро)
	const ksRunPromise = depth2KS
		.run({
			task: "Kill-switch тест",
			children: 3,
			deadline: new Date(Date.now() + 120_000).toISOString(),
		})
		.catch((err) => {
			console.log(`  (run завершился с ошибкой: ${err.message})`);
			return null;
		});

	// Ждём подъёма всех 3 узлов (health 200)
	const ksHealthStart = Date.now();
	let ksAllHealthy = false;
	while (Date.now() - ksHealthStart < HEALTH_TIMEOUT_MS) {
		const checks = await Promise.all(
			ksPids.map((p) => getStatus(`http://127.0.0.1:${p.port}/api/health`)),
		);
		if (ksPids.length === 3 && checks.every((s) => s === 200)) {
			ksAllHealthy = true;
			break;
		}
		await sleep(HEALTH_POLL_MS);
	}
	record(
		"kill-switch: 3 узла подняты",
		ksAllHealthy,
		`порты: ${ksPids.map((p) => p.port).join(", ")}`,
	);

	if (ksAllHealthy) {
		// Небольшая пауза — убедиться что sendPackage in-flight
		await sleep(500);

		// ABORT!
		const abortStart = Date.now();
		await depth2KS.abort();
		const abortMs = Date.now() - abortStart;
		console.log(`  abort() вернулся за ${abortMs} мс`);

		// Ждём смерти всех процессов (max KILL_BUDGET_MS + буфер)
		const maxKillWait = KILL_BUDGET_MS + 5_000;
		const killPollStart = Date.now();
		let allDead = false;
		let killTimeMs = 0;

		while (Date.now() - killPollStart < maxKillWait) {
			const alive = ksPids.filter((p) => isAlive(p.pid));
			if (alive.length === 0) {
				allDead = true;
				killTimeMs = Date.now() - abortStart;
				break;
			}
			await sleep(200);
		}
		if (!allDead) {
			killTimeMs = Date.now() - abortStart;
		}

		record(
			"kill-switch: все процессы мертвы <10 сек",
			allDead && killTimeMs < KILL_BUDGET_MS,
			`${(killTimeMs / 1000).toFixed(1)}с (лимит ${KILL_BUDGET_MS / 1000}с)${allDead ? "" : " — некоторые живы!"}`,
		);

		// Порты свободны
		const portsAfter = existsSync(portsFile) ? JSON.parse(readFileSync(portsFile, "utf8")) : {};
		const portsFreed = Object.keys(portsAfter).length === 0;
		record("kill-switch: порты свободны", portsFreed, JSON.stringify(portsAfter));

		// Abort-записи в журнале
		const ksEntries = journal.readAll();
		const abortEntries = ksEntries.filter((e) => e.event === "abort");
		record(
			"kill-switch: abort-записи в журнале",
			abortEntries.length > 0,
			`${abortEntries.length} abort-записей`,
		);
	} else {
		record("kill-switch: все процессы мертвы <10 сек", false, "узлы не поднялись");
		record("kill-switch: порты свободны", false, "пропущено");
		record("kill-switch: abort-записи в журнале", false, "пропущено");
		// Убить оставшиеся процессы вручную
		for (const p of ksPids) {
			try {
				process.kill(p.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
	}

	// Дождаться завершения kill-switch run (с таймаутом)
	const ksTimeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("ks run timeout")), 30_000),
	);
	try {
		await Promise.race([ksRunPromise, ksTimeout]);
	} catch {
		console.log("  (kill-switch run не завершился за 30с — принудительно)");
	}

	// cleanup argv files for kill-switch
	for (const p of ksPids) {
		try {
			const f = join(EXT_DIR, `argv-${p.port}.txt`);
			if (existsSync(f)) rmSync(f);
		} catch {
			/* ignore */
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════════
	client1.close();
	client2.close();
	// Убить все оставшиеся процессы (страховка)
	for (const p of [...pids1, ...ksPids]) {
		try {
			process.kill(p.pid, "SIGKILL");
		} catch {
			/* already dead */
		}
	}
	rmSync(tmp, { recursive: true, force: true });

	// ═══════════════════════════════════════════════════════════════════════
	// ИТОГОВАЯ ТАБЛИЦА
	// ═══════════════════════════════════════════════════════════════════════
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(`\n┌──────────────────────────────────────────────────────────────────┬────────┐`);
	for (const r of results) {
		console.log(`│ ${r.step.padEnd(64)} │ ${r.ok ? "PASS  " : "FAIL  "} │`);
	}
	console.log(`└──────────────────────────────────────────────────────────────────┴────────┘`);

	const failed = results.filter((r) => !r.ok).length;
	const total = results.length;
	console.log(
		`\nИТОГ: ${total - failed}/${total} зелёные за ${elapsed}с${failed ? ` — ${failed} провал(а)` : ""}`,
	);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("\nFATAL:", err);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`ИТОГ: ${results.length - failed}/${results.length} зелёные (аварийное завершение)`);
	process.exit(1);
});
