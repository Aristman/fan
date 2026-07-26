/**
 * Workspace templates — barrel + project creation orchestration (F-3.3, F-3.4).
 *
 * Re-exports the template types, the template registry/applier and the three
 * built-in templates (`code`, `research`, `automation`). Also provides
 * `createProject()`, the single entry point for creating a workspace from a
 * template.
 *
 * Boundary (documented decision): `createProject()` only touches the file
 * system and returns metadata. It deliberately does NOT update the project
 * registry (`~/.fan/agent/projects.json`) — registry writes are the
 * responsibility of the API layer (F-3.5, `POST /api/projects`), which owns
 * validation, auth and persistence.
 */

import { resolve } from "node:path";
import { PROJECT_TYPES, type ProjectType } from "../../core/project-registry.js";
import { detectWorkspaceType, type WorkspaceType } from "../detector.js";
import { applyTemplate } from "./apply-template.js";

export { applyTemplate, getTemplate, listTemplates, registerTemplate } from "./apply-template.js";
export { automationHubTemplate } from "./automation-hub.js";
export { codeProjectTemplate } from "./code-project.js";
export { researchLabTemplate } from "./research-lab.js";
export type { ApplyTemplateResult, TemplateContext, TemplateFile, WorkspaceTemplate } from "./types.js";

/** Metadata of a freshly created project workspace. */
export interface CreatedProjectMetadata {
	/** Absolute path of the created workspace (`resolve(rootPath, name)`). */
	path: string;
	/** Project name (directory basename). */
	name: string;
	/** Auto-detected workspace type after applying the template. */
	type: WorkspaceType;
	/** Name of the template that was applied. */
	template: string;
}

/**
 * Create a project workspace from a template.
 *
 * Orchestration: resolve the full path → apply the template → auto-detect
 * the workspace type on the resulting structure → return metadata.
 *
 * Does NOT register the project in `projects.json` — that is the API
 * layer's job (F-3.5).
 *
 * @param template Template name (`'code' | 'research' | 'automation'`).
 * @param name     Project name — used as the directory name under `rootPath`.
 * @param rootPath Parent directory for the new project.
 * @returns Metadata `{ path, name, type, template }`.
 * @throws  Error when the template name is not registered.
 */
export function createProject(template: string, name: string, rootPath: string): CreatedProjectMetadata {
	const path = resolve(rootPath, name);
	applyTemplate(template, path);
	const detected = detectWorkspaceType(path);
	// Fallback (documented decision): a freshly applied template may not yet
	// satisfy the detector's heuristics — e.g. 'code' requires `.git`, which
	// the template deliberately does not create (the user runs `git init`
	// when they are ready). When detection yields 'unknown', the template
	// name declares the intended type (only if it is a valid ProjectType).
	const type =
		detected !== "unknown" || !PROJECT_TYPES.includes(template as ProjectType)
			? detected
			: (template as WorkspaceType);
	return { path, name, type, template };
}
