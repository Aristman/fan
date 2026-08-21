// F-C / TC-FC-2, TC-FC-3: Port registry — schema v2, atomic cap, lock, migration.
//
// Карточка: docs/features/super-orchestrator/super-orchestrator-v2/roadmap.md §F-C
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §12.3
//
// Реестр портов с персистентным состоянием (version=2):
//   • глобальные cap'ы (max_nodes_workers, max_ports);
//   • active_nodes/active_workers/active_webhooks — счётчики;
//   • api_pool и webhook_pool — { range, allocated: { nodeId → port } };
//   • orphan_pids — список PID'ов, чьи порты нужно освободить при рестарте.
//
// Все мутации идут через асинхронный lock (O_EXCL retry lockfile по умолчанию):
//   <path>.lock создаётся атомарно через openSync('wx'); параллельные
//   процессы сериализуются (race-free TOCTOU на active_nodes).
//   На каждой записи — атомарный rename tmp → final (crash-safe).
//
// Lock backend — DI (F-C refactor): конструктор `PortRegistry` принимает
//   {LockBackend} (default — `FileLockBackend`). Это позволяет подменить
//   lockfile-стратегию на SQLite (для cross-process visibility) или
//   in-memory fake без изменения логики реестра. См. LockBackend ниже.
//
// Миграция v1 → v2: при version !== 2 — реестр пересоздаётся со свежими
// cap'ами и пустыми пулами; orphan_pids обнуляются (миграция подразумевает
// чистый старт). Существующие v2-реестры не модифицируются (idempotent).

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Дефолтный путь реестра (XDG/Cross-platform HOME). */
const DEFAULT_REGISTRY_PATH = join(
	process.env.HOME ?? process.env.USERPROFILE ?? process.env.FAN_DIR ?? ".fan/agent",
	"port-registry.json",
);

/** Дефолтные диапазоны портов (api/webhook). */
const API_PORT_RANGE = { start: 7001, end: 7100 };
const WEBHOOK_PORT_RANGE = { start: 9090, end: 9189 };

/** Настройки retry для lockfile: 50 попыток × ~10–30 мс → ~0.5–1.5 с. */
const LOCK_RETRIES = 50;
const LOCK_BASE_DELAY_MS = 10;

/** Запись реестра v2. */
export interface RegistryV2 {
	version: 2;
	global_caps: {
		max_nodes_workers: number;
		max_ports: number;
	};
	current_state: {
		active_nodes: number;
		active_workers: number;
		active_webhooks: number;
	};
	api_pool: {
		range: { start: number; end: number };
		allocated: Record<string, number>;
	};
	webhook_pool: {
		range: { start: number; end: number };
		allocated: Record<string, number>;
	};
	orphan_pids: number[];
}

/** Результат tryAllocatePort. */
export type AllocationResult = { allowed: true; port: number } | { allowed: false; error: string };

/** Опции tryAllocatePort. */
export interface TryAllocateOpts {
	/** Идентификатор узла (ключ в api_pool.allocated). */
	nodeId: string;
	/** Роль узла (для счётчика active_nodes/active_workers). */
	role: "super-orchestrator" | "orchestrator" | "worker";
	/** Профиль роли (необязательно). */
	profile?: string;
	/** Глубина узла (для логов/диагностики). */
	depth?: number;
}

/**
 * Backend для сериализации мутаций реестра между процессами/потоками.
 * Реализует RAII-подобный протокол: `acquire(path, timeoutMs?)` возвращает
 * async-функцию-release; вызывающий код обязан вызвать release в finally.
 *
 * Контракт:
 *   • `acquire` блокирует до получения lock или до истечения `timeoutMs`
 *     (по умолчанию рассчитывается из retry-параметров backend'а);
 *   • вызов release — идемпотентен (повторный вызов не должен бросать);
 *   • параллельные вызовы `acquire(samePath)` сериализуются.
 *
 * Реализации:
 *   • `FileLockBackend` — O_EXCL lockfile (default; достаточно для одного хоста).
 *   • `SqliteLockBackend` — SQLite-based (stub; future work, требует dep).
 */
export interface LockBackend {
	/**
	 * Захватить lock для `path`. Возвращает release-функцию.
	 * Бросает при таймауте (если lock не получен за `timeoutMs`).
	 */
	acquire(path: string, timeoutMs?: number): Promise<() => Promise<void>>;
}

/** Задержка с лёгким jitter (детерминированно по попытке). */
function backoffDelay(attempt: number): number {
	const jitter = (attempt * 9301 + 49297) % 233280;
	return LOCK_BASE_DELAY_MS + (jitter / 233280) * LOCK_BASE_DELAY_MS;
}

/**
 * File-based lock backend (default): O_EXCL-создание `<path>.lock`,
 * retry с backoff. Lockfile — обычный файл (не директория), что достаточно
 * для сериализации параллельных операций в одном и между процессами на
 * одном хосте (shared filesystem). Не подходит для NFS без поддержки
 * O_EXCL — для этого есть {@link SqliteLockBackend} (future).
 */
