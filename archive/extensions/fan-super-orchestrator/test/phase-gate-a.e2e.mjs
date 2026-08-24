// PHASE-GATE A (этап 2, фаза «Процессы и безопасность»): реальный e2e.
//
// Standalone-скрипт (НЕ vitest, чтобы не попадать в обычный прогон):
//   node test/phase-gate-a.e2e.mjs
//
// Сценарий:
//   1. Временный каталог для portsFile/pidDir.
//   2. createProcessManager с РЕАЛЬНЫМИ spawn/healthFetch (без моков),
//      serverCommand = local build: node packages/coding-agent/dist/cli.js.
//   3. generateNodeToken() + spawn({ id: "L1/node-1", token, nodeName }).
//   4. Health-poll GET /api/health (каждые 2 сек, таймаут 60 сек).
//   5. Auth: /api/health → 200 (публичный); /api/sessions без токена → 401;
//      /api/sessions с Bearer <token> → 200.
//   6. kill → <10 сек; порт освобождён; PID-файл удалён; процесс мёртв.
//   7. Guard: canSpawn(12,0) → max_depth_exceeded; canSpawn(1,4) → max_width_exceeded.
//   8. Таблица результатов; exit 0 только если ВСЁ зелёное.
//
// Примечание: дочерний сервер пишет в ту же глобальную БД (~/.fan/agent),
// что и текущая сессия FAN — это ожидаемо по архитектуре (БД общая).
//
// Node не резолвит TS-импорты модуля (`./health-checker.js` → .ts), поэтому
// скрипт сначала бандлит нужные модули esbuild'ом во временный каталог.

import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(EXT_DIR, "../..");
const CLI_PATH = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");

const NODE_ID = "L1/node-1";
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 2_000;
const KILL_BUDGET_MS = 10_000;
const START_TARGET_MS = 10_000;

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

async function getStatus(url, headers) {
	try {
		const res = await fetch(url, { headers });
		await res.arrayBuffer(); // дочитать тело, чтобы соединение закрылось
		return res.status;
	} catch {
		return 0; // сеть недоступна/отказ — не HTTP-статус
	}
}

/** Диагностика при провале старта: разовый запуск сервера с видимым выводом. */
async function collectStartupLogs(port) {
	console.log("\n--- диагностический запуск дочернего сервера (10 сек, вывод видим) ---");
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [CLI_PATH, "server", "--port", String(port), "--host", "127.0.0.1"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});
	let out = "";
	child.stdout?.on("data", (d) => (out += d.toString()));
	child.stderr?.on("data", (d) => (out += d.toString()));
	await sleep(10_000);
	child.kill();
	await sleep(500);
	console.log(out.trim() || "(вывода нет)");
	console.log("--- конец диагностики ---\n");
}

// ─── основной сценарий ──────────────────────────────────────────────────────

