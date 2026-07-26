/**
 * Workspace type auto-detection by directory structure (F-3.2).
 *
 * Canonical implementation of the detection rules from spec section 2.1.
 * Priority order: code > research > automation > unknown.
 *
 * Criteria:
 * - `code`:       `.git` entry (dir or file — worktrees/submodules use a
 *                 gitfile) AND (`src/` directory OR `package.json` file)
 * - `research`:   `docs/research/` directory OR `.fan/prompts/` directory
 * - `automation`: script files (`*.sh`, `*.py`) AND config files (see below)
 * - `unknown`:    no criterion matched
 *
 * Automation glob scope (documented decisions):
 * - Scripts are searched in the workspace ROOT and in the `scripts/`
 *   subdirectory (one level, matching the "Automation Hub" template layout).
 * - Config files are: a `config/` directory in the root, OR root-level files
 *   with extensions `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`. `*.json` is
 *   deliberately excluded — `package.json`/`tsconfig.json` would otherwise
 *   misclassify non-git JS projects as automation workspaces.
 *
 * Error handling: this module never throws. Missing directories, permission
 * errors and fs races all result in a graceful fallthrough to "unknown".
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ProjectType } from "../core/project-registry.js";

/** Workspace classification — alias of the registry ProjectType. */
export type WorkspaceType = ProjectType;

/** Script extensions that count toward the automation criterion. */
const SCRIPT_EXTENSIONS: readonly string[] = [".sh", ".py"];

/** Config file extensions that count toward the automation criterion (root level). */
const CONFIG_EXTENSIONS: readonly string[] = [".yaml", ".yml", ".toml", ".ini", ".cfg"];

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** List files (not directories) directly inside `dir`. Empty on any error. */
function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function hasExtension(files: string[], extensions: readonly string[]): boolean {
	return files.some((file) => extensions.includes(extname(file).toLowerCase()));
}

/** Scripts (*.sh, *.py) in the workspace root or in the scripts/ subdirectory. */
function hasScripts(cwd: string): boolean {
	if (hasExtension(listFiles(cwd), SCRIPT_EXTENSIONS)) return true;
	const scriptsDir = join(cwd, "scripts");
	return isDirectory(scriptsDir) && hasExtension(listFiles(scriptsDir), SCRIPT_EXTENSIONS);
}

/** A config/ directory or root-level config files (*.yaml/*.yml/*.toml/*.ini/*.cfg). */
function hasConfig(cwd: string): boolean {
	if (isDirectory(join(cwd, "config"))) return true;
	return hasExtension(listFiles(cwd), CONFIG_EXTENSIONS);
}

/**
 * Detect the workspace type by scanning the directory structure.
 *
 * Returns "unknown" for non-existent paths and on any fs error — never throws.
 */
export function detectWorkspaceType(cwd: string): WorkspaceType {
	try {
		// code: .git (dir or gitfile) + (src/ or package.json)
		const hasGit = existsSync(join(cwd, ".git"));
		const hasSrc = isDirectory(join(cwd, "src")) || isFile(join(cwd, "package.json"));
		if (hasGit && hasSrc) return "code";

		// research: docs/research/ or .fan/prompts/
		if (isDirectory(join(cwd, "docs", "research")) || isDirectory(join(cwd, ".fan", "prompts"))) {
			return "research";
		}

		// automation: scripts + config files
		if (hasScripts(cwd) && hasConfig(cwd)) return "automation";
	} catch {
		// fs errors (permissions, races) → fall through to "unknown"
	}
	return "unknown";
}
