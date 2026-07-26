/**
 * «Automation Hub» workspace template (F-3.4).
 *
 * Layout (spec section 2.2):
 * ```
 * my-automation/
 * ├── .fan/settings.json   # default {}
 * ├── scripts/             # automation scripts (*.sh, *.py)
 * │   └── example.sh       # placeholder example (see detection note)
 * ├── config/              # configuration files
 * ├── output/              # script output artifacts
 * └── logs/                # execution logs
 * ```
 *
 * Detection note: `detectWorkspaceType` classifies a workspace as
 * `automation` only when BOTH criteria hold: script files (`*.sh`/`*.py`
 * in the root or `scripts/`) AND config (a `config/` directory or
 * root-level `*.yaml`/`*.toml`/... files). A bare `scripts/` directory is
 * not enough — empty directories (and `.gitkeep` placeholders) do not
 * match the script glob. This template therefore ships `scripts/example.sh`,
 * a meaningful executable placeholder with a shebang, so that a freshly
 * applied template always detects as `automation`. It doubles as a
 * starting point / convention example for the user's own scripts.
 */

import type { WorkspaceTemplate } from "./types.js";

export const automationHubTemplate: WorkspaceTemplate = {
	name: "automation",
	description: "Automation hub: scripts/, config/, output/ and logs/ for scripting and ops automation",
	directories: [".fan", "scripts", "config", "output", "logs"],
	files: [
		{
			path: ".fan/settings.json",
			content: "{}\n",
		},
		{
			path: "scripts/example.sh",
			content: ({ projectName }) =>
				[
					"#!/usr/bin/env bash",
					"# Example automation script — replace with your own.",
					"# Conventions: configuration lives in config/, artifacts in output/, logs in logs/.",
					"set -euo pipefail",
					"",
					`echo "Hello from ${projectName} automation workspace"`,
					"",
				].join("\n"),
		},
	],
};