async function main() {
	console.log("PHASE-GATE A e2e: процессы и безопасность (super-orchestrator, этап 2)");
	console.log(`repo root : ${REPO_ROOT}`);
	console.log(`cli.js    : ${CLI_PATH}`);
	if (!existsSync(CLI_PATH)) {
		console.error("FATAL: packages/coding-agent/dist/cli.js не найден — нужен `npm run build`");
		process.exit(1);
	}

	// 1. Временный каталог
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-e2e-"));
	const portsFile = join(tmp, "child-ports.json");
	const pidDir = join(tmp, "pids");
	console.log(`tmp dir   : ${tmp}\n`);

	// Бандл TS-модулей расширения (Node не резолвит их .js-спецификаторы в .ts)
	const buildDir = join(tmp, "build");
	await build({
		entryPoints: [
			join(EXT_DIR, "process-manager.ts"),
			join(EXT_DIR, "node-auth.ts"),
			join(EXT_DIR, "depth-width-guard.ts"),
		],
		outdir: buildDir,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n', "utf8");
	const { createProcessManager } = await import(pathToFileURL(join(buildDir, "process-manager.js")));
	const { generateNodeToken } = await import(pathToFileURL(join(buildDir, "node-auth.js")));
	const { canSpawn } = await import(pathToFileURL(join(buildDir, "depth-width-guard.js")));

	// 2. ProcessManager: РЕАЛЬНЫЕ spawn/healthFetch (дефолты), local build как команда
	const pm = createProcessManager({
		portsFile,
		pidDir,
		serverCommand: { command: process.execPath, baseArgs: [CLI_PATH] },
	});

	let pid = -1;
	let port = -1;
	let startupOk = false;
	try {
		// 3. Spawn с токеном узла
		const token = generateNodeToken();
		const spawnStarted = Date.now();
		const spawned = await pm.spawn({ id: NODE_ID, token, nodeName: NODE_ID });
		({ port, pid } = spawned);
		record(
			"spawn L1/node-1",
			port > 0 && pid > 0,
			`port=${port} pid=${pid} (${Date.now() - spawnStarted} мс)`,
		);

		// 4. Health-poll: /api/health каждые 2 сек, таймаут 60 сек
		const healthUrl = `http://127.0.0.1:${port}/api/health`;
		const start = Date.now();
		let healthy = false;
		while (Date.now() - start < HEALTH_TIMEOUT_MS) {
			if ((await getStatus(healthUrl)) === 200) {
				healthy = true;
				break;
			}
			await sleep(HEALTH_POLL_MS);
		}
		const startupMs = Date.now() - start;
		startupOk = record(
			"health 200 (старт сервера)",
			healthy,
			healthy
				? `${(startupMs / 1000).toFixed(1)} сек (лимит 60 сек; цель <10 сек: ${startupMs < START_TARGET_MS ? "выполнена" : "НЕ выполнена — зафиксировано"})`
				: `таймаут ${HEALTH_TIMEOUT_MS / 1000} сек`,
		);

		if (!healthy) {
			await pm.kill(NODE_ID); // освободить порт перед диагностическим запуском
			await collectStartupLogs(port);
			record("auth-проверки", false, "пропущены: сервер не поднялся");
			record("kill", false, "пропущен: сервер не поднялся");
		} else {
			// 5. Auth-проверки
			const base = `http://127.0.0.1:${port}`;
			record("GET /api/health без токена → 200 (публичный)", (await getStatus(`${base}/api/health`)) === 200);
			record(
				"GET /api/sessions без токена → 401",
				(await getStatus(`${base}/api/sessions`)) === 401,
			);
			const authed = await getStatus(`${base}/api/sessions`, {
				Authorization: `Bearer ${token}`,
			});
			record("GET /api/sessions с Bearer <node-token> → 200", authed === 200, `фактически: ${authed}`);

			// 6. Kill: <10 сек, порт освобождён, PID-файл удалён, процесс мёртв
			const killStarted = Date.now();
			await pm.kill(NODE_ID);
			const killMs = Date.now() - killStarted;
			record("kill <10 сек", killMs < KILL_BUDGET_MS, `${(killMs / 1000).toFixed(1)} сек`);

			const ports = existsSync(portsFile) ? JSON.parse(readFileSync(portsFile, "utf8")) : {};
			record("порт освобождён в child-ports.json", ports[NODE_ID] === undefined, JSON.stringify(ports));
			const pidFile = join(pidDir, "child-L1-node-1.pid");
			record("PID-файл удалён", !existsSync(pidFile));

			let alive = true;
			try {
				process.kill(pid, 0); // сигнал 0: проверка существования
			} catch {
				alive = false;
			}
			record("процесс реально мёртв", !alive, `pid=${pid}`);
			if (alive) {
				try {
					process.kill(pid, "SIGKILL"); // не оставлять сироту
				} catch {
					/* уже мёртв */
				}
			}
		}

		// 7. Guard-проверки (синхронные)
		const depthDecision = canSpawn(12, 0);
		record(
			"canSpawn(12, 0) → max_depth_exceeded",
			!depthDecision.allowed && depthDecision.reason === "max_depth_exceeded",
			JSON.stringify(depthDecision),
		);
		const widthDecision = canSpawn(1, 4);
		record(
			"canSpawn(1, 4) → max_width_exceeded",
			!widthDecision.allowed && widthDecision.reason === "max_width_exceeded",
			JSON.stringify(widthDecision),
		);
	} finally {
		try {
			pm.stopHealthChecks();
			await pm.killAll(); // страховка от сирот при раннем падении
		} catch {
			/* ignore */
		}
		rmSync(tmp, { recursive: true, force: true });
	}

	// 8. Итоговая таблица
	console.log("\n┌──────────────────────────────────────────────────────────────┬────────┐");
	for (const r of results) {
		console.log(`│ ${r.step.padEnd(60)} │ ${r.ok ? "PASS  " : "FAIL  "} │`);
	}
	console.log("└──────────────────────────────────────────────────────────────┴────────┘");

	const failed = results.filter((r) => !r.ok).length;
	console.log(`\nИТОГ: ${results.length - failed}/${results.length} зелёные${failed ? ` — ${failed} провал(а)` : ""}${startupOk ? "" : " (PARTIAL: сервер не стартовал в этом окружении)"}`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("\nFATAL:", err);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`ИТОГ: ${results.length - failed}/${results.length} зелёные (аварийное завершение)`);
	process.exit(1);
});
