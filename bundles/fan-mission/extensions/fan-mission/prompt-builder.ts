// Prompt builder for mission item execution (mission-loop step 4).
//
// The step-4 executor prompt used to be just `Execute mission item: <text>`,
// which forced the agent into a rediscovery cycle (memory_search → find →
// read all mission files → project research) on every iteration. This module
// assembles a context-rich prompt: MISSION.md body, ROADMAP (current item
// marked), STATE.md, BACKLOG.md (if non-empty), the `<promise>` reporting
// protocol and execution guidance — so the agent can start working directly.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EPIC_MARKER } from "./epic-delegation.js";
import { extractGoal, isRecurringItem, type MissionState, readMission, stripCurrentItemMarker } from "./file-state-manager.js";

// ─── Limits (protection against bloated STATE/BACKLOG/ROADMAP) ──────────────

/** Each variable section is capped at this many characters. */
export const MAX_SECTION_CHARS = 4000;
/** The whole assembled prompt is capped at this many characters. */
export const MAX_PROMPT_CHARS = 20000;

/**
 * 0.7.0 bootstrap planning: synthetic roadmap item the mission-loop feeds to
 * the executor when the ROADMAP has only checked items but the mission Goal
 * is not empty yet (bootstrap did not produce unchecked items). The guidance
 * line instructs the agent to decompose the Goal into ROADMAP items.
 */
export const PLANNING_ITEM_TEXT = "Plan: decompose mission Goal into ROADMAP items";

/** Guidance line appended for bootstrap/planning iterations. */
export const BOOTSTRAP_PLANNING_GUIDANCE =
	"- This is the bootstrap iteration: decompose the mission Goal into concrete unchecked ROADMAP.md items (- [ ] ...) and replace/extend the roadmap. Keep items atomic — one focused change per item, completable and verifiable in a single iteration (~20–30 minutes); split bigger areas into separate items.";

/**
 * F-22 size-heuristic: guidance appended for promoted idea items (marker
 * `(idea:<id>)` at the end). The executor must first assess the idea's size:
 * large → decompose into unchecked ROADMAP items below it and finish the
 * iteration as planning; small → implement directly as usual.
 */
export const IDEA_PLANNING_GUIDANCE =
	"- This roadmap item is a newly promoted operator idea (marker `(idea:<id>)`). FIRST assess its size honestly. If it needs more than one atomic verifiable change (e.g. new integration surface, multi-step feature, several modules/files, config + code + docs) — do NOT implement everything in this single iteration: instead decompose the idea into concrete, atomic, verifiable unchecked ROADMAP.md items and insert them directly BELOW this item, then mark THIS item as done ([x] — planning complete) and end the iteration; the loop will pick up the new items one by one. If it is genuinely small (single focused change) — implement, verify and complete it directly in this iteration as usual. Do not decompose trivially small ideas; do not implement large ideas in one run.";

/**
 * Anti-long-steps: guidance appended for REGULAR roadmap items (not planning,
 * not idea-promoted, not [EPIC], not recurring). Generalizes the F-22
 * mechanics to any oversized item: before executing, the agent assesses the
 * item's size; oversized items are decomposed into atomic sub-items instead of
 * being attempted in one giant iteration.
 */
export const ITEM_SIZE_GUIDANCE =
	"- Before starting, honestly assess the size of this roadmap item. If it clearly needs multiple unrelated changes or cannot be finished and verified in one focused iteration (~20–30 minutes) — do NOT attempt it all at once: decompose it into atomic, verifiable unchecked ROADMAP.md items and insert them directly BELOW this item, then mark THIS item as done ([x] — decomposed) and end the iteration; the loop will execute the new sub-items one by one. Do not split items that already fit in a single focused iteration.";

/** Guidance line appended for recurring items (R2: from RECURRING.md). */
export const RECUR_GUIDANCE =
	"- This is a RECURRING task: perform the work for this tick only, report results. The item lives in RECURRING.md (not ROADMAP) and is governed by its interval.";

/**
 * ralph-loop (S4): section appended when the executor runs in a FRESH session
 * (`session_mode: fresh`). Exact wording from
 * docs/research/ralph-loop-mission-mode.md §5.
 */
export const FRESH_SESSION_SECTION = [
	"## Session mode",
	"- This is a FRESH session (ralph loop): no prior conversation exists. All mission",
	"  state is in the sections above and in git history. Do NOT search for prior chat context.",
	"- The previous iteration's outcome is the latest BACKLOG entry and STATE.md.",
	"- Before finishing, record anything the NEXT iteration must know into STATE.md",
	"  '## Следующие шаги' — the next session will not remember this one.",
	// ralph-loop incident fix: oversized STATE.md is truncated on read — keep it
	// a compact handoff document, not a knowledge base.
	"- Keep STATE.md compact (past ~5KB it is truncated): details go to dedicated files",
	"  (RUNBOOK.md etc.), STATE.md keeps only next-steps and pointers.",
].join("\n");

