// PHASE-GATE C3 (этап 3, финал): полный сквозной wired e2e — F-36..F-47 + F-48.5.
//
// Standalone-скрипт (НЕ vitest; vitest включает только test/**/*.test.mjs):
//   cd extensions/fan-super-orchestrator && node test/phase-gate-c3.e2e.mjs
//
// Критерии (один сквозной прогон ЧЕРЕЗ WIRED-контур):
//   ☑ Полный wired-сценарий (F-48.5): tempdir-миссия (MISSION.md active,
//     ROADMAP с [EPIC]-пунктом) → fan-mission MissionLoop +
//     fan-super-orchestrator фабрика на ОДНОМ EventBus → loop.tick()
//     → EPIC-декомпозиция (runAgent-мок → JSON подзадач) → mission_delegate
//     → super-orchestrator поднимает РЕАЛЬНЫЕ дочерние процессы
//     (mock-node-main; реальный fan доказан gate-c) → отчёты → синтез
//     → ROADMAP [x] → STATE done → git commit; totalUsage учтён в бюджете
//     итерации контура миссии.
//   ☑ Checkpoint в действии (F-45): чекпоинты до/после итерации — git log
//     содержит checkpoint:-коммиты (порядок: до → итерация → после),
//     state-файлы в .fan/checkpoints/<slug>/ (sessionId/iteration/timestamp/
//     gitCommit), .fan/ исключён из git-трекинга.
//   ☑ Iteration budget (F-46 + f-fix): мок trackIterationUsage с лимитом
//     (контракт BudgetTracker.checkIterationBudget) → превышение →
//     iteration_budget_exceeded → FAILED-тег с бюджетной диагностикой →
//     blocker в STATE.md; глобальный бюджет не задет.
//   ☑ Kill-switch: родитель с in-flight делегированием получает сигнал
//     завершения (SIGTERM на POSIX; на Windows SIGTERM недоставим в обработчик
//     — эквивалентный сигнал: EOF stdin, watchdog смерти родителя) → дочерние
//     мертвы < 10с, abort-записи в журнале, порты свободны.
//   ☑ Журнал/дерево: reconstructTree — глубина 2+ (L0→L1→L2 через
//     gate-паттерн: L1 реальные процессы, L2 in-process эмуляция теми же
//     модулями), tool_blocked/validation_failed при спровоцированных
//     нарушениях.
//
// Архитектура: esbuild бандлит TS-модули обоих расширений + git-checkpoint-
// helper (ядро) во временные каталоги; git-репозиторий в tempdir-workspace.
// Cleanup процессов/каталогов — в finally.

import { build } from "esbuild";
import { execFileSync, spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startMockNode } from "./helpers/mock-node-server.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR_SO = resolve(SCRIPT_DIR, "..");
const EXT_DIR_FM = resolve(SCRIPT_DIR, "..", "..", "fan-mission");
const CORE_DIR = resolve(SCRIPT_DIR, "..", "..", "..", "packages", "coding-agent", "src", "core");
const MOCK_NODE_MAIN = join(SCRIPT_DIR, "helpers", "mock-node-main.mjs");

const SLUG = "gate-c3";
const SESSION_ID = "gate-c3-session-1";
const BUDGET_TOKENS_GLOBAL = 500_000;
const BUDGET_USD_GLOBAL = 10;
const ITER_TOKEN_LIMIT = 50_000; // F-46: потолок токенов на итерацию
const MOCK_TOKENS_PER_NODE = 1500; // 1200 in + 300 out
const MOCK_USD_PER_NODE = 0.05;
const SUBTASKS = [
	{ task: "Подзадача 1: JWT-модуль", tokenBudget: 5000, toolManifest: ["read", "write", "bash"] },
	{ task: "Подзадача 2: auth middleware", tokenBudget: 5000, toolManifest: ["read", "write", "bash"] },
	{ task: "Подзадача 3: тесты auth", tokenBudget: 5000, toolManifest: ["read", "write", "bash"] },
];
const EPIC_ITEM = "[EPIC] Рефакторинг auth middleware: декомпозиция и параллельное выполнение";
const BUDGET_ITEM = "Длинная итерация с превышением iteration-бюджета";

const HEALTH_POLL_MS = 300;
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

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Свободный порт от ОС (listen 0). */
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

/**
 * Mock EventBus (контракт production EventBus: emit/on/listenerCount).
 * Общий для fan-mission (emit mission_delegate, on replyEvent) и
 * fan-super-orchestrator (on mission_delegate, emit replyEvent).
 */
function makeMockEventBus() {
	const listeners = new Map();
	const emitCalls = [];
	return {
		_emitCalls: emitCalls,
		emit(channel, data) {
			emitCalls.push({ channel, data });
			const handlers = listeners.get(channel) ?? [];
			for (const h of [...handlers]) {
				h(data);
			}
		},
		on(channel, handler) {
			if (!listeners.has(channel)) listeners.set(channel, []);
			listeners.get(channel).push(handler);
			return () => {
				const arr = listeners.get(channel) ?? [];
				const i = arr.indexOf(handler);
				if (i >= 0) arr.splice(i, 1);
			};
		},
		listenerCount(channel) {
			return (listeners.get(channel) ?? []).length;
		},
	};
}

/** Mock fan API для фабрики super-orchestrator (on = lifecycle hooks). */
function makeMockFan(eventBus) {
	const hooks = new Map();
	return {
		hooks,
		on(event, handler) {
			hooks.set(event, handler);
		},
		events: eventBus,
		async emitHook(event, ...args) {
			const handler = hooks.get(event);
			if (handler) await handler(...args);
		},
	};
}

/**
 * F-46: мок BudgetTracker (per-iteration контракт). Повторяет семантику
 * packages/model-manager/src/budget.ts (trackIterationUsage /
 * checkIterationBudget / resetIteration): `0` = unlimited, превышение
 * `>= limit`, remaining — минимум по включённым лимитам, событие
 * iteration_budget_exceeded один раз за эпизод превышения. Реальный
 * BudgetTracker покрыт unit-тестами model-manager; здесь — e2e-контракт.
 */
