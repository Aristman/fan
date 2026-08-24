// F-SO-PM: Менеджер дочерних процессов super-orchestrator (REFACTOR-фаза TDD).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.1
//
// Задачи модуля:
//   • spawn узла fan server на первом свободном порту пула 7001–7099
//     (блокировка в portsFile — JSON {[id]: port}; занятые порты прошлой
//     сессии не переиспользуются), PID-файл <pidDir>/child-<id>.pid;
//   • kill-switch: SIGTERM → grace-период (killGraceMs) → SIGKILL,
//     освобождение порта и удаление PID-файла; kill идемпотентен;
//   • health-check: делегирован HealthChecker (health-checker.ts) —
//     GET /api/health каждые healthIntervalMs; после healthFailThreshold
//     провалов — маркировка "unhealthy", onUnhealthy(id, reason) и ОДИН
//     рестарт на том же порту; повторный порог — эскалация без рестарта.
//
// REFACTOR (без изменения поведения): пул портов вынесен в port-pool.ts
// (PortPool), health-check — в health-checker.ts (HealthChecker); менеджер
// композирует их. spawn и healthFetch инъектируются (DI) для тестируемости:
// в тестах — FakeChild и stub-fetch, в production — child_process.spawn и fetch.
//
// FIX F-1 (reconcile kills own children): модульный реестр activeChildPids
// пополняется на spawn (после получения child.pid) и очищается на child
// exit И в cleanupNode. Экспортируется isOwnChildPid(pid) — предикат для
// reconcile() в index.ts / depth2-integration.ts. Защищает собственных
// детей текущего процесса от убийства при стартовой сверке; не ломает
// crash-recovery (новая сессия → реестр пуст, все старые PID = сироты).
//
// FIX F-2 (stderr lost): stdio ребёнка теперь ["ignore","pipe","pipe"],
// stdout+stderr пишутся в append-файл <logsDir>/child-<id>.log (default
// <missionDir>/logs/...). Запись через fs.createWriteStream({flags:"a"})
// с unref() — стрим не держит родителя живым и не блокирует shutdown.
// ProcessManager.getExitInfo(id) возвращает {code, signal} для диагностики
// преждевременной смерти ребёнка в tree-journal.

import { spawn as cpSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentDepthFromEnv } from "./depth-width-guard.js";
import { HealthChecker, type HealthFetchFn } from "./health-checker.js";
import { buildSpawnEnv } from "./node-auth.js";
import { PortPool } from "./port-pool.js";

// ─── FIX F-1: process-level реестр живых детей этого процесса ──────────────
//
// reconcile() в index.ts (initCircuit) и depth2-integration.ts (run())
// нужен предикат "этот PID — мой ребёнок". Модульная Map — общая для всех
// ProcessManager-инстансов в текущем процессе (одна миссия = один PM, но
// при повторных handleDelegate создаётся новый depth2-handle и новый PM;
// без общего реестра reconcile внутри нового PM не увидит детей старого
// PM в этом же процессе). Пополнение — после успешного spawn (pid получен);
// очистка — на child exit event + на всякий случай в cleanupNode (double
// safety: FakeChild в тестах может не emit-ить exit).

interface ActiveChildEntry {
	id: string;
	port: number;
	startedAt: number;
}

const activeChildPids = new Map<number, ActiveChildEntry>();

/** F-1 fix: предикат для reconcile — PID живёт среди детей этого процесса. */
export function isOwnChildPid(pid: number): boolean {
	return activeChildPids.has(pid);
}

/** F-1 fix: снимок реестра (для тестов / диагностики). */
export function getActiveChildPids(): readonly number[] {
	return [...activeChildPids.keys()];
}

/** F-2 fix: Node.js streams (fs.WriteStream, child stdout/stderr) имеют
 *  недекларированный в @types/node unref() — Node.js v15+ runtime, но
 *  типы ReadableStream/WriteStream его не включают. Хелпер: типизированный
 *  вызов через structural check, runtime-безопасен. */
function tryUnref(stream: unknown): void {
	const s = stream as { unref?: () => void } | null | undefined;
	if (s && typeof s.unref === "function") {
		s.unref();
	}
}

