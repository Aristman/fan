import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Single per-project budget entry (F-4.9). */
export interface ProjectBudgetEntry {
	/** Token cap for the project (sum of assistant-message tokens across its sessions). */
	tokenLimit: number;
	/** ISO 8601 timestamp of the last update. */
	updatedAt: string;
}

/** On-disk format of project-budgets.json. */
interface ProjectBudgetsFile {
	version: 1;
	budgets: Record<string, ProjectBudgetEntry>;
}

/**
 * File-based per-project token budget store (F-4.9, part A).
 *
 * Storage decision (documented per the F-4.9 task): a dedicated JSON file
 * `project-budgets.json` in the FAN agent dir (default `~/.fan/agent/`,
 * next to the `projects.json` registry) instead of Prisma. Rationale:
 * - the gateway's per-project budget is a scheduler-facing control plane,
 *   not user data — a flat file keeps it inspectable/editable and free of
 *   DB migrations;
 * - write volume is tiny (one write per task start);
 * - the file is the single source of truth shared by server restarts,
 *   matching the JSONL-sessions philosophy (disk = truth).
 *
 * Keys are project paths; the CALLER must normalize them (the HTTP layer
 * uses the same normalizeProjectPath as the ?project= session filter, so
 * `C:\proj` and `c:/proj` resolve to one entry).
 *
 * Writes are atomic (temp file + rename) and synchronous — the file is a
 * few hundred bytes and writes happen once per task launch, so sync I/O
 * keeps the store free of async state/locking concerns.
 *
 * A missing or corrupted file is treated as an empty store (limits are a
 * protective mechanism, but losing them must not break the gateway; the
 * scheduler re-sets the cap before every task anyway).
 */
export class ProjectBudgetStore {
	constructor(readonly filePath: string) {}

	/** Returns the entry for a (normalized) project path, or null when unset. */
	get(project: string): ProjectBudgetEntry | null {
		return this.load().budgets[project] ?? null;
	}

	/** Sets (or replaces) the token limit for a (normalized) project path. */
	set(project: string, tokenLimit: number): ProjectBudgetEntry {
		const data = this.load();
		const entry: ProjectBudgetEntry = { tokenLimit, updatedAt: new Date().toISOString() };
		data.budgets[project] = entry;
		this.save(data);
		return entry;
	}

	private load(): ProjectBudgetsFile {
		if (!existsSync(this.filePath)) return { version: 1, budgets: {} };
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<ProjectBudgetsFile>;
			if (raw === null || typeof raw !== "object" || typeof raw.budgets !== "object" || raw.budgets === null) {
				return { version: 1, budgets: {} };
			}
			return { version: 1, budgets: raw.budgets as Record<string, ProjectBudgetEntry> };
		} catch {
			// Corrupted file → empty store (see class docblock).
			return { version: 1, budgets: {} };
		}
	}

	private save(data: ProjectBudgetsFile): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmpPath = `${this.filePath}.tmp-${process.pid}`;
		writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
		renameSync(tmpPath, this.filePath);
	}
}
