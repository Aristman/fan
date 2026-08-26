// F-08: File-state-manager — mission file management for the FAN super-orchestrator.
// Manages 5 mission files (MISSION.md, ROADMAP.md, STATE.md, BACKLOG.md, DECISIONS.md),
// FSM status transitions, and slug validation with path-traversal protection.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_STATE_BYTES = 150 * 1024;
/** Плановый порог компактизации — при превышении запускается архивирование (тихо, без failed). */
export const SOFT_STATE_BYTES = 100 * 1024;
export const MAX_SLUG_LENGTH = 100;
export const MISSION_FILES = ["MISSION.md", "ROADMAP.md", "STATE.md", "BACKLOG.md", "DECISIONS.md"] as const;

// ─── Recurring items (0.7.3) ───────────────────────────────────────────────

/**
 * Marker for recurring ROADMAP items (watch-loop / вахта semantics).
 * A checkbox line containing this marker is executed every tick but NEVER
 * marked [x] — the mission stays alive as long as at least one recur item
 * exists unchecked.
 */
export const RECUR_MARKER = "(recur)";

/**
 * True if the item text contains the recurring marker (case-insensitive).
 */
export function isRecurringItem(text: string): boolean {
	return text.toLowerCase().includes(RECUR_MARKER.toLowerCase());
}

// ─── RECURRING.md infrastructure (R1) ──────────────────────────────────────

/** Default interval when (interval: ...) is missing or invalid: 5 minutes. */
export const DEFAULT_RECUR_INTERVAL_MS = 300_000;

/** A parsed recurring item from RECURRING.md. */
export interface RecurringItem {
	/** 0-based line index in the file. */
	index: number;
	/** Task text without the interval marker. */
	text: string;
	/** Parsed interval in milliseconds. */
	intervalMs: number;
	/** Original raw line text (trimmed). */
	rawText: string;
}

/** Suffix → multiplier map for interval parsing. */
const INTERVAL_SUFFIXES: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * Parse interval string like "30m", "2h", "7d", "30s" to milliseconds.
 * Returns DEFAULT_RECUR_INTERVAL_MS for invalid/missing input.
 */
function parseIntervalMs(raw: string): number {
	const m = /^(\d+)([smhd])$/i.exec(raw.trim());
	if (!m) return DEFAULT_RECUR_INTERVAL_MS;
	const value = Number(m[1]);
	const suffix = m[2].toLowerCase();
	const multiplier = INTERVAL_SUFFIXES[suffix];
	if (!multiplier || value <= 0) return DEFAULT_RECUR_INTERVAL_MS;
	return value * multiplier;
}

/**
 * Parse RECURRING.md content into RecurringItem[].
 * Canonical format: `- [ ] Task text (interval: 30m)`
 * Tolerant format: heading line with an interval marker,
 * e.g. `## Task text (interval: 30m)` (body under the heading is NOT
 * part of the item; headings without the marker are structure, ignored).
 * The interval marker `(interval: ...)` is extracted from the end of text;
 * if multiple markers exist, the last one wins.
 * text field = item text WITHOUT the interval marker.
 */
export function parseRecurringItems(raw: string): RecurringItem[] {
	const items: RecurringItem[] = [];
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const checkboxMatch = /^[-*] \[ \] (.+)$/.exec(trimmed);
		let fullText: string | null = null;
		if (checkboxMatch) {
			fullText = checkboxMatch[1];
		} else {
			// Tolerant header format: `## Text (interval: 15m)`. Requires the
			// (interval: ...) marker — headings without it are structure.
			const headerMatch = /^#{1,3}\s+(.+)$/.exec(trimmed);
			if (headerMatch && /\(interval:\s*\S+\)/i.test(headerMatch[1])) {
				fullText = headerMatch[1];
			}
		}
		if (!fullText) continue;

		// Extract the LAST (interval: ...) marker (case-insensitive).
		const intervalRegex = /\(interval:\s*(\S+)\)/gi;
		const allMatches = fullText.matchAll(intervalRegex);
		let lastMatch: RegExpExecArray | null = null;
		for (const m of allMatches) {
			lastMatch = m as RegExpExecArray;
		}

		let text = fullText;
		let intervalMs = DEFAULT_RECUR_INTERVAL_MS;
		if (lastMatch) {
			intervalMs = parseIntervalMs(lastMatch[1]);
			// Remove the last (interval: ...) marker from text, trim trailing spaces.
			text = fullText.slice(0, lastMatch.index).replace(/\s+$/, "");
		}

		items.push({ index: i, text, intervalMs, rawText: trimmed });
	}
	return items;
}

/**
 * True if RECURRING.md content has substantive (non-structural) lines:
 * anything beyond blank lines, HTML comments and headings. Used to warn
 * about silent degradation (file has content but no parseable items).
 */
function hasSubstantiveRecurringContent(raw: string): boolean {
	const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
	return withoutComments.split("\n").some((line) => {
		const t = line.trim();
		return t.length > 0 && !/^#{1,6}\s/.test(t);
	});
}

/**
 * Read and parse RECURRING.md from mission directory.
 * Returns empty array if file doesn't exist (not an error).
 * Warns when the file has substantive content but no parseable items
 * (silent degradation: scheduler would never tick this mission).
 */
export function readRecurring(missionDir: string): RecurringItem[] {
	const filePath = join(missionDir, "RECURRING.md");
	if (!existsSync(filePath)) return [];
	const raw = readFileSync(filePath, "utf8");
	const items = parseRecurringItems(raw);
	if (items.length === 0 && hasSubstantiveRecurringContent(raw)) {
		console.warn(
			`[fan-mission] ${filePath} has content but no parseable recurring items — ` +
				"use '- [ ] text (interval: 30m)' or '## text (interval: 30m)'",
		);
	}
	return items;
}

