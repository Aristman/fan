// F-47: Mission data reader — самодостаточный модуль api-gateway.
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-47
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.2
//
// Архитектурное ограничение: api-gateway — пакет ядра, импортировать из
// extensions/ запрещено. Поэтому чтение артефактов миссии реализовано здесь
// локально (форматы совместимы с fan-mission / fan-super-orchestrator):
//   docs/missions/<slug>/MISSION.md          — YAML-подобный frontmatter
//   docs/missions/<slug>/tree-journal.jsonl  — JSONL-журнал дерева (F-32)
//   docs/missions/<slug>/mission-budget.json — бюджет (F-31), passthrough

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Slug validation (path traversal protection)
// ============================================================================

/** Допустимые символы slug миссии — только безопасное имя каталога. */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Dot-only slug (".", "..", "...") — отклоняется (path traversal). */
const DOTS_ONLY_PATTERN = /^\.+$/;

/** Проверка slug: только [A-Za-z0-9._-]+, без dot-only имён (защита от path traversal). */
export function isValidMissionSlug(slug: string): boolean {
	return SLUG_PATTERN.test(slug) && !DOTS_ONLY_PATTERN.test(slug);
}

// ============================================================================
// Types
// ============================================================================

/** Узел восстановленного дерева (формат reconstructTree из F-32). */
export interface MissionTreeNode {
	parentId: string | null;
	children: string[];
	status: string;
	correlationId?: string;
	usage?: { tokens?: number; usd?: number };
}

/** Дерево миссии, восстановленное из tree-journal.jsonl. */
export interface MissionTree {
	nodes: Record<string, MissionTreeNode>;
	/** Узлы без parentId, в порядке появления в журнале. */
	roots: string[];
}

/** Запись журнала (минимальный контракт: event + nodeId). */
interface JournalEntry {
	timestamp?: string;
	event: string;
	nodeId: string;
	parentId?: string;
	correlationId?: string;
	usage?: { tokens?: number; usd?: number };
	[key: string]: unknown;
}

// ============================================================================
// MISSION.md frontmatter (простой YAML-подобный парсер, формат fan-mission)
// ============================================================================

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

/** Простой YAML-подобный парсер frontmatter (как в fan-mission):
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
	if (!existsSync(missionPath)) {
		return {};
	}
	let raw: string;
	try {
		raw = readFileSync(missionPath, "utf8").replace(/\r\n/g, "\n");
	} catch {
		return {};
	}
	if (!raw.startsWith("---\n")) {
		return {};
	}
	const endIdx = raw.indexOf("\n---\n", 4);
	if (endIdx < 0) {
		return {};
	}
	return parseSimpleYaml(raw.slice(4, endIdx));
}

// ============================================================================
// tree-journal.jsonl → дерево (локальная реконструкция, формат F-32)
// ============================================================================

/** Минимальная валидация записи журнала: объект со строковыми event/nodeId. */
function isJournalEntry(value: unknown): value is JournalEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<JournalEntry>;
	return typeof candidate.event === "string" && typeof candidate.nodeId === "string";
}

/** Разбирает JSONL-содержимое журнала; повреждённые строки пропускаются. */
function parseJournalEntries(content: string): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // повреждённая строка — пропускаем
		}
		if (isJournalEntry(parsed)) {
			entries.push(parsed);
		}
	}
	return entries;
}

/** Восстанавливает топологию дерева по записям журнала (семантика F-32):
 *  любая запись создаёт/обновляет узел (status = event, последняя wins);
 *  запись с parentId привязывает ребёнка к родителю; без parentId — корень. */
