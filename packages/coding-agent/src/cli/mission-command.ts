// F-10: CLI `fan mission <subcommand>` — init + lifecycle subcommands.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-10
// Спека:   docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.2, §6.1
//
// Команда условна: требует расширение `fan-mission`. Файловое хранилище
// (F-08) подключается динамически из `bundles/fan-mission/extensions/fan-mission/file-state-manager.ts`,
// чтобы не ломать rootDir сборки coding-agent и не падать, когда расширение
// отсутствует (в этом случае бросается MissionExtensionMissingError).
//
// Субкоманды: init, start, stop, status, pause, resume, tree.
// start/stop/pause/resume — проверки + FSM-переходы через file-state-manager;
// реальный executor подключается на этапе 1 через F-09 (сейчас start — no-op).
// tree (F-42) — ASCII/JSON-дерево миссии из tree-journal.jsonl (локальная
// реконструкция формата F-32; coding-agent не импортирует из extensions/).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "../config.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MISSION_FILES = ["MISSION.md", "ROADMAP.md", "STATE.md", "BACKLOG.md", "DECISIONS.md"] as const;

const SUBCOMMANDS = ["init", "start", "stop", "status", "pause", "resume", "tree"] as const;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class MissionAlreadyExistsError extends Error {
	constructor(slug: string, missionDir: string) {
		super(`Mission "${slug}" already exists at ${missionDir}`);
		this.name = "MissionAlreadyExistsError";
	}
}

export class MissionNotInitializedError extends Error {
	constructor(dir: string) {
		super(`No mission initialized in ${dir}. Run "fan mission init <slug>" first.`);
		this.name = "MissionNotInitializedError";
	}
}