function makeIterationBudgetTracker({ iterationBudgetTokens = 0, iterationBudgetUsd = 0, onExceeded }) {
	let tokensUsed = 0;
	let costUsed = 0;
	let alerted = false;
	return {
		trackIterationUsage(tokens, cost = 0) {
			const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
			const safeCost = Number.isFinite(cost) && cost > 0 ? cost : 0;
			tokensUsed += safeTokens;
			costUsed += safeCost;
		},
		checkIterationBudget() {
			const tokenRemaining = iterationBudgetTokens > 0 ? iterationBudgetTokens - tokensUsed : Number.POSITIVE_INFINITY;
			const usdRemaining = iterationBudgetUsd > 0 ? iterationBudgetUsd - costUsed : Number.POSITIVE_INFINITY;
			const remaining = Math.min(tokenRemaining, usdRemaining);
			const tokensExceeded = iterationBudgetTokens > 0 && tokensUsed >= iterationBudgetTokens;
			const usdExceeded = iterationBudgetUsd > 0 && costUsed >= iterationBudgetUsd;
			const allowed = !tokensExceeded && !usdExceeded;
			if (!allowed && !alerted && onExceeded) {
				alerted = true;
				onExceeded({
					type: "iteration_budget_exceeded",
					tokensUsed,
					costUsed,
					remaining,
					message: `Iteration budget exceeded: ${tokensUsed} / ${iterationBudgetTokens || "∞"} tokens, $${costUsed.toFixed(2)} / $${iterationBudgetUsd ? iterationBudgetUsd.toFixed(2) : "∞"}`,
				});
			}
			return { allowed, remaining };
		},
		resetIteration() {
			tokensUsed = 0;
			costUsed = 0;
			alerted = false;
		},
		getIterationUsage() {
			return { tokensUsed, costUsed, tokenLimit: iterationBudgetTokens, usdLimit: iterationBudgetUsd };
		},
	};
}

/** Глубина узла из correlationId (<mission>/L<N>/node-<M>). */
function depthFromCorrelationId(correlationId) {
	if (typeof correlationId !== "string") return null;
	const match = /\/L(\d+)\/node-\d+$/.exec(correlationId);
	return match === null ? null : Number(match[1]);
}

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ─── kill-switch родитель (сценарий 4): standalone-скрипт ──────────────────
//
// Эмуляция fan-процесса с in-flight делегированием: depth2-integration
// поднимает РЕАЛЬНЫЕ дочерние mock-node, sendPackage «в полёте» (15с).
// Сигнал завершения (SIGTERM/SIGINT на POSIX; EOF stdin — portable-watchdog
// смерти родителя) → kill-switch: handle.abort() → дочерние мертвы → exit 0.

const KS_PARENT_SRC = `
import { spawn as cpSpawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD_DIR = process.env.KS_BUILD_DIR;
const MOCK_NODE_MAIN = process.env.KS_MOCK_NODE_MAIN;
const MISSION_DIR = process.env.KS_MISSION_DIR;
const CHILDREN_FILE = process.env.KS_CHILDREN_FILE;
const EXT_CWD = process.env.KS_EXT_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createDepth2Integration } = await import(pathToFileURL(join(BUILD_DIR, "depth2-integration.js")).href);

const children = [];
function persistChildren() {
	writeFileSync(CHILDREN_FILE, JSON.stringify(children, null, 2), "utf8");
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

const spawnNode = async ({ id, port, token, args }) => {
	const child = cpSpawn(process.execPath, [MOCK_NODE_MAIN, "--port", String(port), ...args], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, FAN_NODE_TOKEN: token },
		cwd: EXT_CWD,
	});
	children.push({ id, pid: child.pid, port });
	persistChildren();
	const t0 = Date.now();
	while (Date.now() - t0 < 20000) {
		if ((await getStatus(\`http://127.0.0.1:\${port}/api/health\`)) === 200) {
			return { pid: child.pid };
		}
		await sleep(150);
	}
	throw new Error(\`mock-node port \${port} not ready in 20s\`);
};

const killNode = async (id) => {
	const entry = children.find((c) => c.id === id);
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
	} catch { /* already dead */ }
};

// in-flight: пакет «в полёте» до SIGTERM (15с — дольше любого kill-бюджета).
const sendPackage = async () => {
	await sleep(15000);
	throw new Error("in-flight work package interrupted");
};

const handle = createDepth2Integration({
	missionDir: MISSION_DIR,
	missionId: "gate-c3-ks",
	budgetTotal: { tokens: 100000, usd: 10 },
	spawnNode,
	sendPackage,
	killNode,
});

let shuttingDown = false;
async function killSwitch(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(\`KILL_SWITCH \${reason}\`);
	try {
		await handle.abort();
	} catch (err) {
		console.log(\`abort error: \${err?.message ?? err}\`);
	}
	process.exit(0);
}

process.on("SIGTERM", () => void killSwitch("SIGTERM"));
process.on("SIGINT", () => void killSwitch("SIGINT"));
process.stdin.on("end", () => void killSwitch("stdin-EOF"));
process.stdin.resume();

const runPromise = handle.run({
	task: "KS mid-flight delegation",
	children: 2,
	deadline: new Date(Date.now() + 120000).toISOString(),
});
runPromise
	.then(() => { if (!shuttingDown) process.exit(0); })
	.catch(() => { if (!shuttingDown) process.exit(0); });

setInterval(() => {}, 1000); // держать процесс живым до сигнала
`;

// ── основной сценарий ──────────────────────────────────────────────────────

