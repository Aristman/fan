// Phase 2 MVP: TUI-виджет дерева сабагентов (fan-super-orchestrator).
//
// Назначение: оператор видит живое дерево дочерних узлов (воркеры ⬡ +
// супер-оркестраторы ✦, глубина до 4) в футере (компактный статус по
// ctx.ui.setStatus) и по F8 (полное дерево через ctx.ui.setWidget),
// не мешая основному чату.
//
// Контракт:
//   registerAgentTreeWidget(args): AgentTreeWidgetHandle
//
// DI-стиль по образцу fan-mission/mission-widget.ts: расширение тестируется
// на моках UI/journal без живого TUI.
//   - ui: фасад setStatus/setWidget (ctx.ui захватывается в index.ts —
//     session_start + F8-handler, последний wins);
//   - readJournal: источник записей (default: createTreeJournal(path).readAll());
//   - registerShortcut: регистрация F8-toggle.
//
// Канал данных: polling readJournal (500 мс) + reconstructTree — журнал
// общий для L0 и SO-детей (несколько процессов пишут append), а
// in-process onJournalWrite ловит только локальные записи, поэтому poll —
// базовый механизм; refreshNow() даёт мгновенный refresh по событию.
//
// Деградация: любые ошибки (нет UI, битый журнал, бросающий setWidget) —
// молчаливые (try/catch): виджет не влияет на контур оркестратора.

import { createTreeJournal, reconstructTree, type ReconstructedTree, type TreeJournalEntry } from "./tree-journal.js";

/** Ключ статуса в футере (ctx.ui.setStatus). */
const STATUS_KEY = "agents";
/** Ключ виджета дерева (ctx.ui.setWidget). */
const WIDGET_KEY = "agent-tree";
/** Ключ шортката разворота дерева. */
const SHORTCUT_KEY = "f8";
/** Авто-скрытие статуса после перехода всех узлов в terminal (мс). */
const AUTO_HIDE_MS = 30_000;
/** Лимит строк виджета (TUI MAX_WIDGET_LINES=10: шапка + узлы + хвост «+N ещё»). */
const DEFAULT_MAX_LINES = 9;
/** Обрезка описания задачи узла (символов, без «…»). */
const TASK_MAX_CHARS = 30;

/** UI-фасад виджета (подмножество ctx.ui). */
export interface AgentTreeWidgetUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement: "aboveEditor" | "belowEditor" },
	): void;
}

/** Сборка DI-аргументов. */
export interface AgentTreeWidgetArgs {
	ui: AgentTreeWidgetUI;
	journalPath: string;
	/** DI: источник записей журнала (default: createTreeJournal(path).readAll()). */
	readJournal?: () => TreeJournalEntry[];
	/** Регистрация шортката toggle (F8). */
	registerShortcut(key: string, def: { description: string; handler: () => Promise<void> | void }): void;
	/** Интервал poll журнала, мс (default 500). */
	pollIntervalMs?: number;
}

/** Handle виджета: dispose + мгновенный refresh. */
export interface AgentTreeWidgetHandle {
	dispose(): void;
	refreshNow(): void;
}

/** Сводка по дереву: счётчики статусов + суммарный расход. */
export interface AgentTreeSummary {
	running: number;
	done: number;
	failed: number;
	other: number;
	totalTokens: number;
	totalUsd: number;
}

/** Минимальная валидация записи (тот же предикат, что у readAll): мусор из
 *  DI-мока readJournal не должен ронять reconstructTree/renderTreeLines. */
function isEntryLike(value: unknown): value is TreeJournalEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<TreeJournalEntry>;
	return typeof candidate.event === "string" && typeof candidate.nodeId === "string";
}

/** Статус узла → иконка в дереве (● running, ✓ complete, ✗ fail/diag,
 *  ⊘ abort/orphan_cleanup, ○ unknown). */
export function nodeStatusIcon(status: string): string {
	switch (status) {
		case "spawn":
			return "●";
		case "complete":
			return "✓";
		case "fail":
		case "diag":
		case "tool_blocked":
		case "validation_failed":
			return "✗";
		case "abort":
		case "orphan_cleanup":
			return "⊘";
		default:
			return "○";
	}
}