/**
 * Stable short hash of normalized recurring item text.
 * Normalization: trim, collapse whitespace, lowercase.
 * Returns first 12 hex chars of SHA-1.
 */
export function recurringItemHash(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
	return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Read .recurring-state.json from mission directory.
 * Returns empty object if file doesn't exist.
 */
export function readRecurringState(missionDir: string): Record<string, number> {
	const filePath = join(missionDir, ".recurring-state.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Record<string, number>;
	} catch {
		return {};
	}
}

/**
 * Write .recurring-state.json atomically.
 */
export function writeRecurringState(missionDir: string, state: Record<string, number>): void {
	const filePath = join(missionDir, ".recurring-state.json");
	atomicWriteFileSync(
		filePath,
		`${JSON.stringify(state, null, 2)}
`,
	);
}

/**
 * Check if a recurring item is due for execution.
 * An item is due when (nowMs - lastRunMs) >= intervalMs.
 * Items that have never run (no entry in state) are always due.
 */
export function isRecurringDue(item: RecurringItem, state: Record<string, number>, nowMs: number): boolean {
	const hash = recurringItemHash(item.text);
	if (!(hash in state)) return true; // never run → always due
	return nowMs - state[hash] >= item.intervalMs;
}

/**
 * Return a new state object with the item's last-run timestamp updated.
 * Immutable — does not mutate the input state.
 */
export function markRecurringRun(
	state: Record<string, number>,
	item: RecurringItem,
	nowMs: number,
): Record<string, number> {
	const hash = recurringItemHash(item.text);
	return { ...state, [hash]: nowMs };
}

/**
 * Append recurring items to RECURRING.md.
 * Creates the file with a header if it doesn't exist.
 * Each item is added as `- [ ] <text> (interval: <intervalStr>)`.
 */
export function appendRecurringItems(missionDir: string, items: Array<{ text: string; intervalStr: string }>): void {
	const filePath = join(missionDir, "RECURRING.md");
	let existing = "";
	if (existsSync(filePath)) {
		existing = readFileSync(filePath, "utf8");
	}
	if (!existing.trim()) {
		existing = "# Recurring tasks\n";
	}
	const lines = items.map((item) => `- [ ] ${item.text} (interval: ${item.intervalStr})`);
	const updated = `${existing.trimEnd()}\n${lines.join("\n")}\n`;
	writeFileSync(filePath, updated, "utf8");
}

// ─── Dynamic template loader (handles .ts and .js at runtime) ──────────────

interface MissionTemplateFiles {
	"MISSION.md": string;
	"ROADMAP.md": string;
	"STATE.md": string;
	"BACKLOG.md": string;
	"DECISIONS.md": string;
	"RECURRING.md": string;
}

interface TemplateModule {
	loadTemplate(name: string): Promise<MissionTemplateFiles>;
	renderTemplate(raw: string, vars: { slug: string; missionId: string; now: string; description?: string }): string;
}

let templateModuleCache: TemplateModule | undefined;

async function getTemplateModule(): Promise<TemplateModule> {
	if (templateModuleCache) return templateModuleCache;

	const here = new URL(".", import.meta.url);
	// Try .js first (compiled), then .ts (dev / strip-mode)
	for (const ext of ["js", "ts"]) {
		try {
			const mod = (await import(new URL(`./templates/index.${ext}`, here).href)) as TemplateModule;
			templateModuleCache = mod;
			return mod;
		} catch {}
	}
	throw new Error("Template module not found (tried ./templates/index.js and ./templates/index.ts)");
}

// Windows reserved device names (case-insensitive, with or without extension)
const WINDOWS_RESERVED = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
]);

// ─── Error classes ──────────────────────────────────────────────────────────

export class MissionFileImmutable extends Error {
	constructor(msg = "MISSION.md is immutable after init") {
		super(msg);
		this.name = "MissionFileImmutable";
	}
}

// ralph-loop incident fix: no longer thrown from readState (oversized STATE.md
// is truncated + warned instead, so a bloated file cannot wedge the mission
// loop). Still thrown by writeState; kept exported for compatibility.
export class StateFileTooLarge extends Error {
	constructor(max: number, actual?: number) {
		const detail = actual !== undefined ? ` (${actual} bytes)` : "";
		super(`STATE.md exceeds ${max} bytes${detail}`);
		this.name = "StateFileTooLarge";
	}
}

export class InvalidStateSchema extends Error {
	constructor(missing: string[]) {
		super(`STATE.md missing required sections: ${missing.join(", ")}`);
		this.name = "InvalidStateSchema";
	}
}

export class DuplicateSection extends Error {
	constructor(section: string) {
		super(`STATE.md contains duplicate section: ${JSON.stringify(section)}`);
		this.name = "InvalidStateSchema";
	}
}

export class InvalidSlug extends Error {
	constructor(slug: string, reason?: string) {
		const detail = reason ? ` (${reason})` : "";
		super(`Invalid slug: ${JSON.stringify(slug)}${detail}`);
		this.name = "InvalidSlug";
	}
}

export class MissionNotFound extends Error {
	constructor(missionDir: string) {
		super(`Mission not found: ${missionDir}`);
		this.name = "MissionNotFound";
	}
}

