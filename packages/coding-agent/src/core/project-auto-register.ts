/**
 * Auto-registration of project workspaces on session creation (F-1.7).
 *
 * When a session is created with a non-empty, non-system cwd, the workspace
 * is automatically added to the project registry (~/.fan/agent/projects.json)
 * with a detected type:
 * - has `.git` entry        → "code"
 * - has `docs/` directory   → "research"
 * - otherwise               → "unknown"
 *
 * Exclusion rules (documented system paths):
 * - The OS temp directory (os.tmpdir()) and everything inside it.
 * - POSIX system dirs: /, /bin, /boot, /dev, /etc, /lib, /lib64, /proc,
 *   /run, /sbin, /snap, /sys, /usr, /var — the dir itself and any subdir.
 * - Windows: <SystemDrive>\ root, %SystemRoot% (e.g. C:\Windows),
 *   Program Files, Program Files (x86), ProgramData — and any subdir.
 * - The user home directory ITSELF (a bare home dir is not a project);
 *   subdirectories of home are allowed.
 *
 * Non-existent (or non-directory) paths are NOT registered: there is no
 * filesystem evidence to classify them, and registering phantom paths would
 * pollute the registry. `autoRegisterProject` returns `null` in that case.
 *
 * Error handling: this module never throws. Registry write failures are
 * logged as warnings and result in a `null` return — session creation must
 * never fail because of registration.
 */

import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { type AddToProjectsResult, addToProjects, type ProjectType } from "./project-registry.js";

/** POSIX system directories excluded from auto-registration. */
const POSIX_SYSTEM_DIRS: readonly string[] = [
	"/",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/lib64",
	"/proc",
	"/run",
	"/sbin",
	"/snap",
	"/sys",
	"/usr",
	"/var",
];

function normalizeForCompare(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Build the list of system roots (normalized for comparison). */
function getSystemRoots(): string[] {
	const roots: string[] = [tmpdir(), ...POSIX_SYSTEM_DIRS];
	if (process.platform === "win32") {
		const systemDrive = process.env.SystemDrive ?? "C:";
		roots.push(`${systemDrive}\\`);
		if (process.env.SystemRoot) {
			roots.push(process.env.SystemRoot);
		}
		roots.push(
			`${systemDrive}\\Windows`,
			`${systemDrive}\\Program Files`,
			`${systemDrive}\\Program Files (x86)`,
			`${systemDrive}\\ProgramData`,
		);
	}
	return roots.map(normalizeForCompare);
}

function isUnderRoot(normalized: string, root: string): boolean {
	if (normalized === root) return true;
	// Filesystem root (/ or C:\) excludes only itself — otherwise every path would match.
	if (root.endsWith(sep)) return false;
	return normalized.startsWith(root + sep);
}

/**
 * Check whether a path is a system path excluded from auto-registration.
 * System roots (temp dir, POSIX system dirs, Windows system dirs) exclude
 * themselves AND their subdirectories. The home directory excludes only
 * itself (subdirectories of home are valid projects).
 */
export function isSystemPath(path: string): boolean {
	const normalized = normalizeForCompare(path);
	if (normalized === normalizeForCompare(homedir())) return true;
	return getSystemRoots().some((root) => isUnderRoot(normalized, root));
}

/**
 * Detect the project type via filesystem checks:
 * `.git` (dir or file — worktrees/submodules use a gitfile) → "code",
 * `docs/` directory → "research", otherwise "unknown".
 */
export function detectProjectType(cwd: string): ProjectType {
	try {
		if (existsSync(join(cwd, ".git"))) return "code";
		const docsPath = join(cwd, "docs");
		if (existsSync(docsPath) && statSync(docsPath).isDirectory()) return "research";
	} catch {
		// fs errors (permissions, races) → fall through to "unknown"
	}
	return "unknown";
}

export interface AutoRegisterOptions {
	/** Registry file path override (defaults to ~/.fan/agent/projects.json). */
	projectsPath?: string;
}

/**
 * Auto-register a session cwd in the project registry.
 *
 * Returns the AddToProjectsResult on registration (or dedup hit), or `null`
 * when the cwd is empty, non-existent, not a directory, a system path, or
 * when registration fails. Never throws.
 */
export function autoRegisterProject(
	cwd: string | undefined | null,
	options?: AutoRegisterOptions,
): AddToProjectsResult | null {
	try {
		if (!cwd || typeof cwd !== "string" || cwd.trim() === "") return null;

		const resolved = resolve(cwd);
		if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
			// Non-existent path → not registered (documented decision).
			return null;
		}
		if (isSystemPath(resolved)) return null;

		return addToProjects(resolved, undefined, detectProjectType(resolved), options?.projectsPath);
	} catch (error) {
		console.warn(
			`[project-auto-register] Failed to register project for cwd "${cwd}":`,
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}
