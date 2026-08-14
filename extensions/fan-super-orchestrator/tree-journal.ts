// F-32: Tree journal (JSONL).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-32
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.5
//
// Append-only журнал дерева узлов: каждое порождение и завершение узла
// записывается одной JSON-строкой в docs/missions/<slug>/tree-journal.jsonl
// (продакшн-путь инжектится параметром). Запись durable: openSync("a") →
// writeSync → fsyncSync → closeSync — строка на диске сразу после возврата
// из write(), переживает crash процесса. Повреждённые строки при чтении
// пропускаются. reconstructTree восстанавливает топологию по журналу:
// статус узла — последняя запись wins; дети привязываются по parentId;
// узлы без parentId — корни. Если в журнале фигурирует узел "root",
// корневые узлы дополнительно отражаются в его children (parentId при
// этом остаётся null, они сохраняются в roots).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Тип события журнала дерева (orphan_cleanup — для startup-reconciliation, F-33). */
export type TreeJournalEventType = "spawn" | "complete" | "fail" | "abort" | "orphan_cleanup";

/** Потреблённые ресурсы в записи журнала. */
export interface TreeJournalUsage {
	tokens?: number;
	usd?: number;
}

/** Одна запись журнала. */
export interface TreeJournalEntry {
	/** ISO-8601; авто-генерируется, если не задан при записи. */
	timestamp: string;
	event: TreeJournalEventType;
	nodeId: string;
	parentId?: string;
	correlationId?: string;
	task?: string;
	depth?: number;
	port?: number;
	pid?: number;
	usage?: TreeJournalUsage;
}

/** Узел восстановленного дерева. */
export interface ReconstructedTreeNode {
	parentId: string | null;
	children: string[];
	status: string;
	correlationId?: string;
	usage?: TreeJournalUsage;
}

/** Дерево, восстановленное из журнала. */
export interface ReconstructedTree {
	nodes: Record<string, ReconstructedTreeNode>;
	/** Узлы без parentId, в порядке появления в журнале. */
	roots: string[];
}

/** JSONL-журнал дерева узлов. */
export interface TreeJournal {
	/** Добавляет запись (append + fsync) и возвращает её с timestamp. */
	write(entry: Omit<TreeJournalEntry, "timestamp"> & { timestamp?: string }): TreeJournalEntry;
	/** Все валидные записи в порядке записи; повреждённые строки пропускаются. */
	readAll(): TreeJournalEntry[];
	path: string;
}

/** Минимальная валидация записи: JSON-объект со строковыми event и nodeId. */
function isJournalEntry(value: unknown): value is TreeJournalEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<TreeJournalEntry>;
	return typeof candidate.event === "string" && typeof candidate.nodeId === "string";
}

/** Создаёт журнал: родительский каталог рекурсивно, файл — если отсутствует
 *  (существующий журнал НЕ усекается). */
export function createTreeJournal(filePath: string): TreeJournal {
	mkdirSync(dirname(filePath), { recursive: true });
	const createFd = openSync(filePath, "a");
	closeSync(createFd);

	return {
		path: filePath,
		write(entry) {
			const full: TreeJournalEntry = {
				timestamp: entry.timestamp ?? new Date().toISOString(),
				event: entry.event,
				nodeId: entry.nodeId,
			};
			if (entry.parentId !== undefined) full.parentId = entry.parentId;
			if (entry.correlationId !== undefined) full.correlationId = entry.correlationId;
			if (entry.task !== undefined) full.task = entry.task;
			if (entry.depth !== undefined) full.depth = entry.depth;
			if (entry.port !== undefined) full.port = entry.port;
			if (entry.pid !== undefined) full.pid = entry.pid;
			if (entry.usage !== undefined) full.usage = entry.usage;

			const fd = openSync(filePath, "a");
			try {
				writeSync(fd, `${JSON.stringify(full)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return full;
		},
		readAll() {
			if (!existsSync(filePath)) {
				return [];
			}
			const entries: TreeJournalEntry[] = [];
			for (const line of readFileSync(filePath, "utf8").split("\n")) {
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
		},
	};
}

/** Восстанавливает топологию дерева по записям журнала.
 *
 *  Любая запись создаёт/обновляет узел (status = event, последняя запись
 *  wins); запись с parentId создаёт также узел-родителя (статус "unknown",
 *  если собственных записей нет) и привязывает ребёнка. Пустой список →
 *  { nodes: {}, roots: [] }. */
export function reconstructTree(entries: TreeJournalEntry[]): ReconstructedTree {
	const nodes: Record<string, ReconstructedTreeNode> = {};
	const order: string[] = [];

	const ensureNode = (id: string): ReconstructedTreeNode => {
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
