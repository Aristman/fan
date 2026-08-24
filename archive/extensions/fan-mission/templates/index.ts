// Template loader for fan-mission init.
// Resolves template files by name (e.g. "default", "refactor") and returns
// the rendered content for each of the 5 mission files.

export const AVAILABLE_TEMPLATES = ["default", "refactor"] as const;
export type TemplateName = (typeof AVAILABLE_TEMPLATES)[number];

export interface MissionTemplateFiles {
	"MISSION.md": string;
	"ROADMAP.md": string;
	"STATE.md": string;
	"BACKLOG.md": string;
	"DECISIONS.md": string;
	"RECURRING.md": string;
}

/**
 * Check whether a template name is known.
 */
export function isKnownTemplate(name: string): name is TemplateName {
	return (AVAILABLE_TEMPLATES as readonly string[]).includes(name);
}

/**
 * Load the 5 template files for the given template name.
 * Throws if the template is unknown.
 */
export async function loadTemplate(name: string): Promise<MissionTemplateFiles> {
	if (!isKnownTemplate(name)) {
		throw new Error(`Unknown mission template: "${name}". Available: ${AVAILABLE_TEMPLATES.join(", ")}`);
	}

	// Resolve the template directory relative to this module.
	// Works in both dev (.ts via tsx/bun) and compiled (.js) modes.
	const here = new URL(".", import.meta.url);
	const templateDir = new URL(`./${name}/`, here);

	const [missionMod, roadmapMod, stateMod, backlogMod, decisionsMod, recurringMod] = await Promise.all([
		import(new URL("MISSION.md.ts", templateDir).href),
		import(new URL("ROADMAP.md.ts", templateDir).href),
		import(new URL("STATE.md.ts", templateDir).href),
		import(new URL("BACKLOG.md.ts", templateDir).href),
		import(new URL("DECISIONS.md.ts", templateDir).href),
		import(new URL("RECURRING.md.ts", templateDir).href),
	]);

	return {
		"MISSION.md": missionMod.MISSION_MD,
		"ROADMAP.md": roadmapMod.ROADMAP_MD,
		"STATE.md": stateMod.STATE_MD,
		"BACKLOG.md": backlogMod.BACKLOG_MD,
		"DECISIONS.md": decisionsMod.DECISIONS_MD,
		"RECURRING.md": recurringMod.RECURRING_MD,
	};
}

/**
 * Render a template string by replacing {{description}}, {{slug}},
 * {{mission_id}}, {{now}}. {{description}} is handled FIRST so a
 * description containing template-like text is not re-processed.
 * Empty/missing description → the placeholder LINE is dropped entirely,
 * keeping the rendered file byte-identical to the pre-0.7.0 layout.
 */
export function renderTemplate(
	raw: string,
	vars: { slug: string; missionId: string; now: string; description?: string },
): string {
	let out = raw;
	if (vars.description) {
		out = out.replace(/\{\{description\}\}/g, vars.description);
	} else {
		// Drop lines containing only the placeholder (no stray blank line).
		out = out.replace(/^[ \t]*\{\{description\}\}[ \t]*\r?\n/gm, "");
		out = out.replace(/\{\{description\}\}/g, "");
	}
	return out
		.replace(/\{\{slug\}\}/g, vars.slug)
		.replace(/\{\{mission_id\}\}/g, vars.missionId)
		.replace(/\{\{now\}\}/g, vars.now);
}