export type { HealthFetchFn } from "./health-checker.js";

export interface SpawnOptions {
	id: string;
	args?: string[];
	env?: Record<string, string>;
	/** Токен узла (FAN_NODE_TOKEN); если задан — сидится при старте дочернего процесса. */
	token?: string;
	/** Имя узла (FAN_NODE_NAME); передаётся в seedNodeToken для уникальности в глобальной БД. */
	nodeName?: string;
	/** F-1: Роль узла (FAN_NODE_ROLE). Default — "worker" (env vars не добавляются).
	 *  При role="super-orchestrator" дочерний узел опознаётся как SO
	 *  и получает env для обратной связи с родителем. */
	role?: "worker" | "super-orchestrator";
	/** F-1: Профиль роли (FAN_NODE_ROLE_PROFILE); имеет смысл только при role=super-orchestrator. */
	roleProfile?: string;
	/** F-1: URL родительского fan server (FAN_PARENT_NODE_URL); для обратной связи SO. */
	parentUrl?: string;
	/** F-1: Bearer token родителя (FAN_PARENT_NODE_TOKEN); для обратной связи SO. */
	parentToken?: string;
}

export interface SpawnResult {
	port: number;
	pid: number;
}

/** Минимальный образ child_process.ChildProcess (достаточно для менеджера).
 *  F-2 fix: stdout/stderr типизированы как Readable|null для совместимости
 *  с stdio:"pipe" (production); тесты с stdio:"ignore" имеют null. */
export interface ChildLike {
	pid?: number;
	stdout?: NodeJS.ReadableStream | null;
	stderr?: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
	unref?(): void;
}

export interface SpawnCommandOptions {
	detached: boolean;
	/** F-26 fix: windowsHide=true предотвращает всплытие консольных окон
	 *  на Windows при detached:true (вывод уже идёт в pipe → child-*.log). */
	windowsHide?: boolean;
	/** F-2 fix: production — ["ignore","pipe","pipe"] для логирования;
	 *  unit-tests могут использовать "ignore" (FakeChild без потоков). */
	stdio: "ignore" | Array<"ignore" | "pipe">;
	env: NodeJS.ProcessEnv;
}

export type SpawnFn = (command: string, args: string[], options: SpawnCommandOptions) => ChildLike;

/** Информация, передаваемая в revokeHook перед остановкой узла. */
export interface RevokeHookInfo {
	id: string;
	port: number;
	token?: string;
	nodeName?: string;
}

export interface ProcessManagerOptions {
	portsFile: string;
	pidDir: string;
	/** F-2 fix: директория для логов stdout/stderr ребёнка.
	 *  Default: <dirname(pidDir)>/logs (рядом с pidDir, на уровне миссии).
	 *  Создаётся рекурсивно при первом spawn. */
	logsDir?: string;
	/** Первый порт пула (default 7001). */
	portRangeStart?: number;
	/** Последний порт пула (default 7099). */
	portRangeEnd?: number;
	/** DI вместо child_process.spawn (default — реальный spawn). */
	spawn?: SpawnFn;
	/** Команда запуска дочернего сервера (default { command: "fan", baseArgs: [] }).
	 *  Итоговая команда: `<command> [...baseArgs, "server", "--port", N, "--host", "127.0.0.1", ...]`.
	 *  ВАЖНО: режим FOREGROUND (`server`, не `server start`) — launcher остаётся
	 *  живым процессом, поэтому PID-трекинг и SIGTERM работают корректно.
	 *  Для e2e на local build: { command: process.execPath, baseArgs: ["<path>/cli.js"] }. */
	serverCommand?: { command: string; baseArgs: string[] };
	/** DI вместо fetch (default — реальный fetch). */
	healthFetch?: HealthFetchFn;
	/** Интервал health-check, мс (default 5000). */
	healthIntervalMs?: number;
	/** Провалов подряд до маркировки unhealthy (default 3). */
	healthFailThreshold?: number;
	/** Grace-период SIGTERM → SIGKILL, мс (default 5000). */
	killGraceMs?: number;
	/** Эскалация: узел нездоров (после порога провалов). */
	onUnhealthy?: (id: string, reason: string) => void;
	/** Хук отзыва токена узла; вызывается ПЕРЕД SIGTERM. Ошибка хука не блокирует kill. */
	revokeHook?: (info: RevokeHookInfo) => Promise<void> | void;
}

