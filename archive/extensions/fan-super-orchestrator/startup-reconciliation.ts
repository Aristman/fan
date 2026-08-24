// F-33: Startup-reconciliation (стартовая сверка, зачистка orphan-процессов).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-33
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.6
//
// При старте контура читает portsFile прошлой сессии (формат PortPool:
// JSON {nodeId: port}) и для каждой записи:
//   • PID-файл отсутствует/пустой/не число → cleaned_dead (pid null);
//   • PID мёртв (probe signal 0 бросает/false) → cleaned_dead без SIGTERM;
//   • PID жив и isOwnChild(pid) → skipped_own_child: запись и файлы остаются;
//   • PID жив и не свой ребёнок → orphan: SIGTERM → poll probe с шагом
//     sleepMs → жив после killGraceMs → SIGKILL → journal orphan_cleanup.
// Для мёртвых/orphan-записей порт освобождается (portsFile перезаписывается
// оставшимися записями), PID-файл удаляется. Все файловые операции
// синхронные. Имя PID-файла — child-<sanitized>.pid, санитизация "/"→"-"
// (как pidFileFor в process-manager.ts). Реальные процессы не требуются:
// processKill и sleepMs инъектируются (DI), defaults — process.kill и
// setTimeout-promise.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Журнал для записи orphan_cleanup (TreeJournal-совместимый). */
export interface ReconciliationJournal {
	write(entry: object): unknown;
}

export interface ReconciliationOptions {
	/** portsFile PortPool: JSON {nodeId: port}. */
	portsFile: string;
	/** Каталог PID-файлов child-<id>.pid. */
	pidDir: string;
	/** Журнал для orphan_cleanup (опционален). */
	journal?: ReconciliationJournal;
	/** Является ли PID своим ребёнком текущего процесса (default () => false). */
	isOwnChild?: (pid: number) => boolean;
	/** Grace-период после SIGTERM до SIGKILL, мс (default 5000). */
	killGraceMs?: number;
	/** DI вместо process.kill (default — реальный process.kill). */
	processKill?: (pid: number, signal?: string | number) => boolean;
	/** DI вместо setTimeout (default — setTimeout-promise). */
	sleepMs?: (ms: number) => Promise<void>;
}

export interface ReconciledEntry {
	nodeId: string;
	pid: number | null;
	port: number;
	action: "cleaned_dead" | "killed_orphan" | "skipped_own_child";
}

export interface ReconciliationResult {
	entries: ReconciledEntry[];
}

const DEFAULT_KILL_GRACE_MS = 5000;

function defaultSleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** PID-файл: санитизация nodeId "/"→"-" (как pidFileFor в process-manager). */
function pidFileFor(pidDir: string, nodeId: string): string {
	return join(pidDir, `child-${nodeId.split("/").join("-")}.pid`);
}

/** PID из файла; null если файла нет/содержимое пустое или не число. */
function readPid(pidFile: string): number | null {
	try {
		const raw = readFileSync(pidFile, "utf8").trim();
		if (raw === "") {
			return null;
		}
		const pid = Number(raw);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function removeFile(file: string): void {
	if (existsSync(file)) {
		try {
			unlinkSync(file);
		} catch {
			// Уже удалён конкурентом — не критично.
		}
	}
}

/**
 * Стартовая сверка: зачистить orphaned записи portsFile прошлой сессии.
 * Возвращает обработанные записи; portsFile перезаписывается оставшимися
 * (только skipped_own_child), PID-файлы мёртвых/orphan удаляются.
 */
export async function reconcile(options: ReconciliationOptions): Promise<ReconciliationResult> {
	const isOwnChild = options.isOwnChild ?? (() => false);
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	const processKill = options.processKill ?? ((pid, signal) => process.kill(pid, signal));
	const sleepMs = options.sleepMs ?? defaultSleepMs;

	const probeAlive = (pid: number): boolean => {
		try {
			return processKill(pid, 0) !== false;
		} catch {
			return false; // ESRCH и пр. — процесс мёртв
		}
	};

	// portsFile: отсутствует/пустой/повреждённый/не объект → no-op.
	let ports: Record<string, unknown>;
	if (!existsSync(options.portsFile)) {
		return { entries: [] };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(options.portsFile, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { entries: [] };
		}
		ports = parsed as Record<string, unknown>;
	} catch {
		return { entries: [] };
	}

	const entries: ReconciledEntry[] = [];
	const remaining: Record<string, number> = {};

	for (const [nodeId, portValue] of Object.entries(ports)) {
		const port = Number(portValue);
		const pidFile = pidFileFor(options.pidDir, nodeId);
		const pid = readPid(pidFile);

		if (pid === null) {
			// PID-файл отсутствует/нечитаем: убивать некого.
			removeFile(pidFile);
			entries.push({ nodeId, pid: null, port, action: "cleaned_dead" });
			continue;
		}

		if (!probeAlive(pid)) {
			// Мёртвый PID: чистим без SIGTERM.
			removeFile(pidFile);
			entries.push({ nodeId, pid, port, action: "cleaned_dead" });
			continue;
		}

		if (isOwnChild(pid)) {
			// Свой ребёнок текущей сессии: запись и файлы не трогаем.
			remaining[nodeId] = port;
			entries.push({ nodeId, pid, port, action: "skipped_own_child" });
			continue;
		}

		// Orphan: SIGTERM → poll probe → SIGKILL после killGraceMs.
		let alive = true;
		try {
			processKill(pid, "SIGTERM");
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ESRCH") {
				// Процесс уже мёртв (TOCTOU: умер между probe и сигналом).
				alive = false;
			} else {
				console.warn(`[reconcile] SIGTERM pid ${pid} failed: ${code ?? err}`);
			}
		}
		const stepMs = Math.min(100, Math.max(1, Math.floor(killGraceMs / 10)));
		let elapsedMs = 0;
		while (true) {
			if (!probeAlive(pid)) {
				alive = false;
				break;
			}
			if (elapsedMs >= killGraceMs) {
				break;
			}
			await sleepMs(stepMs);
			elapsedMs += stepMs;
		}
		if (alive) {
			try {
				processKill(pid, "SIGKILL");
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ESRCH") {
					console.warn(`[reconcile] SIGKILL pid ${pid} failed: ${code ?? err}`);
				}
			}
		}
		try {
			options.journal?.write({ event: "orphan_cleanup", nodeId, pid, port });
		} catch (err: unknown) {
			console.warn(`[reconcile] journal.write failed: ${err}`);
		}
		removeFile(pidFile);
		entries.push({ nodeId, pid, port, action: "killed_orphan" });
	}

	writeFileSync(options.portsFile, JSON.stringify(remaining, null, 2), "utf8");
	return { entries };
}
