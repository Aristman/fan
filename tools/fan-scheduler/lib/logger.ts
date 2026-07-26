/**
 * Structured JSON logging (F-4.11).
 *
 * Every log entry is emitted as a single JSON line (JSONL — one JSON object
 * per line), compatible with Docker logging drivers and log aggregation tools:
 *
 *   { "timestamp": "2026-07-26T12:00:00.000Z", "level": "info",
 *     "module": "scheduler", "event": "scheduler_started",
 *     "taskId": "daily-review", "message": "human readable" }
 *
 * Fields:
 * - timestamp — ISO 8601 (UTC);
 * - level     — debug | info | warn | error;
 * - module    — scheduler | queue | executor | gh (bound per logger instance);
 * - event     — machine-readable action description (snake_case);
 * - taskId    — optional, present for task-scoped entries;
 * - message   — human-readable description;
 * - stack     — error level only, when an Error is passed in fields.error.
 *
 * Routing: info/debug → stdout, warn/error → stderr.
 * Filtering: the LOG_LEVEL env var sets the minimum level (default "info");
 * entries below it are dropped. Unknown values fall back to "info".
 *
 * Usage:
 *   import { createLogger } from "./logger.js";
 *   const log = createLogger("queue");
 *   log.info("task_started", `task "${task.name}" started`, { taskId: task.name });
 *   log.error("task_failed", `task failed: ${err.message}`, { taskId, error: err });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Extra structured fields merged into the log entry (taskId, error, domain data). */
export interface LogFields {
	/** Task name/id this entry relates to (TaskConfig.name). */
	taskId?: string;
	/** Underlying error; its stack trace is included for error-level entries only. */
	error?: unknown;
	[key: string]: unknown;
}

export interface Logger {
	debug(event: string, message: string, fields?: LogFields): void;
	info(event: string, message: string, fields?: LogFields): void;
	warn(event: string, message: string, fields?: LogFields): void;
	error(event: string, message: string, fields?: LogFields): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const DEFAULT_LEVEL: LogLevel = "info";

function isLogLevel(value: string): value is LogLevel {
	return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/** Minimum level from LOG_LEVEL (read per call so tests can re-stub the env). */
function minLevelPriority(): number {
	const raw = process.env.LOG_LEVEL?.trim().toLowerCase() ?? "";
	return LEVEL_PRIORITY[isLogLevel(raw) ? raw : DEFAULT_LEVEL];
}

function emit(module: string, level: LogLevel, event: string, message: string, fields?: LogFields): void {
	if (LEVEL_PRIORITY[level] < minLevelPriority()) return;
	const { error, ...rest } = fields ?? {};
	const entry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		module,
		event,
		...rest,
		message,
	};
	// Stack traces are included for the error level only.
	if (level === "error" && error instanceof Error && typeof error.stack === "string") {
		entry.stack = error.stack;
	}
	const line = JSON.stringify(entry);
	if (level === "warn" || level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

/** Creates a logger bound to a module name (scheduler/queue/executor/gh). */
export function createLogger(module: string): Logger {
	return {
		debug: (event, message, fields) => emit(module, "debug", event, message, fields),
		info: (event, message, fields) => emit(module, "info", event, message, fields),
		warn: (event, message, fields) => emit(module, "warn", event, message, fields),
		error: (event, message, fields) => emit(module, "error", event, message, fields),
	};
}

/** Default logger for the scheduler entry point and cron loop (module "scheduler"). */
export const logger: Logger = createLogger("scheduler");
