/**
 * F-3.7: Logging/metrics for MCP tool calls.
 *
 * Structured JSON-lines logger to ~/.fan/agent/logs/mcp-YYYY-MM-DD.log.
 * Every tool call is logged with timestamp, event, serverId, toolName,
 * duration_ms, and status — but NEVER args/content (PII/secrets).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".fan", "agent", "logs");

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface LogEntry {
	timestamp: string; // ISO 8601
	event: "tool_call_start" | "tool_call_end" | "tool_call_error";
	serverId?: string;
	toolName?: string;
	durationMs?: number;
	status?: "success" | "error";
	errorMessage?: string;
}

// ──────────────────────────────────────────────────
// Formatting (whitelist only — no args/content)
// ──────────────────────────────────────────────────

/**
 * Format a LogEntry as a one-line JSON string.
 *
 * Only whitelisted fields are serialised. Arbitrary properties
 * (e.g. tool arguments, response content) are never included,
 * preventing accidental PII/secret leakage.
 */
export function formatLogEntry(entry: LogEntry): string {
	const safe: Record<string, unknown> = {
		timestamp: entry.timestamp,
		event: entry.event,
	};
	if (entry.serverId !== undefined) safe.serverId = entry.serverId;
	if (entry.toolName !== undefined) safe.toolName = entry.toolName;
	if (entry.durationMs !== undefined) safe.durationMs = entry.durationMs;
	if (entry.status !== undefined) safe.status = entry.status;
	if (entry.errorMessage !== undefined) safe.errorMessage = entry.errorMessage;
	return JSON.stringify(safe);
}

// ──────────────────────────────────────────────────
// File I/O
// ──────────────────────────────────────────────────

/**
 * Append a single JSON-line entry to ~/.fan/agent/logs/mcp-YYYY-MM-DD.log.
 *
 * Automatically creates the logs directory if it doesn't exist.
 * Write failures are silently caught — logging must never break tool execution.
 *
 * @param entry - structured log entry to write
 * @param logDir - directory for log files (default: ~/.fan/agent/logs)
 */
export async function writeLog(
	entry: LogEntry,
	logDir: string = LOG_DIR,
): Promise<void> {
	const line = formatLogEntry(entry) + "\n";
	const today = entry.timestamp.slice(0, 10); // YYYY-MM-DD
	const path = join(logDir, `mcp-${today}.log`);
	try {
		await mkdir(logDir, { recursive: true });
		await appendFile(path, line, "utf8");
	} catch (e) {
		// Log write failure should never break tool execution.
		console.warn(
			`mcp-logger: failed to write log: ${e instanceof Error ? e.message : e}`,
		);
	}
}

// ──────────────────────────────────────────────────
// Wrapper
// ──────────────────────────────────────────────────

/**
 * Wrap an MCP tool execution with structured start/end logging.
 *
 * - On entry: writes a `tool_call_start` event
 * - On success: writes `tool_call_end` with duration and status: "success"
 * - On error: writes `tool_call_error` with duration and errorMessage, then re-throws
 *
 * @param serverId - MCP server identifier
 * @param toolName - MCP tool name
 * @param execute - async function performing the actual tool call
 * @param logDir - optional override for log directory (used in tests)
 */
export async function withLogging<T>(
	serverId: string,
	toolName: string,
	execute: () => Promise<T>,
	logDir?: string,
): Promise<T> {
	const start = Date.now();
	const logDirArg = logDir ?? LOG_DIR;

	await writeLog(
		{
			timestamp: new Date().toISOString(),
			event: "tool_call_start",
			serverId,
			toolName,
		},
		logDirArg,
	);

	try {
		const result = await execute();
		await writeLog(
			{
				timestamp: new Date().toISOString(),
				event: "tool_call_end",
				serverId,
				toolName,
				durationMs: Date.now() - start,
				status: "success",
			},
			logDirArg,
		);
		return result;
	} catch (e) {
		await writeLog(
			{
				timestamp: new Date().toISOString(),
				event: "tool_call_error",
				serverId,
				toolName,
				durationMs: Date.now() - start,
				status: "error",
				errorMessage: e instanceof Error ? e.message : String(e),
			},
			logDirArg,
		);
		throw e;
	}
}
