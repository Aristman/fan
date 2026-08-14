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

import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HealthChecker, type HealthFetchFn } from "./health-checker.js";
import { buildSpawnEnv } from "./node-auth.js";
import { PortPool } from "./port-pool.js";

export type { HealthFetchFn } from "./health-checker.js";

export interface SpawnOptions {
	id: string;
	args?: string[];
	env?: Record<string, string>;
	/** Токен узла (FAN_NODE_TOKEN); если задан — сидится при старте дочернего процесса. */
	token?: string;
	/** Имя узла (FAN_NODE_NAME); передаётся в seedNodeToken для уникальности в глобальной БД. */
	nodeName?: string;
}

export interface SpawnResult {
	port: number;
	pid: number;
}

/** Минимальный образ child_process.ChildProcess (достаточно для менеджера). */
export interface ChildLike {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	unref?(): void;
}

export interface SpawnCommandOptions {
	detached: boolean;
	stdio: "ignore";
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
	/** Первый порт пула (default 7001). */
	portRangeStart?: number;
	/** Последний порт пула (default 7099). */
	portRangeEnd?: number;
	/** DI вместо child_process.spawn (default — реальный spawn). */
	spawn?: SpawnFn;
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
}

export function createProcessManager(options: ProcessManagerOptions): ProcessManager {
	const healthIntervalMs = options.healthIntervalMs ?? 5000;
	const healthFailThreshold = options.healthFailThreshold ?? 3;
	const killGraceMs = options.killGraceMs ?? 5000;
	const spawnFn: SpawnFn = options.spawn ?? ((cmd, args, opts) => cpSpawn(cmd, args, opts));
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

	// ─── PID-файлы ──────────────────────────────────────────────────────────

	function pidFileFor(id: string): string {
		return join(options.pidDir, `child-${id.split("/").join("-")}.pid`);
	}

	function writePidFile(id: string, pid: number | undefined): void {
		mkdirSync(options.pidDir, { recursive: true });
		writeFileSync(pidFileFor(id), String(pid ?? ""), "utf8");
	}

	// ─── порождение процесса ────────────────────────────────────────────────

	function launch(
		port: number,
		extraArgs: string[],
		extraEnv: Record<string, string>,
		token?: string,
		nodeName?: string,
	): ChildLike {
		const args = ["server", "start", "--port", String(port), "--host", "127.0.0.1", ...extraArgs];
		// buildSpawnEnv формирует базу (FAN_NODE_TOKEN + FAN_NO_AUTH=0),
		// extraEnv мержится поверх, FAN_NO_AUTH="0" пинится последним —
		// вызывающий не может включить no-auth на дочернем узле (F-3).
		const authBase = token ? buildSpawnEnv(token, extraEnv) : extraEnv;
		const child = spawnFn("fan", args, {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
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

	function wireExit(child: ChildLike): Promise<void> {
		return new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
		});
	}

	async function spawn(opts: SpawnOptions): Promise<SpawnResult> {
		const existing = nodes.get(opts.id);
		if (existing && existing.status !== "stopped") {
			throw new Error(`Node "${opts.id}" is already active (status: ${existing.status}); kill it first`);
		}
		const port = portPool.allocate(opts.id); // исчерпание пула → явная ошибка
		const extraArgs = opts.args ?? [];
		const extraEnv = opts.env ?? {};
		const child = launch(port, extraArgs, extraEnv, opts.token, opts.nodeName);
		const node: ManagedNode = {
			id: opts.id,
			port,
			extraArgs,
			extraEnv,
			token: opts.token,
			nodeName: opts.nodeName,
			child,
			status: "running",
			exitPromise: wireExit(child),
			killPromise: null,
		};
		nodes.set(opts.id, node);
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
		node.child = child;
		node.exitPromise = wireExit(child);
		node.killPromise = null;
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
	};
}
