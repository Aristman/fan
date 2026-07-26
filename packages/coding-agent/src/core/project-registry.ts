/**
 * Project registry — persistent list of known workspaces.
 *
 * Stored as a JSON array in `<agentDir>/projects.json`
 * (agent dir resolves via FAN_CODING_AGENT_DIR env or ~/.fan/agent — see config.ts).
 *
 * Format: [{ "path": "/abs/path", "name": "basename", "type": "code|research|automation|unknown", "addedAt": "ISO8601" }]
 *
 * Guarantees:
 * - Atomic writes: content is written to a temp file in the same directory,
 *   then renamed over the target (no torn/partial files on crash).
 * - Deduplication by path: adding an already-registered path is a no-op.
 *   The existing entry is returned unchanged — `name`/`type` are NOT overwritten.
 * - Missing or corrupted registry file: read operations return an empty array
 *   (with a warning logged for corrupted content) instead of throwing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { getAgentDir } from "../config.js";

export type ProjectType = "code" | "research" | "automation" | "unknown";

export interface ProjectEntry {
	/** Absolute path to the project workspace. */
	path: string;
	/** Display name (basename of the path by default). */
	name: string;
	/** Project classification. */
	type: ProjectType;
	/** ISO 8601 timestamp of when the project was registered. */
	addedAt: string;
}

export const PROJECT_TYPES: readonly ProjectType[] = ["code", "research", "automation", "unknown"];

/** Get path to projects.json registry file. */
export function getProjectsPath(): string {
	return join(getAgentDir(), "projects.json");
}

function isValidEntry(entry: unknown): entry is ProjectEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return (
		typeof e.path === "string" &&
		e.path.length > 0 &&
		typeof e.name === "string" &&
		PROJECT_TYPES.includes(e.type as ProjectType) &&
		typeof e.addedAt === "string"
	);
}

/**
 * Read the project registry.
 * Returns an empty array when the file is missing, contains invalid JSON,
 * or does not hold a JSON array. A warning is logged for corrupted content.
 * Never throws on file/parse errors.
 */
export function listProjects(projectsPath: string = getProjectsPath()): ProjectEntry[] {
	if (!existsSync(projectsPath)) {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(projectsPath, "utf-8"));
	} catch (error) {
		console.warn(
			`[project-registry] Failed to parse ${projectsPath}, treating as empty registry:`,
			error instanceof Error ? error.message : String(error),
		);
		return [];
	}

	if (!Array.isArray(parsed)) {
		console.warn(`[project-registry] ${projectsPath} does not contain a JSON array, treating as empty registry`);
		return [];
	}

	return parsed.filter(isValidEntry);
}

/**
 * Atomically write the registry: write temp file in the same directory,
 * then rename over the target. Temp file is cleaned up on failure.
 */
function writeProjectsAtomic(projectsPath: string, projects: ProjectEntry[]): void {
	const dir = dirname(projectsPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const tmpPath = join(dir, `projects.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tmpPath, JSON.stringify(projects, null, 2), "utf-8");
		renameSync(tmpPath, projectsPath);
	} catch (error) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// best effort cleanup
		}
		throw error;
	}
}

export interface AddToProjectsResult {
	/** True when a new entry was created; false when the path was already registered. */
	added: boolean;
	/** The resulting registry entry (new or pre-existing). */
	entry: ProjectEntry;
}

/**
 * Add a project to the registry.
 *
 * Deduplicates by resolved absolute path: if the path is already registered,
 * the existing entry is returned unchanged (`name` and `type` are NOT overwritten)
 * and `added` is false.
 */
export function addToProjects(
	path: string,
	name?: string,
	type: ProjectType = "unknown",
	projectsPath: string = getProjectsPath(),
): AddToProjectsResult {
	const resolvedPath = resolve(path);
	const projects = listProjects(projectsPath);

	const existing = projects.find((p) => p.path === resolvedPath);
	if (existing) {
		return { added: false, entry: existing };
	}

	const entry: ProjectEntry = {
		path: resolvedPath,
		name: name && name.length > 0 ? name : basename(resolvedPath),
		type,
		addedAt: new Date().toISOString(),
	};

	projects.push(entry);
	writeProjectsAtomic(projectsPath, projects);

	return { added: true, entry };
}

export interface RemoveFromProjectsResult {
	/** True when an entry was removed; false when the path was not registered. */
	removed: boolean;
	/** The removed registry entry (undefined when nothing was removed). */
	entry?: ProjectEntry;
}

/**
 * Remove a project from the registry (F-2.13).
 *
 * Matches by resolved absolute path (same normalization as addToProjects).
 * When the path is not registered the registry file is left untouched
 * (no write) and `removed` is false. The removal only affects the registry —
 * sessions and files on disk are never deleted.
 */
export function removeFromProjects(path: string, projectsPath: string = getProjectsPath()): RemoveFromProjectsResult {
	const resolvedPath = resolve(path);
	const projects = listProjects(projectsPath);

	const index = projects.findIndex((p) => p.path === resolvedPath);
	if (index === -1) {
		return { removed: false };
	}

	const [entry] = projects.splice(index, 1);
	writeProjectsAtomic(projectsPath, projects);

	return { removed: true, entry };
}
