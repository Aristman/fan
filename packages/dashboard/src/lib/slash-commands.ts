// @fan/dashboard/lib — slash command autocomplete data (F-3.9)
//
// Command source: STATIC list (no server endpoint exists — verified
// api-gateway http-server.ts has no /api/commands route). Chosen over adding
// GET /api/commands as the lowest-complexity option with honest value.
//
// Protocol reality (packages/coding-agent/src/core/agent-session.ts):
//   - `/skill:<name> <args>` → expanded to the skill's SKILL.md content
//     (_expandSkillCommand). This is the ONLY slash syntax that works when
//     sending text through the server (dashboard/RPC path).
//   - `/<template> <args>`  → user-defined prompt templates (cannot be
//     enumerated without an endpoint — excluded).
//   - Built-in TUI commands (/model, /compact, …) are interactive-mode only
//     and do NOT work via the server path — intentionally NOT listed.
//
// Ordering: commands relevant to the current workspace type (F-3.1) come
// first; the rest follow in a stable default order.

import { normalizeWorkspaceType } from "./workspace-type.js";

export interface SlashCommand {
	/** Command name without the leading slash, e.g. "skill:idea-lab". */
	name: string;
	/** Short human-readable description shown in the dropdown. */
	description: string;
}

/** All pre-installed FAN skills (skills/ dir, CLAUDE.md) as slash commands. */
const SKILL_COMMANDS: ReadonlyArray<SlashCommand> = [
	{ name: "skill:idea-lab", description: "Исследование идеи: SWOT, альтернативы, план действий" },
	{ name: "skill:research-spec-generator", description: "Исследование темы и генерация спецификации" },
	{ name: "skill:repo-explorer", description: "Анализ Git-репозитория (GitHub или локального)" },
	{ name: "skill:deep-dive", description: "Глубокий анализ аспекта кодовой базы" },
	{ name: "skill:code-research", description: "READ-ONLY анализ архитектуры и зависимостей" },
	{ name: "skill:bug-fix", description: "Автономное исправление бага (reproduce → fix → verify)" },
	{ name: "skill:auto-tests", description: "Автономная генерация тестов" },
	{ name: "skill:fan-forge", description: "Фабрика расширений и скиллов FAN" },
];

/** Names promoted to the top for each workspace type (in priority order). */
const TYPE_PRIORITY: Record<string, ReadonlyArray<string>> = {
	research: ["skill:idea-lab", "skill:research-spec-generator", "skill:deep-dive"],
	code: ["skill:bug-fix", "skill:auto-tests", "skill:code-research", "skill:repo-explorer"],
	automation: ["skill:repo-explorer", "skill:auto-tests"],
};

/**
 * Slash commands for the given workspace type, ordered so the most relevant
 * commands for the type come first. Unknown/missing type → default order.
 */
export function getSlashCommands(projectType?: string | null): SlashCommand[] {
	const type = normalizeWorkspaceType(projectType);
	const priority = TYPE_PRIORITY[type];
	if (!priority) return [...SKILL_COMMANDS];

	const rank = new Map(priority.map((name, i) => [name, i]));
	return [...SKILL_COMMANDS].sort((a, b) => {
		const ra = rank.get(a.name) ?? priority.length;
		const rb = rank.get(b.name) ?? priority.length;
		if (ra !== rb) return ra - rb;
		return SKILL_COMMANDS.indexOf(a) - SKILL_COMMANDS.indexOf(b);
	});
}

/**
 * Filter commands by the text typed after "/". Case-insensitive substring
 * match on the command name. Empty query → all commands.
 */
export function filterSlashCommands(commands: ReadonlyArray<SlashCommand>, query: string): SlashCommand[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...commands];
	return commands.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Decide whether the autocomplete dropdown should be active for the current
 * input value. Decision (documented): the dropdown opens ONLY when "/" is
 * the first character of the input and no space has been typed yet (i.e. the
 * user is still typing the command name). A "/" in the middle of the text
 * does NOT trigger autocomplete.
 */
export function isSlashCommandContext(inputValue: string): boolean {
	return inputValue.startsWith("/") && !inputValue.includes(" ");
}