export class InvalidTransitionError extends Error {
	readonly from: string;
	readonly to: string;
	constructor(from: string, to: string) {
		super(`Invalid status transition: ${from} → ${to}`);
		this.name = "InvalidTransitionError";
		this.from = from;
		this.to = to;
	}
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MissionState {
	done: string[];
	blockers: string[];
	nextSteps: string[];
}

export interface MissionFrontmatter {
	mission_id: string;
	created: string;
	status: string;
	metric_type: string;
	metric_command: string;
	budget_tokens: number;
	budget_usd: number;
	max_depth: number;
	max_width: number;
	/** Optional: 'fresh' | 'persistent'. Absent = persistent (backward compat). */
	session_mode?: string;
	[key: string]: unknown;
}

export interface BacklogEntry {
	id: string;
	date: string;
	idea: string;
	source: string;
	fit: number;
	value: number;
	risk: number;
	cost: number;
	score: number;
	status: string;
}

export interface DecisionEntry {
	id: string;
	date: string;
	status: string;
	context: string;
	decision: string;
	consequences: string;
}

// ─── Slug validation ────────────────────────────────────────────────────────

export function validateSlug(slug: string): void {
	if (!slug || slug.length === 0) {
		throw new InvalidSlug(slug, "empty");
	}
	// Length limit: 100 characters
	if (slug.length > MAX_SLUG_LENGTH) {
		throw new InvalidSlug(slug, `exceeds ${MAX_SLUG_LENGTH} characters`);
	}
	// Dot-only slugs: ".", "..", "..." etc.
	if (/^\.+$/.test(slug)) {
		throw new InvalidSlug(slug, "dot-only");
	}
	// Leading-dot: ".foo", ".hidden"
	if (slug.startsWith(".")) {
		throw new InvalidSlug(slug, "leading dot");
	}
	// Trailing dots or spaces: "foo.", "foo ", "foo. "
	if (/[.\s]$/.test(slug)) {
		throw new InvalidSlug(slug, "trailing dot or space");
	}
	// Path traversal: dot-dot segments or bare '..'
	if (/\.\./.test(slug)) {
		throw new InvalidSlug(slug, "path traversal");
	}
	// Absolute paths: forward-slash or backslash prefix
	if (/^[/\\]/.test(slug)) {
		throw new InvalidSlug(slug, "absolute path");
	}
	// Windows drive letter: C:\..., D:\...
	if (/^[a-zA-Z]:/.test(slug)) {
		throw new InvalidSlug(slug, "drive letter");
	}
	// Only allow: alphanumeric, underscore, hyphen, dot
	if (!/^[a-zA-Z0-9_.-]+$/.test(slug)) {
		throw new InvalidSlug(slug, "invalid characters");
	}
	// Windows reserved device names (case-insensitive, with or without extension)
	const baseName = slug.split(".")[0].toUpperCase();
	if (WINDOWS_RESERVED.has(baseName)) {
		throw new InvalidSlug(slug, "Windows reserved name");
	}
}

// ─── Atomic write helper ────────────────────────────────────────────────────

/**
 * Write content to a file atomically via tmp-file + rename.
 * On NTFS/POSIX within the same volume, rename is atomic.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmpPath, content, "utf8");
		renameSync(tmpPath, filePath);
	} catch (err) {
		// Cleanup tmp on failure (best-effort)
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath);
			}
		} catch {
			// ignore cleanup errors
		}
		throw err;
	}
}

// ─── Mission init ───────────────────────────────────────────────────────────

export async function initMission(
	slug: string,
	opts?: { baseDir?: string; template?: string; description?: string },
): Promise<string> {
	validateSlug(slug);
	const baseDir = opts?.baseDir ?? join("docs", "missions");
	const missionDir = resolve(baseDir, slug);

	// Idempotent: do not overwrite an existing mission
	if (existsSync(join(missionDir, "MISSION.md"))) {
		return missionDir;
	}

	// Load template files (default if not specified)
	const templateName = opts?.template ?? "default";
	const tmpl = await getTemplateModule();
	const templates = await tmpl.loadTemplate(templateName);

	mkdirSync(missionDir, { recursive: true });

	const now = new Date().toISOString();
	const missionId = `mission-${randomUUID()}`;
	// 0.7.0: operator-provided mission description → {{description}} → ## Goal.
	// The whole text goes into Goal (no heuristic parsing); newlines are
	// preserved so multi-line dialog input stays readable.
	const description = (opts?.description ?? "").trim();
	const vars = { slug, missionId, now, description };

	for (const [fileName, raw] of Object.entries(templates) as [keyof MissionTemplateFiles, string][]) {
		writeFileSync(join(missionDir, fileName), tmpl.renderTemplate(raw, vars), "utf8");
	}

	// .gitignore: exclude runtime state files from version control.
	const gitignorePath = join(missionDir, ".gitignore");
	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, ".mission-loop.json\n.mission-loop.lock\n.recurring-state.json\n", "utf8");
	}

	return missionDir;
}

// ─── STATE.md read / write ──────────────────────────────────────────────────

export async function readState(missionDir: string): Promise<MissionState> {
	const statePath = join(missionDir, "STATE.md");
	if (!existsSync(statePath)) {
		throw new MissionNotFound(missionDir);
	}
	let raw = readFileSync(statePath, "utf8");

	const sections = parseSections(raw);
	const done = sections.get("Сделано");
	const blockers = sections.get("Блокеры");
	const nextSteps = sections.get("Следующие шаги");

	const missing: string[] = [];
	if (done === undefined) missing.push("Сделано");
	if (blockers === undefined) missing.push("Блокеры");
	if (nextSteps === undefined) missing.push("Следующие шаги");
	if (missing.length > 0) {
		throw new InvalidStateSchema(missing);
	}

	// F-10 fix: section-aware truncation instead of byte-level truncation.
	// Byte-level truncation (raw.subarray(0, MAX_STATE_BYTES)) could cut a
	// section header mid-line, causing InvalidStateSchema on the next tick.
	// Here we truncate the *content* of sections (keeping headers intact)
	// so the resulting file always parses successfully.
	const byteLen = Buffer.byteLength(raw, "utf8");
	if (byteLen > MAX_STATE_BYTES) {
		console.warn(
			`[fan-mission] STATE.md is ${byteLen} bytes (limit ${MAX_STATE_BYTES}) — truncating content of sections; archive or compact the file`,
		);
		raw = truncateStateSections(done!, blockers!, nextSteps!, MAX_STATE_BYTES);
		// Re-parse the truncated content to get the final items.
		const truncatedSections = parseSections(raw);
		return {
			done: truncatedSections.get("Сделано") ?? [],
			blockers: truncatedSections.get("Блокеры") ?? [],
			nextSteps: truncatedSections.get("Следующие шаги") ?? [],
		};
	}

	return { done: done!, blockers: blockers!, nextSteps: nextSteps! };
}

export async function writeState(missionDir: string, state: MissionState): Promise<void> {
	const lines: string[] = [];
	lines.push("## Сделано");
	for (const item of state.done) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Блокеры");
	for (const item of state.blockers) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Следующие шаги");
	for (const item of state.nextSteps) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	const content = lines.join("\n");
	const byteLen = Buffer.byteLength(content, "utf8");
	if (byteLen > MAX_STATE_BYTES) {
		throw new StateFileTooLarge(MAX_STATE_BYTES, byteLen);
	}
	atomicWriteFileSync(join(missionDir, "STATE.md"), content);
}

/**
 * Sanitize item text for STATE.md: replace newlines with spaces
 * to prevent breaking the markdown list format.
 */
function sanitizeItem(item: string): string {
	return item.replace(/[\r\n]+/g, " ");
}

// ─── MISSION.md ─────────────────────────────────────────────────────────────

export async function readMission(missionDir: string): Promise<{
	frontmatter: MissionFrontmatter;
	body: string;
}> {
	const missionPath = join(missionDir, "MISSION.md");
	if (!existsSync(missionPath)) {
		throw new MissionNotFound(missionDir);
	}
	const rawRaw = readFileSync(missionPath, "utf8");
	// Normalize CRLF → LF before parsing
	const raw = rawRaw.replace(/\r\n/g, "\n");
	if (!raw.startsWith("---\n")) {
		throw new Error("MISSION.md missing YAML frontmatter");
	}
	const endIdx = raw.indexOf("\n---\n", 4);
	if (endIdx < 0) {
		throw new Error("MISSION.md missing frontmatter end delimiter");
	}

	const fmBlock = raw.slice(4, endIdx);
	const body = raw.slice(endIdx + 5);

	const fm = parseSimpleYaml(fmBlock);
	const required = [
		"mission_id",
		"created",
		"status",
		"metric_type",
		"metric_command",
		"budget_tokens",
		"budget_usd",
		"max_depth",
		"max_width",
	];
	for (const key of required) {
		if (!(key in fm)) {
			throw new Error(`MISSION.md frontmatter missing field: ${key}`);
		}
	}

	return { frontmatter: fm as MissionFrontmatter, body };
}

export async function updateMission(_missionDir: string, _updates: Record<string, unknown>): Promise<never> {
	throw new MissionFileImmutable();
}

/**
 * Update only the `status` field in MISSION.md frontmatter.
 * Respects FSM transitions (canTransition) and preserves all body content.
 * This is the ONLY mutation allowed on MISSION.md after init.
 *
 * P2-8: Preserves the file's original line-ending style (CRLF→CRLF, LF→LF).
 */
export async function writeMissionStatus(missionDir: string, newStatus: string): Promise<void> {
	const missionPath = join(missionDir, "MISSION.md");
	if (!existsSync(missionPath)) {
		throw new MissionNotFound(missionDir);
	}
	const rawOriginal = readFileSync(missionPath, "utf8");
	const useCRLF = rawOriginal.includes("\r\n");
	const raw = rawOriginal.replace(/\r\n/g, "\n");
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!fmMatch) throw new Error("MISSION.md missing frontmatter");

