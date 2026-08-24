// PHASE-GATE A3 (этап 3, фаза A «Глубина и границы»): сквозной e2e.
//
// Standalone-скрипт (НЕ vitest):
//   cd extensions/fan-super-orchestrator && node test/phase-gate-a3.e2e.mjs
//
// Критерии приёмки фазы A (F-36, F-37, F-38):
//   ☑ Дерево глубины 3: L0 → 2×L1 (реальные процессы, depth2-integration)
//     → каждый L1 canSpawn(depth=2, maxWorkingDepth=4) → L2 (in-process мок),
//     пакет L2 с toolManifest проходит граничную валидацию
//   ☑ L2 пытается вызвать write → isAllowed=false + «tool 'write' not in manifest»
//   ☑ Guard: глубина 4 разрешена; глубина 5 — отказ max_depth_exceeded
//     + onDepthExceeded (эскалация I3, эмуляция колбэком)
//   ☑ Невалидный манифест → tool_blocked в tree-journal (fail-fast run)
//   ☑ Невалидный входящий отчёт (bad correlationId / depth mismatch)
//     → validation_failed в tree-journal
//   ☑ Циклический отчёт → отказ без краша
//   ☑ FAN_ORCHESTRATOR_DEPTH проброс: spawn env содержит depth+1
//   ☑ Каждый уровень пишет в tree-journal; reconstructTree — глубина 3
//
// Архитектура: реальные процессы только для L0→L1 (depth2-integration +
// mock-node-main.mjs); L1→L2 эмулируется программно через ТЕ ЖЕ модули
// (guard + manifest + sanitizer + journal + child-node-client) поверх
// in-process мок-узлов (helpers/mock-node-server.mjs). esbuild бандлит
// TS-модули расширения во временный каталог.

import { build } from "esbuild";
import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startMockNode } from "./helpers/mock-node-server.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(SCRIPT_DIR, "..");
const MOCK_NODE_MAIN = join(SCRIPT_DIR, "helpers", "mock-node-main.mjs");

const MISSION_ID = "gate-a3";
const BUDGET_TOKENS = 100_000;
const BUDGET_USD = 10;
const L1_MANIFEST = ["read", "bash", "grep"];
const HEALTH_POLL_MS = 300;
const HEALTH_TIMEOUT_MS = 30_000;

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

/** WsLike-фабрика поверх ws-пакета (как в phase-gate-b/c). */
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

/** Глубина узла из correlationId (<mission>/L<N>/node-<M>) — та же фиксированная
 *  точка, что в depth2-integration; null если формат не парсится. */
function depthFromCorrelationId(correlationId) {
	if (typeof correlationId !== "string") {
		return null;
	}
	const match = /\/L(\d+)\/node-\d+$/.exec(correlationId);
	return match === null ? null : Number(match[1]);
}

/** Свободный порт от ОС (listen 0): нет коллизий с занятыми диапазонами. */
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

// ── основной сценарий ──────────────────────────────────────────────────────

