// F-08: File-state-manager — mission file management for the FAN super-orchestrator.
// Manages 5 mission files (MISSION.md, ROADMAP.md, STATE.md, BACKLOG.md, DECISIONS.md),
// FSM status transitions, and slug validation with path-traversal protection.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_STATE_BYTES = 5 * 1024;
export const MAX_SLUG_LENGTH = 100;
export const MISSION_FILES = ["MISSION.md", "ROADMAP.md", "STATE.md", "BACKLOG.md", "DECISIONS.md"] as const;

// ─── Dynamic template loader (handles .ts and .js at runtime) ──────────────

interface MissionTemplateFiles {
	"MISSION.md": string;
	"ROADMAP.md": string;
	"STATE.md": string;
	"BACKLOG.md": string;
	"DECISIONS.md": string;
}

interface TemplateModule {
	loadTemplate(name: string): Promise<MissionTemplateFiles>;
	renderTemplate(raw: string, vars: { slug: string; missionId: string; now: string }): string;
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

export async function initMission(slug: string, opts?: { baseDir?: string; template?: string }): Promise<string> {
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
	const vars = { slug, missionId, now };

	for (const [fileName, raw] of Object.entries(templates) as [keyof MissionTemplateFiles, string][]) {
		writeFileSync(join(missionDir, fileName), tmpl.renderTemplate(raw, vars), "utf8");
	}

	return missionDir;
}

// ─── STATE.md read / write ──────────────────────────────────────────────────

export async function readState(missionDir: string): Promise<MissionState> {
	const statePath = join(missionDir, "STATE.md");
	if (!existsSync(statePath)) {
		throw new MissionNotFound(missionDir);
	}
	const raw = readFileSync(statePath, "utf8");
	const byteLen = Buffer.byteLength(raw, "utf8");
	if (byteLen > MAX_STATE_BYTES) {
		throw new StateFileTooLarge(MAX_STATE_BYTES, byteLen);
	}

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

export async function readRoadmap(missionDir: string): Promise<string> {
	return readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
}

export async function writeRoadmap(missionDir: string, content: string): Promise<void> {
	atomicWriteFileSync(join(missionDir, "ROADMAP.md"), content);
}

// ─── FSM: mission status transitions ────────────────────────────────────────

const TRANSITIONS: Record<string, Set<string>> = {
	active: new Set(["paused", "completed", "aborted", "failed", "budget_exhausted", "awaiting_decision"]),
	paused: new Set(["active", "aborted"]),
	completed: new Set(),
	aborted: new Set(["active"]),
	failed: new Set(["active"]),
	budget_exhausted: new Set(["active"]),
	// F-17: DECIDE interruption — loop blocked until operator answer or timeout
	awaiting_decision: new Set(["active", "aborted"]),
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
 * Move old done-items from STATE.md to ARCHIVE.md, keeping the last `keepCount`.
 * Returns true if items were archived, false if nothing to archive or archiving failed.
 *
 * P1-3 fix: compute result in memory first. If kept items still exceed MAX_STATE_BYTES,
 * return false WITHOUT touching ARCHIVE.md (prevents zombie-cycle and duplicates).
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
	if (!done || done.length <= keepCount) return false;

	const toArchive = done.slice(0, done.length - keepCount);
	const toKeep = done.slice(done.length - keepCount);

	// P1-3: compute new STATE.md in memory and check if it fits BEFORE writing anything
	const newLines: string[] = [];
	newLines.push("## Сделано");
	for (const item of toKeep) newLines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	newLines.push("");
	newLines.push("## Блокеры");
	for (const item of blockers) newLines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	newLines.push("");
	newLines.push("## Следующие шаги");
	for (const item of nextSteps) newLines.push(`- ${item.replace(/[\r\n]+/g, " ")}`);
	newLines.push("");
	const newStateContent = newLines.join("\n");

	// If kept items still exceed limit → abort without touching ARCHIVE.md
	if (Buffer.byteLength(newStateContent, "utf8") > MAX_STATE_BYTES) {
		return false;
	}

	// P1-3: dedup — only archive items not already in ARCHIVE.md
	ensureArchive(missionDir);
	const archivePath = join(missionDir, "ARCHIVE.md");
	const existingArchive = readFileSync(archivePath, "utf8");
	const existingItems = new Set<string>();
	for (const line of existingArchive.split("\n")) {
		const m = /^- (.+)$/.exec(line.trim());
		if (m) existingItems.add(m[1]);
	}
	const newArchiveItems = toArchive.filter((item) => !existingItems.has(item));

	// Write ARCHIVE.md (only if there are new items to add)
	if (newArchiveItems.length > 0) {
		const archiveLines = newArchiveItems.map((item) => `- ${item}`).join("\n");
		atomicWriteFileSync(archivePath, `${existingArchive}${archiveLines}\n`);
	}

	// Write new STATE.md (guaranteed to fit from the check above)
	atomicWriteFileSync(join(missionDir, "STATE.md"), newStateContent);

	return true;
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