	const fm = parseSimpleYaml(fmMatch[1]);
	const currentStatus = String(fm.status ?? "active");
	if (currentStatus === newStatus) return; // idempotent
	if (!canTransition(currentStatus, newStatus)) {
		throw new InvalidTransitionError(currentStatus, newStatus);
	}

	let updated = raw.replace(/^(status:\s*).*$/m, `$1${newStatus}`);
	if (useCRLF) {
		updated = updated.replace(/\n/g, "\r\n");
	}
	atomicWriteFileSync(missionPath, updated);
}

// ─── BACKLOG.md ─────────────────────────────────────────────────────────────

/**
 * Escape pipe characters in backlog field values to prevent breaking
 * the markdown table format. Uses backslash escaping: | → \|
 * Newlines are replaced with spaces (table cells must be single-line).
 */
function escapeTableCell(value: string): string {
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ");
}

/**
 * Unescape pipe characters when reading backlog table cells.
 * Reverses escapeTableCell: \| → |, \\ → \
 */
function unescapeTableCell(value: string): string {
	return value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
}

export async function readBacklog(missionDir: string): Promise<BacklogEntry[]> {
	const raw = readFileSync(join(missionDir, "BACKLOG.md"), "utf8");
	const lines = raw.split("\n");
	const entries: BacklogEntry[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
		// Split on unescaped pipes only: use a regex that splits on | not preceded by \
		const cells = splitTableLine(trimmed);
		if (cells[0] === "id") continue; // skip header row
		if (/^-+$/.test(cells[0])) continue; // separator row
		if (cells.length < 10) continue;
		entries.push({
			id: unescapeTableCell(cells[0]),
			date: unescapeTableCell(cells[1]),
			idea: unescapeTableCell(cells[2]),
			source: unescapeTableCell(cells[3]),
			fit: Number.parseFloat(cells[4]),
			value: Number.parseFloat(cells[5]),
			risk: Number.parseFloat(cells[6]),
			cost: Number.parseFloat(cells[7]),
			score: Number.parseFloat(cells[8]),
			status: unescapeTableCell(cells[9]),
		});
	}
	return entries;
}