/** Узел в состоянии running (незавершён)? Только собственный spawn:
 *  "unknown" — структурный родитель без собственных записей (L0-ствол),
 *  его running не считается (иначе авто-скрытие никогда не сработает). */
function isRunningStatus(status: string): boolean {
	return status === "spawn";
}

/** Сводка по дереву. Узлы со статусом "unknown" (структурные родители —
 *  например, L0-ствол, на который ссылаются дети) в счётчики не входят. */
export function summarize(tree: ReconstructedTree): AgentTreeSummary {
	const summary: AgentTreeSummary = { running: 0, done: 0, failed: 0, other: 0, totalTokens: 0, totalUsd: 0 };
	for (const node of Object.values(tree.nodes)) {
		switch (node.status) {
			case "spawn":
				summary.running++;
				break;
			case "complete":
				summary.done++;
				break;
			case "fail":
			case "diag":
			case "tool_blocked":
			case "validation_failed":
				summary.failed++;
				break;
			case "unknown":
				break; // структурный родитель — не сабагент
			default:
				summary.other++; // abort, orphan_cleanup, …
		}
		summary.totalTokens += node.usage?.tokens ?? 0;
		summary.totalUsd += node.usage?.usd ?? 0;
	}
	return summary;
}

/** Компактный формат токенов: 1234 → «1.2k», 1_500_000 → «1.5M».
 *  Граница k/M — 1e6; округление не должно давать «1000.0k» (FIX c403892). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) {
		// Обрезка (floor) до 1 десятичной — не допускаем «1000.0k» на границе.
		const k = Math.floor((n / 1_000) * 10) / 10;
		return `${k.toFixed(1)}k`;
	}
	return String(n);
}

/** Счётчики статусов: «3● / 2✓ / 1✗» (пустые части опускаются). */
function countsPart(summary: AgentTreeSummary): string {
	const parts: string[] = [];
	if (summary.running > 0) parts.push(`${summary.running}●`);
	if (summary.done > 0) parts.push(`${summary.done}✓`);
	if (summary.failed > 0) parts.push(`${summary.failed}✗`);
	if (summary.other > 0) parts.push(`${summary.other}⊘`);
	if (parts.length === 0) parts.push("0");
	return parts.join(" / ");
}

/** Токен-часть строки итогов (« │ 1.2M tok» либо пусто). */
function tokensPart(summary: AgentTreeSummary): string {
	return summary.totalTokens > 0 ? ` │ ${formatTokens(summary.totalTokens)} tok` : "";
}

/** Компактная строка футера: «⚡ Сабагенты: 3● / 2✓ / 1✗ │ 1.2M tok (F8 — дерево)». */
export function renderCompact(summary: AgentTreeSummary): string {
	return `⚡ Сабагенты: ${countsPart(summary)}${tokensPart(summary)} (F8 — дерево)`;
}

/** Обрезка задачи: TASK_MAX_CHARS символов + «…». */
export function truncateTask(task: string): string {
	return task.length > TASK_MAX_CHARS ? `${task.slice(0, TASK_MAX_CHARS)}…` : task;
}

/** Отображаемая мета узла (last-write-wins из записей журнала). */
interface NodeMeta {
	task?: string;
	via?: string;
	port?: number;
	/** Timestamp последней записи узла (мс; 0 — нет/битый). */
	lastTs: number;
}

/** Строка узла + данные приоритизации при переполнении лимита строк. */
interface NodeDisplay {
	line: string;
	running: boolean;
	/** Порядок DFS — для стабильного вывода после приоритизации. */
	order: number;
	lastTs: number;
}

/** Рендер дерева: шапка с итогами + DFS-строки узлов.
 *  Отступ 2 пробела/depth; иконка ✦ (via=http_delegate — SO) / ⬡ (spawn —
 *  worker); статус ●/✓/✗/⊘/○; порт «:7001»; токены узла k-форматом.
 *  Если узлов больше, чем влезает в maxLines — приоритет running-узлам,
 *  затем свежим; хвост «… +N ещё». Пустое дерево → []. */