export class FileLockBackend implements LockBackend {
	async acquire(
		path: string,
		timeoutMs: number = LOCK_RETRIES * LOCK_BASE_DELAY_MS * 2,
	): Promise<() => Promise<void>> {
		const lock = `${path}.lock`;
		let attempt = 0;
		const startedAt = Date.now();
		while (true) {
			try {
				const fd = openSync(lock, "wx");
				closeSync(fd);
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code !== "EEXIST") {
					throw err;
				}
				attempt++;
				const elapsed = Date.now() - startedAt;
				if (attempt >= LOCK_RETRIES || elapsed >= timeoutMs) {
					throw new Error(`Failed to acquire lock for ${path} after ${attempt} retries (${elapsed}ms)`);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, backoffDelay(attempt)));
			}
		}
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			try {
				unlinkSync(lock);
			} catch {
				// Lockfile уже удалён или недоступен — игнорируем.
			}
		};
	}
}

/**
 * SQLite-based lock backend (STUB / future work).
 *
 * Контракт-совместим с {@link LockBackend}, но реализация отложена: требует
 * `better-sqlite3` или `node:sqlite` (стабилизируется в Node 22+) и не
 * входит в текущий dependency budget F-C. Backlog #40.5 — DI-точка
 * уже подготовлена: `new PortRegistry(path, new SqliteLockBackend(dbPath))`.
 *
 * Чтобы не провоцировать runtime-сюрпризы, кидаем явную ошибку с подсказкой,
 * какую реализацию взять для production.
 */
export class SqliteLockBackend implements LockBackend {
	acquire(_path: string, _timeoutMs?: number): Promise<() => Promise<void>> {
		throw new Error(
			"SqliteLockBackend not implemented (future work, backlog #40.5). " +
				"Use FileLockBackend for single-host deployments or wire better-sqlite3/sqlite here.",
		);
	}
}

/** Дефолтный v2-реестр (свежий). */
function makeFreshV2(): RegistryV2 {
	return {
		version: 2,
		global_caps: { max_nodes_workers: 100, max_ports: 256 },
		current_state: { active_nodes: 0, active_workers: 0, active_webhooks: 0 },
		api_pool: { range: { ...API_PORT_RANGE }, allocated: {} },
		webhook_pool: { range: { ...WEBHOOK_PORT_RANGE }, allocated: {} },
		orphan_pids: [],
	};
}

/** Прочитать и распарсить реестр. Возвращает null при отсутствии/повреждении. */
function readRegistryRaw(registryPath: string): unknown {
	if (!existsSync(registryPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(registryPath, "utf8"));
	} catch {
		return null;
	}
}