/**
 * Split a markdown table line on unescaped pipes.
 * Pipes preceded by backslash (\|) are treated as literal characters.
 */
function splitTableLine(line: string): string[] {
	// Remove leading/trailing pipes
	const inner = line.slice(1, -1);
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === "\\" && i + 1 < inner.length && (inner[i + 1] === "|" || inner[i + 1] === "\\")) {
			current += inner[i] + inner[i + 1];
			i++;
		} else if (inner[i] === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += inner[i];
		}
	}
	cells.push(current.trim());
	return cells;
}

/** Render one BACKLOG.md table row (without trailing newline). */
function formatBacklogRow(entry: BacklogEntry): string {
	return `| ${escapeTableCell(entry.id)} | ${escapeTableCell(entry.date)} | ${escapeTableCell(entry.idea)} | ${escapeTableCell(entry.source)} | ${entry.fit} | ${entry.value} | ${entry.risk} | ${entry.cost} | ${entry.score} | ${escapeTableCell(entry.status)} |`;
}

export async function appendBacklog(missionDir: string, entry: BacklogEntry): Promise<void> {
	const filePath = join(missionDir, "BACKLOG.md");
	let raw = readFileSync(filePath, "utf8");

	if (!raw.includes("| id")) {
		raw +=
			"| id | date | idea | source | fit | value | risk | cost | score | status |\n" +
			"|---|---|---|---|---|---|---|---|---|---|\n";
	}

	atomicWriteFileSync(filePath, `${raw}${formatBacklogRow(entry)}\n`);
}

/**
 * F-20: Update an existing BACKLOG.md entry by id (shallow merge of updates).
 * Preserves the rest of the file (title, header, other rows) and the original
 * line-ending style. Returns false if no entry with the given id exists.
 */
export async function updateBacklogEntry(
	missionDir: string,
	id: string,
	updates: Partial<Omit<BacklogEntry, "id">>,
): Promise<boolean> {
	const entries = await readBacklog(missionDir);
	const target = entries.find((entry) => entry.id === id);
	if (!target) return false;
	const updated = { ...target, ...updates };

	const filePath = join(missionDir, "BACKLOG.md");
	const rawOriginal = readFileSync(filePath, "utf8");
	const useCRLF = rawOriginal.includes("\r\n");
	const lines = rawOriginal.replace(/\r\n/g, "\n").split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
		const cells = splitTableLine(trimmed);
		if (cells.length < 10) continue;
		const cellId = unescapeTableCell(cells[0]);
		if (cellId === "id" || /^-+$/.test(cellId) || cellId !== id) continue;
		lines[i] = formatBacklogRow(updated);
		let content = lines.join("\n");
		if (useCRLF) content = content.replace(/\n/g, "\r\n");
		atomicWriteFileSync(filePath, content);
		return true;
	}
	return false;
}

// ─── DECISIONS.md ───────────────────────────────────────────────────────────

