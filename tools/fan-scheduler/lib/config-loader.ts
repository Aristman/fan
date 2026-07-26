import { readFileSync } from "node:fs";
import { parse, YAMLParseError } from "yaml";

/**
 * Task configuration parsed from config.yaml (F-4.1).
 */
export interface TaskConfig {
	name: string;
	/** 5-field cron expression: minute hour day-of-month month day-of-week */
	schedule: string;
	/** Path to the project workspace (used as session cwd) */
	workspace: string;
	/** Prompt sent to the agent */
	message: string;
	/** Token budget cap; null = no cap (default) */
	budget_limit: number | null;
	/** Execution timeout in seconds; default 3600 */
	timeout: number;
}

export const DEFAULT_BUDGET_LIMIT: number | null = null;
export const DEFAULT_TIMEOUT = 3600;

// ---------------------------------------------------------------------------
// Cron validation (syntax-only, 5 fields). A full cron library (e.g. croner)
// will be introduced in F-4.5 for actual scheduling.
// ---------------------------------------------------------------------------

const CRON_FIELD_RANGES = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day-of-month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day-of-week", min: 0, max: 7 },
] as const;

function isValidCronPart(part: string, min: number, max: number): boolean {
	// part: <range>[/<step>] where range is "*", "a", or "a-b"
	const segments = part.split("/");
	if (segments.length > 2) return false;
	const [rangePart, stepPart] = segments;
	if (stepPart !== undefined) {
		if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) return false;
	}
	if (rangePart === "*") return true;
	if (/^\d+$/.test(rangePart)) {
		const value = Number(rangePart);
		return value >= min && value <= max;
	}
	const rangeMatch = /^(\d+)-(\d+)$/.exec(rangePart);
	if (rangeMatch) {
		const from = Number(rangeMatch[1]);
		const to = Number(rangeMatch[2]);
		return from >= min && to <= max && from <= to;
	}
	return false;
}

/**
 * Syntax-only validation of a 5-field cron expression.
 * Supports: "*", numbers, ranges ("1-5"), steps ("*\/2", "1-10/3"), lists ("1,2,3").
 */
export function isValidCron(expression: string): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== CRON_FIELD_RANGES.length) return false;
	return fields.every((field, index) => {
		if (field.length === 0) return false;
		const { min, max } = CRON_FIELD_RANGES[index];
		return field.split(",").every((part) => isValidCronPart(part, min, max));
	});
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function formatYamlError(error: unknown): string {
	if (error instanceof YAMLParseError) {
		const pos = error.linePos?.[0];
		if (pos) {
			return `${error.message.split("\n")[0]} (line ${pos.line}, column ${pos.col})`;
		}
		return error.message.split("\n")[0];
	}
	return error instanceof Error ? error.message : String(error);
}

function requireString(raw: Record<string, unknown>, field: string, taskLabel: string): string {
	const value = raw[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid config: task ${taskLabel} is missing required field "${field}" (non-empty string)`);
	}
	return value;
}

function parseTask(entry: unknown, index: number): TaskConfig {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new Error(`Invalid config: task at index ${index} must be an object`);
	}
	const raw = entry as Record<string, unknown>;

	const name = requireString(raw, "name", `at index ${index}`);
	const label = `"${name}"`;

	const schedule = requireString(raw, "schedule", label);
	if (!isValidCron(schedule)) {
		throw new Error(
			`Invalid config: task "${name}" has invalid cron schedule "${schedule}" (expected 5-field cron expression)`,
		);
	}

	const workspace = requireString(raw, "workspace", label);
	const message = requireString(raw, "message", label);

	let budgetLimit: number | null = DEFAULT_BUDGET_LIMIT;
	if (raw.budget_limit !== undefined && raw.budget_limit !== null) {
		if (typeof raw.budget_limit !== "number" || !Number.isFinite(raw.budget_limit) || raw.budget_limit < 0) {
			throw new Error(
				`Invalid config: task "${name}" has invalid "budget_limit" (expected a non-negative number or null)`,
			);
		}
		budgetLimit = raw.budget_limit;
	}

	let timeout = DEFAULT_TIMEOUT;
	if (raw.timeout !== undefined && raw.timeout !== null) {
		if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) {
			throw new Error(
				`Invalid config: task "${name}" has invalid "timeout" (expected a positive number of seconds)`,
			);
		}
		timeout = raw.timeout;
	}

	return { name, schedule, workspace, message, budget_limit: budgetLimit, timeout };
}

/**
 * Loads and validates tasks from a YAML config file.
 * Throws descriptive errors for unreadable files, invalid YAML (with line number),
 * missing required fields, and invalid cron expressions (with task name).
 */
export function loadTasks(configPath: string): TaskConfig[] {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		throw new Error(
			`Failed to read config file "${configPath}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let doc: unknown;
	try {
		doc = parse(raw);
	} catch (error) {
		throw new Error(`Invalid YAML in config file "${configPath}": ${formatYamlError(error)}`);
	}

	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		throw new Error(`Invalid config file "${configPath}": root must be an object with a "tasks" array`);
	}

	const tasks = (doc as Record<string, unknown>).tasks;
	if (!Array.isArray(tasks)) {
		throw new Error(`Invalid config file "${configPath}": "tasks" must be an array`);
	}

	return tasks.map((entry, index) => parseTask(entry, index));
}
