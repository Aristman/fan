// F-21: Metrics collector — per-iteration mission metrics (JSONL append-only).
// Appends one JSON line per iteration to <missionDir>/metrics.jsonl and aggregates
// failure / premature-termination rates (MAST-oriented, spec §5.2 / §6.1).
// On-disk state survives process restarts; corrupt/blank lines are skipped on read.

import { appendFile, type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Status classification (locked by F-21 contract) ────────────────────────

/** Statuses counted into failureRate. */
export const FAILURE_STATUSES = ["failed", "failed_watchdog"];

/** Statuses counted into prematureTerminationRate. */
export const PREMATURE_STATUSES = ["failed_watchdog", "watchdog", "budget_exhausted"];

const FAILURE_SET = new Set(FAILURE_STATUSES);
const PREMATURE_SET = new Set(PREMATURE_STATUSES);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IterationRecord {
	iteration: number;
	tokensIn: number;
	tokensOut: number;
	durationMs: number;
	status: string;
	promiseTag?: string | null;
	verificationResult?: string | null;
}

export interface MissionMetrics {
	totalIterations: number;
	avgDurationMs: number;
	failureRate: number;
	prematureTerminationRate: number;
	totalTokensIn: number;
	totalTokensOut: number;
}

export interface MetricsCollector {
	onIterationEnd(missionDir: string, record: IterationRecord): Promise<void>;
	getMetrics(missionDir: string): Promise<MissionMetrics>;
}

export interface MetricsCollectorOptions {
	/** DI clock; default () => new Date(). */
	now?: () => Date;
}

const METRICS_FILE = "metrics.jsonl";

function metricsPath(missionDir: string): string {
	return join(missionDir, METRICS_FILE);
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Check whether the file exists and its last byte is NOT '\n'.
 * Returns true when a leading '\n' must be prepended before appending
 * to avoid concatenating the new record with the previous (truncated) line.
 * Uses fs.open + fstat + 1-byte read — never loads the whole file.
 */
async function needsLeadingNewline(filePath: string): Promise<boolean> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(filePath, "r");
		const stat = await fh.stat();
		if (stat.size === 0) return false;
		const buf = Buffer.alloc(1);
		await fh.read(buf, 0, 1, stat.size - 1);
		return buf[0] !== 0x0a; // 0x0a = '\n'
	} catch (err: unknown) {
		if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return false; // file doesn't exist yet — first append, no prefix needed
		}
		throw err;
	} finally {
		await fh?.close();
	}
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMetricsCollector(opts?: MetricsCollectorOptions): MetricsCollector {
	const now = opts?.now ?? (() => new Date());

	return {
		async onIterationEnd(missionDir: string, record: IterationRecord): Promise<void> {
			const line = `${JSON.stringify({ ...record, timestamp: now().toISOString() })}\n`;
			await mkdir(missionDir, { recursive: true });
			const path = metricsPath(missionDir);
			const prefix = (await needsLeadingNewline(path)) ? "\n" : "";
			await appendFile(path, prefix + line, "utf8");
		},

		async getMetrics(missionDir: string): Promise<MissionMetrics> {
			let content: string;
			try {
				content = await readFile(metricsPath(missionDir), "utf8");
			} catch {
				content = "";
			}

			let total = 0;
			let failures = 0;
			let premature = 0;
			let durationSum = 0;
			let tokensIn = 0;
			let tokensOut = 0;

			for (const raw of content.split("\n")) {
				const line = raw.trim();
				if (line.length === 0) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue; // corrupt line — skip, never fail aggregation
				}
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const rec = entry as Record<string, unknown>;

				total += 1;
				durationSum += asNumber(rec.durationMs);
				tokensIn += asNumber(rec.tokensIn);
				tokensOut += asNumber(rec.tokensOut);
				const status = typeof rec.status === "string" ? rec.status : "";
				if (FAILURE_SET.has(status)) failures += 1;
				if (PREMATURE_SET.has(status)) premature += 1;
			}

			return {
				totalIterations: total,
				avgDurationMs: total > 0 ? durationSum / total : 0,
				failureRate: total > 0 ? failures / total : 0,
				prematureTerminationRate: total > 0 ? premature / total : 0,
				totalTokensIn: tokensIn,
				totalTokensOut: tokensOut,
			};
		},
	};
}