export function renderTreeLines(entries: TreeJournalEntry[], maxLines: number = DEFAULT_MAX_LINES): string[] {
	const valid = entries.filter(isEntryLike);
	const tree = reconstructTree(valid);

	// Мета узлов: task/via/port из записей (последняя wins), recency —
	// timestamp последней записи узла.
	const meta = new Map<string, NodeMeta>();
	for (const entry of valid) {
		const current = meta.get(entry.nodeId) ?? { lastTs: 0 };
		if (entry.task !== undefined) current.task = entry.task;
		if (entry.via !== undefined) current.via = entry.via;
		if (entry.port !== undefined) current.port = entry.port;
		const ts = Date.parse(entry.timestamp ?? "");
		if (Number.isFinite(ts)) current.lastTs = ts;
		meta.set(entry.nodeId, current);
	}

	const displays: NodeDisplay[] = [];
	const visited = new Set<string>();
	const walk = (id: string, depth: number): void => {
		if (visited.has(id)) return; // защита от циклов в журнале
		visited.add(id);
		const node = tree.nodes[id];
		if (!node) return;
		const info = meta.get(id);
		const icon = info?.via === "http_delegate" ? "✦" : "⬡";
		let line = `${"  ".repeat(depth)}${icon} ${id} ${nodeStatusIcon(node.status)}`;
		if (info?.task !== undefined && info.task !== "") line += ` ${truncateTask(info.task)}`;
		if (info?.port !== undefined) line += ` :${info.port}`;
		const tokens = node.usage?.tokens ?? 0;
		if (tokens > 0) line += ` ${formatTokens(tokens)}`;
		displays.push({
			line,
			running: isRunningStatus(node.status),
			order: displays.length,
			lastTs: info?.lastTs ?? 0,
		});
		for (const childId of node.children) walk(childId, depth + 1);
	};
	for (const rootId of tree.roots) walk(rootId, 0);
	// Узлы вне DFS-достижимости из корней (циклы в журнале) — верхним уровнем.
	for (const id of Object.keys(tree.nodes)) walk(id, 0);
	if (displays.length === 0) return [];

	const summary = summarize(tree);
	const header = `⚡ Дерево сабагентов: ${countsPart(summary)}${tokensPart(summary)}`;
	const lines: string[] = [header];
	const nodeBudget = Math.max(0, maxLines - 1);
	if (displays.length <= nodeBudget) {
		lines.push(...displays.map((display) => display.line));
		return lines;
	}
	// Переполнение: running-узлы первыми (внутри — свежее), выбранные
	// возвращаются в DFS-порядок для читаемого дерева.
	const keep = Math.max(0, maxLines - 2); // шапка + хвост «… +N ещё»
	const selected = [...displays]
		.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return b.lastTs - a.lastTs;
		})
		.slice(0, keep)
		.sort((a, b) => a.order - b.order);
	lines.push(...selected.map((display) => display.line));
	lines.push(`… +${displays.length - selected.length} ещё`);
	return lines;
}

/** Реализация registerAgentTreeWidget (отдельная функция — чтобы любая
 *  ошибка конструирования деградировала в no-op handle снаружи). */
