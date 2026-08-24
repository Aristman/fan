// F-22: Промоушн одобренных идей из BACKLOG.md в ROADMAP.md.
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-22
//
// Контракт:
//   promoteAcceptedIdeas(missionDir, opts?): Promise<PromoteResult>
//
// Поведение:
//   1. readBacklog → записи со status === "ROADMAP" (одобрены скорером F-20).
//   2. Дедупликация: идея уже промоучена, если ROADMAP.md содержит `(idea:<id>)`.
//   3. Добавить unchecked-пункт: `- [ ] <текст> (idea:<id>)`.
//   4. Капы: ≤3 промоушнов за вызов; roadmap ≥50 пунктов → не промоутить.
//   5. updateBacklogEntry(id, { status: "PROMOTED" }) — защита от повторного промоушна.
//
// Ошибки промоушна не роняют контур (try/catch в месте вызова).

import type { BacklogEntry } from "./file-state-manager.js";
import { readBacklog, readRoadmap, stripCurrentItemMarker, updateBacklogEntry, writeRoadmap } from "./file-state-manager.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Максимум идей, промоутируемых за один вызов promoteAcceptedIdeas. */
export const MAX_PROMOTE_PER_TICK = 3;

/** Максимум пунктов в ROADMAP.md; при достижении промоушн блокируется. */
export const MAX_ROADMAP_ITEMS = 50;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PromoteResult {
	promoted: string[];
}

export interface PromoteOptions {
	/** Override max promoted per call (default MAX_PROMOTE_PER_TICK = 3). */
	maxPerTick?: number;
	/** Override max roadmap items (default MAX_ROADMAP_ITEMS = 50). */
	maxRoadmapItems?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Count checklist items (both checked and unchecked) in ROADMAP.md content. */
function countRoadmapItems(raw: string): number {
	let count = 0;
	for (const line of raw.split("\n")) {
		if (/^[-*] \[[x ]\] /.test(stripCurrentItemMarker(line.trim()))) count++;
	}
	return count;
}

/** Extract all idea-id markers `(idea:<id>)` from ROADMAP.md content. */
function extractIdeaIds(raw: string): Set<string> {
	const ids = new Set<string>();
	const matches = raw.matchAll(/\(idea:([^)]+)\)/g);
	for (const m of matches) {
		ids.add(m[1]);
	}
	return ids;
}

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Promote BACKLOG ideas with status "ROADMAP" to ROADMAP.md as unchecked
 * checklist items. Each promoted idea gets `(idea:<id>)` marker for
 * deduplication and its BACKLOG status is updated to "PROMOTED".
 *
 * Caps:
 *   - ≤3 promotions per call (configurable via opts.maxPerTick)
 *   - Skip promotion when ROADMAP.md has ≥50 items (configurable via opts.maxRoadmapItems)
 *
 * Deduplication:
 *   - An idea is already promoted if ROADMAP.md contains `(idea:<id>)`
 *   - Ideas with status "PROMOTED" in BACKLOG are never re-promoted
 */
export async function promoteAcceptedIdeas(missionDir: string, opts?: PromoteOptions): Promise<PromoteResult> {
	const maxPerTick = opts?.maxPerTick ?? MAX_PROMOTE_PER_TICK;
	const maxItems = opts?.maxRoadmapItems ?? MAX_ROADMAP_ITEMS;

	const backlog = await readBacklog(missionDir);
	const roadmapIdeas = backlog.filter((e: BacklogEntry) => e.status === "ROADMAP");

	if (roadmapIdeas.length === 0) return { promoted: [] };

	let roadmapRaw: string;
	try {
		roadmapRaw = await readRoadmap(missionDir);
	} catch {
		return { promoted: [] };
	}

	// Cap: roadmap too large → refuse to promote.
	if (countRoadmapItems(roadmapRaw) >= maxItems) return { promoted: [] };

	const existingIds = extractIdeaIds(roadmapRaw);
	const promoted: string[] = [];

	for (const entry of roadmapIdeas) {
		if (promoted.length >= maxPerTick) break;
		if (existingIds.has(entry.id)) continue;

		// Append unchecked item with idea-id marker.
		const itemText = `${entry.idea} (idea:${entry.id})`;
		const line = `- [ ] ${itemText}`;

		roadmapRaw = roadmapRaw.endsWith("\n") ? `${roadmapRaw}${line}\n` : `${roadmapRaw}\n${line}\n`;

		await writeRoadmap(missionDir, roadmapRaw);
		await updateBacklogEntry(missionDir, entry.id, { status: "PROMOTED" });

		promoted.push(entry.id);
		existingIds.add(entry.id);
	}

	return { promoted };
}