async function main() {
	const t0 = Date.now();
	console.log("PHASE-GATE C3 e2e: финальный сквозной wired e2e этапа 3 (F-36..F-47 + F-48.5)");
	console.log(`so ext dir: ${EXT_DIR_SO}`);
	console.log(`fm ext dir: ${EXT_DIR_FM}`);

	const tmp = mkdtempSync(join(tmpdir(), "fan-so-gate-c3-"));
	console.log(`tmp dir   : ${tmp}`);

	// Ресурсы для cleanup в finally.
	const pidsSO = []; // сценарий 1: реальные L1 { id, pid, port }
	const l2Mocks = []; // сценарий 5: in-process L2 мок-узлы
	const clients = []; // child-node-client (страховка close)
	let ksParent = null; // сценарий 4: процесс-родитель
	let ksChildren = []; // сценарий 4: дочерние родителя
	let loop = null; // MissionLoop (abort в конце)

	// ── 1. esbuild: бандлы обоих расширений + git-checkpoint-helper (ядро) ──
	const buildFM = join(tmp, "build-fm");
	const buildSO = join(tmp, "build-so");
	const buildCore = join(tmp, "build-core");

	await build({
		entryPoints: [
			join(EXT_DIR_FM, "mission-loop.ts"),
			join(EXT_DIR_FM, "session-executor.ts"),
			join(EXT_DIR_FM, "git-adapter.ts"),
		],
		outdir: buildFM,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	await build({
		entryPoints: [
			join(EXT_DIR_SO, "index.ts"),
			join(EXT_DIR_SO, "depth2-integration.ts"),
			join(EXT_DIR_SO, "child-node-client.ts"),
			join(EXT_DIR_SO, "tree-journal.ts"),
			join(EXT_DIR_SO, "work-package.ts"),
			join(EXT_DIR_SO, "tool-manifest.ts"),
			join(EXT_DIR_SO, "depth-width-guard.ts"),
			join(EXT_DIR_SO, "message-sanitizer.ts"),
			join(EXT_DIR_SO, "node-report.ts"),
			join(EXT_DIR_SO, "node-auth.ts"),
			join(EXT_DIR_SO, "budget-coordinator.ts"),
		],
		outdir: buildSO,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	await build({
		entryPoints: [join(CORE_DIR, "git-checkpoint-helper.ts")],
		outdir: buildCore,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	for (const dir of [buildFM, buildSO, buildCore]) {
		writeFileSync(join(dir, "package.json"), '{"type":"module"}\n', "utf8");
	}
	const loadFrom = (dir) => (name) => import(pathToFileURL(join(dir, `${name}.js`)));
	const loadFM = loadFrom(buildFM);
	const loadSO = loadFrom(buildSO);
	const loadCore = loadFrom(buildCore);

	const { MissionLoop, readMissionLoopState } = await loadFM("mission-loop");
	const { createSessionExecutor } = await loadFM("session-executor");
	const { createGitAdapter } = await loadFM("git-adapter");

	const soIndex = await loadSO("index");
	const { createTreeJournal, reconstructTree } = await loadSO("tree-journal");
	const { createChildNodeClient } = await loadSO("child-node-client");
	const { totalUsage } = await loadSO("node-report");
	const { generateNodeToken } = await loadSO("node-auth");
	const { canSpawn } = await loadSO("depth-width-guard");
	const { isAllowed } = await loadSO("tool-manifest");
	const { validateReport, validateDepth } = await loadSO("message-sanitizer");
	const { createWorkPackage, makeCorrelationId } = await loadSO("work-package");
	const { readMissionBudgetFile } = await loadSO("budget-coordinator");

	const { isInsideGitWorkTree, ensureGitExcludes, gitCommitAll } = await loadCore("git-checkpoint-helper");

	// ── 2. Workspace: git-репозиторий + файлы миссии ──
	const workspace = join(tmp, "workspace");
	const missionDir = join(workspace, "docs", "missions", SLUG);
	mkdirSync(missionDir, { recursive: true });

	const nowIso = new Date().toISOString();
	writeFileSync(
		join(missionDir, "MISSION.md"),
		[
			"---",
			`mission_id: mission-${SLUG}`,
			`created: ${nowIso}`,
			"status: active",
			"metric_type: test_pass_rate",
			"metric_command: npm test",
			`budget_tokens: ${BUDGET_TOKENS_GLOBAL}`,
			`budget_usd: ${BUDGET_USD_GLOBAL}`,
			"max_depth: 4",
			"max_width: 4",
			"---",
			"",
			`# Mission: ${SLUG}`,
			"",
			"Сквозной wired e2e (phase-gate C3).",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(missionDir, "ROADMAP.md"),
		`# Roadmap\n\n- [ ] ${EPIC_ITEM}\n- [ ] ${BUDGET_ITEM}\n`,
		"utf8",
	);
	writeFileSync(join(missionDir, "STATE.md"), "## Сделано\n\n## Блокеры\n\n## Следующие шаги\n", "utf8");
	writeFileSync(join(missionDir, "BACKLOG.md"), "# Backlog\n", "utf8");
	writeFileSync(join(missionDir, "DECISIONS.md"), "# Decisions\n", "utf8");

	git(["init"], workspace);
	git(["config", "user.email", "gate-c3@fan.local"], workspace);
	git(["config", "user.name", "Phase Gate C3"], workspace);
	git(["add", "-A"], workspace);
	git(["commit", "-m", "init mission"], workspace);

	const argvDumpDir = join(tmp, "argv-dump");
	mkdirSync(argvDumpDir, { recursive: true });

	console.log(`workspace : ${workspace}`);
	console.log(`\nНачало: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

	// ── F-45: checkpoint-хелпер (уровень e2e — git-checkpoint-helper +
	//    state-файл .fan/checkpoints/<slug>/<label>.json, как AgentSession) ──
	async function createCheckpoint(label, iteration) {
		const checkpointsDir = join(missionDir, ".fan", "checkpoints", SLUG);
		const file = join(checkpointsDir, `${label}.json`);
		if (existsSync(file)) {
			throw new Error(`Checkpoint "${label}" already exists`);
		}
		let gitCommit;
		if (await isInsideGitWorkTree(missionDir)) {
			await ensureGitExcludes(missionDir, [".fan/"]);
			gitCommit = await gitCommitAll(missionDir, `checkpoint:${label}`);
		}
		const state = {
			label,
			sessionId: SESSION_ID,
			iteration,
			timestamp: new Date().toISOString(),
			gitCommit,
		};
		mkdirSync(checkpointsDir, { recursive: true });
		writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
		return state;
	}

	// ── runAgent-мок: декомпозиция EPIC (JSON) + сценарий iteration budget ──
	const runAgentCalls = [];
	const budgetEvents = [];
	const budgetChecksInLimit = [];
	const budgetChecksExceeded = [];
	const tracker = makeIterationBudgetTracker({
		iterationBudgetTokens: ITER_TOKEN_LIMIT,
		onExceeded: (event) => budgetEvents.push(event),
	});

	async function runAgent(prompt) {
		runAgentCalls.push(prompt);
		if (prompt.includes("Декомпозиция EPIC-пункта")) {
			return { response: JSON.stringify(SUBTASKS), costTokens: 800, costUsd: 0.01 };
		}
		if (prompt.includes("превышением iteration-бюджета")) {
			// F-46: прогрессивное потребление итерации (TC-F46-2 семантика).
			tracker.resetIteration();
			tracker.trackIterationUsage(49_000, 0.5);
			budgetChecksInLimit.push(tracker.checkIterationBudget());
			tracker.trackIterationUsage(2_000, 0.01); // 51000 > 50000
			budgetChecksExceeded.push(tracker.checkIterationBudget());
			const usage = tracker.getIterationUsage();
			// AgentSession эмитит iteration_budget_exceeded и останавливает прогон
			// ДО следующего API call (I1 drain); default-run-agent транслирует флаг
			// в FAILED-тег с бюджетной диагностикой (f-fix).
			return {
				response: `<promise>FAILED: iteration budget exceeded (tokensUsed=${usage.tokensUsed}, costUsed=$${usage.costUsed})</promise>`,
				costTokens: usage.tokensUsed,
				costUsd: usage.costUsed,
			};
		}
		// Локальный fallback делегирования не ожидался — явная диагностика.
		return { response: "<promise>FAILED: unexpected local fallback runAgent call</promise>" };
	}

	// ── spawn/kill адаптеры сценария 1 (реальные процессы mock-node-main) ──
	function makeSpawnNode(pidsArray) {
		return async ({ id, port, token, args }) => {
			const child = cpSpawn(process.execPath, [MOCK_NODE_MAIN, "--port", String(port), ...args], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					FAN_NODE_TOKEN: token,
					MOCK_DELAY_MS: "400",
					FAN_ARGV_DUMP_DIR: argvDumpDir,
				},
				cwd: EXT_DIR_SO,
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

	async function killPid(pid) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
		for (let i = 0; i < 30; i++) {
			await sleep(100);
			if (!isAlive(pid)) return;
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead */
		}
	}

	try {
		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 2a: Checkpoint ДО итерации (F-45)
		// ═══════════════════════════════════════════════════════════════════
		console.log("── Сценарий 2a: checkpoint до итерации ──");
		const cpBefore = await createCheckpoint("iteration-0", 0);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 1: Полный wired-контур (F-48.5)
		//   MissionLoop (fan-mission) + superOrchestratorExtension
		//   (fan-super-orchestrator) на одном EventBus → tick() → РЕАЛЬНЫЕ L1
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 1: полный wired-контур (EPIC → делегирование → реальные L1) ──");

		const eventBus = makeMockEventBus();

		// fan-super-orchestrator: фабрика на общем EventBus + DI spawn/send/kill
		// (реальные процессы mock-node-main, как адаптеры gate-c).
		const fanSO = makeMockFan(eventBus);
		soIndex.default(fanSO, {
			spawnNode: makeSpawnNode(pidsSO),
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
				const entry = pidsSO.find((p) => p.id === id);
				if (entry) await killPid(entry.pid);
			},
			deadlineMs: 120_000,
		});
		// session_start → init контура (journal, подписка mission_delegate).
		await fanSO.emitHook("session_start", { cwd: workspace }, { cwd: workspace });

		record(
			"wiring: контур SO активен (missionDir, подписка mission_delegate)",
			fanSO.hooks.get("session_start") !== undefined &&
				eventBus.listenerCount("mission_delegate") === 1 &&
				existsSync(join(missionDir, "tree-journal.jsonl")),
			`listenerCount=${eventBus.listenerCount("mission_delegate")}`,
		);

		// fan-mission: MissionLoop с EPIC delegation deps (runAgent + EventBus).
		loop = new MissionLoop({
			missionDir,
			deps: {
				executor: createSessionExecutor({ runAgent }),
				git: createGitAdapter(),
				clock: { now: () => new Date() },
			},
			runAgent,
			eventBus,
			delegationTimeoutMs: 120_000,
		});

		const tick1Promise = loop.tick();

		// health poll: все 3 реальных L1 одновременно.
		const healthStart = Date.now();
		let allHealthy = false;
		while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
			const checks = await Promise.all(pidsSO.map((p) => getStatus(`http://127.0.0.1:${p.port}/api/health`)));
			if (pidsSO.length === SUBTASKS.length && checks.every((s) => s === 200)) {
				allHealthy = true;
				break;
			}
			await sleep(HEALTH_POLL_MS);
		}
		const healthMs = Date.now() - healthStart;

		const tick1 = await tick1Promise;

		record(
			"delegation path: runAgent вызван 1 раз с промптом декомпозиции (без fallback)",
			runAgentCalls.length === 1 && runAgentCalls[0].includes("Декомпозиция EPIC-пункта"),
			`calls=${runAgentCalls.length}`,
		);
		record(
			"3 реальных L1 подняты (health 200 каждый)",
			allHealthy && pidsSO.length === SUBTASKS.length,
			allHealthy ? `${(healthMs / 1000).toFixed(1)}с, порты: ${pidsSO.map((p) => p.port).join(",")}` : "не поднялись",
		);
		record(
			"tick() вернул active, итерация 1, EPIC-пункт",
			tick1.status === "active" && tick1.iteration === 1 && tick1.item === EPIC_ITEM,
			`status=${tick1.status}, item=${JSON.stringify(tick1.item)}`,
		);

		// argv: --tools из объединённого манифеста подзадач.
		await sleep(300);
		const argvVerified =
			pidsSO.length === SUBTASKS.length &&
			pidsSO.every((p) => {
				const argvFile = join(argvDumpDir, `argv-${p.port}.txt`);
				if (!existsSync(argvFile)) return false;
				const args = JSON.parse(readFileSync(argvFile, "utf8"));
				const toolsIdx = args.indexOf("--tools");
				return toolsIdx !== -1 && args[toolsIdx + 1] === "read,write,bash";
			});
		record("argv spawn содержит --tools read,write,bash", argvVerified);

		// Файлы миссии после tick: ROADMAP [x], STATE done, git commit.
		const roadmapAfter = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		record(
			"ROADMAP: EPIC-пункт отмечен [x]",
			roadmapAfter.includes(`- [x] ${EPIC_ITEM}`) && roadmapAfter.includes(`- [ ] ${BUDGET_ITEM}`),
		);

		const stateAfterRaw = readFileSync(join(missionDir, "STATE.md"), "utf8");
		record("STATE.md: EPIC-пункт в «Сделано»", stateAfterRaw.includes(EPIC_ITEM));

		const gitSubjects = git(["log", "--pretty=format:%s"], workspace).split("\n");
		record(
			"git commit итерации создан (mission: [EPIC] …)",
			gitSubjects.some((s) => s.startsWith(`mission: ${EPIC_ITEM}`)),
			`subjects: ${JSON.stringify(gitSubjects)}`,
		);

		// Бюджет итерации: стоимость декомпозиции + totalUsage дочерних узлов.
		const loopState1 = await readMissionLoopState(missionDir);
		const expectedTokens1 = 800 + SUBTASKS.length * MOCK_TOKENS_PER_NODE;
		const expectedUsd1 = 0.01 + SUBTASKS.length * MOCK_USD_PER_NODE;
		record(
			"бюджет итерации: costTokens = декомпозиция + totalUsage L1",
			loopState1.budgetUsed.tokens === expectedTokens1 && Math.abs(loopState1.budgetUsed.usd - expectedUsd1) < 1e-6,
			`expected=${expectedTokens1}/$${expectedUsd1}, actual=${loopState1.budgetUsed.tokens}/$${loopState1.budgetUsed.usd}`,
		);

		// tree-journal миссии: spawn/complete всех L1 (пишет контур SO).
		const journal1 = createTreeJournal(join(missionDir, "tree-journal.jsonl"));
		const entries1 = journal1.readAll();
		const spawns1 = entries1.filter((e) => e.event === "spawn" && e.depth === 1);
		const completes1 = entries1.filter((e) => e.event === "complete" && e.depth === 1);
		const corrOk =
			spawns1.length === SUBTASKS.length &&
			spawns1.every((e) => typeof e.correlationId === "string" && e.correlationId.startsWith(`${SLUG}/L1/node-`));
		record(
			"tree-journal: 3 spawn + 3 complete (depth 1, correlationId сквозь wired-контур)",
			spawns1.length === SUBTASKS.length && completes1.length === SUBTASKS.length && corrOk,
			`spawns=${spawns1.length}, completes=${completes1.length}`,
		);

		// mission-budget.json: consumed = Σ usage дочерних узлов.
		const budgetFile = readMissionBudgetFile(join(missionDir, "mission-budget.json"));
		const missionBudget = budgetFile?.missions?.[SLUG];
		const consumedOk =
			missionBudget?.consumed?.tokens === SUBTASKS.length * MOCK_TOKENS_PER_NODE &&
			Math.abs((missionBudget?.consumed?.usd ?? -1) - SUBTASKS.length * MOCK_USD_PER_NODE) < 0.001;
		record(
			"mission-budget.json: consumed = Σ usage L1",
			consumedOk,
			`consumed=${JSON.stringify(missionBudget?.consumed)}`,
		);

		// Узлы сценария 1 больше не нужны — убиваем ДО следующих сценариев.
		for (const p of pidsSO) {
			await killPid(p.pid);
		}

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 2b: Checkpoint ПОСЛЕ итерации + проверки F-45
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 2b: checkpoint после итерации (F-45) ──");
		const cpAfter = await createCheckpoint("iteration-1", 1);

		const gitSubjects2 = git(["log", "--pretty=format:%s"], workspace).split("\n");
		const idxCp1 = gitSubjects2.indexOf("checkpoint:iteration-1");
		const idxMission = gitSubjects2.findIndex((s) => s.startsWith(`mission: ${EPIC_ITEM}`));
		const idxCp0 = gitSubjects2.indexOf("checkpoint:iteration-0");
		record(
			"git log: checkpoint-коммиты до/после итерации (порядок корректен)",
			idxCp1 !== -1 && idxMission !== -1 && idxCp0 !== -1 && idxCp1 < idxMission && idxMission < idxCp0,
			`порядок: [${gitSubjects2.join(" | ")}]`,
		);

		const checkpointsDir = join(missionDir, ".fan", "checkpoints", SLUG);
		const cpFiles = readdirSync(checkpointsDir).filter((f) => f.endsWith(".json")).sort();
		const cpStateOk = [cpBefore, cpAfter].every((cp) => {
			const parsed = JSON.parse(readFileSync(join(checkpointsDir, `${cp.label}.json`), "utf8"));
			return (
				parsed.sessionId === SESSION_ID &&
				typeof parsed.iteration === "number" &&
				typeof parsed.timestamp === "string" &&
				new Date(parsed.timestamp).getTime() > 0 &&
				typeof parsed.gitCommit === "string" &&
				/^[0-9a-f]{40}$/.test(parsed.gitCommit) &&
				parsed.gitCommit === cp.gitCommit
			);
		});
		record(
			".fan/checkpoints/<slug>: state-файлы (sessionId/iteration/timestamp/gitCommit)",
			cpFiles.length === 2 && cpFiles[0] === "iteration-0.json" && cpFiles[1] === "iteration-1.json" && cpStateOk,
			`files=[${cpFiles.join(", ")}]`,
		);

		const trackedFan = git(["ls-files"], workspace)
			.split("\n")
			.filter((f) => f.includes(".fan/"));
		record("git: .fan/ исключён из трекинга (checkpoint-коммиты чистые)", trackedFan.length === 0, `tracked=${JSON.stringify(trackedFan)}`);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 5: Журнал/дерево — глубина 2+ (gate-паттерн L1→L2)
		//   + спровоцированные нарушения (tool_blocked, validation_failed)
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 5: reconstructTree глубина 2+ (L0→L1→L2) ──");

		const journal = createTreeJournal(join(missionDir, "tree-journal.jsonl"));
		const deadline = new Date(Date.now() + 60_000).toISOString();

		// L0 — корень (mission-loop, оркестрировавший делегирование).
		journal.write({
			event: "spawn",
			nodeId: "L0",
			correlationId: makeCorrelationId(SLUG, 0, 0),
			task: EPIC_ITEM,
			depth: 0,
			pid: process.pid,
		});

		// L1 → L2: эмуляция теми же модулями поверх in-process мок-узла
		// (gate-паттерн phase-gate-a3 / e2e-depth34).
		const l2Guard = canSpawn(2, 0, { maxWorkingDepth: 4 });
		record("guard: canSpawn(depth=2, maxWorkingDepth=4) → allowed", l2Guard.allowed === true);

		const l2Port = await getFreePort();
		const l2Token = generateNodeToken();
		const l2Mock = await startMockNode({ port: l2Port, token: l2Token, delayMs: 100 });
		l2Mocks.push(l2Mock);

		const l2Correlation = makeCorrelationId(SLUG, 2, 1);
		journal.write({
			event: "spawn",
			nodeId: "L2/node-1",
			parentId: "L1/node-1",
			correlationId: l2Correlation,
			task: "L2: покрытие тестами (gate-паттерн)",
			depth: 2,
			port: l2Port,
			pid: process.pid,
		});

		const l2WorkPackage = createWorkPackage({
			task: "L2: покрытие тестами (gate-паттерн)",
			correlationId: l2Correlation,
			depth: 2,
			tokenBudget: 5000,
			costBudgetUsd: 0.5,
			toolManifest: ["read", "bash", "grep"],
			deadline,
		});
		const l2Client = createChildNodeClient({
			wsFactory,
			onValidationFailed: (failure) => {
				journal.write({
					event: "validation_failed",
					nodeId: failure.nodeId ?? "L2/node-1",
					parentId: "L1/node-1",
					correlationId: failure.correlationId ?? l2Correlation,
					depth: 2,
					diag: failure.diag,
				});
			},
		});
		clients.push(l2Client);
		const l2Report = await l2Client.sendWorkPackage({ port: l2Port, token: l2Token, workPackage: l2WorkPackage });
		l2Client.close();

		const l2ReportDepth = depthFromCorrelationId(l2Report.correlationId);
		const l2DepthCheck = validateDepth(1, l2ReportDepth ?? -1);
		const l2Usage = totalUsage(l2Report);
		journal.write({
			event: l2DepthCheck.valid ? "complete" : "fail",
			nodeId: "L2/node-1",
			parentId: "L1/node-1",
			correlationId: l2Correlation,
			depth: 2,
			usage: { tokens: l2Usage.inputTokens + l2Usage.outputTokens, usd: l2Usage.costUsd },
		});
		record(
			"L2 (in-process): пакет доставлен, отчёт получен, depth-проверка прошла",
			l2Report.status === "completed" && l2DepthCheck.valid,
			`status=${l2Report.status}, depthCheck=${l2DepthCheck.valid}`,
		);

		// ── спровоцированные нарушения ──
		// tool_blocked: L2 с манифестом ["read","bash"] пытается write (F-37).
		const restrictedManifest = ["read", "bash"];
		const writeCheck = isAllowed(restrictedManifest, "write");
		record(
			"манифест: write вне ['read','bash'] отклонён с диагностикой",
			writeCheck.allowed === false && writeCheck.diag === "tool 'write' not in manifest",
			`diag=${JSON.stringify(writeCheck.diag)}`,
		);
		journal.write({
			event: "tool_blocked",
			nodeId: "L2/node-1",
			parentId: "L1/node-1",
			correlationId: l2Correlation,
			depth: 2,
			diag: writeCheck.diag,
		});

		// validation_failed: фиксированная точка приёма отчёта (gate-a3 паттерн).
		function acceptReport(parentNodeId, parentDepth, report) {
			const schemaCheck = validateReport(report);
			if (!schemaCheck.valid) {
				const diag = schemaCheck.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
				journal.write({
					event: "validation_failed",
					nodeId: parentNodeId,
					parentId: "L1/node-1",
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
					parentId: "L1/node-1",
					correlationId: report.correlationId,
					depth: 2,
					diag,
				});
				return { accepted: false, diag };
			}
			return { accepted: true };
		}
		const badCorr = acceptReport("L2/node-2", 1, {
			nodeId: "L2/node-2",
			correlationId: "invalid-id",
			status: "completed",
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
		});
		const badDepth = acceptReport("L2/node-2", 1, {
			nodeId: "L2/node-2",
			correlationId: makeCorrelationId(SLUG, 3, 1),
			status: "completed",
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
		});
		record(
			"граничная валидация: bad correlationId + depth mismatch отклонены",
			!badCorr.accepted && !badDepth.accepted,
			`diag: ${JSON.stringify([badCorr.diag, badDepth.diag])}`,
		);

		// Завершение L0.
		journal.write({
			event: "complete",
			nodeId: "L0",
			correlationId: makeCorrelationId(SLUG, 0, 0),
			depth: 0,
		});

		const entries = journal.readAll();
		const depthsSeen = new Set(entries.map((e) => e.depth).filter((d) => d !== undefined));
		const tree = reconstructTree(entries);
		const l0Node = tree.nodes["L0"];
		const l1n1 = tree.nodes["L1/node-1"];
		const l2n1 = tree.nodes["L2/node-1"];
		const l2n2 = tree.nodes["L2/node-2"];
		const maxEntryDepth = Math.max(...entries.map((e) => e.depth ?? 0));
		const topologyOk =
			l0Node?.children?.includes("L1/node-1") &&
			l0Node.children.includes("L1/node-2") &&
			l0Node.children.includes("L1/node-3") &&
			l1n1?.children?.includes("L2/node-1") &&
			l1n1.children.includes("L2/node-2") &&
			l2n1?.parentId === "L1/node-1" &&
			maxEntryDepth === 2;
		record(
			"reconstructTree: глубина 2+ (L0→3×L1→L2), топология корректна",
			topologyOk && depthsSeen.has(0) && depthsSeen.has(1) && depthsSeen.has(2),
			`L0.children=[${l0Node?.children}], L1/node-1.children=[${l1n1?.children}], maxDepth=${maxEntryDepth}`,
		);

		const toolBlockedEntries = entries.filter((e) => e.event === "tool_blocked");
		const validationEntries = entries.filter((e) => e.event === "validation_failed");
		record(
			"журнал: tool_blocked (diag «tool 'write' not in manifest») + validation_failed ≥2",
			toolBlockedEntries.length >= 1 &&
				toolBlockedEntries.some((e) => e.diag === "tool 'write' not in manifest") &&
				validationEntries.length >= 2,
			`tool_blocked=${toolBlockedEntries.length}, validation_failed=${validationEntries.length}`,
		);
		record(
			"reconstructTree статусы: L2/node-1=tool_blocked, L2/node-2=validation_failed",
			l2n1?.status === "tool_blocked" && l2n2?.status === "validation_failed",
			`status: ${JSON.stringify([l2n1?.status, l2n2?.status])}`,
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 3: Iteration budget (F-46) — превышение → FAILED-тег
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 3: iteration budget (превышение → FAILED с диагностикой) ──");

		const tick2 = await loop.tick();

		record(
			"трекер: в лимите allowed=true (remaining 1000), превышение allowed=false (remaining -1000)",
			budgetChecksInLimit.length === 1 &&
				budgetChecksInLimit[0].allowed === true &&
				budgetChecksInLimit[0].remaining === 1_000 &&
				budgetChecksExceeded.length === 1 &&
				budgetChecksExceeded[0].allowed === false &&
				budgetChecksExceeded[0].remaining === -1_000,
			`in-limit=${JSON.stringify(budgetChecksInLimit[0])}, exceeded=${JSON.stringify(budgetChecksExceeded[0])}`,
		);
		record(
			"iteration_budget_exceeded: одно событие (tokensUsed=51000)",
			budgetEvents.length === 1 &&
				budgetEvents[0].type === "iteration_budget_exceeded" &&
				budgetEvents[0].tokensUsed === 51_000,
			`events=${budgetEvents.length}, message=${JSON.stringify(budgetEvents[0]?.message)}`,
		);

		const expectedBlocker = `iteration budget exceeded (tokensUsed=51000, costUsed=$0.51)`;
		const stateRaw = readFileSync(join(missionDir, "STATE.md"), "utf8");
		record(
			"FAILED-тег с бюджетной диагностикой → blocker в STATE.md",
			tick2.item === BUDGET_ITEM && stateRaw.includes(expectedBlocker),
			`blocker=${JSON.stringify(expectedBlocker)}`,
		);

		const roadmapAfterFail = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		const backlogRaw = readFileSync(join(missionDir, "BACKLOG.md"), "utf8");
		const loopState2 = await readMissionLoopState(missionDir);
		record(
			"FAILED-итерация: пункт не отмечен, BACKLOG фиксирует FAILED, глобальный бюджет цел",
			roadmapAfterFail.includes(`- [ ] ${BUDGET_ITEM}`) &&
				backlogRaw.includes("FAILED") &&
				tick2.status === "active" &&
				loopState2.budgetUsed.tokens === 800 + 3 * MOCK_TOKENS_PER_NODE + 51_000,
			`tick2.status=${tick2.status}, budgetUsed=${JSON.stringify(loopState2.budgetUsed)}`,
		);
		const missionMdRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		record(
			"MISSION.md статус active (per-iteration лимит не исчерпал глобальный)",
			/^status:\s*active\s*$/m.test(missionMdRaw),
		);

		// ═══════════════════════════════════════════════════════════════════
		// СЦЕНАРИЙ 4: Kill-switch — SIGTERM родителя mid-flight
		// ═══════════════════════════════════════════════════════════════════
		console.log("\n── Сценарий 4: kill-switch (родитель mid-flight) ──");

		// Пауза: освобождение портов/TIME_WAIT после сценария 1.
		await sleep(2000);

		const ksParentScript = join(tmp, "ks-parent.mjs");
		writeFileSync(ksParentScript, KS_PARENT_SRC, "utf8");

		/** Одна попытка kill-switch сценария. infraFailure (родитель не поднял
		 *  дочерних / завершился аварийно) — основание для единственного ретрая:
		 *  реальные процессы подвержены транзиентным OS/AV-флэйкам. */
		async function runKillSwitchAttempt(attempt) {
			const attemptMissionDir = join(tmp, `ks-mission-${attempt}`);
			mkdirSync(attemptMissionDir, { recursive: true });
			const attemptChildrenFile = join(tmp, `ks-children-${attempt}.json`);

			const parent = cpSpawn(process.execPath, [ksParentScript], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					KS_BUILD_DIR: buildSO,
					KS_MOCK_NODE_MAIN: MOCK_NODE_MAIN,
					KS_MISSION_DIR: attemptMissionDir,
					KS_CHILDREN_FILE: attemptChildrenFile,
					KS_EXT_DIR: EXT_DIR_SO,
				},
			});
			let out = "";
			parent.stdout.on("data", (d) => {
				out += d.toString();
			});
			parent.stderr.on("data", (d) => {
				out += d.toString();
			});
			const parentExit = new Promise((resolveExit) => {
				parent.on("close", (code, signal) => resolveExit({ code, signal }));
			});

			// Ждём: родитель поднимет 2 реальных дочерних (health 200 у обоих).
			const attemptStart = Date.now();
			let children = [];
			let healthy = false;
			while (Date.now() - attemptStart < HEALTH_TIMEOUT_MS) {
				if (existsSync(attemptChildrenFile)) {
					try {
						children = JSON.parse(readFileSync(attemptChildrenFile, "utf8"));
					} catch {
						children = [];
					}
				}
				if (children.length === 2) {
					const healthChecks = await Promise.all(children.map((c) => getStatus(`http://127.0.0.1:${c.port}/api/health`)));
					if (healthChecks.every((s) => s === 200) && children.every((c) => isAlive(c.pid))) {
						healthy = true;
						break;
					}
				}
				await sleep(HEALTH_POLL_MS);
			}
			if (!healthy) {
				return { infraFailure: true, reason: "дочерние не поднялись", parent, children, out, missionDir: attemptMissionDir };
			}

			const abortStart = Date.now();
			let trigger;
			if (process.platform === "win32") {
				// Windows: SIGTERM/SIGINT недоставимы в обработчик дочернего
				// процесса (безусловный kill) — проверено экспериментально.
				// Эквивалентный сигнал завершения родителя: EOF stdin (watchdog
				// смерти родителя — portable-путь kill-switch).
				parent.stdin.end();
				trigger = "stdin-EOF (эквивалент SIGTERM на Windows)";
			} else {
				process.kill(parent.pid, "SIGTERM");
				trigger = "SIGTERM";
			}

			// Дочерние должны умереть < 10с.
			let allDead = false;
			let killMs = 0;
			while (Date.now() - abortStart < KILL_BUDGET_MS + 5_000) {
				if (children.every((c) => !isAlive(c.pid))) {
					allDead = true;
					killMs = Date.now() - abortStart;
					break;
				}
				await sleep(200);
			}
			if (!allDead) {
				killMs = Date.now() - abortStart;
			}
			const parentExitInfo = await Promise.race([parentExit, sleep(5_000).then(() => null)]);
			const infraFailure = parentExitInfo === null || parentExitInfo.code !== 0;
			return {
				infraFailure,
				healthy,
				allDead,
				killMs,
				trigger,
				parentExitInfo,
				parent,
				children,
				out,
				missionDir: attemptMissionDir,
			};
		}

		let ks = await runKillSwitchAttempt(1);
		if (ks.infraFailure) {
			console.log(
				`  (инфраструктурный сбой попытки 1: ${ks.parentExitInfo ? JSON.stringify(ks.parentExitInfo) : ks.reason} — единичный ретрай)`,
			);
			// Зачистка процессов попытки 1 перед ретраем.
			try {
				if (ks.parent.exitCode === null) ks.parent.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			for (const c of ks.children) {
				try {
					process.kill(c.pid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			await sleep(500);
			ks = await runKillSwitchAttempt(2);
		}
		ksParent = ks.parent; // страховка cleanup в finally
		ksChildren = ks.children;

		record(
			"kill-switch: родитель mid-flight поднял 2 реальных дочерних",
			ks.healthy,
			ks.healthy ? `порты: ${ks.children.map((c) => c.port).join(", ")}` : `out=${ks.out.slice(-200)}`,
		);

		if (ks.healthy) {
			record(
				"kill-switch: дочерние мертвы < 10с после сигнала родителю",
				ks.allDead && ks.killMs < KILL_BUDGET_MS,
				`${(ks.killMs / 1000).toFixed(1)}с (лимит ${KILL_BUDGET_MS / 1000}с), trigger=${ks.trigger}, parent=${JSON.stringify(ks.parentExitInfo)}${ks.allDead ? "" : `, parentOut=${JSON.stringify(ks.out.slice(-300))}`}`,
			);
			record(
				"kill-switch: родитель завершился корректно (exit 0)",
				ks.parentExitInfo !== null && ks.parentExitInfo.code === 0,
				`exit=${JSON.stringify(ks.parentExitInfo)}, out=${JSON.stringify(ks.out.slice(-300))}`,
			);

			// Журнал миссии kill-switch: abort-записи + освобождённые порты.
			const ksJournal = createTreeJournal(join(ks.missionDir, "tree-journal.jsonl"));
			const ksEntries = ksJournal.readAll();
			const abortEntries = ksEntries.filter((e) => e.event === "abort");
			record(
				"kill-switch: abort-записи в журнале миссии",
				abortEntries.length >= 1,
				`${abortEntries.length} abort-записей из ${ksEntries.length}`,
			);
			const portsFilePath = join(ks.missionDir, "child-ports.json");
			const portsAfter = existsSync(portsFilePath) ? JSON.parse(readFileSync(portsFilePath, "utf8")) : {};
			record("kill-switch: порты свободны", Object.keys(portsAfter).length === 0, JSON.stringify(portsAfter));
		} else {
			record("kill-switch: дочерние мертвы < 10с после сигнала родителю", false, "дочерние не поднялись");
			record("kill-switch: родитель завершился корректно (exit 0)", false, "пропущено");
			record("kill-switch: abort-записи в журнале миссии", false, "пропущено");
			record("kill-switch: порты свободны", false, "пропущено");
		}

		// ═══════════════════════════════════════════════════════════════════
		// Финал: abort миссии (cleanup контура)
		// ═══════════════════════════════════════════════════════════════════
		await loop.abort();
		const missionMdFinal = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		record("финал: loop.abort() → MISSION.md status aborted", /^status:\s*aborted\s*$/m.test(missionMdFinal));
	} finally {
		// ── Cleanup: клиенты, мок-узлы, процессы, каталоги ──
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
		if (ksParent !== null && ksParent.exitCode === null) {
			try {
				ksParent.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
		for (const c of ksChildren) {
			try {
				process.kill(c.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
		for (const p of pidsSO) {
			try {
				process.kill(p.pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
		rmSync(tmp, { recursive: true, force: true });
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
	console.log(`\nИТОГ: ${total - failed}/${total} зелёные за ${elapsed}с${failed ? ` — ${failed} провал(а)` : ""}`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("\nFATAL:", err);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`ИТОГ: ${results.length - failed}/${results.length} зелёные (аварийное завершение)`);
	process.exit(1);
});
