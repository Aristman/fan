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
import { type MissionState, readMission } from "./file-state-manager.js";

// ─── Limits (protection against bloated STATE/BACKLOG/ROADMAP) ──────────────

/** Each variable section is capped at this many characters. */
export const MAX_SECTION_CHARS = 4000;
/** The whole assembled prompt is capped at this many characters. */
export const MAX_PROMPT_CHARS = 20000;

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
