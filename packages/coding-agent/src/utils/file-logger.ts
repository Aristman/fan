/**
 * F-0.10: File logging with rotation for the container deployment.
 *
 * The slim runtime image has no logrotate/tee-with-rotation, so rotation is
 * implemented at the Node level: a tiny logger that tees `console.*` output
 * into `<LOG_DIR>/app.log` while passing everything through to the original
 * console (so `docker logs` keeps working).
 *
 * Configuration (env vars):
 *   LOG_DIR       — directory for the log file. Unset/empty → no-op (default
 *                   for local runs). The container sets it to /data/logs.
 *   LOG_LEVEL     — error | warn | info | debug (default: info). Controls the
 *                   verbosity of what is written to the FILE. Console output
 *                   (stdout/stderr) is always passed through unchanged.
 *   LOG_MAX_SIZE  — max size of app.log in bytes before rotation
 *                   (default: 10 MB). Accepts plain bytes or k/m/g suffixes
 *                   (e.g. "5m").
 *   LOG_MAX_FILES — number of rotated files to keep, app.log.1 .. app.log.N
 *                   (default: 5).
 *
 * Rotation: when app.log reaches LOG_MAX_SIZE it is renamed to app.log.1,
 * app.log.1 → app.log.2, ..., app.log.(N-1) → app.log.N, app.log.N is dropped.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

export interface FileLoggerConfig {
	/** Directory holding app.log (+ rotated app.log.N files). */
	dir: string;
	/** File name for the active log (default: "app.log"). */
	fileName: string;
	/** Minimum severity written to the file. */
	level: LogLevel;
	/** Rotate when app.log reaches this many bytes. */
	maxSizeBytes: number;
	/** Number of rotated files to keep. */
	maxFiles: number;
}

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_FILE_NAME = "app.log";

/**
 * Parse LOG_LEVEL. Unknown/empty values fall back to "info".
 */
export function resolveLogLevel(value: string | undefined): LogLevel {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
		return normalized;
	}
	return "info";
}

/**
 * Parse LOG_MAX_SIZE: plain bytes or k/m/g suffix ("512k", "10m", "1g").
 * Invalid/empty values fall back to the default (10 MB).
 */
export function resolveMaxSize(value: string | undefined): number {
	const match = value
		?.trim()
		.toLowerCase()
		.match(/^(\d+)([kmg]?)$/);
	if (!match) {
		return DEFAULT_MAX_SIZE_BYTES;
	}
	const multiplier = match[2] === "g" ? 1024 ** 3 : match[2] === "m" ? 1024 ** 2 : match[2] === "k" ? 1024 : 1;
	const bytes = Number(match[1]) * multiplier;
	return bytes > 0 ? bytes : DEFAULT_MAX_SIZE_BYTES;
}

/**
 * Parse LOG_MAX_FILES. Invalid/empty values fall back to the default (5).
 */
export function resolveMaxFiles(value: string | undefined): number {
	const parsed = Number(value?.trim());
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_FILES;
}

/**
 * Build a FileLoggerConfig from environment variables.
 * Returns undefined when LOG_DIR is unset/empty (file logging disabled).
 */
export function resolveFileLoggerConfig(env: NodeJS.ProcessEnv = process.env): FileLoggerConfig | undefined {
	const dir = env.LOG_DIR?.trim();
	if (!dir) {
		return undefined;
	}
	return {
		dir,
		fileName: DEFAULT_FILE_NAME,
		level: resolveLogLevel(env.LOG_LEVEL),
		maxSizeBytes: resolveMaxSize(env.LOG_MAX_SIZE),
		maxFiles: resolveMaxFiles(env.LOG_MAX_FILES),
	};
}

/**
 * Rotate app.log if it reached maxSizeBytes:
 * app.log.(N-1) → app.log.N (oldest dropped), ..., app.log → app.log.1.
 * Returns true when a rotation happened.
 */
export function rotateIfNeeded(logPath: string, maxSizeBytes: number, maxFiles: number): boolean {
	let size = 0;
	try {
		size = statSync(logPath).size;
	} catch {
		return false; // file does not exist yet
	}
	if (size < maxSizeBytes) {
		return false;
	}
	try {
		rmSync(`${logPath}.${maxFiles}`, { force: true });
		for (let i = maxFiles - 1; i >= 1; i--) {
			if (existsSync(`${logPath}.${i}`)) {
				renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
			}
		}
		renameSync(logPath, `${logPath}.1`);
		return true;
	} catch {
		return false; // rotation failure must never break the app
	}
}

interface ConsoleLike {
	error: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	log: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
}

/**
 * Install the file logger: wraps console.error/warn/log/info/debug so every
 * call is also appended (with ISO timestamp + level tag) to
 * `<config.dir>/app.log`, subject to the configured LOG_LEVEL threshold and
 * size-based rotation. Console output itself is passed through unchanged.
 *
 * Returns an uninstall function that restores the original console methods,
 * or undefined when LOG_DIR is not set (file logging disabled).
 *
 * File I/O failures are swallowed — logging must never break the process.
 */
export function installFileLogger(
	env: NodeJS.ProcessEnv = process.env,
	targetConsole: ConsoleLike = console,
): (() => void) | undefined {
	const config = resolveFileLoggerConfig(env);
	if (!config) {
		return undefined;
	}

	let logPath: string;
	try {
		mkdirSync(config.dir, { recursive: true });
		logPath = join(config.dir, config.fileName);
	} catch {
		return undefined;
	}

	const writeToFile = (level: LogLevel, args: unknown[]): void => {
		if (LEVEL_ORDER[level] > LEVEL_ORDER[config.level]) {
			return;
		}
		try {
			rotateIfNeeded(logPath, config.maxSizeBytes, config.maxFiles);
			const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${format(...args)}\n`;
			appendFileSync(logPath, line, "utf8");
		} catch {
			// Logging must never break the app.
		}
	};

	const originals: Partial<Record<keyof ConsoleLike, (...args: unknown[]) => void>> = {};
	const wrap = (method: keyof ConsoleLike, level: LogLevel): void => {
		const original = targetConsole[method].bind(targetConsole);
		originals[method] = original;
		targetConsole[method] = (...args: unknown[]) => {
			writeToFile(level, args);
			original(...args);
		};
	};

	wrap("error", "error");
	wrap("warn", "warn");
	wrap("log", "info");
	wrap("info", "info");
	wrap("debug", "debug");

	return () => {
		for (const [method, original] of Object.entries(originals)) {
			if (original) {
				targetConsole[method as keyof ConsoleLike] = original;
			}
		}
	};
}
