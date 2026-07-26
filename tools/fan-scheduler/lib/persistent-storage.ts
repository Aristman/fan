import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskConfig } from "./config-loader.js";
import { createLogger } from "./logger.js";

const log = createLogger("persistence");

/**
 * Persistent queue storage (F-4.13) — file-based durability for TaskQueue.pending.
 *
 * The pending task list is serialized to `<agentDir>/scheduler-pending.json`
 * on every queue mutation (enqueue/dequeue — the queue calls the
 * `onPendingChange` hook) and restored on scheduler startup.
 *
 * File format:
 *   { "version": 1, "tasks": [TaskConfig, ...] }
 *
 * Guarantees:
 * - Atomic write: payload is written to `<path>.tmp` and renamed over the
 *   target, so a crash mid-write never leaves a truncated JSON file.
 * - Corrupt file (invalid JSON / wrong shape) → empty queue + warning, no crash.
 * - Version mismatch → file ignored (empty queue) + warning — future-proof
 *   for format migrations.
 * - Best-effort: save failures are logged, never thrown into the queue.
 *
 * Single-writer assumption: the scheduler is a single process; atomic rename
 * is used instead of an explicit file lock (rename is atomic on POSIX and
 * Windows for same-volume moves).
 */

/** Current on-disk schema version. */
export const PENDING_QUEUE_VERSION = 1;

export const PENDING_QUEUE_FILENAME = "scheduler-pending.json";

export interface PendingQueueFile {
	version: number;
	tasks: TaskConfig[];
}

/**
 * Agent config directory (e.g. ~/.fan/agent/).
 * Mirrors packages/agent/src/paths.ts — the scheduler is a standalone Bun
 * package and must not import across workspace packages.
 * Respects the FAN_CODING_AGENT_DIR environment variable.
 */
export function getAgentDir(): string {
	const envDir = process.env.FAN_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".fan", "agent");
}

/**
 * Storage path for the pending queue. Overridable via
 * FAN_SCHEDULER_PENDING_FILE (tests, side-by-side scheduler instances).
 */
export function defaultPendingQueuePath(): string {
	const override = process.env.FAN_SCHEDULER_PENDING_FILE?.trim();
	if (override) return override;
	return join(getAgentDir(), PENDING_QUEUE_FILENAME);
}

/**
 * Serializes the pending task list to disk atomically (tmp file + rename).
 * Best-effort: I/O failures are logged as errors and swallowed — a broken
 * disk must not take the in-memory queue down.
 */
export function savePendingTasks(filePath: string, tasks: readonly TaskConfig[]): void {
	const payload: PendingQueueFile = { version: PENDING_QUEUE_VERSION, tasks: [...tasks] };
	const tmpPath = `${filePath}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
		renameSync(tmpPath, filePath);
	} catch (error) {
		log.error(
			"pending_save_failed",
			`[persistence] failed to save pending queue to "${filePath}": ` +
				(error instanceof Error ? error.message : String(error)),
			{ error, filePath, pending: tasks.length },
		);
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup
		}
	}
}

function isTaskConfigLike(entry: unknown): entry is TaskConfig {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
	const raw = entry as Record<string, unknown>;
	return (
		typeof raw.name === "string" &&
		typeof raw.schedule === "string" &&
		typeof raw.workspace === "string" &&
		typeof raw.message === "string"
	);
}

/**
 * Loads the persisted pending task list from disk.
 *
 * - Missing file → empty queue (silent).
 * - Corrupt JSON / wrong shape → empty queue + warning (no crash).
 * - Version mismatch → empty queue + warning (file ignored).
 * - Individual malformed task entries are skipped with a warning.
 */
export function loadPendingTasks(filePath: string): TaskConfig[] {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		log.warn(
			"pending_read_failed",
			`[persistence] failed to read "${filePath}" — starting with an empty queue: ` +
				(error instanceof Error ? error.message : String(error)),
			{ error, filePath },
		);
		return [];
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		log.warn(
			"pending_file_corrupt",
			`[persistence] "${filePath}" is not valid JSON — starting with an empty queue`,
			{ filePath },
		);
		return [];
	}

	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		log.warn(
			"pending_file_corrupt",
			`[persistence] "${filePath}" has an unexpected shape (expected an object) — starting with an empty queue`,
			{ filePath },
		);
		return [];
	}

	const record = data as Record<string, unknown>;
	if (record.version !== PENDING_QUEUE_VERSION) {
		log.warn(
			"pending_version_mismatch",
			`[persistence] "${filePath}" has version ${String(record.version)} (expected ${PENDING_QUEUE_VERSION}) — file ignored, starting with an empty queue`,
			{ filePath, version: record.version },
		);
		return [];
	}

	if (!Array.isArray(record.tasks)) {
		log.warn(
			"pending_file_corrupt",
			`[persistence] "${filePath}" has no "tasks" array — starting with an empty queue`,
			{ filePath },
		);
		return [];
	}

	const tasks: TaskConfig[] = [];
	for (const entry of record.tasks) {
		if (isTaskConfigLike(entry)) {
			tasks.push(entry);
		} else {
			log.warn(
				"pending_task_skipped",
				`[persistence] skipping malformed task entry in "${filePath}" (missing required string fields)`,
				{ filePath },
			);
		}
	}
	return tasks;
}