export type NodeStatus = "running" | "unhealthy" | "stopped";

export interface ProcessManager {
	spawn(opts: SpawnOptions): Promise<SpawnResult>;
	kill(id: string): Promise<void>;
	killAll(): Promise<void>;
	startHealthChecks(): void;
	stopHealthChecks(): void;
	status(id: string): NodeStatus | undefined;
	listPorts(): Record<string, number>;
	/** F-2 fix: код/сигнал exit живого/мёртвого узла, либо null если
	 *  узел ещё работает. Позволяет launchWorkerChild различать
	 *  "waitForReady провалился из-за смерти ребёнка" vs "таймаут". */
	getExitInfo(id: string): { code: number | null; signal: string | null } | null;
}

interface ManagedNode {
	id: string;
	port: number;
	extraArgs: string[];
	extraEnv: Record<string, string>;
	token?: string;
	nodeName?: string;
	child: ChildLike;
	status: NodeStatus;
	exitPromise: Promise<void>;
	killPromise: Promise<void> | null;
	/** F-2 fix: код/сигнал последнего exit (null = процесс ещё жив). */
	exitInfo: { code: number | null; signal: string | null } | null;
	/** F-2 fix: путь к лог-файлу stdout/stderr (для диагностики). */
	logPath: string;
}

export function createProcessManager(options: ProcessManagerOptions): ProcessManager {
	const healthIntervalMs = options.healthIntervalMs ?? 5000;
	const healthFailThreshold = options.healthFailThreshold ?? 3;
	const killGraceMs = options.killGraceMs ?? 5000;
	const spawnFn: SpawnFn = options.spawn ?? ((cmd, args, opts) => cpSpawn(cmd, args, opts));
	const serverCommand = options.serverCommand ?? { command: "fan", baseArgs: [] };
	const healthFetch: HealthFetchFn = options.healthFetch ?? ((url) => fetch(url));

	const portPool = new PortPool(options.portsFile, {
		start: options.portRangeStart,
		end: options.portRangeEnd,
	});

	const nodes = new Map<string, ManagedNode>();

	const checker = new HealthChecker({
		intervalMs: healthIntervalMs,
		failThreshold: healthFailThreshold,
		healthFetch,
		urlFor: (id) => `http://127.0.0.1:${nodes.get(id)?.port}/api/health`,
		onUnhealthy: (id, reason) => {
			const node = nodes.get(id);
			if (node && node.status !== "stopped") {
				node.status = "unhealthy"; // маркировка ДО эскалации наружу
			}
			options.onUnhealthy?.(id, reason);
		},
		onRecovered: (id) => {
			const node = nodes.get(id);
			if (node && node.status === "unhealthy") {
				node.status = "running"; // восстановился после рестарта
			}
		},
		onRestart: (id) => {
			const node = nodes.get(id);
			if (node) {
				restart(node);
			}
		},
	});

	// F-2 fix: директория логов (default <dirname(pidDir)>/logs).
	const logsDir = options.logsDir ?? join(dirname(options.pidDir), "logs");

	// ─── PID-файлы и лог-файлы ──────────────────────────────────────────────

	function pidFileFor(id: string): string {
		return join(options.pidDir, `child-${id.split("/").join("-")}.pid`);
	}

	function writePidFile(id: string, pid: number | undefined): void {
		mkdirSync(options.pidDir, { recursive: true });
		writeFileSync(pidFileFor(id), String(pid ?? ""), "utf8");
	}

	function logFileFor(id: string): string {
		return join(logsDir, `child-${id.split("/").join("-")}.log`);
	}

	// ─── порождение процесса ────────────────────────────────────────────────

	function launch(
		port: number,
		extraArgs: string[],
		extraEnv: Record<string, string>,
		token?: string,
		nodeName?: string,
	): ChildLike {
		// FOREGROUND-режим `fan server` (без "start"): процесс-сервер и есть
		// прямой child — PID-трекинг, exitPromise и SIGTERM работают как надо.
		// `server start` — daemon-режим: launcher выходит сразу после запуска
		// демона и для process-менеджмента непригоден.
		const args = [...serverCommand.baseArgs, "server", "--port", String(port), "--host", "127.0.0.1", ...extraArgs];
		// buildSpawnEnv формирует базу (FAN_NODE_TOKEN + FAN_NO_AUTH=0),
		// extraEnv мержится поверх, FAN_NO_AUTH="0" пинится последним —
		// вызывающий не может включить no-auth на дочернем узле (F-3).
		const authBase = token ? buildSpawnEnv(token, extraEnv) : extraEnv;
		// F-2 fix: pipe stdout/stderr чтобы ProcessManager мог логировать в файл.
		const child = spawnFn(serverCommand.command, args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// F-36: дочерний узел знает свою глубину = глубина родителя + 1.
				// Вызывающий может переопределить через extraEnv (поверх authBase).
				FAN_ORCHESTRATOR_DEPTH: String(currentDepthFromEnv() + 1),
				...authBase,
				FAN_NO_AUTH: "0",
				...(nodeName !== undefined ? { FAN_NODE_NAME: nodeName } : {}),
			},
		});
		// FakeChild в тестах unref() не имеет — вызываем только при наличии.
		if (typeof child.unref === "function") {
			child.unref();
		}
		return child;
	}

	function wireExit(child: ChildLike, onExit: (code: number | null, signal: string | null) => void): Promise<void> {
		return new Promise<void>((resolve) => {
			child.on("exit", (code, signal) => {
				try {
					onExit(code, signal);
				} catch (err) {
					console.warn("[super-orchestrator] wireExit onExit handler failed:", err);
				}
				resolve();
			});
		});
	}

	/** F-1: Сформировать role-aware env vars (FAN_NODE_ROLE и связанные).
	 *  Возвращает Record с 4 env vars только при role=super-orchestrator;
	 *  role=worker или undefined → {} (back-compat, ничего не добавляется).
	 *  Optional поля (roleProfile/parentUrl/parentToken) включаются через
	 *  `!== undefined` guards — отсутствующее поле НЕ попадает в env.
	 *  Композируется с buildSpawnEnv через spread в extraEnv. */
	function buildRoleEnv(opts: SpawnOptions): Record<string, string> {
		if (opts.role !== "super-orchestrator") {
			return {};
		}
		const env: Record<string, string> = { FAN_NODE_ROLE: "super-orchestrator" };
		if (opts.roleProfile !== undefined) {
			env.FAN_NODE_ROLE_PROFILE = opts.roleProfile;
		}
		if (opts.parentUrl !== undefined) {
			env.FAN_PARENT_NODE_URL = opts.parentUrl;
		}
		if (opts.parentToken !== undefined) {
			env.FAN_PARENT_NODE_TOKEN = opts.parentToken;
		}
		return env;
	}

	async function spawn(opts: SpawnOptions): Promise<SpawnResult> {
		const existing = nodes.get(opts.id);
		if (existing && existing.status !== "stopped") {
			throw new Error(`Node "${opts.id}" is already active (status: ${existing.status}); kill it first`);
		}
		const port = portPool.allocate(opts.id); // исчерпание пула → явная ошибка
		const extraArgs = opts.args ?? [];
		const baseExtraEnv = opts.env ?? {};
		// F-1: role-aware spawn. При role=super-orchestrator мерджим 4 env vars
		// в extraEnv (FAN_NODE_ROLE, FAN_NODE_ROLE_PROFILE, FAN_PARENT_NODE_URL,
		// FAN_PARENT_NODE_TOKEN). Worker / role не задан → ничего не добавляется.
		// Мердж в extraEnv гарантирует, что restart() сохранит role env
		// (restart читает node.extraEnv и передаёт его в launch()).
		const roleEnv = buildRoleEnv(opts);
		const extraEnv = { ...baseExtraEnv, ...roleEnv };
		const child = launch(port, extraArgs, extraEnv, opts.token, opts.nodeName);

		// F-2 fix: лог-файл stdout+stderr ребёнка (append). Stream
		// unref'ится — не держит родителя; закрывается на exit через
		// detach (cleanupNode). На Windows pipe + detached + unref
		// работают корректно: Node.js v15+ гарантирует unref() на
		// WriteStream.
		const logPath = logFileFor(opts.id);
		mkdirSync(logsDir, { recursive: true });
		const logStream = createWriteStream(logPath, { flags: "a" });
		tryUnref(logStream);
		if (child.stdout) {
			child.stdout.pipe(logStream, { end: false });
			tryUnref(child.stdout);
		}
		if (child.stderr) {
			child.stderr.pipe(logStream, { end: false });
			tryUnref(child.stderr);
		}
		logStream.on("error", (err) => {
			console.warn(`[super-orchestrator] child log stream failed for "${opts.id}":`, err);
		});

		const node: ManagedNode = {
			id: opts.id,
			port,
			extraArgs,
			extraEnv,
			token: opts.token,
			nodeName: opts.nodeName,
			child,
			status: "running",
			exitPromise: wireExit(child, (code, signal) => {
				node.exitInfo = { code, signal };
				// F-1 fix: убираем PID из process-level реестра, чтобы
				// reconcile не считал мёртвого ребёнка "своим".
				if (child.pid !== undefined) {
					activeChildPids.delete(child.pid);
				}
				// Закрываем лог-стрим после exit — wait для pending
				// записей stdout/stderr, затем end().
				if (child.stdout && typeof child.stdout.unpipe === "function") {
					try {
						child.stdout.unpipe(logStream);
					} catch {
						// best-effort
					}
				}
				if (child.stderr && typeof child.stderr.unpipe === "function") {
					try {
						child.stderr.unpipe(logStream);
					} catch {
						// best-effort
					}
				}
				try {
					logStream.end();
				} catch {
					// best-effort
				}
			}),
			killPromise: null,
			exitInfo: null,
			logPath,
		};
		nodes.set(opts.id, node);

		// F-1 fix: пополняем process-level реестр ПОСЛЕ установки node в
		// nodes Map — чтобы reconcile, вызванный параллельно, мог найти
		// и узел, и PID одновременно. PID может быть undefined для
		// FakeChild (тесты) — пропускаем.
		if (child.pid !== undefined) {
			activeChildPids.set(child.pid, { id: opts.id, port, startedAt: Date.now() });
		}

		writePidFile(opts.id, child.pid);
		checker.track(opts.id);

		// Стартовый health-check: best-effort — сервер ещё поднимается,
		// провал не фатален (узел останется running, догонит периодический
		// health-check). Успех гарантирует статус running в TC-F23-1.
		await checker.probe(opts.id);

		return { port, pid: child.pid ?? -1 };
	}

	// ─── kill-switch ────────────────────────────────────────────────────────

	function cleanupNode(node: ManagedNode): void {
		node.status = "stopped";
		// F-1 fix: double-safety cleanup реестра (если child.exit
		// по какой-то причине не выстрелил — FakeChild в тестах).
		if (node.child.pid !== undefined) {
			activeChildPids.delete(node.child.pid);
		}
		checker.untrack(node.id);
		portPool.release(node.id);
		const pidFile = pidFileFor(node.id);
		if (existsSync(pidFile)) {
			try {
				unlinkSync(pidFile);
			} catch {
				// уже удалён — не критично
			}
		}
	}

	async function killNode(node: ManagedNode): Promise<void> {
		// Revoke-hook: отзыв токена ПЕРЕД SIGTERM (F-2).
		// Ошибка хука не блокирует остановку — SIGTERM отправляется в любом случае.
		if (node.token && options.revokeHook) {
			try {
				await options.revokeHook({
					id: node.id,
					port: node.port,
					token: node.token,
					nodeName: node.nodeName,
				});
			} catch (err) {
				console.warn(`[super-orchestrator] revokeHook failed for "${node.id}":`, err);
			}
		}
		// SIGTERM отправляется синхронно, до первого await.
		node.child.kill("SIGTERM");
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<"timeout">((resolve) => {
			graceTimer = setTimeout(() => resolve("timeout"), killGraceMs);
		});
		const outcome = await Promise.race([node.exitPromise.then(() => "exit" as const), grace]);
		if (outcome === "timeout") {
			// Grace-период истёк — SIGKILL и ещё один grace на фактический exit
			// (если процесс не умрёт и после SIGKILL, cleanup всё равно делаем).
			node.child.kill("SIGKILL");
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const killGrace = new Promise<"timeout">((resolve) => {
				killTimer = setTimeout(() => resolve("timeout"), killGraceMs);
			});
			await Promise.race([node.exitPromise.then(() => "exit" as const), killGrace]);
			clearTimeout(killTimer);
		}
		clearTimeout(graceTimer);
		cleanupNode(node);
	}

	function kill(id: string): Promise<void> {
		const node = nodes.get(id);
		if (!node || node.status === "stopped") {
			return Promise.resolve(); // идемпотентность: повторный kill не падает
		}
		if (node.killPromise) {
			return node.killPromise; // конкурентный kill — ждём тот же результат
		}
		node.killPromise = killNode(node);
		return node.killPromise;
	}

	async function killAll(): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const node of nodes.values()) {
			if (node.status !== "stopped") {
				pending.push(kill(node.id));
			}
		}
		await Promise.all(pending);
	}

	// ─── health-check: рестарт ─────────────────────────────────────────────

	function restart(node: ManagedNode): void {
		// Рестарт на ТОМ ЖЕ id и порту: portsFile не трогаем (порт уже
		// заблокирован за этим id), PID-файл перезаписываем новым PID.
		// Статус остаётся "unhealthy" до первого успешного health-check.
		const child = launch(node.port, node.extraArgs, node.extraEnv, node.token, node.nodeName);
		// F-2 fix: при рестарте рестартуем лог-стрим (append-файл тот же).
		// Старый стрим уже закрыт в exit-handler предыдущего child.
		mkdirSync(logsDir, { recursive: true });
		const logStream = createWriteStream(node.logPath, { flags: "a" });
		tryUnref(logStream);
		if (child.stdout) {
			child.stdout.pipe(logStream, { end: false });
			tryUnref(child.stdout);
		}
		if (child.stderr) {
			child.stderr.pipe(logStream, { end: false });
			tryUnref(child.stderr);
		}
		logStream.on("error", (err) => {
			console.warn(`[super-orchestrator] child log stream failed for "${node.id}":`, err);
		});

		// F-1 fix: рестарт может привести к новому PID — обновляем реестр.
		const oldPid = node.child.pid;
		if (oldPid !== undefined) {
			activeChildPids.delete(oldPid);
		}
		node.child = child;
		// F-2 fix: сбрасываем exitInfo — новая жизнь ребёнка.
		node.exitInfo = null;
		node.exitPromise = wireExit(child, (code, signal) => {
			node.exitInfo = { code, signal };
			if (child.pid !== undefined) {
				activeChildPids.delete(child.pid);
			}
			try {
				if (child.stdout && typeof child.stdout.unpipe === "function") {
					child.stdout.unpipe(logStream);
				}
				if (child.stderr && typeof child.stderr.unpipe === "function") {
					child.stderr.unpipe(logStream);
				}
				logStream.end();
			} catch {
				// best-effort
			}
		});
		node.killPromise = null;
		if (child.pid !== undefined) {
			activeChildPids.set(child.pid, { id: node.id, port: node.port, startedAt: Date.now() });
		}
		writePidFile(node.id, child.pid);
	}

	// ─── публичный API ──────────────────────────────────────────────────────

	return {
		spawn,
		kill,
		killAll,
		startHealthChecks: () => checker.start(),
		stopHealthChecks: () => checker.stop(),
		status: (id: string) => nodes.get(id)?.status,
		listPorts: () => portPool.list(),
		// F-2 fix: для launchWorkerChild — различать "waitForReady провалился
		// из-за смерти ребёнка" vs "таймаут". null = процесс ещё жив.
		getExitInfo: (id: string) => nodes.get(id)?.exitInfo ?? null,
	};
}
