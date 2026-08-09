import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { GoldenEntry } from "./types.js";

// ============================================================================
// State types
// ============================================================================

export interface AutoSummary {
	sessionId: string;
	score: number;
	findingsHigh: number;
	findingsMedium: number;
	findingsLow: number;
	reportPath: string;
	analyzedAt: string; // ISO
	shownAt?: string; // ISO — когда показали пользователю
	loopCount?: number;
	errorCount?: number;
	overheadPercent?: number;
}

export interface BatchStats {
	avgScore: number;
	sessionCount: number;
	findingsBySeverity: { high: number; medium: number; low: number };
	topDetectors: Array<{ detectorId: string; count: number }>;
	periodStart: string; // ISO
	periodEnd: string; // ISO
}

/** Record of an analyzed session with metadata for incremental skip. */
export interface AnalyzedEntry {
	mtime: number;
	analyzedAt: string; // ISO
	reportPath?: string;
}

export interface ExtensionState {
	lastBatchRun?: string; // ISO
	lastAutoSummary?: AutoSummary;
	previousBatchStats?: BatchStats;
	/** @deprecated — kept for backward-compat reads; new code writes to `analyzed`. */
	analyzedMtimes: Record<string, number>;
	/** New incremental state: maps absolute jsonl path → analysis metadata. */
	analyzed?: Record<string, AnalyzedEntry>;
	weeklyDeferredUntil?: string; // ISO — отложено после отказа пользователя
	golden?: GoldenEntry[]; // F12 — эталонные сессии
}

const EMPTY_STATE: ExtensionState = {
	analyzedMtimes: {},
	analyzed: {},
	golden: [],
};

// ============================================================================
// State I/O
// ============================================================================

function getStatePath(extensionDir: string): string {
	return join(extensionDir, "state.json");
}

/**
 * Load state from state.json.
 * Broken JSON or missing file → empty state (no crash).
 */
export async function loadState(extensionDir: string): Promise<ExtensionState> {
	const statePath = getStatePath(extensionDir);
	try {
		const raw = await readFile(statePath, "utf-8");
		const parsed = JSON.parse(raw) as ExtensionState;
		// Ensure analyzedMtimes exists
		if (!parsed.analyzedMtimes || typeof parsed.analyzedMtimes !== "object") {
			parsed.analyzedMtimes = {};
		}
		// Ensure analyzed exists
		if (
			!parsed.analyzed ||
			typeof parsed.analyzed !== "object" ||
			Array.isArray(parsed.analyzed)
		) {
			parsed.analyzed = {};
		}
		// Migration: old analyzedMtimes → new analyzed (analyzedAt unknown → "")
		if (parsed.analyzedMtimes && Object.keys(parsed.analyzedMtimes).length > 0) {
			for (const [path, mtime] of Object.entries(parsed.analyzedMtimes)) {
				if (!parsed.analyzed[path]) {
					parsed.analyzed[path] = { mtime, analyzedAt: "", reportPath: undefined };
				}
			}
		}
		// Backward compat: absence of golden → []
		if (!Array.isArray(parsed.golden)) {
			parsed.golden = [];
		}
		return parsed;
	} catch {
		// Missing file, broken JSON, etc. → start fresh
		return { ...EMPTY_STATE, analyzedMtimes: {}, analyzed: {}, golden: [] };
	}
}

/**
 * Save state atomically (tmp + rename).
 * Errors are swallowed — broken save does not crash the extension.
 */
export async function saveState(
	extensionDir: string,
	state: ExtensionState,
): Promise<boolean> {
	const statePath = getStatePath(extensionDir);
	const tmpPath = statePath + ".tmp";
	try {
		await mkdir(dirname(statePath), { recursive: true });
		// Strip deprecated analyzedMtimes from persisted JSON
		const { analyzedMtimes: _strip, ...toWrite } = state;
		const json = JSON.stringify(toWrite, null, 2) + "\n";
		await writeFile(tmpPath, json, "utf-8");
		await rename(tmpPath, statePath);
		return true;
	} catch {
		// Cleanup tmp on failure
		try {
			const { unlink } = await import("node:fs/promises");
			await unlink(tmpPath);
		} catch {
			// tmp doesn't exist
		}
		return false;
	}
}

// ============================================================================
// Incremental analysis helpers
// ============================================================================

/**
 * Check whether a session was already analyzed with the same mtime.
 * Returns the AnalyzedEntry if matched, undefined otherwise.
 */
export function getAnalyzedEntry(
	state: ExtensionState,
	sessionPath: string,
	currentMtime: number,
): AnalyzedEntry | undefined {
	const entry = state.analyzed?.[sessionPath];
	if (entry && entry.mtime === currentMtime) return entry;
	return undefined;
}

/**
 * Mark a session as analyzed (or re-analyzed) in state.
 */
export function markAnalyzed(
	state: ExtensionState,
	sessionPath: string,
	mtime: number,
	reportPath?: string,
): void {
	if (!state.analyzed) state.analyzed = {};
	state.analyzed[sessionPath] = {
		mtime,
		analyzedAt: new Date().toISOString(),
		reportPath,
	};
}