function reconstructMissionTree(entries: JournalEntry[]): MissionTree {
	const nodes: Record<string, MissionTreeNode> = {};
	const order: string[] = [];

	const ensureNode = (id: string): MissionTreeNode => {
		let node = nodes[id];
		if (!node) {
			node = { parentId: null, children: [], status: "unknown" };
			nodes[id] = node;
			order.push(id);
		}
		return node;
	};

	for (const entry of entries) {
		const node = ensureNode(entry.nodeId);
		node.status = entry.event;
		if (entry.correlationId !== undefined) node.correlationId = entry.correlationId;
		if (entry.usage !== undefined) node.usage = entry.usage;
		if (entry.parentId !== undefined) {
			node.parentId = entry.parentId;
			const parent = ensureNode(entry.parentId);
			if (!parent.children.includes(entry.nodeId)) {
				parent.children.push(entry.nodeId);
			}
		}
	}

	// Если журнал ссылается на узел "root", корневые узлы отражаются и в его
	// children тоже (parentId остаётся null — узлы сохраняются в roots).
	const root = nodes.root;
	if (root) {
		for (const id of order) {
			if (id !== "root" && nodes[id].parentId === null && !root.children.includes(id)) {
				root.children.push(id);
			}
		}
	}

	return { nodes, roots: order.filter((id) => nodes[id].parentId === null) };
}

// ============================================================================
// Mission directory resolution
// ============================================================================

/** Каталог миссии missionsDir/<slug> или null (нет каталога / неверный slug). */
function resolveMissionDir(missionsDir: string, slug: string): string | null {
	if (!isValidMissionSlug(slug)) {
		return null;
	}
	const dir = join(missionsDir, slug);
	try {
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			return null;
		}
	} catch {
		return null;
	}
	return dir;
}

// ============================================================================
// Public API
// ============================================================================

/** Статус миссии: frontmatter MISSION.md + сводка бюджета.
 *  Null → 404 (миссия не найдена). Поля бюджета перекрывают frontmatter;
 *  при отсутствии mission-budget.json — значения из frontmatter/нули. */
export function getMissionStatus(missionsDir: string, slug: string): Record<string, unknown> | null {
	const dir = resolveMissionDir(missionsDir, slug);
	if (!dir) {
		return null;
	}

	const frontmatter = readMissionFrontmatter(dir);
	const status: Record<string, unknown> = { ...frontmatter };

	// Сводка бюджета из mission-budget.json (F-31), если файл существует
	const budget = getMissionBudget(missionsDir, slug);
	if (budget) {
		for (const key of ["budget_total", "budget_usd", "allocated", "consumed", "peak"]) {
			if (key in budget) {
				status[key] = budget[key];
			}
		}
	}

	// Числовая сводка бюджета гарантируется даже без mission-budget.json
	if (typeof status.budget_total !== "number") {
		status.budget_total = typeof frontmatter.budget_tokens === "number" ? frontmatter.budget_tokens : 0;
	}
	if (typeof status.consumed !== "number") {
		status.consumed = 0;
	}
	if (typeof status.budget_usd !== "number") {
		status.budget_usd = 0;
	}

	return status;
}

/** Дерево миссии из tree-journal.jsonl. Null → 404 (миссия не найдена).
 *  Миссия без журнала → пустое дерево { nodes: {}, roots: [] } (не ошибка). */
export function getMissionTree(missionsDir: string, slug: string): MissionTree | null {
	const dir = resolveMissionDir(missionsDir, slug);
	if (!dir) {
		return null;
	}
	const journalPath = join(dir, "tree-journal.jsonl");
	if (!existsSync(journalPath)) {
		return { nodes: {}, roots: [] };
	}
	let content: string;
	try {
		content = readFileSync(journalPath, "utf8");
	} catch {
		return { nodes: {}, roots: [] };
	}
	return reconstructMissionTree(parseJournalEntries(content));
}

/** Бюджет миссии: passthrough mission-budget.json (F-31).
 *  Null → 404 (миссия не найдена) либо файл отсутствует/повреждён. */
export function getMissionBudget(missionsDir: string, slug: string): Record<string, unknown> | null {
	const dir = resolveMissionDir(missionsDir, slug);
	if (!dir) {
		return null;
	}
	const budgetPath = join(dir, "mission-budget.json");
	if (!existsSync(budgetPath)) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(budgetPath, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}