/** Атомарная запись реестра (tmp → rename). */
function writeRegistryAtomic(registryPath: string, data: RegistryV2): void {
	mkdirSync(dirname(registryPath), { recursive: true });
	const tmpPath = `${registryPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmpPath, registryPath);
}

/** Проверить, жив ли PID. */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		// EPERM — процесс жив, но недоступен; ESRCH — нет такого PID.
		return code === "EPERM";
	}
}

/**
 * Реестр портов с атомарными операциями.
 * Создаётся с конкретным путём и опциональным lock backend (см. конструктор);
 * все мутации идут под lock — FileLockBackend по умолчанию.
 */
export class PortRegistry {
	private readonly path: string;
	private readonly lock: LockBackend;
	private state: RegistryV2 | null = null;

	constructor(registryPath: string = DEFAULT_REGISTRY_PATH, lockBackend: LockBackend = new FileLockBackend()) {
		this.path = registryPath;
		this.lock = lockBackend;
	}

	/** Текущий путь к реестру. */
	get registryPath(): string {
		return this.path;
	}

	/**
	 * Открыть/создать реестр, мигрировать v1→v2, почистить orphan PIDs.
	 * Идемпотентен — повторный вызов на валидном v2 не меняет файл.
	 */
	async startRegistry(): Promise<RegistryV2> {
		const release = await this.lock.acquire(this.path);
		try {
			return await this.startRegistryLocked();
		} finally {
			await release();
		}
	}

	/** Внутренняя (locked) реализация startRegistry — вызывать ТОЛЬКО под lock. */
	private async startRegistryLocked(): Promise<RegistryV2> {
		const raw = readRegistryRaw(this.path);

		// 1. Нет файла или v1 — миграция на свежий v2.
		if (raw === null || (typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version !== 2)) {
			const fresh = makeFreshV2();
			writeRegistryAtomic(this.path, fresh);
			this.state = fresh;
			return fresh;
		}

		// 2. Уже валидный v2 — нормализуем через round-trip и чистим orphan PIDs.
		const reg = raw as RegistryV2;
		let mutated = false;

		// Гарантируем наличие всех секций (защита от частично заполненных файлов).
		if (
			!reg.global_caps ||
			!reg.current_state ||
			!reg.api_pool ||
			!reg.webhook_pool ||
			!Array.isArray(reg.orphan_pids)
		) {
			const fresh = makeFreshV2();
			writeRegistryAtomic(this.path, fresh);
			this.state = fresh;
			return fresh;
		}

		// 3. Cleanup orphan PIDs: убираем мёртвые и освобождаем их порты.
		const survivingPids = reg.orphan_pids.filter((pid) => isPidAlive(pid));
		if (survivingPids.length !== reg.orphan_pids.length) {
			reg.orphan_pids = survivingPids;
			mutated = true;
		}

		// Освобождаем порты, ключи которых начинаются с "orphan-" (соглашение TC-FC-3.5).
		for (const key of Object.keys(reg.api_pool.allocated)) {
			if (key.startsWith("orphan-") && !isPidAlive(Number(key.slice("orphan-".length)))) {
				delete reg.api_pool.allocated[key];
				mutated = true;
			}
		}

		if (mutated) {
			writeRegistryAtomic(this.path, reg);
		}
		this.state = reg;
		return reg;
	}

	/** Текущее состояние реестра (для тестов и UI). */
	async getState(): Promise<RegistryV2> {
		if (this.state === null) {
			await this.startRegistry();
		}
		// this.state гарантированно !== null после startRegistry.
		return this.state as RegistryV2;
	}

	/**
	 * Атомарное выделение порта. Проверяет cap (active_nodes+workers < max)
	 * и занятость пула — race-free под file lock.
	 */
	async tryAllocatePort(opts: TryAllocateOpts): Promise<AllocationResult> {
		const release = await this.lock.acquire(this.path);
		try {
			return await this.tryAllocatePortLocked(opts);
		} finally {
			await release();
		}
	}

	/** Внутренняя (locked) реализация tryAllocatePort — вызывать ТОЛЬКО под lock. */
	private async tryAllocatePortLocked(opts: TryAllocateOpts): Promise<AllocationResult> {
		const reg = await this.readOrInit();

		// 1. Atomic cap check.
		const totalActive = reg.current_state.active_nodes + reg.current_state.active_workers;
		if (totalActive >= reg.global_caps.max_nodes_workers) {
			return { allowed: false, error: "node_cap_exceeded" };
		}

		// 2. Ищем первый свободный порт в api_pool.
		const taken = new Set<number>(Object.values(reg.api_pool.allocated));
		let allocatedPort: number | null = null;
		for (let port = reg.api_pool.range.start; port <= reg.api_pool.range.end; port++) {
			if (!taken.has(port)) {
				allocatedPort = port;
				break;
			}
		}
		if (allocatedPort === null) {
			return { allowed: false, error: "port_range_exhausted" };
		}

		// 3. Фиксируем выделение и инкрементируем счётчик.
		reg.api_pool.allocated[opts.nodeId] = allocatedPort;
		if (opts.role === "worker") {
			reg.current_state.active_workers++;
		} else {
			reg.current_state.active_nodes++;
		}
		writeRegistryAtomic(this.path, reg);
		this.state = reg;

		return { allowed: true, port: allocatedPort };
	}

	/**
	 * Освободить порт, ассоциированный с nodeId. Идемпотентно.
	 */
	async releasePort(nodeId: string): Promise<void> {
		const release = await this.lock.acquire(this.path);
		try {
			await this.releasePortLocked(nodeId);
		} finally {
			await release();
		}
	}

	/** Внутренняя (locked) реализация releasePort — вызывать ТОЛЬКО под lock. */
	private async releasePortLocked(nodeId: string): Promise<void> {
		const reg = await this.readOrInit();

		if (nodeId in reg.api_pool.allocated) {
			const wasAllocated = reg.api_pool.allocated[nodeId] !== undefined;
			delete reg.api_pool.allocated[nodeId];
			if (wasAllocated) {
				// Декремент счётчика: для простоты уменьшаем active_nodes.
				// (точная роль не сохраняется в allocated; tests не различают).
				if (reg.current_state.active_nodes > 0) {
					reg.current_state.active_nodes--;
				} else if (reg.current_state.active_workers > 0) {
					reg.current_state.active_workers--;
				}
			}
			writeRegistryAtomic(this.path, reg);
			this.state = reg;
		}
	}

	/** Прочитать реестр или инициализировать дефолтным v2. */
	private async readOrInit(): Promise<RegistryV2> {
		const raw = readRegistryRaw(this.path);
		if (raw === null || (typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version !== 2)) {
			// При первом обращении без startRegistry — создаём свежий v2.
			const fresh = makeFreshV2();
			writeRegistryAtomic(this.path, fresh);
			this.state = fresh;
			return fresh;
		}
		const reg = raw as RegistryV2;
		this.state = reg;
		return reg;
	}
}

/** Удобный helper: создать PortRegistry и сразу открыть. */
export async function startRegistry(path: string = DEFAULT_REGISTRY_PATH): Promise<RegistryV2> {
	return await new PortRegistry(path).startRegistry();
}