export async function readDecisions(missionDir: string): Promise<DecisionEntry[]> {
	const raw = readFileSync(join(missionDir, "DECISIONS.md"), "utf8");
	const entries: DecisionEntry[] = [];
	const blocks = raw.split(/^### /m).slice(1);

	for (const block of blocks) {
		const lines = block.split("\n");
		const id = lines[0]?.trim();
		const fields: Record<string, string> = {};
		for (const line of lines) {
			const m = /^- \*\*(\w+)\*\*:\s*(.+)$/.exec(line);
			if (m) {
				fields[m[1].toLowerCase()] = m[2].trim();
			}
		}
		if (id && fields.date) {
			entries.push({
				id,
				date: fields.date,
				status: fields.status ?? "",
				context: fields.context ?? "",
				decision: fields.decision ?? "",
				consequences: fields.consequences ?? "",
			});
		}
	}
	return entries;
}

export async function appendDecision(missionDir: string, entry: DecisionEntry): Promise<void> {
	const filePath = join(missionDir, "DECISIONS.md");
	const existing = readFileSync(filePath, "utf8");
	const block = [
		`### ${entry.id}`,
		`- **Date**: ${entry.date}`,
		`- **Status**: ${entry.status}`,
		`- **Context**: ${entry.context}`,
		`- **Decision**: ${entry.decision}`,
		`- **Consequences**: ${entry.consequences}`,
		"",
	].join("\n");
	atomicWriteFileSync(filePath, existing + block);
}

// ─── ROADMAP.md ─────────────────────────────────────────────────────────────

/*
 * "Current item" marker glyphs that may contaminate ROADMAP.md lines.
 * Canonical: `▶ ` — added by prompt-builder markCurrentItem() to the PROMPT
 * copy of the roadmap only, but an executor agent may copy the marked line
 * back into the file (observed in e2e: `▶ - [ ] [EPIC] ...` — the item then
 * became invisible to `^[-*] \[ \]` parsers and EPIC delegation never fired).
 * The rest are common paraphrases of the same pointer marker. ASCII `>` is
 * deliberately excluded — it is valid markdown (blockquote), not a marker.
 */
/** Line-level marker regex: anchored, tolerates indentation, repeats and
 * spacing variants (`▶ - [ ] x`, `▶  - [ ] x`, `  ▶ ▶ - [ ] x`). */
const CURRENT_ITEM_MARKER_LINE_RE = /^[ \t]*(?:[▶▸►➤➜→⇒»●][ \t]*)+/;

/** Same marker regex, but captures leading indentation so sanitize-on-write
 * keeps the nesting of (contaminated) nested items intact. */
const CURRENT_ITEM_MARKER_SANITIZE_RE = /^([ \t]*)(?:[▶▸►➤➜→⇒»●][ \t]*)+/;

/**
 * Level 1 (tolerant parser): strip a leading current-item marker from a
 * roadmap checklist line (or from captured item text, e.g. `- [ ] ▶ [EPIC] x`).
 * Plain lines without a marker pass through unchanged.
 */
export function stripCurrentItemMarker(line: string): string {
	return line.replace(CURRENT_ITEM_MARKER_LINE_RE, "");
}

/**
 * Level 2 (sanitize on read/write): strip marker glyphs from every line of
 * ROADMAP content, preserving line count (indices stay valid) and leading
 * indentation of nested items.
 */
function sanitizeRoadmapContent(content: string): string {
	return content
		.split("\n")
		.map((line) => line.replace(CURRENT_ITEM_MARKER_SANITIZE_RE, "$1"))
		.join("\n");
}

export async function readRoadmap(missionDir: string): Promise<string> {
	return sanitizeRoadmapContent(readFileSync(join(missionDir, "ROADMAP.md"), "utf8"));
}

export async function writeRoadmap(missionDir: string, content: string): Promise<void> {
	// Heal the file: any ▶-markers an executor copied into ROADMAP.md are
	// normalized away on the next write through this single funnel.
	atomicWriteFileSync(join(missionDir, "ROADMAP.md"), sanitizeRoadmapContent(content));
}

// ─── ROADMAP helpers (shared with mission-loop) ─────────────────────────────

/**
 * Parse the first unchecked checkbox item from ROADMAP.md content.
 * Returns { index, text } or null if all items are checked / no items found.
 * Single source of truth — mission-loop imports this.
 */
export function parseFirstUnchecked(raw: string): { index: number; text: string } | null {
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^[-*] \[ \] (.+)$/.exec(stripCurrentItemMarker(lines[i].trim()));
		if (m) return { index: i, text: stripCurrentItemMarker(m[1]) };
	}
	return null;
}

/**
 * 0.8.0: Parse ALL unchecked checkbox items from ROADMAP.md content.
 * Returns array of { index, text } in document order.
 * Used by the continuous tick loop to process multiple items per tick.
 */
export function parseAllUnchecked(raw: string): Array<{ index: number; text: string }> {
	const items: Array<{ index: number; text: string }> = [];
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^[-*] \[ \] (.+)$/.exec(stripCurrentItemMarker(lines[i].trim()));
		if (m) items.push({ index: i, text: stripCurrentItemMarker(m[1]) });
	}
	return items;
}

/**
 * Check if the ROADMAP.md at `missionDir` contains at least one unchecked
 * checkbox item (`- [ ] ...` or `* [ ] ...`).
 * Used to decide whether a completed mission should be reactivated.
 */
export async function hasUncheckedRoadmapItems(missionDir: string): Promise<boolean> {
	const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
	return parseFirstUnchecked(raw) !== null;
}

/**
 * Extract the trimmed content of the `## Goal` section from a MISSION.md
 * body (frontmatter already stripped). Returns an empty string when the
 * section is missing or empty. Used by bootstrap planning (0.7.0): a
 * non-empty Goal means the mission has something to decompose into ROADMAP
 * items.
 */
export function extractGoal(body: string): string {
	const lines = body.split("\n");
	let inGoal = false;
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^#{2,}\s/.test(trimmed) || /^#{2,}$/.test(trimmed)) {
			if (inGoal) break;
			inGoal = /^#{2,}\s*Goal\s*$/i.test(trimmed);
			continue;
		}
		if (inGoal) out.push(line);
	}
	return out.join("\n").trim();
}

// ─── FSM: mission status transitions ────────────────────────────────────────

const TRANSITIONS: Record<string, Set<string>> = {
	active: new Set(["paused", "completed", "aborted", "failed", "budget_exhausted", "awaiting_decision"]),
	paused: new Set(["active", "aborted"]),
	completed: new Set(["active", "budget_exhausted"]),
	aborted: new Set(["active"]),
	failed: new Set(["active"]),
	budget_exhausted: new Set(["active"]),
	// F-17: DECIDE interruption — loop blocked until operator answer or timeout.
	// completed allowed: operator can close the mission from the decision
	// dialog / /mission:complete (MissionLoop.completeMission).
	awaiting_decision: new Set(["active", "aborted", "completed", "paused"]),
};