function createWidget(args: AgentTreeWidgetArgs): AgentTreeWidgetHandle {
	let disposed = false;
	let expanded = false;
	let everSpawned = false;
	let autoHidden = false;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let lastSignature = "";
	let lastStatusText: string | null = null;
	let lastWidgetJoin: string | null = null;
	let lazyJournal: ReturnType<typeof createTreeJournal> | null = null;

	const reader: () => TreeJournalEntry[] =
		args.readJournal ??
		(() => {
			// Ленивое создание журнала (mkdir + touch файла) — только при
			// реальном poll и без DI-ридера (тесты).
			lazyJournal ??= createTreeJournal(args.journalPath);
			return lazyJournal.readAll();
		});

	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch {
			/* молчаливая деградация */
		}
	};

	const clearHideTimer = (): void => {
		if (hideTimer !== null) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
	};

	/** setStatus с diff-кэшем: не дёргаем UI без изменений. */
	const renderStatus = (text: string | undefined): void => {
		if ((text ?? null) === lastStatusText) return;
		lastStatusText = text ?? null;
		safe(() => args.ui.setStatus(STATUS_KEY, text));
	};

	/** setWidget с diff-кэшем: не дёргаем UI без изменений. */
	const renderWidget = (lines: string[] | undefined): void => {
		const join = lines === undefined ? null : lines.join("\n");
		if (join === lastWidgetJoin) return;
		lastWidgetJoin = join;
		safe(() => args.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" }));
	};

	const poll = (): void => {
		if (disposed) return;
		let raw: TreeJournalEntry[];
		try {
			raw = reader();
		} catch {
			return; // журнал нечитаем — молча ждём следующего тика
		}
		if (!Array.isArray(raw)) return;
		const entries = raw.filter(isEntryLike);
		if (entries.some((entry) => entry.event === "spawn")) {
			everSpawned = true;
		}

		const tree = reconstructTree(entries);
		const summary = summarize(tree);
		let lastEventTs = 0;
		for (const entry of entries) {
			const ts = Date.parse(entry.timestamp ?? "");
			if (Number.isFinite(ts) && ts > lastEventTs) lastEventTs = ts;
		}

		// Новые события в журнале: сбрасываем авто-скрытие и таймер.
		const signature = `${entries.length}|${lastEventTs}`;
		if (signature !== lastSignature) {
			lastSignature = signature;
			autoHidden = false;
			clearHideTimer();
		}

		if (summary.running > 0) {
			clearHideTimer();
		} else if (everSpawned && !autoHidden && hideTimer === null && lastEventTs > 0) {
			// Все узлы terminal: авто-скрытие на границе 30с от последнего
			// события журнала (статус — всегда; виджет — только если свёрнут).
			const delay = Math.max(0, AUTO_HIDE_MS - (Date.now() - lastEventTs));
			hideTimer = setTimeout(() => {
				hideTimer = null;
				if (disposed) return;
				autoHidden = true;
				renderStatus(undefined);
				if (!expanded) renderWidget(undefined);
			}, delay);
			try {
				(hideTimer as { unref?: () => void }).unref?.(); // не держим процесс
			} catch {
				/* fake timers (тесты) — unref отсутствует, не критично */
			}
		}

		const withinGrace = Date.now() - lastEventTs < AUTO_HIDE_MS;
		const showStatus = everSpawned && entries.length > 0 && (summary.running > 0 || withinGrace);
		renderStatus(showStatus ? renderCompact(summary) : undefined);
		if (expanded) {
			if (entries.length > 0) {
				renderWidget(renderTreeLines(entries));
			} else {
				// F8 на пустом журнале — видимый отклик (заглушка).
				renderWidget(["⚡ Дерево сабагентов: нет активных узлов"]);
			}
		}
	};

	safe(() => {
		args.registerShortcut(SHORTCUT_KEY, {
			description: "Toggle agent tree (дерево сабагентов)",
			handler: (): void => {
				if (disposed) return;
				expanded = !expanded;
				if (!expanded) {
					renderWidget(undefined);
					return;
				}
				poll(); // сразу отрисовать дерево актуальными данными
			},
		});
	});

	const interval = setInterval(poll, args.pollIntervalMs ?? 500);
	try {
		(interval as { unref?: () => void }).unref?.(); // не держим процесс
	} catch {
		/* таймер без unref (тестовые fake timers) — не критично */
	}
	poll(); // мгновенный старт: авто-появление по существующему журналу

	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearHideTimer();
			clearInterval(interval);
			// Принудительно (мимо diff-кэша) чистим ключи UI.
			safe(() => args.ui.setStatus(STATUS_KEY, undefined));
			safe(() => args.ui.setWidget(WIDGET_KEY, undefined));
		},
		refreshNow(): void {
			safe(poll);
		},
	};
}

/** Регистрация виджета дерева сабагентов. Любая ошибка конструирования —
 *  no-op handle: виджет не критичен для контура оркестратора. */
export function registerAgentTreeWidget(args: AgentTreeWidgetArgs): AgentTreeWidgetHandle {
	try {
		return createWidget(args);
	} catch {
		return {
			dispose: () => {},
			refreshNow: () => {},
		};
	}
}
