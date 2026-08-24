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
//
// F-47: хук onJournalWrite(listener) — уведомление о каждой успешной записи
// (после fsync). Механизм для WS-продюсера mission_event в api-gateway
// (структурно совместим с MissionJournalLike); продакшн-подключение — F-48.5.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Тип события журнала дерева (orphan_cleanup — startup-reconciliation, F-33;
 * tool_blocked — отказы манифеста инструментов, F-37; validation_failed —
 * отклонение невалидного межагентного сообщения граничной валидацией, F-38). */
export type TreeJournalEventType =
	| "spawn"
	| "complete"
	| "fail"
	| "abort"
	| "orphan_cleanup"
	| "tool_blocked"
	| "validation_failed";

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
	/** Диагностика отказа (tool_blocked, F-37: "tool '<name>' not in manifest" /
	 *  причина валидации манифеста; validation_failed, F-38: ошибки схемы
	 *  отклонённого межагентного сообщения). */
	diag?: string;
	/** F-4: канал порождения узла. "spawn" — локальный child_process.spawn
	 *  (worker, existing path); "http_delegate" — HTTP POST /api/mission-delegate
	 *  в родительский fan server (super-orchestrator, recursive wiring). */
	via?: "spawn" | "http_delegate";
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

/** F-47: колбэк, вызываемый после каждой успешной записи в журнал. */
export type JournalWriteListener = (entry: TreeJournalEntry) => void;

/** JSONL-журнал дерева узлов. */
export interface TreeJournal {
	/** Добавляет запись (append + fsync) и возвращает её с timestamp. */
	write(entry: Omit<TreeJournalEntry, "timestamp"> & { timestamp?: string }): TreeJournalEntry;
	/** Все валидные записи в порядке записи; повреждённые строки пропускаются. */
	readAll(): TreeJournalEntry[];
	path: string;
	/** F-47: подписка на уведомления о записи (после fsync). Возвращает
	 *  функцию отписки. Ошибка listener'а не прерывает запись в журнал. */
	onJournalWrite(listener: JournalWriteListener): () => void;
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

	// F-47: подписчики уведомлений о записи (WS-продюсеры)
	const writeListeners = new Set<JournalWriteListener>();

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
			if (entry.diag !== undefined) full.diag = entry.diag;
			if (entry.via !== undefined) full.via = entry.via;

			const fd = openSync(filePath, "a");
			try {
				writeSync(fd, `${JSON.stringify(full)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			// F-47: уведомление после того, как строка на диске (после fsync).
			// Ошибка listener'а не должна ломать запись в журнал.
			for (const listener of writeListeners) {
				try {
					listener(full);
				} catch {
					/* ignore listener errors */
				}
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
		onJournalWrite(listener) {
			writeListeners.add(listener);
			return () => {
				writeListeners.delete(listener);
			};
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
