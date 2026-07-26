/**
 * «Code Project» workspace template (F-3.3).
 *
 * Layout (spec section 2.2):
 * ```
 * my-project/
 * ├── .fan/settings.json   # default {}
 * ├── src/                 # empty directory
 * ├── tests/               # empty directory
 * ├── docs/                # empty directory
 * └── package.json         # minimal manifest, name from target dir basename
 * ```
 */

import type { WorkspaceTemplate } from "./types.js";

export const codeProjectTemplate: WorkspaceTemplate = {
	name: "code",
	description: "Code project: src/, tests/, docs/, .fan settings and a minimal package.json",
	directories: [".fan", "src", "tests", "docs"],
	files: [
		{
			path: ".fan/settings.json",
			content: "{}\n",
		},
		{
			path: "package.json",
			content: ({ projectName }) =>
				`${JSON.stringify({ name: projectName, version: "0.1.0", private: true }, null, 2)}\n`,
		},
	],
};
