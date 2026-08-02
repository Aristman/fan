import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

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

export interface ExtensionState {
	lastBatchRun?: string; // ISO
	lastAutoSummary?: AutoSummary;
	previousBatchStats?: BatchStats;
	analyzedMtimes: Record<string, number>;
	weeklyDeferredUntil?: string; // ISO — отложено после отказа пользователя
}

const EMPTY_STATE: ExtensionState = {
	analyzedMtimes: {},
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
		return parsed;
	} catch {
		// Missing file, broken JSON, etc. → start fresh
		return { ...EMPTY_STATE, analyzedMtimes: {} };
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
		const json = JSON.stringify(state, null, 2) + "\n";
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

/**
 * Check if state.json exists.
 */
export function stateExists(extensionDir: string): boolean {
	return existsSync(getStatePath(extensionDir));
}