export class MissionExtensionMissingError extends Error {
	constructor(detail?: string) {
		super(detail ? `${detail} — extension "fan-mission" is not loaded` : 'Extension "fan-mission" is not loaded');
		this.name = "MissionExtensionMissingError";
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

// ─── Context ────────────────────────────────────────────────────────────────

export interface MissionContext {
	/** DI: проверка загрузки расширения (по умолчанию fan-mission считается встроенным). */
	isExtensionLoaded?: (name: string) => boolean;
	/** Базовый каталог миссий (по умолчанию `docs/missions`). */
	baseDir?: string;
}

// ─── file-state-manager (F-08) dynamic loader ───────────────────────────────

interface FileStateManagerModule {
	MISSION_FILES: readonly string[];
	validateSlug(slug: string): void;
	initMission(slug: string, opts?: { baseDir?: string; template?: string; description?: string }): Promise<string>;
	readMission(missionDir: string): Promise<{ frontmatter: Record<string, unknown>; body: string }>;
	readState(missionDir: string): Promise<{ done: string[]; blockers: string[]; nextSteps: string[] }>;
	writeMissionStatus(missionDir: string, newStatus: string): Promise<void>;
	canTransition(from: string, to: string): boolean;
	parseFirstUnchecked(raw: string): { index: number; text: string } | null;
	hasUncheckedRoadmapItems(missionDir: string): Promise<boolean>;
	readBacklog(missionDir: string): Promise<Array<{ id: string; status: string }>>;
	InvalidTransitionError: typeof InvalidTransitionError;
}

let fsmCache: FileStateManagerModule | undefined;

async function loadFileStateManager(): Promise<FileStateManagerModule> {
	if (fsmCache) return fsmCache;

	const here = new URL(".", import.meta.url);
	const candidates: string[] = [];
	if (process.env.FAN_MISSION_DIR) {
		// P-4: try .js first, then .ts fallback for dev with tsx-loader.
		candidates.push(resolve(process.env.FAN_MISSION_DIR, "file-state-manager.js"));
		candidates.push(resolve(process.env.FAN_MISSION_DIR, "file-state-manager.ts"));
	}
	// Deployed-окружение: runtime extension discovery (как в
	// core/extensions/loader.ts) — project-local и global каталоги.
	// Приоритет выше монорепо-путей: у deployed-бинаря в произвольном
	// проекте монорепо-кандидатов не существует.
	for (const ext of ["js", "ts"]) {
		// P-4: try .js first, then .ts fallback for dev with tsx-loader.
		candidates.push(resolve(process.cwd(), ".fan", "extensions", "fan-mission", `file-state-manager.${ext}`));
	}
	for (const ext of ["js", "ts"]) {
		candidates.push(join(getAgentDir(), "extensions", "fan-mission", `file-state-manager.${ext}`));
	}
	for (const ext of ["js", "ts"]) {
		// Монорепо: <root>/packages/coding-agent/src/cli → <root>/bundles/fan-mission/extensions/fan-mission
		candidates.push(
			fileURLToPath(
				new URL(`../../../../bundles/fan-mission/extensions/fan-mission/file-state-manager.${ext}`, here),
			),
		);
		// Запуск из корня монорепо (например, из собранного бандла другой глубины).
		candidates.push(resolve("bundles", "fan-mission", "extensions", "fan-mission", `file-state-manager.${ext}`));
	}

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const mod = (await import(pathToFileURL(candidate).href)) as FileStateManagerModule;
			fsmCache = mod;
			return mod;
		} catch (err) {
			// Log and continue to next candidate
			console.error(
				`[mission] Failed to load file-state-manager from ${candidate}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	throw new MissionExtensionMissingError("file-state-manager module not found");
}

// ─── Mission directory resolution ───────────────────────────────────────────

function resolveMissionDir(missionDir: string | undefined, baseDir: string | undefined): string {
	if (missionDir) return resolve(missionDir);
	const base = resolve(baseDir ?? join("docs", "missions"));
	if (existsSync(join(base, "MISSION.md"))) return base;
	if (existsSync(base)) {
		let entries: string[] = [];
		try {
			entries = readdirSync(base, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			entries = [];
		}
		for (const name of entries) {
			const candidate = join(base, name);
			if (existsSync(join(candidate, "MISSION.md"))) {
				// P-8: log auto-detected mission slug to stderr.
				console.error(`[mission] auto-detected mission: ${name}`);
				return candidate;
			}
		}
	}
	return base;
}

async function requireMissionDir(missionDir: string | undefined, ctx: MissionContext | undefined): Promise<string> {
	const dir = resolveMissionDir(missionDir, ctx?.baseDir);
	if (!existsSync(join(dir, "MISSION.md"))) {
		throw new MissionNotInitializedError(dir);
	}
	return dir;
}

async function readStatus(fsm: FileStateManagerModule, missionDir: string): Promise<string> {
	const { frontmatter } = await fsm.readMission(missionDir);
	return String(frontmatter.status ?? "active");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function listMissionSubcommands(): string[] {
	return [...SUBCOMMANDS];
}

/**
 * Создать миссию: `<baseDir>/<slug>/` с 5 файлами-шаблонами.
 * Делегирует создание и валидацию slug в file-state-manager (F-08).
 * 0.7.0: `description` подставляется в секцию `## Goal` шаблона MISSION.md
 * (весь текст, без эвристического разбора).
 */
export async function missionInit(
	slug: string,
	opts?: { baseDir?: string; template?: string; description?: string },
): Promise<string> {
	const fsm = await loadFileStateManager();
	fsm.validateSlug(slug);
	const baseDir = opts?.baseDir ?? join("docs", "missions");
	const missionDir = resolve(baseDir, slug);
	if (existsSync(missionDir)) {
		throw new MissionAlreadyExistsError(slug, missionDir);
	}
	return fsm.initMission(slug, { baseDir, template: opts?.template, description: opts?.description });
}

/**
 * Запустить миссию. Заглушка: реальный executor подключается через F-09
 * (этап 1). Сейчас — проверка наличия миссии и статуса active.
 * P-5: использует FSM-переходы; для aborted/failed/budget_exhausted
 * предлагает resume. Completed миссия реактивируется при наличии
 * unchecked-пунктов в ROADMAP.md.
 */
export async function missionStart(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "active") {
		const { frontmatter } = await fsm.readMission(dir);
		console.log(`Mission ${frontmatter.mission_id} is active at ${dir}`);
		console.log("(running fan session will attach the loop on restart; in-session: /mission:start)");
		return;
	}
	// Completed mission: reactivate only if ROADMAP has unchecked items
	if (status === "completed") {
		const hasUnchecked = await fsm.hasUncheckedRoadmapItems(dir);
		if (hasUnchecked) {
			await fsm.writeMissionStatus(dir, "active");
			console.log(`Mission reactivated — new unchecked items found at ${dir}`);
			return;
		}
		const { frontmatter } = await fsm.readMission(dir);
		const slug = frontmatter.mission_id ? String(frontmatter.mission_id) : dir;
		console.log(
			`Mission ${slug} is completed. Add new unchecked items to ROADMAP.md and run fan mission start, or create a new mission.`,
		);
		return;
	}
	// FSM allows transitioning to active from aborted, failed, budget_exhausted, paused.
	if (!fsm.canTransition(status, "active")) {
		throw new InvalidTransitionError(status, "active");
	}
	await fsm.writeMissionStatus(dir, "active");
	console.log(`Mission started at ${dir}`);
}

/** Остановить миссию (FSM: active/paused → aborted). */
export async function missionStop(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "completed" || status === "aborted") {
		console.log(`Mission already ${status} at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "aborted")) {
		throw new InvalidTransitionError(status, "aborted");
	}
	await fsm.writeMissionStatus(dir, "aborted");
	console.log(`Mission stopped (aborted) at ${dir}`);
}

/** Показать состояние миссии: frontmatter + сводка STATE.md. */
export async function missionStatus(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const { frontmatter } = await fsm.readMission(dir);
	console.log(`Mission:  ${frontmatter.mission_id}`);
	console.log(`Dir:      ${dir}`);
	console.log(`Status:   ${frontmatter.status}`);
	console.log(`Created:  ${frontmatter.created}`);
	console.log(`Metric:   ${frontmatter.metric_type} (${frontmatter.metric_command})`);
	console.log(`Budget:   ${frontmatter.budget_tokens} tokens / $${frontmatter.budget_usd}`);
	const state = await fsm.readState(dir).catch(() => undefined);
	if (state) {
		console.log(
			`Done:     ${state.done.length} item(s); blockers: ${state.blockers.length}; next: ${state.nextSteps.length}`,
		);
	}
}

/** Поставить миссию на паузу (FSM: active → paused). */
export async function missionPause(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "paused") {
		console.log(`Mission already paused at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "paused")) {
		throw new InvalidTransitionError(status, "paused");
	}
	await fsm.writeMissionStatus(dir, "paused");
	console.log(`Mission paused at ${dir}`);
}

/** Возобновить миссию (FSM: paused/aborted/failed/budget_exhausted → active). */
export async function missionResume(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "active") {
		console.log(`Mission already active at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "active")) {
		throw new InvalidTransitionError(status, "active");
	}
	// For completed missions: warn if nothing to resume (no unchecked
	// ROADMAP items and no IDEA backlog entries). Changing status would
	// just cause the loop to complete again immediately.
	if (status === "completed") {
		const hasUnchecked = await fsm.hasUncheckedRoadmapItems(dir);
		let hasIdeas = false;
		if (!hasUnchecked && typeof fsm.readBacklog === "function") {
			try {
				hasIdeas = (await fsm.readBacklog(dir)).some((e) => e.status === "IDEA");
			} catch {
				hasIdeas = false;
			}
		}
		if (!hasUnchecked && !hasIdeas) {
			console.log("Nothing to resume: backlog has no IDEA entries and ROADMAP is complete.");
			console.log("Add new items via `/idea <text>` in a fan session, then use /mission:resume.");
			return;
		}
	}
	await fsm.writeMissionStatus(dir, "active");
	console.log(`Mission resumed at ${dir}`);
	if (status === "completed") {
		console.log("Start a fan session or use /mission:resume in-session to begin processing.");
	}
}

// ─── F-42: mission tree (tree-journal.jsonl → ASCII/JSON) ───────────────────

/** Запись журнала (минимальный контракт: event + nodeId). */
interface TreeJournalEntry {
	event: string;
	nodeId: string;
	parentId?: string;
	usage?: { tokens?: number; usd?: number };
}

/** Узел, восстановленный из журнала (локальный формат F-32). */
interface RawMissionTreeNode {
	parentId: string | null;
	status: string;
	costUsd: number;
	childIds: string[];
}

interface ReconstructedCliTree {
	nodes: Map<string, RawMissionTreeNode>;
	/** Порядок появления nodeId в журнале. */
	order: string[];
	/** Узлы без parentId, в порядке появления. */
	roots: string[];
}

/** Иконки статусов: ✓ completed, ● active, ✗ failed, ○ pending/unknown. */
const NODE_STATUS_ICONS: Record<string, string> = {
	complete: "✓",
	completed: "✓",
	spawn: "●",
	active: "●",
	fail: "✗",
	failed: "✗",
};

function nodeStatusIcon(status: string): string {
	return NODE_STATUS_ICONS[status] ?? "○";
}

/** Удаляет инлайн-комментарий (# ...) из значения YAML с учётом кавычек. */
function stripInlineComment(value: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			return value.slice(0, i).trim();
		}
	}
	return value;
}

/** Простой YAML-подобный парсер frontmatter (формат fan-mission):
 *  кавычки снимаются, инлайн-комментарии удаляются, числа типизируются. */
function parseSimpleYaml(block: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx < 1) continue;
		const key = line.slice(0, colonIdx).trim();
		let rawVal = line.slice(colonIdx + 1).trim();
		rawVal = stripInlineComment(rawVal);
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

/** Читает frontmatter MISSION.md. Отсутствующий/невалидный файл → {}. */
function readMissionFrontmatter(missionDir: string): Record<string, unknown> {
	const missionPath = join(missionDir, "MISSION.md");
	if (!existsSync(missionPath)) return {};
	let raw: string;
	try {
		raw = readFileSync(missionPath, "utf8").replace(/\r\n/g, "\n");
	} catch {
		return {};
	}
	if (!raw.startsWith("---\n")) return {};
	const endIdx = raw.indexOf("\n---\n", 4);
	if (endIdx < 0) return {};
	return parseSimpleYaml(raw.slice(4, endIdx));
}

/** Минимальная валидация записи журнала: объект со строковыми event/nodeId. */
function isTreeJournalEntry(value: unknown): value is TreeJournalEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<TreeJournalEntry>;
	return typeof candidate.event === "string" && typeof candidate.nodeId === "string";
}

/** Разбирает JSONL-содержимое журнала; повреждённые строки пропускаются. */
function parseTreeJournal(content: string): TreeJournalEntry[] {
	const entries: TreeJournalEntry[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // повреждённая строка — пропускаем
		}
		if (isTreeJournalEntry(parsed)) entries.push(parsed);
	}
	return entries;
}

/** Восстанавливает топологию дерева по записям журнала (семантика F-32):
 *  любая запись создаёт/обновляет узел (status = event, последняя wins);
 *  запись с parentId привязывает ребёнка к родителю (implicit-родитель,
 *  упомянутый только как parentId, получает status "unknown"). */
function reconstructCliTree(entries: TreeJournalEntry[]): ReconstructedCliTree {
	const nodes = new Map<string, RawMissionTreeNode>();
	const order: string[] = [];

	const ensureNode = (id: string): RawMissionTreeNode => {
		let node = nodes.get(id);
		if (!node) {
			node = { parentId: null, status: "unknown", costUsd: 0, childIds: [] };
			nodes.set(id, node);
			order.push(id);
		}
		return node;
	};

	for (const entry of entries) {
		const node = ensureNode(entry.nodeId);
		node.status = entry.event;
		if (entry.usage !== undefined && typeof entry.usage.usd === "number") {
			node.costUsd = entry.usage.usd;
		}
		if (entry.parentId !== undefined) {
			node.parentId = entry.parentId;
			const parent = ensureNode(entry.parentId);
			if (!parent.childIds.includes(entry.nodeId)) {
				parent.childIds.push(entry.nodeId);
			}
		}
	}

	// Если журнал содержит узел "root", все parentless-узлы отражаются и в его
	// childIds тоже (parentId остаётся null — узлы сохраняются в roots).
	// Семантика идентична reconstructMissionTree в @fan/api-gateway (F-47):
	// один журнал → одинаковая топология в CLI и API.
	const root = nodes.get("root");
	if (root) {
		for (const id of order) {
			if (id !== "root" && nodes.get(id)?.parentId === null && !root.childIds.includes(id)) {
				root.childIds.push(id);
			}
		}
	}

	return { nodes, order, roots: order.filter((id) => nodes.get(id)?.parentId === null) };
}

/** Рендер ASCII-дерева. visited-защита от циклов; depth обрезает уровни
 *  (1 = только корни). Узлы, недостижимые из корней (циклы в журнале),
 *  выводятся отдельными верхнеуровневыми записями. */
function renderCliTree(tree: ReconstructedCliTree, depth: number | undefined): string[] {
	const { nodes, order, roots } = tree;
	const lines: string[] = [];

	// Сначала помечаем все узлы, достижимые из корней (без учёта depth),
	// чтобы depth-обрезка не приводила к повторному выводу на верхнем уровне.
	const reachable = new Set<string>();
	const markReachable = (id: string): void => {
		if (reachable.has(id)) return;
		reachable.add(id);
		const node = nodes.get(id);
		if (!node) return;
		for (const childId of node.childIds) markReachable(childId);
	};
	for (const rootId of roots) markReachable(rootId);

	const visited = new Set<string>();
	const renderNode = (id: string, prefix: string, childPrefix: string, level: number): void => {
		if (visited.has(id)) return;
		visited.add(id);
		const node = nodes.get(id);
		if (!node) return;
		let line = `${prefix}${id}${node.parentId === null ? " (root)" : ""} ${nodeStatusIcon(node.status)}`;
		if (node.costUsd > 0) line += ` $${node.costUsd.toFixed(2)}`;
		lines.push(line);
		if (depth !== undefined && level >= depth) return;
		const kids = node.childIds.filter((childId) => nodes.has(childId));
		kids.forEach((childId, index) => {
			const last = index === kids.length - 1;
			renderNode(
				childId,
				`${childPrefix}${last ? "└── " : "├── "}`,
				`${childPrefix}${last ? "    " : "│   "}`,
				level + 1,
			);
		});
	};

	for (const rootId of roots) renderNode(rootId, "├── ", "│   ", 1);
	for (const id of order) {
		if (!reachable.has(id)) renderNode(id, "├── ", "│   ", 1);
	}
	return lines;
}

/** Сериализация узла для --format json (с visited-защитой и depth-обрезкой). */
function serializeCliNode(
	tree: ReconstructedCliTree,
	id: string,
	level: number,
	depth: number | undefined,
	visited: Set<string>,
): Record<string, unknown> | null {
	if (visited.has(id)) return null;
	visited.add(id);
	const node = tree.nodes.get(id);
	if (!node) return null;
	const children: Record<string, unknown>[] = [];
	if (depth === undefined || level < depth) {
		for (const childId of node.childIds) {
			const child = serializeCliNode(tree, childId, level + 1, depth, visited);
			if (child) children.push(child);
		}
	}
	return {
		nodeId: id,
		parentId: node.parentId,
		status: node.status,
		costUsd: Math.round(node.costUsd * 100) / 100,
		children,
	};
}

function formatTotalLine(totalCostUsd: number, budgetUsd: number | undefined): string {
	const total = `$${totalCostUsd.toFixed(2)}`;
	if (budgetUsd !== undefined && budgetUsd > 0) {
		const pct = Math.round((totalCostUsd / budgetUsd) * 100);
		return `└── Total: ${total} / $${budgetUsd.toFixed(2)} (${pct}%)`;
	}
	return `└── Total: ${total}`;
}

/**
 * F-42: вывести дерево миссии из `<missionDir>/tree-journal.jsonl`.
 * Читает frontmatter MISSION.md (статус, budget_usd), восстанавливает
 * топологию (локальная реконструкция формата F-32) и печатает ASCII-дерево
 * (✓ completed, ● active, ✗ failed, ○ pending/unknown) либо JSON
 * при opts.format === "json". opts.depth ограничивает глубину вывода.
 * Отсутствующая миссия (нет MISSION.md) → MissionNotInitializedError.
 */
export async function missionTree(missionDir: string, opts?: { format?: string; depth?: number }): Promise<void> {
	const dir = resolve(missionDir);
	if (!existsSync(join(dir, "MISSION.md"))) {
		throw new MissionNotInitializedError(dir);
	}
	const slug = basename(dir);
	const frontmatter = readMissionFrontmatter(dir);
	const status = typeof frontmatter.status === "string" ? frontmatter.status : "active";
	const budgetUsd = typeof frontmatter.budget_usd === "number" ? frontmatter.budget_usd : undefined;

	const journalPath = join(dir, "tree-journal.jsonl");
	let entries: TreeJournalEntry[] = [];
	if (existsSync(journalPath)) {
		try {
			entries = parseTreeJournal(readFileSync(journalPath, "utf8").replace(/\r\n/g, "\n"));
		} catch {
			entries = [];
		}
	}
	const tree = reconstructCliTree(entries);
	let totalCostUsd = 0;
	for (const node of tree.nodes.values()) totalCostUsd += node.costUsd;

	if (opts?.format === "json") {
		// Достижимые из корней узлы (без учёта depth) — как в ASCII-рендере.
		const reachable = new Set<string>();
		const markReachable = (id: string): void => {
			if (reachable.has(id)) return;
			reachable.add(id);
			const node = tree.nodes.get(id);
			if (!node) return;
			for (const childId of node.childIds) markReachable(childId);
		};
		for (const rootId of tree.roots) markReachable(rootId);
		const visited = new Set<string>();
		const rootTrees: Record<string, unknown>[] = [];
		for (const rootId of tree.roots) {
			const serialized = serializeCliNode(tree, rootId, 1, opts.depth, visited);
			if (serialized) rootTrees.push(serialized);
		}
		for (const id of tree.order) {
			if (reachable.has(id)) continue;
			const serialized = serializeCliNode(tree, id, 1, opts.depth, visited);
			if (serialized) rootTrees.push(serialized);
		}
		const payload = {
			mission: slug,
			status,
			budgetUsd: budgetUsd ?? null,
			root: rootTrees[0] ?? null,
			roots: rootTrees,
			total: { costUsd: Math.round(totalCostUsd * 100) / 100, nodeCount: tree.nodes.size },
		};
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(`Mission: ${slug}`);
	console.log(`Status:  ${status}`);
	if (tree.nodes.size === 0) {
		console.log("(no nodes in tree journal)");
	}
	for (const line of renderCliTree(tree, opts?.depth)) {
		console.log(line);
	}
	console.log(formatTotalLine(totalCostUsd, budgetUsd));
}

// ─── CLI dispatcher ─────────────────────────────────────────────────────────

/**
 * Parse --template flag from args. Supports:
 *   --template <name>
 *   --template=<name>
 * Returns undefined if not present.
 */
function parseTemplateFlag(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--template" && i + 1 < args.length) {
			return args[i + 1];
		}
		if (arg.startsWith("--template=")) {
			return arg.slice("--template=".length);
		}
	}
	return undefined;
}

/** Generic `--name <value>` / `--name=<value>` parser. Undefined if absent. */
function parseNamedFlag(args: string[], name: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === name && i + 1 < args.length) {
			return args[i + 1];
		}
		if (arg.startsWith(`${name}=`)) {
			return arg.slice(name.length + 1);
		}
	}
	return undefined;
}

/**
 * Диспетчер `fan mission <subcommand>`.
 * Возвращает false, если args не относится к команде mission (другие
 * хендлеры продолжают), либо для неизвестной субкоманды.
 */
export async function handleMissionCommand(args: string[], ctx?: MissionContext): Promise<boolean> {
	if (args[0] !== "mission") return false;

	// Условная регистрация: без расширения fan-mission команда не выполняется.
	const isExtensionLoaded = ctx?.isExtensionLoaded ?? (() => true);
	if (!isExtensionLoaded("fan-mission")) {
		console.error('Command "mission" requires the fan-mission extension, which is not loaded.');
		process.exit(1);
		return false;
	}

	const subcommand = args[1];
	try {
		switch (subcommand) {
			case "init": {
				// 0.7.0: `fan mission init <slug> [description]` — первый
				// позициональный аргумент (после флагов) = slug, остальные
				// позициональные склеиваются в описание миссии (→ ## Goal).
				const initArgs = args.slice(2);
				const positionals: string[] = [];
				for (let i = 0; i < initArgs.length; i++) {
					const a = initArgs[i];
					if (a === "--template") {
						i++;
						continue;
					} // skip flag + value
					if (a.startsWith("--")) continue; // skip other flags
					positionals.push(a);
				}
				const slug = positionals[0];
				if (!slug) {
					console.error("Usage: fan mission init <slug> [description] [--template <name>]");
					process.exit(1);
					return false;
				}
				const description = positionals.slice(1).join(" ") || undefined;
				const template = parseTemplateFlag(initArgs);
				const initOpts: { baseDir?: string; template?: string; description?: string } = {};
				if (ctx?.baseDir) initOpts.baseDir = ctx.baseDir;
				if (template) initOpts.template = template;
				if (description) initOpts.description = description;
				const dir = await missionInit(slug, Object.keys(initOpts).length > 0 ? initOpts : undefined);
				console.log(`Mission initialized: ${dir}`);
				return true;
			}
			case "tree": {
				const treeArgs = args.slice(2);
				let slug: string | undefined;
				for (let i = 0; i < treeArgs.length; i++) {
					const a = treeArgs[i];
					if (a === "--format" || a === "--depth") {
						i++;
						continue;
					}
					if (a.startsWith("--")) continue;
					slug = a;
					break;
				}
				if (!slug) {
					console.error("Usage: fan mission tree <slug> [--format json] [--depth <n>]");
					process.exit(1);
					return false;
				}
				const format = parseNamedFlag(treeArgs, "--format");
				const depthRaw = parseNamedFlag(treeArgs, "--depth");
				const depthValue = depthRaw === undefined ? Number.NaN : Number.parseInt(depthRaw, 10);
				const base = resolve(ctx?.baseDir ?? join("docs", "missions"));
				await missionTree(resolve(base, slug), {
					format,
					depth: Number.isFinite(depthValue) ? depthValue : undefined,
				});
				return true;
			}
			case "start":
				await missionStart(undefined, ctx);
				return true;
			case "stop":
				await missionStop(undefined, ctx);
				return true;
			case "status":
				await missionStatus(undefined, ctx);
				return true;
			case "pause":
				await missionPause(undefined, ctx);
				return true;
			case "resume":
				await missionResume(undefined, ctx);
				return true;
			default: {
				console.error(
					`Unknown mission subcommand: ${subcommand ?? "(none)"}. Usage: fan mission <${listMissionSubcommands().join("|")}>`,
				);
				return false;
			}
		}
	} catch (err) {
		const known =
			err instanceof MissionAlreadyExistsError ||
			err instanceof MissionNotInitializedError ||
			err instanceof MissionExtensionMissingError ||
			err instanceof InvalidTransitionError ||
			(err instanceof Error && err.name === "InvalidSlug") ||
			(err instanceof Error && err.name === "InvalidTransitionError");
		if (known) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
			return false;
		}
		throw err;
	}
}