const TRUNCATION_MARKER = "...[truncated]";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionPromptOptions {
	/** Absolute path of the mission directory (slug = basename). */
	missionDir: string;
	/** Text of the roadmap item being executed. */
	itemText: string;
	/** Line index of the current item in roadmapRaw (from parseFirstUnchecked). */
	index: number;
	/** Raw ROADMAP.md content. */
	roadmapRaw: string;
	/** Parsed STATE.md (done/blockers/nextSteps). */
	state: MissionState;
	/** Optional operator steer message(s) for this iteration. */
	steer?: string;
	/** R2: true when executing a recurring item from RECURRING.md. */
	recurring?: boolean;
	/** ralph-loop (S4): true when this iteration runs in a fresh session
	 * (`session_mode: fresh`) — adds the "Session mode" cold-start section. */
	freshSession?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Truncate text to `limit` characters, appending the truncation marker. */
function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Mark the current roadmap item: line `index` gets a "▶ " prefix inserted
 * before its first non-whitespace character (indentation preserved).
 */
function markCurrentItem(roadmapRaw: string, index: number): string {
	const lines = roadmapRaw.split("\n");
	if (index < 0 || index >= lines.length) return roadmapRaw;
	const m = /^(\s*)(\S.*)$/.exec(lines[index]);
	if (m) {
		lines[index] = `${m[1]}▶ ${m[2]}`;
	}
	return lines.join("\n");
}

/**
 * True when the current item is the bootstrap item: its text starts with
 * "Bootstrap mission:" (case-insensitive, default template wording) AND it
 * is the FIRST checklist item in the roadmap.
 */
export function isBootstrapItem(roadmapRaw: string, index: number, itemText: string): boolean {
	if (!/^bootstrap mission:/i.test(itemText)) return false;
	const lines = roadmapRaw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/^[-*] \[[x ]\] /.test(stripCurrentItemMarker(lines[i].trim()))) return i === index;
	}
	return false;
}

/**
 * F-22: true when the current item is a promoted idea — its text ends with
 * an `(idea:<id>)` marker (see idea-promoter.ts item format).
 */
export function isPromotedIdeaItem(itemText: string): boolean {
	return /\(idea:[^)]+\)\s*$/.test(itemText);
}

/** Render parsed STATE.md as simple lists; empty state → placeholder. */
function renderState(state: MissionState): string {
	const done = state.done ?? [];
	const blockers = state.blockers ?? [];
	const nextSteps = state.nextSteps ?? [];
	if (done.length === 0 && blockers.length === 0 && nextSteps.length === 0) {
		return "No prior state yet.";
	}
	const parts: string[] = [];
	if (done.length > 0) parts.push(`Done:\n${done.map((item) => `- ${item}`).join("\n")}`);
	if (blockers.length > 0) parts.push(`Blockers:\n${blockers.map((item) => `- ${item}`).join("\n")}`);
	if (nextSteps.length > 0) parts.push(`Next steps:\n${nextSteps.map((item) => `- ${item}`).join("\n")}`);
	return parts.join("\n");
}

/**
 * Read raw BACKLOG.md content. Returns null when the file is missing or
 * "empty" (no content beyond markdown headers, e.g. the default
 * `# Backlog` template) — the Backlog section is then omitted entirely.
 */
