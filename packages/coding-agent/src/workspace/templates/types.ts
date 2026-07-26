/**
 * Workspace templates (F-3.3, extended by F-3.4).
 *
 * A template is pure data: a list of directories to create and files to
 * write. The generic applier (`applyTemplate`) materializes any template
 * into a target directory without ever overwriting existing entries.
 */

/** Context passed to dynamic file content factories. */
export interface TemplateContext {
	/** Absolute path of the directory the template is applied to. */
	targetDir: string;
	/** Basename of the target directory (used e.g. as package name). */
	projectName: string;
}

/** A single file entry of a template. */
export interface TemplateFile {
	/** Path relative to the target directory. */
	path: string;
	/** Static content or a factory resolved against the target directory. */
	content: string | ((ctx: TemplateContext) => string);
}

/** Workspace template definition (data-only). */
export interface WorkspaceTemplate {
	/** Template name as used in `applyTemplate('code', ...)` and the API. */
	name: string;
	/** Human-readable description. */
	description: string;
	/** Directories to create (relative paths, created recursively). */
	directories: string[];
	/** Files to create (relative paths, skipped when already present). */
	files: TemplateFile[];
}

/** Result of a template application — what was created and what was skipped. */
export interface ApplyTemplateResult {
	/** Name of the applied template. */
	template: string;
	/** Absolute path the template was applied to. */
	targetDir: string;
	/** Directories created by this call (relative paths). */
	createdDirectories: string[];
	/** Files created by this call (relative paths). */
	createdFiles: string[];
	/** Entries that already existed and were left untouched (relative paths). */
	skipped: string[];
}
