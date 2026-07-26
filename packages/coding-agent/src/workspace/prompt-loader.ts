/**
 * Workspace system prompt loader (F-3.6).
 *
 * Provides a type-aware system prompt for a workspace:
 *
 *   loadSystemPrompt(cwd):
 *     1. detect workspace type (F-3.2, `workspace/detector.ts`)
 *     2. pick the base template for that type (code / research / automation),
 *        or the generic default prompt for `unknown`
 *     3. if `<cwd>/.fan/prompts/system.md` exists AND is non-empty (after
 *        trimming whitespace) → the custom content REPLACES the template
 *        entirely (no merge — spec section 2.4 / F-3.6 acceptance criterion 3)
 *     4. substitute prompt variables `{workspace_path}` and `{project_name}`
 *        in BOTH template and custom prompts
 *
 * Documented decisions:
 * - Empty override = no override. A `system.md` that is empty or contains
 *   only whitespace is ignored and the type template is used instead. This
 *   prevents an accidental empty file from producing an empty system prompt.
 * - `project_name` is the basename of the resolved workspace path.
 * - `workspace_path` uses forward slashes (consistent with the runtime
 *   prompt in `core/system-prompt.ts`).
 * - This module never throws: unreadable override files fall back to the
 *   type template (mirrors the detector's graceful-degradation contract).
 *
 * Integration point (NOT wired yet — separate feature/phase):
 * `AgentSession._rebuildSystemPrompt()` (core/agent-session.ts) calls
 * `buildSystemPrompt({ customPrompt, ... })`. Wiring this loader in means
 * passing `loadSystemPrompt(this._cwd)` as `customPrompt` (or via the
 * `ResourceLoader` systemPromptOverride hook, core/resource-loader.ts:147).
 * The runtime prompt (`buildSystemPrompt`) additionally appends tool
 * snippets, guidelines, context files, skills, date and cwd — this loader
 * supplies only the role/base part.
 */

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { detectWorkspaceType, type WorkspaceType } from "./detector.js";

/** Relative path of the custom system prompt override inside a workspace. */
export const SYSTEM_PROMPT_OVERRIDE_PATH = join(".fan", "prompts", "system.md");

/**
 * Base system prompts per workspace type (spec section 2.4).
 *
 * Variables `{workspace_path}` and `{project_name}` are substituted by
 * `loadSystemPrompt()` — they appear here verbatim on purpose.
 */
export const BASE_SYSTEM_PROMPTS: Readonly<Record<Exclude<WorkspaceType, "unknown">, string>> = {
	code: `You are a coding assistant working in a code repository at {workspace_path} (project "{project_name}").

Help with: code changes, testing, refactoring, PR preparation.
Available tools: bash (git, npm, etc.), read/write/edit files, grep/find.

Guidelines:
- Follow best practices for this codebase structure.
- Source code lives in src/, tests live in tests/ — keep new code and its tests in the right places.
- Run the project's test suite after making changes to verify correctness.
- Keep changes minimal and focused; don't refactor unrelated code.`,
	research: `You are a research assistant working in an analysis workspace at {workspace_path} (project "{project_name}").

Help with: SWOT analysis, competitive research, spec generation, data analysis.
Available tools: read/write/edit files, idea-lab skill, research-spec-generator skill.

Guidelines:
- Output goes to {workspace_path}/docs/research/ by default; final reports go to reports/.
- Store raw or intermediate data under data/, keep research documents in docs/research/.
- Structure findings as markdown documents with clear sections and sources.
- Prefer evidence-based conclusions; flag assumptions explicitly.`,
	automation: `You are an automation assistant working at {workspace_path} (project "{project_name}").

Help with: script creation, cron job setup, data processing pipelines.
Available tools: bash, file operations, cron management.

Guidelines:
- Scripts go to {workspace_path}/scripts/ by default; configuration goes to config/.
- Write task output to output/ and logs to logs/ — keep the workspace root clean.
- Make scripts idempotent and safe to re-run; fail loudly on errors.
- Document schedule, inputs and outputs in a header comment of each script.`,
};

/** Generic fallback prompt for workspaces of type `unknown`. */
export const DEFAULT_SYSTEM_PROMPT = `You are a general-purpose assistant working in a workspace at {workspace_path} (project "{project_name}").

Help with: answering questions, reading and writing files, running commands, organizing the workspace.
Available tools: bash, read/write/edit files, grep/find.

Guidelines:
- Inspect the workspace structure before making changes.
- Keep files organized; don't clutter the workspace root.
- Be concise and show file paths clearly when working with files.`;

/** Options for {@link loadSystemPrompt}. */
export interface LoadSystemPromptOptions {
	/**
	 * Explicit workspace type. When omitted, the type is auto-detected from
	 * the directory structure via `detectWorkspaceType()`.
	 */
	type?: WorkspaceType;
}

/**
 * Substitute prompt variables in `template`.
 *
 * Supported variables: `{workspace_path}`, `{project_name}`.
 * Unknown variables are left untouched.
 */
export function substitutePromptVariables(template: string, cwd: string): string {
	const workspacePath = resolve(cwd).replace(/\\/g, "/");
	const projectName = basename(workspacePath);
	return template.replaceAll("{workspace_path}", workspacePath).replaceAll("{project_name}", projectName);
}

/**
 * Read the custom system prompt override, if present and non-empty.
 *
 * Returns the raw file content (before variable substitution) or
 * `undefined` when the file is missing, unreadable, or empty/whitespace-only
 * (documented decision: empty override = no override).
 */
export function readSystemPromptOverride(cwd: string): string | undefined {
	try {
		const content = readFileSync(join(cwd, SYSTEM_PROMPT_OVERRIDE_PATH), "utf-8");
		return content.trim().length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

/** Base template for a workspace type (`unknown` → generic default). */
export function getBaseSystemPrompt(type: WorkspaceType): string {
	return type === "unknown" ? DEFAULT_SYSTEM_PROMPT : BASE_SYSTEM_PROMPTS[type];
}

/**
 * Load the system prompt for a workspace.
 *
 * Resolution order: custom override (`.fan/prompts/system.md`, non-empty)
 * → type template (`code`/`research`/`automation`) → generic default
 * (`unknown`). Variables `{workspace_path}` and `{project_name}` are
 * substituted in whichever source wins. Never throws.
 *
 * @param cwd Workspace root directory.
 * @returns The final system prompt text.
 */
export function loadSystemPrompt(cwd: string, options: LoadSystemPromptOptions = {}): string {
	const override = readSystemPromptOverride(cwd);
	const template = override ?? getBaseSystemPrompt(options.type ?? detectWorkspaceType(cwd));
	return substitutePromptVariables(template, cwd);
}