function readBacklogContent(missionDir: string): string | null {
	const backlogPath = join(missionDir, "BACKLOG.md");
	if (!existsSync(backlogPath)) return null;
	let raw: string;
	try {
		raw = readFileSync(backlogPath, "utf8");
	} catch {
		return null;
	}
	const meaningful = raw.split("\n").some((line) => {
		const trimmed = line.trim();
		return trimmed.length > 0 && !trimmed.startsWith("#");
	});
	if (!meaningful) return null;
	return raw.trim();
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the step-4 execution prompt enriched with mission context.
 *
 * The first line is always `Execute mission item: <itemText>` (kept stable
 * for executor/test compatibility). Sections: Mission context (MISSION.md
 * body without frontmatter), Roadmap (current item marked with "▶ "), State,
 * Backlog (only when non-empty), Operator steer (only when provided),
 * Reporting protocol (`<promise>` tags) and Guidance.
 *
 * Limits: each variable section ≤ MAX_SECTION_CHARS, total ≤ MAX_PROMPT_CHARS.
 */
export async function buildExecutionPrompt(opts: ExecutionPromptOptions): Promise<string> {
	const slug = basename(opts.missionDir);
	const mission = await readMission(opts.missionDir);
	const missionBody = mission.body.trim();
	const stateContent = renderState(opts.state);
	const roadmapContent = markCurrentItem(opts.roadmapRaw, opts.index);
	let backlogContent = readBacklogContent(opts.missionDir);
	// 0.7.0 bootstrap planning: the Goal→ROADMAP decomposition guidance is
	// added for the bootstrap item (first roadmap item, "Bootstrap mission:")
	// and for the synthetic planning item — only when the Goal is non-empty.
	const goalText = extractGoal(mission.body);
	const isPlanningIteration =
		goalText.length > 0 &&
		(opts.itemText === PLANNING_ITEM_TEXT || isBootstrapItem(opts.roadmapRaw, opts.index, opts.itemText));
	// F-22 size-heuristic: promoted idea items get size-assessment guidance —
	// except EPIC items (own delegation path) and bootstrap/planning iterations
	// (already guided by BOOTSTRAP_PLANNING_GUIDANCE).
	const isIdeaIteration =
		!isPlanningIteration && !opts.itemText.trimStart().startsWith(EPIC_MARKER) && isPromotedIdeaItem(opts.itemText);
	// Anti-long-steps: ITEM_SIZE_GUIDANCE applies ONLY to regular items —
	// excluded: planning iterations (own bootstrap guidance), promoted idea
	// items (F-22 guidance), [EPIC] items (own delegation path), recurring
	// items (tick semantics, never completed).
	const isEpicItem = opts.itemText.trimStart().startsWith(EPIC_MARKER);
	const isRecurringIteration = opts.recurring === true || isRecurringItem(opts.itemText);
	const isRegularItemIteration =
		!isPlanningIteration && !isIdeaIteration && !isEpicItem && !isRecurringIteration;

	const assemble = (): string => {
		const parts: string[] = [];
		parts.push(`Execute mission item: ${opts.itemText}`);
		parts.push("");
		parts.push("## Mission context (provided — do NOT re-read these files)");
		parts.push(`Mission: ${slug} (dir: ${opts.missionDir})`);
		if (missionBody) {
			parts.push(truncate(missionBody, MAX_SECTION_CHARS));
		}
		parts.push("");
		parts.push("## Roadmap (current item marked)");
		parts.push(truncate(roadmapContent, MAX_SECTION_CHARS));
		parts.push("");
		parts.push("## State");
		parts.push(truncate(stateContent, MAX_SECTION_CHARS));
		if (backlogContent !== null) {
			parts.push("");
			parts.push("## Backlog");
			parts.push(truncate(backlogContent, MAX_SECTION_CHARS));
		}
		if (opts.steer) {
			parts.push("");
			parts.push("## Operator steer");
			parts.push(truncate(opts.steer, MAX_SECTION_CHARS));
		}
		parts.push("");
		parts.push("## Reporting protocol");
		parts.push("When done, end your final message with exactly one tag:");
		parts.push("<promise>COMPLETE</promise> — item fully done and verified");
		parts.push("<promise>BLOCKED</promise> — cannot proceed (state what's missing)");
		parts.push("<promise>DECIDE</promise> — need operator decision (ask the question)");
		parts.push("<promise>FAILED</promise> — attempted, failed (state why)");
		parts.push("");
		parts.push("## Guidance");
		parts.push("- Mission files above are already provided — do not re-read them.");
		parts.push("- Work directly on small items; only delegate genuinely multi-file/multi-module work.");
		parts.push("- Commit meaningful results with clear messages.");
		parts.push(
			"- STATE.md sections must use EXACT Russian names: '## Сделано', '## Блокеры', '## Следующие шаги' (not 'Done', 'Blockers', 'Текущий шаг', etc.).",
		);
		if (isPlanningIteration) {
			parts.push(BOOTSTRAP_PLANNING_GUIDANCE);
			parts.push(
				"- Periodic tasks go into RECURRING.md with marker (interval: Ns/m/h/d) as checklist items: '- [ ] Task text (interval: 30m)' (or '## Task text (interval: 30m)'), NOT into ROADMAP.",
			);
		}
		// F-22 size-heuristic for promoted idea items (see isIdeaIteration above)
		if (isIdeaIteration) {
			parts.push(IDEA_PLANNING_GUIDANCE);
		}
		// R2: recurring items (from RECURRING.md or legacy (recur) marker)
		if (opts.recurring || isRecurringItem(opts.itemText)) {
			parts.push(RECUR_GUIDANCE);
		}
		// Anti-long-steps: regular items get size-assessment guidance (see
		// isRegularItemIteration above)
		if (isRegularItemIteration) {
			parts.push(ITEM_SIZE_GUIDANCE);
		}
		// ralph-loop (S4): fresh-session cold-start section (only when enabled)
		if (opts.freshSession === true) {
			parts.push("");
			parts.push(FRESH_SESSION_SECTION);
		}
		return parts.join("\n");
	};

	let prompt = assemble();

	// Total cap: first drop the lowest-priority optional section (Backlog),
	// then (unreachable safety net) hard-truncate the whole prompt.
	if (prompt.length > MAX_PROMPT_CHARS && backlogContent !== null) {
		backlogContent = null;
		prompt = assemble();
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		prompt = truncate(prompt, MAX_PROMPT_CHARS);
	}
	return prompt;
}