export function canTransition(from: string, to: string): boolean {
	return TRANSITIONS[from]?.has(to) ?? false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse markdown ## sections from STATE.md content.
 * Detects duplicate section headers and throws DuplicateSection.
 */
function parseSections(content: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	const parts = content.split(/^## /m);
	for (const part of parts) {
		if (!part.trim()) continue;
		const nl = part.indexOf("\n");
		if (nl < 0) continue;
		const header = part.slice(0, nl).trim();
		if (result.has(header)) {
			throw new DuplicateSection(header);
		}
		const body = part.slice(nl + 1);
		const items: string[] = [];
		for (const line of body.split("\n")) {
			const m = /^- (.+)$/.exec(line.trim());
			if (m) items.push(m[1]);
		}
		result.set(header, items);
	}
	return result;
}

// ─── STATE.md truncation helpers (F-10) ────────────────────────────────────

/**
 * Truncate sections content to fit within maxBytes while preserving all
 * section headers. This prevents InvalidStateSchema errors that occur when
 * byte-level truncation cuts a section header mid-line.
 *
 * Strategy:
 *   1. Always preserve `## Следующие шаги` and `## Блокеры` completely
 *   2. Truncate `## Сделано` items if needed (keep the most recent ones)
 *   3. If still over limit, truncate `## Следующие шаги` items
 *   4. If still over limit, truncate `## Блокеры` items (rare — usually small)
 */
function truncateStateSections(
	done: string[],
	blockers: string[],
	nextSteps: string[],
	maxBytes: number,
): string {
	const lines: string[] = [];
	lines.push("## Сделано");
	for (const item of done) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Блокеры");
	for (const item of blockers) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Следующие шаги");
	for (const item of nextSteps) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");

	let content = lines.join("\n");
	let byteLen = Buffer.byteLength(content, "utf8");

	// Step 1: Truncate done items (keep most recent)
	if (byteLen > maxBytes && done.length > 0) {
		// Remove oldest done items until under limit
		while (byteLen > maxBytes && done.length > 1) {
			done.shift(); // remove oldest
			content = buildSections(done, blockers, nextSteps);
			byteLen = Buffer.byteLength(content, "utf8");
		}
	}

	// Step 2: Truncate nextSteps items if still over
	if (byteLen > maxBytes && nextSteps.length > 0) {
		while (byteLen > maxBytes && nextSteps.length > 1) {
			nextSteps.shift();
			content = buildSections(done, blockers, nextSteps);
			byteLen = Buffer.byteLength(content, "utf8");
		}
	}

	// Step 3: Truncate blockers items if still over (rare)
	if (byteLen > maxBytes && blockers.length > 0) {
		while (byteLen > maxBytes && blockers.length > 1) {
			blockers.shift();
			content = buildSections(done, blockers, nextSteps);
			byteLen = Buffer.byteLength(content, "utf8");
		}
	}

	return content;
}

/** Build sections string from items arrays. */
function buildSections(done: string[], blockers: string[], nextSteps: string[]): string {
	const lines: string[] = [];
	lines.push("## Сделано");
	for (const item of done) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Блокеры");
	for (const item of blockers) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	lines.push("## Следующие шаги");
	for (const item of nextSteps) lines.push(`- ${sanitizeItem(item)}`);
	lines.push("");
	return lines.join("\n");
}

// ─── STATE.md size preflight & archiving (P1-5) ────────────────────────────

/** Default number of recent done-items to keep after archiving. */
export const ARCHIVE_KEEP_COUNT = 10;

/**
 * Check STATE.md byte size without parsing (no throw on missing file).
 * Returns 0 if the file doesn't exist yet.
 */
export function checkStateFileSize(missionDir: string): number {
	const statePath = join(missionDir, "STATE.md");
	if (!existsSync(statePath)) return 0;
	const raw = readFileSync(statePath, "utf8");
	return Buffer.byteLength(raw, "utf8");
}

/**
 * Ensure ARCHIVE.md exists with a proper header.
 */
function ensureArchive(missionDir: string): void {
	const archivePath = join(missionDir, "ARCHIVE.md");
	if (!existsSync(archivePath)) {
		writeFileSync(archivePath, "# Archive\n\n", "utf8");
	}
}

/**
 * Уровни keepCount для прогрессивного архивирования.
 * При overflow архивация пробуется последовательно: 10→5→3→1.
 * Если даже 1 запись не влезает — архивация невозможна (радикальный случай).
 */
const PROGRESSIVE_KEEP_COUNTS = [10, 5, 3, 1] as const;

/**
 * Собрать содержимое STATE.md из массивов done/blockers/nextSteps.
 */
function buildStateContent(
	done: string[],
	blockers: string[],
	nextSteps: string[],
): string {
	const lines: string[] = [];
	lines.push("## Сделано");
	for (const item of done) lines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	lines.push("");
	lines.push("## Блокеры");
	for (const item of blockers) lines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	lines.push("");
	lines.push("## Следующие шаги");
	for (const item of nextSteps) lines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	lines.push("");
	return lines.join("\n");
}

/**
 * Плановая компактизация STATE.md: если размер >= SOFT_STATE_BYTES —
 * прогрессивное архивирование старых done-записей. Тихо, без failed.
 * Вызывается при смене пункта ROADMAP и при перезапуске миссии.
 *
 * Возвращает true, если архивирование было выполнено (файл уменьшен).
 */
export async function compactStateIfNeeded(missionDir: string): Promise<boolean> {
	const stateSize = checkStateFileSize(missionDir);
	if (stateSize < SOFT_STATE_BYTES) return false;
	return archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
}

/**
 * Радикальная усечка: оставить только последнюю done-запись,
 * остальное архивировать. Последний рубеж перед 'failed'.
 *
 * Возвращает true, если файл после усечки <= MAX_STATE_BYTES.
 */
export async function radicalTruncateDone(missionDir: string): Promise<boolean> {
	const statePath = join(missionDir, "STATE.md");
	if (!existsSync(statePath)) return false;
	const raw = readFileSync(statePath, "utf8");
	const sections = parseSections(raw);
	const done = sections.get("Сделано");
	const blockers = sections.get("Блокеры") ?? [];
	const nextSteps = sections.get("Следующие шаги") ?? [];
	if (!done || done.length <= 1) return false;

	const toArchive = done.slice(0, done.length - 1);
	const toKeep = done.slice(done.length - 1);
	const newStateContent = buildStateContent(toKeep, blockers, nextSteps);

	if (Buffer.byteLength(newStateContent, "utf8") > MAX_STATE_BYTES) return false;

	ensureArchive(missionDir);
	const archivePath = join(missionDir, "ARCHIVE.md");
	const existingArchive = readFileSync(archivePath, "utf8");
	const existingItems = new Set<string>();
	for (const line of existingArchive.split("\n")) {
		const m = /^- (.+)$/.exec(line.trim());
		if (m) existingItems.add(m[1]);
	}
	const newArchiveItems = toArchive.filter((item) => !existingItems.has(item));
	if (newArchiveItems.length > 0) {
		const archiveLines = newArchiveItems.map((item) => `- ${item}`).join("\n");
		atomicWriteFileSync(archivePath, `${existingArchive}${archiveLines}\n`);
	}

	atomicWriteFileSync(join(missionDir, "STATE.md"), newStateContent);
	return true;
}

/**
 * Move old done-items from STATE.md to ARCHIVE.md.
 *
 * Прогрессивное архивирование (fix: STATE.md overflow — миссия не умирает
 * от подробного STATE):
 *   - Если done.length > keepCount — архивировать лишние, проверить размер.
 *   - Если после архивирования STATE.md всё ещё >= MAX_STATE_BYTES —
 *     пробовать уменьшать keepCount последовательно: 10→5→3→1.
 *   - 'failed' в mission-loop (step 2) — только если даже 1 запись
 *     не влезает (радикальный случай: одна done-запись > MAX_STATE_BYTES).
 *
 * Deduplicates archived items against existing ARCHIVE.md entries.
 *
 * Bypasses the MAX_STATE_BYTES size check in readState (the whole point
 * of archiving is to reduce size when STATE.md is already too large).
 */
export async function archiveOldDoneItems(
	missionDir: string,
	keepCount: number = ARCHIVE_KEEP_COUNT,
): Promise<boolean> {
	// Read state bypassing size limit (the file may be oversized — that's why we're archiving)
	const statePath = join(missionDir, "STATE.md");
	if (!existsSync(statePath)) return false;
	const raw = readFileSync(statePath, "utf8");
	const sections = parseSections(raw);
	const done = sections.get("Сделано");
	const blockers = sections.get("Блокеры") ?? [];
	const nextSteps = sections.get("Следующие шаги") ?? [];
	if (!done || done.length === 0) return false;

	// Прогрессивное архивирование: пробуем keepCount от исходного вниз до 1.
	// Если вызвано с явным keepCount (не по умолчанию) — пробуем только его.
	const keepCounts = keepCount === ARCHIVE_KEEP_COUNT
		? PROGRESSIVE_KEEP_COUNTS
		: [keepCount] as const;

	for (const kc of keepCounts) {
		if (done.length <= kc) continue; // нечего архивировать при этом уровне

		const toArchive = done.slice(0, done.length - kc);
		const toKeep = done.slice(done.length - kc);
		const newStateContent = buildStateContent(toKeep, blockers, nextSteps);

		if (Buffer.byteLength(newStateContent, "utf8") > MAX_STATE_BYTES) {
			continue; // не влезло — пробуем менее жадный keepCount
		}

		// Влезло — записываем ARCHIVE.md и STATE.md
		ensureArchive(missionDir);
		const archivePath = join(missionDir, "ARCHIVE.md");
		const existingArchive = readFileSync(archivePath, "utf8");
		const existingItems = new Set<string>();
		for (const line of existingArchive.split("\n")) {
			const m = /^- (.+)$/.exec(line.trim());
			if (m) existingItems.add(m[1]);
		}
		const newArchiveItems = toArchive.filter((item) => !existingItems.has(item));

		if (newArchiveItems.length > 0) {
			const archiveLines = newArchiveItems.map((item) => `- ${item}`).join("\n");
			atomicWriteFileSync(archivePath, `${existingArchive}${archiveLines}\n`);
		}

		atomicWriteFileSync(join(missionDir, "STATE.md"), newStateContent);
		return true;
	}

	// Ни один keepCount не помог — даже 1 запись не влезает (радикальный случай).
	return false;
}

/**
 * Parse simple YAML-like frontmatter block.
 * Handles:
 * - Quoted values: status: "active" → active
 * - Inline comments: budget_tokens: 500000 # limit → 500000
 * - CRLF is normalized before calling this function
 */
function parseSimpleYaml(block: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx < 1) continue;
		const key = line.slice(0, colonIdx).trim();
		let rawVal = line.slice(colonIdx + 1).trim();

		// Strip inline comments: remove `# ...` but only outside quotes
		rawVal = stripInlineComment(rawVal);

		// Strip surrounding quotes (single or double)
		if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
			rawVal = rawVal.slice(1, -1);
		}

		let val: unknown = rawVal;
		const s = String(val);
		if (/^-?\d+$/.test(s)) val = Number.parseInt(s, 10);
		else if (/^-?\d+\.\d+$/.test(s)) val = Number.parseFloat(s);
		result[key] = val;
	}
	return result;
}

/**
 * Strip inline comment (# ...) from a YAML value, respecting quotes.
 * Examples:
 *   `500000 # limit` → `500000`
 *   `"hello # world"` → `"hello # world"` (preserved inside quotes)
 *   `active` → `active`
 */
function stripInlineComment(value: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value;
}
