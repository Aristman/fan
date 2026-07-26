/**
 * `fan project` CLI subcommand (F-1.8) — manual project registry management.
 *
 * Commands:
 *   fan project register <path> [--type code|research|automation|unknown]
 *   fan project list
 *
 * Manual registration semantics (documented decision):
 * - Unlike auto-registration (F-1.7), a manually registered path is ALWAYS
 *   added to the registry, even when the directory does not exist yet —
 *   e.g. a repo that is not yet cloned on a VPS. A warning is printed in
 *   that case and the type falls back to "unknown" (no filesystem evidence),
 *   unless --type is given explicitly.
 * - When the directory exists and --type is omitted, the type is
 *   auto-detected via detectProjectType (.git → code, docs/ → research,
 *   otherwise unknown).
 * - System-path exclusions do NOT apply to manual registration: an explicit
 *   user command is treated as intent.
 * - Re-registering an existing path is a no-op (dedup by resolved path in
 *   project-registry): the existing entry is kept and reported.
 *
 * Exit codes: 0 on success, 1 on usage errors (missing/invalid arguments)
 * or registry write failures.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { detectProjectType } from "../core/project-auto-register.js";
import {
	type AddToProjectsResult,
	addToProjects,
	getProjectsPath,
	listProjects,
	PROJECT_TYPES,
	type ProjectEntry,
	type ProjectType,
} from "../core/project-registry.js";

/** Parsed arguments of `fan project register`. */
export interface RegisterArgs {
	path?: string;
	type?: ProjectType;
	error?: string;
}

/** Parse `fan project register` arguments: <path> and optional --type. */
export function parseRegisterArgs(args: string[]): RegisterArgs {
	let path: string | undefined;
	let type: ProjectType | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		let typeValue: string | undefined;

		if (arg === "--type") {
			typeValue = args[++i];
		} else if (arg.startsWith("--type=")) {
			typeValue = arg.slice("--type=".length);
		} else if (arg.startsWith("-")) {
			return { error: `Unknown option: ${arg}` };
		} else if (path === undefined) {
			path = arg;
			continue;
		} else {
			return { error: `Unexpected argument: ${arg}` };
		}

		if (typeValue === undefined || !PROJECT_TYPES.includes(typeValue as ProjectType)) {
			return { error: `--type requires one of: ${PROJECT_TYPES.join(", ")}` };
		}
		type = typeValue as ProjectType;
	}

	if (!path) {
		return { error: "Missing required <path> argument" };
	}
	return { path, type };
}

export interface RegisterProjectOutcome {
	result: AddToProjectsResult;
	/** Present when the directory does not exist (registered with a warning). */
	warning?: string;
}

/**
 * Register a project path in the registry.
 *
 * Existing directory → type auto-detected when not given explicitly.
 * Missing directory → registered anyway with a warning and type "unknown"
 * (unless `type` is given). See module docblock for the rationale.
 */
export function registerProject(
	path: string,
	type?: ProjectType,
	projectsPath: string = getProjectsPath(),
): RegisterProjectOutcome {
	const resolved = resolve(path);
	const exists = existsSync(resolved) && statSync(resolved).isDirectory();

	if (!exists) {
		const effectiveType = type ?? "unknown";
		return {
			result: addToProjects(resolved, undefined, effectiveType, projectsPath),
			warning:
				`Warning: directory does not exist: ${resolved}\n` +
				`  Registering anyway as type "${effectiveType}" (no filesystem evidence). ` +
				`Pass --type to override.`,
		};
	}

	const effectiveType = type ?? detectProjectType(resolved);
	return { result: addToProjects(resolved, undefined, effectiveType, projectsPath) };
}

/** Format the registry as an aligned table: PATH | NAME | TYPE | ADDED AT. */
export function formatProjectsTable(projects: ProjectEntry[]): string {
	if (projects.length === 0) {
		return "No projects registered.";
	}

	const headers = ["PATH", "NAME", "TYPE", "ADDED AT"];
	const rows = projects.map((p) => [p.path, p.name, p.type, p.addedAt]);
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

	const formatRow = (cells: string[]): string =>
		cells
			.map((cell, i) => cell.padEnd(widths[i]))
			.join("  ")
			.trimEnd();
	const separator = widths.map((w) => "-".repeat(w)).join("  ");

	return [formatRow(headers), separator, ...rows.map(formatRow)].join("\n");
}

export interface ProjectCommandOptions {
	/** Registry file path override (defaults to <agentDir>/projects.json). */
	projectsPath?: string;
	/** Output sinks (default: console.log / console.error). Injectable for tests. */
	log?: (line: string) => void;
	error?: (line: string) => void;
}

function printProjectUsage(print: (line: string) => void): void {
	print("Usage:");
	print(`  fan project register <path> [--type ${PROJECT_TYPES.join("|")}]`);
	print("  fan project list");
}

/**
 * Run a `fan project` subcommand. Returns the exit code:
 * 0 on success, 1 on usage errors or registry failures.
 */
export function runProjectCommand(args: string[], options?: ProjectCommandOptions): number {
	const log = options?.log ?? console.log;
	const error = options?.error ?? ((line: string) => console.error(line));
	const subcommand = args[0];

	if (subcommand === "register") {
		const parsed = parseRegisterArgs(args.slice(1));
		if (parsed.error || !parsed.path) {
			error(`Error: ${parsed.error ?? "Missing required <path> argument"}`);
			printProjectUsage(error);
			return 1;
		}
		try {
			const outcome = registerProject(parsed.path, parsed.type, options?.projectsPath);
			if (outcome.warning) {
				error(outcome.warning);
			}
			const { added, entry } = outcome.result;
			if (added) {
				log(`Registered project: ${entry.path}`);
				log(`  name: ${entry.name}`);
				log(`  type: ${entry.type}`);
				log(`  addedAt: ${entry.addedAt}`);
			} else {
				log(`Project already registered: ${entry.path} (type: ${entry.type}, addedAt: ${entry.addedAt})`);
			}
			return 0;
		} catch (err) {
			error(`Error: failed to register project: ${err instanceof Error ? err.message : String(err)}`);
			return 1;
		}
	}

	if (subcommand === "list") {
		const projects = listProjects(options?.projectsPath);
		log(formatProjectsTable(projects));
		return 0;
	}

	error(subcommand ? `Error: Unknown project subcommand: ${subcommand}` : "Error: Missing project subcommand");
	printProjectUsage(error);
	return 1;
}
