/**
 * Generic workspace template applier (F-3.3).
 *
 * Applies a template (data-only description, see `types.ts`) to a target
 * directory: creates directories recursively and writes files with their
 * default content. NEVER overwrites existing files or directories —
 * already-present entries are reported in `skipped`, making repeated
 * calls idempotent.
 *
 * Templates are registered by name: `'code'` (F-3.3), `'research'` and
 * `'automation'` (F-3.4). The barrel `index.ts` re-exports everything.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { automationHubTemplate } from "./automation-hub.js";
import { codeProjectTemplate } from "./code-project.js";
import { researchLabTemplate } from "./research-lab.js";
import type { ApplyTemplateResult, TemplateContext, WorkspaceTemplate } from "./types.js";

/** Registry of available templates, keyed by template name. */
const templates = new Map<string, WorkspaceTemplate>();

/** Register a template. Overwrites any previous template with the same name. */
export function registerTemplate(template: WorkspaceTemplate): void {
	templates.set(template.name, template);
}

/** Look up a template by name. Returns undefined for unknown names. */
export function getTemplate(name: string): WorkspaceTemplate | undefined {
	return templates.get(name);
}

/** Names of all registered templates. */
export function listTemplates(): string[] {
	return [...templates.keys()];
}

registerTemplate(codeProjectTemplate);
registerTemplate(researchLabTemplate);
registerTemplate(automationHubTemplate);

/**
 * Apply a workspace template to a target directory.
 *
 * @param template  Template name (e.g. `'code'`) or a template object.
 * @param targetDir Directory to materialize the template into
 *                  (created recursively when missing).
 * @returns What was created and what was skipped (for logs/API).
 * @throws  Error when the template name is not registered.
 */
export function applyTemplate(template: string | WorkspaceTemplate, targetDir: string): ApplyTemplateResult {
	const resolved = typeof template === "string" ? templates.get(template) : template;
	if (!resolved) {
		throw new Error(`Unknown template: ${template}`);
	}

	const absoluteTarget = resolve(targetDir);
	const ctx: TemplateContext = {
		targetDir: absoluteTarget,
		projectName: basename(absoluteTarget),
	};

	const result: ApplyTemplateResult = {
		template: resolved.name,
		targetDir: absoluteTarget,
		createdDirectories: [],
		createdFiles: [],
		skipped: [],
	};

	mkdirSync(absoluteTarget, { recursive: true });

	for (const dir of resolved.directories) {
		const absolute = join(absoluteTarget, dir);
		if (existsSync(absolute)) {
			result.skipped.push(dir);
			continue;
		}
		mkdirSync(absolute, { recursive: true });
		result.createdDirectories.push(dir);
	}

	for (const file of resolved.files) {
		const absolute = join(absoluteTarget, file.path);
		if (existsSync(absolute)) {
			result.skipped.push(file.path);
			continue;
		}
		mkdirSync(dirname(absolute), { recursive: true });
		const content = typeof file.content === "function" ? file.content(ctx) : file.content;
		writeFileSync(absolute, content, "utf-8");
		result.createdFiles.push(file.path);
	}

	return result;
}
