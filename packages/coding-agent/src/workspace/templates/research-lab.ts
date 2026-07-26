/**
 * «Research Lab» workspace template (F-3.4).
 *
 * Layout (spec section 2.2):
 * ```
 * my-research/
 * ├── .fan/
 * │   ├── prompts/         # custom system prompt overrides (F-3.6)
 * │   └── settings.json    # default {}
 * ├── docs/research/       # research documents (idea-lab, research-spec output)
 * ├── data/                # raw / intermediate data
 * └── reports/             # final reports
 * ```
 *
 * Detection note: `detectWorkspaceType` classifies a workspace as `research`
 * when `docs/research/` OR `.fan/prompts/` exists — this template creates
 * both, so a freshly applied template always detects as `research`.
 */

import type { WorkspaceTemplate } from "./types.js";

export const researchLabTemplate: WorkspaceTemplate = {
	name: "research",
	description: "Research lab: .fan/prompts/, docs/research/, data/ and reports/ for non-code investigation work",
	directories: [".fan", ".fan/prompts", "docs/research", "data", "reports"],
	files: [
		{
			path: ".fan/settings.json",
			content: "{}\n",
		},
	],
};