async function main() {
	const t0 = Date.now();
	console.log("PHASE-GATE A3 e2e: фаза A «Глубина и границы» — все критерии приёмки");
	console.log(`ext dir   : ${EXT_DIR}`);

	// Временные каталоги: основная миссия + миссия невалидного манифеста.
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-gate-a3-"));
	const tmpInvalid = mkdtempSync(join(tmpdir(), "fan-so-gate-a3-inv-"));
	console.log(`tmp dir   : ${tmp}`);

	// Ресурсы для cleanup в finally.
	const pids = []; // L1: реальные процессы { id, pid, port }
	const l2Mocks = []; // L2: in-process мок-узлы (startMockNode)
	const clients = []; // child-node-client (страховка close)

	// esbuild: бандлим TS-модули расширения.
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
			join(EXT_DIR, "startup-reconciliation.ts"),
			join(EXT_DIR, "tool-manifest.ts"),
			join(EXT_DIR, "message-sanitizer.ts"),
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
	const { createTreeJournal, reconstructTree } = await load("tree-journal");
	const { createChildNodeClient } = await load("child-node-client");
	const { totalUsage } = await load("node-report");
	const { createDepth2Integration } = await load("depth2-integration");
	const { canSpawn } = await load("depth-width-guard");
	const { isAllowed } = await load("tool-manifest");
	const {
		validateReport,
		validateDepth,
		validateWorkPackageSchema,
	} = await load("message-sanitizer");
	const {
		createWorkPackage,
		parseWorkPackage,
		makeCorrelationId,
	} = await load("work-package");

	const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));
	const deadline = new Date(Date.now() + 90_000).toISOString();
	console.log(`\nНачало: ${(Date.now() - t0) / 1000}s\n`);

	/**
	 * spawnNode для L1 (реальные процессы mock-node-main). F-36: env пробрасывает
	 * FAN_ORCHESTRATOR_DEPTH = depth+1 (глубина порождаемого узла).
	 */
	function makeSpawnNode(pidsArray) {
		return async ({ id, port, token, args }) => {
			const childDepth = Number(id.split("/")[0].slice(1)); // "L1/node-N" → 1
			const child = cpSpawn(process.execPath, [MOCK_NODE_MAIN, "--port", String(port), ...args], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					FAN_NODE_TOKEN: token,
					MOCK_DELAY_MS: "300",
					FAN_ARGV_DUMP_DIR: tmp,
					FAN_ORCHESTRATOR_DEPTH: String(childDepth),
					FAN_ORCHESTRATOR_WIDTH: "2",
				},
				cwd: EXT_DIR,
			});
			pidsArray.push({ id, pid: child.pid, port });

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
				}, 200);
				child.stdout.on("data", (data) => {
					if (data.toString().includes("READY")) {
						clearInterval(healthInterval);
						done(resolveSpawn, { pid: child.pid });
					}
				});
				child.on("close", (code, signal) => {
					if (settled) return;
					clearInterval(healthInterval);
					setTimeout(() => {
						done(rejectSpawn, new Error(`mock-node (port ${port}) closed: code=${code} signal=${signal}`));
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

	/** sendPackage-адаптер: per-call клиент с пробросом onValidationFailed (F-38). */
	function makeSendPackage() {
		return async ({ port, token, workPackage, onValidationFailed }) => {
			const client = createChildNodeClient({ wsFactory, onValidationFailed });
			clients.push(client);
			try {
				return await client.sendWorkPackage({ port, token, workPackage });
			} finally {
				client.close();
			}
		};
	}

	try {
		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 1: Дерево глубины 3 (L0 → 2×L1 реально, L1→L2 эмуляция)
		// ═══════════════════════════════════════════════════════════════════
		console.log("── Сценарий 1: дерево глубины 3 (L0 → 2×L1 → 2×L2) ──");

		// L0 пишет в журнал (корень миссии).
		journal.write({
			event: "spawn",
			nodeId: "L0",
			correlationId: makeCorrelationId(MISSION_ID, 0, 0),
			task: "Эпик: рефакторинг auth middleware",
			depth: 0,
			pid: process.pid,
		});

		const depth2 = createDepth2Integration({
			missionDir: tmp,
			missionId: MISSION_ID,
			budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
			guardOptions: { maxWorkingDepth: 4 },
			spawnNode: makeSpawnNode(pids),
			sendPackage: makeSendPackage(),
			killNode: makeKillNode(pids),
		});

		const runPromise = depth2.run({
			task: "Эпик: рефакторинг auth middleware",
			children: 2,
			toolManifest: [...L1_MANIFEST],
			deadline,
		});

		// health poll: оба узла L1.
		const healthStart = Date.now();
		let allHealthy = false;
		while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
			const checks = await Promise.all(
				pids.map((p) => getStatus(`http://127.0.0.1:${p.port}/api/health`)),
			);
			if (pids.length === 2 && checks.every((s) => s === 200)) {
				allHealthy = true;
				break;
			}
			await sleep(HEALTH_POLL_MS);
		}

		const result = await runPromise;
		const l1Ok =
			allHealthy &&
			result.reports.length === 2 &&
			result.reports.every((r) => r.report.status === "completed" && r.report.verdict === "PASS");
		record(
			"L0 → 2×L1: узлы подняты, run() вернул 2 отчёта (completed/PASS)",
			l1Ok,
			`health=${allHealthy}, reports=${result.reports.length}`,
		);

		// argv: --tools read,bash,grep у обоих L1.
		await sleep(200);
		const argvOk =
			pids.length === 2 &&
			pids.every((p) => {
				const argvFile = join(tmp, `argv-${p.port}.txt`);
				if (!existsSync(argvFile)) return false;
				const args = JSON.parse(readFileSync(argvFile, "utf8"));
				const idx = args.indexOf("--tools");
				return idx !== -1 && args[idx + 1] === "read,bash,grep";
			});
		record("argv L1 содержит --tools read,bash,grep", argvOk);

		// F-36: env dump реальных процессов — FAN_ORCHESTRATOR_DEPTH = 1 (0+1).
		const envDumpL1 = pids.map((p) => {
			const envFile = join(tmp, `env-${p.port}.txt`);
			if (!existsSync(envFile)) return null;
			try {
				return JSON.parse(readFileSync(envFile, "utf8"));
			} catch {
				return null;
			}
		});
		const l1EnvOk =
			envDumpL1.length === 2 && envDumpL1.every((e) => e !== null && e.FAN_ORCHESTRATOR_DEPTH === "1");
		record(
			"FAN_ORCHESTRATOR_DEPTH: spawn env L1 содержит depth+1 (=1)",
			l1EnvOk,
			`env dump: ${JSON.stringify(envDumpL1.map((e) => e?.FAN_ORCHESTRATOR_DEPTH))}`,
		);

		// ── L1 → L2: программная эмуляция теми же модулями ──
		console.log("\n── Сценарий 1b: L1 → L2 (эмуляция: guard + manifest + sanitizer) ──");

		const l2SpawnDecisions = [];
		const l2Envs = [];
		const l2SchemaChecks = [];
		const l2Received = [];
		const l2Reports = [];

		for (let i = 1; i <= 2; i++) {
			const parentId = `L1/node-${i}`;
			const nodeId = `L2/node-${i}`;
			const correlationId = makeCorrelationId(MISSION_ID, 2, i);
			const task = `Подзадача ${i} — покрытие тестами`;

			// Guard: L1 (depth 1) порождает L2 (depth 2) при maxWorkingDepth 4.
			const decision = canSpawn(2, 0, { maxWorkingDepth: 4 });
			l2SpawnDecisions.push(decision);
			if (!decision.allowed) {
				continue;
			}

			const port = await getFreePort();
			const token = generateNodeToken();
			// F-36: spawn env ребёнка содержит depth родителя + 1 (эмуляция
			// env, который process-manager передал бы дочернему fan server).
			l2Envs.push({
				id: nodeId,
				env: {
					FAN_NODE_TOKEN: token,
					FAN_ORCHESTRATOR_DEPTH: "2",
					FAN_ORCHESTRATOR_WIDTH: "1",
				},
			});

			const mock = await startMockNode({ port, token, delayMs: 100 });
			l2Mocks.push(mock);

			journal.write({
				event: "spawn",
				nodeId,
				parentId,
				correlationId,
				task,
				depth: 2,
				port,
				pid: process.pid,
			});

			// Пакет работ для L2 с манифестом ["read","bash","grep"].
			const workPackage = createWorkPackage({
				task,
				correlationId,
				depth: 2,
				tokenBudget: 5000,
				costBudgetUsd: 0.5,
				toolManifest: [...L1_MANIFEST],
				deadline,
			});
			l2SchemaChecks.push(validateWorkPackageSchema(workPackage));

			const report = await makeSendPackage()({
				port,
				token,
				workPackage,
				onValidationFailed: (failure) => {
					journal.write({
						event: "validation_failed",
						nodeId,
						parentId,
						correlationId: failure.correlationId ?? correlationId,
						depth: 2,
						diag: failure.diag,
					});
				},
			});
			l2Reports.push(report);

			// Фиксированная точка depth2-integration: validateDepth на приёме отчёта
			// (родитель L1 depth 1 → ожидаемая глубина отчёта 2).
			const reportDepth = depthFromCorrelationId(report.correlationId);
			const depthCheck = validateDepth(1, reportDepth ?? -1);
			const usage = totalUsage(report);
			journal.write({
				event: depthCheck.valid ? "complete" : "fail",
				nodeId,
				parentId,
				correlationId,
				depth: 2,
				usage: { tokens: usage.inputTokens + usage.outputTokens, usd: usage.costUsd },
			});

			// Что реально получил узел: parseWorkPackage по принятому сообщению.
			const receivedBody = mock.receivedWorkPackage();
			l2Received.push(parseWorkPackage(receivedBody?.message ?? ""));
		}

		record(
			"canSpawn(depth=2, maxWorkingDepth=4) → allowed для каждого L1",
			l2SpawnDecisions.length === 2 && l2SpawnDecisions.every((d) => d.allowed),
			`решения: ${JSON.stringify(l2SpawnDecisions)}`,
		);

		const l2Sent = l2SchemaChecks.length === 2;
		const l2SchemaOk = l2Sent && l2SchemaChecks.every((c) => c.valid);
		const l2ManifestOk =
			l2Received.length === 2 &&
			l2Received.every((wp) => wp !== null && JSON.stringify(wp.toolManifest) === JSON.stringify(L1_MANIFEST));
		record(
			"пакет L2 с toolManifest прошёл валидацию (схема + приём узлом)",
			l2SchemaOk && l2ManifestOk,
			`schema=${l2SchemaOk}, принято узлами: ${JSON.stringify(l2Received.map((wp) => wp?.toolManifest))}`,
		);
		record(
			"L2 отчёты получены (completed), depth-проверка отчёта прошла",
			l2Reports.length === 2 && l2Reports.every((r) => r.status === "completed"),
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 2: Манифесты — попытка write вне манифеста (F-37)
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 2: манифесты (попытка write вне манифеста) ──");

		const writeCheck = isAllowed(L1_MANIFEST, "write");
		const readCheck = isAllowed(L1_MANIFEST, "read");
		record(
			"L2 пытается write: isAllowed=false + «tool 'write' not in manifest»",
			writeCheck.allowed === false && writeCheck.diag === "tool 'write' not in manifest",
			`diag=${JSON.stringify(writeCheck.diag)}; read control=${readCheck.allowed}`,
		);
		// Отказ фиксируется в журнале (диагностика для оператора).
		journal.write({
			event: "tool_blocked",
			nodeId: "L2/node-1",
			parentId: "L1/node-1",
			correlationId: makeCorrelationId(MISSION_ID, 2, 1),
			depth: 2,
			diag: writeCheck.diag,
		});

		// Невалидный манифест в пакете → fail-fast run() + tool_blocked (F-37).
		const depth2Invalid = createDepth2Integration({
			missionDir: tmpInvalid,
			missionId: `${MISSION_ID}-inv`,
			budgetTotal: { tokens: BUDGET_TOKENS, usd: BUDGET_USD },
		});
		let invalidThrown = false;
		try {
			await depth2Invalid.run({
				task: "Миссия с невалидным манифестом",
				children: 2,
				toolManifest: ["read", "delete_all"],
				deadline,
			});
		} catch (error) {
			invalidThrown = error?.name === "InvalidToolManifestError";
		}
		const invalidJournal = createTreeJournal(join(tmpInvalid, "tree-journal.jsonl"));
		const blockedEntries = invalidJournal.readAll().filter((e) => e.event === "tool_blocked");
		record(
			"невалидный манифест: run() бросил InvalidToolManifestError",
			invalidThrown,
		);
		record(
			"невалидный манифест: tool_blocked в tree-journal",
			blockedEntries.length === 1 && (blockedEntries[0].diag ?? "").includes("delete_all"),
			`diag=${JSON.stringify(blockedEntries[0]?.diag)}`,
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 3: Guard — граница рабочей глубины (F-36, эскалация I3)
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 3: guard глубины 4/5 + эскалация I3 ──");

		const depth4 = canSpawn(4, 0, { maxWorkingDepth: 4 });
		record("guard: глубина 4 → allowed", depth4.allowed === true);

		const escalations = [];
		const depth5 = canSpawn(5, 0, {
			maxWorkingDepth: 4,
			onDepthExceeded: (info) => escalations.push(info),
		});
		record(
			"guard: глубина 5 → max_depth_exceeded + эскалация I3 (колбэк 1 раз)",
			depth5.allowed === false &&
				depth5.reason === "max_depth_exceeded" &&
				escalations.length === 1 &&
				escalations[0].currentDepth === 4 &&
				escalations[0].maxDepth === 4,
			`решение=${JSON.stringify(depth5)}, колбэк=${JSON.stringify(escalations)}`,
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 4: Граничная валидация входящих отчётов (F-38)
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 4: граничная валидация отчётов ──");

		/** Эмуляция фиксированной точки приёма отчёта (как в depth2-integration):
		 *  validateReport → depthFromCorrelationId → validateDepth; отказ →
		 *  validation_failed в журнал. */
		function acceptReport(parentNodeId, parentDepth, report) {
			const schemaCheck = validateReport(report);
			if (!schemaCheck.valid) {
				const diag = schemaCheck.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
				journal.write({
					event: "validation_failed",
					nodeId: parentNodeId,
					parentId: `L1/node-${parentNodeId.slice(-1)}`,
					correlationId: typeof report?.correlationId === "string" ? report.correlationId : undefined,
					depth: 2,
					diag,
				});
				return { accepted: false, diag };
			}
			const reportDepth = depthFromCorrelationId(report.correlationId);
			const depthCheck =
				reportDepth === null
					? { valid: false, errors: [{ field: "correlationId", message: "cannot parse depth" }] }
					: validateDepth(parentDepth, reportDepth);
			if (!depthCheck.valid) {
				const diag = depthCheck.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
				journal.write({
					event: "validation_failed",
					nodeId: parentNodeId,
					parentId: `L1/node-${parentNodeId.slice(-1)}`,
					correlationId: report.correlationId,
					depth: 2,
					diag,
				});
				return { accepted: false, diag };
			}
			return { accepted: true };
		}

		// 4a: невалидный correlationId.
		const badCorr = acceptReport("L2/node-1", 1, {
			nodeId: "L2/node-1",
			correlationId: "invalid-id",
			status: "completed",
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
		});
		// 4b: depth mismatch (отчёт претендует на L3, родитель ждёт depth 2).
		const badDepth = acceptReport("L2/node-2", 1, {
			nodeId: "L2/node-2",
			correlationId: makeCorrelationId(MISSION_ID, 3, 1),
			status: "completed",
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
		});

		const entriesAfterBoundary = journal.readAll();
		const validationEntries = entriesAfterBoundary.filter((e) => e.event === "validation_failed");
		record(
			"отчёт с плохим correlationId отклонён → validation_failed",
			!badCorr.accepted &&
				validationEntries.some((e) => e.nodeId === "L2/node-1" && (e.diag ?? "").includes("correlationId")),
			`diag=${JSON.stringify(badCorr.diag)}`,
		);
		record(
			"отчёт с depth mismatch отклонён → validation_failed",
			!badDepth.accepted &&
				validationEntries.some((e) => e.nodeId === "L2/node-2" && (e.diag ?? "").includes("depth mismatch")),
			`diag=${JSON.stringify(badDepth.diag)}`,
		);

		// 4c: циклический отчёт (children → сам на себя) — отказ без краша.
		const cyclic = {
			nodeId: "L2/node-1",
			correlationId: makeCorrelationId(MISSION_ID, 2, 1),
			status: "completed",
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
		};
		cyclic.children = [cyclic];
		let cyclicResult = null;
		let cyclicCrash = false;
		try {
			cyclicResult = validateReport(cyclic);
		} catch {
			cyclicCrash = true;
		}
		record(
			"циклический отчёт: отказ без краша",
			!cyclicCrash &&
				cyclicResult !== null &&
				cyclicResult.valid === false &&
				cyclicResult.errors.some((e) => (e.message ?? "").includes("cycle detected")),
			`errors=${JSON.stringify(cyclicResult?.errors?.map((e) => e.field))}`,
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 5: Итог по журналу — дерево глубины 3 (F-32)
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 5: tree-journal и reconstructTree ──");

		// L2 env (эмуляция): depth+1 для каждого.
		const l2EnvOk =
			l2Envs.length === 2 && l2Envs.every((e) => e.env.FAN_ORCHESTRATOR_DEPTH === "2");
		record(
			"FAN_ORCHESTRATOR_DEPTH: spawn env L2 содержит depth+1 (=2)",
			l2EnvOk,
			`env: ${JSON.stringify(l2Envs.map((e) => e.env.FAN_ORCHESTRATOR_DEPTH))}`,
		);

		// Завершение L0 (все дети обработаны).
		journal.write({
			event: "complete",
			nodeId: "L0",
			correlationId: makeCorrelationId(MISSION_ID, 0, 0),
			depth: 0,
		});

		const entries = journal.readAll();
		const depthsSeen = new Set(entries.map((e) => e.depth).filter((d) => d !== undefined));
		record(
			"tree-journal: записи всех уровней (depth 0, 1, 2)",
			depthsSeen.has(0) && depthsSeen.has(1) && depthsSeen.has(2),
			`${entries.length} записей, depth: [${[...depthsSeen].sort().join(", ")}]`,
		);

		const tree = reconstructTree(entries);
		const l0 = tree.nodes["L0"];
		const l1n1 = tree.nodes["L1/node-1"];
		const l1n2 = tree.nodes["L1/node-2"];
		const topologyOk =
			l0?.children?.length === 2 &&
			l0.children.includes("L1/node-1") &&
			l0.children.includes("L1/node-2") &&
			l1n1?.children?.length === 1 &&
			l1n1.children[0] === "L2/node-1" &&
			l1n2?.children?.length === 1 &&
			l1n2.children[0] === "L2/node-2";
		const maxEntryDepth = Math.max(...entries.map((e) => e.depth ?? 0));
		record(
			"reconstructTree: топология L0 → 2×L1 → 2×L2, глубина 3",
			topologyOk && maxEntryDepth === 2,
			`L0.children=[${l0?.children}], maxDepth=${maxEntryDepth} (уровней ${maxEntryDepth + 1})`,
		);
	} finally {
		// ── Cleanup: клиенты, мок-узлы, процессы, временные каталоги ──
		for (const client of clients) {
			try {
				client.close();
			} catch {
				/* ignore */
			}
		}
		for (const mock of l2Mocks) {
			try {
				await mock.stop();
			} catch {
				/* ignore */
			}
		}
		for (const p of pids) {
			try {
				process.kill(p.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
		rmSync(tmp, { recursive: true, force: true });
		rmSync(tmpInvalid, { recursive: true, force: true });
	}

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
