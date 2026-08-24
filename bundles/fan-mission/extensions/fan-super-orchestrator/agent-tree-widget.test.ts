// Unit-тесты виджета дерева сабагентов (Phase 2 MVP).
//
// Чистые функции (summarize/renderCompact/renderTreeLines) — на
// синтетических журналах; поведение виджета (poll/auto-hide/F8/dispose) —
// на DI-моках UI/journal с fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerAgentTreeWidget,
	renderCompact,
	renderTreeLines,
	summarize,
	truncateTask,
	type AgentTreeWidgetUI,
} from "./agent-tree-widget.js";
import { reconstructTree, type TreeJournalEntry, type TreeJournalEventType } from "./tree-journal.js";

/** Короткая сборка записи журнала. */
function entry(partial: Partial<TreeJournalEntry> & { event: TreeJournalEventType; nodeId: string }): TreeJournalEntry {
	return { timestamp: new Date().toISOString(), ...partial };
}

/** UI-мок: лог вызовов setStatus/setWidget. */
function createUiMock(): AgentTreeWidgetUI & {
	setStatus: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
} {
	return {
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};
}

/** Текст последнего вызова setStatus (undefined — статус скрыт). */
function lastStatusText(ui: ReturnType<typeof createUiMock>): string | undefined {
	const calls = ui.setStatus.mock.calls;
	return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("summarize", () => {
	it("считает статусы узлов по журналу spawn/complete/fail", () => {
		const entries = [
			entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", via: "spawn" }),
			entry({ event: "complete", nodeId: "L1/a", parentId: "L0", usage: { tokens: 1000, usd: 0.5 } }),
			entry({ event: "spawn", nodeId: "L1/b", parentId: "L0", via: "spawn" }),
			entry({ event: "fail", nodeId: "L1/b", parentId: "L0" }),
			entry({ event: "spawn", nodeId: "L1/c", parentId: "L0", via: "http_delegate" }),
		];
		const summary = summarize(reconstructTree(entries));
		expect(summary.running).toBe(1); // c
		expect(summary.done).toBe(1); // a
		expect(summary.failed).toBe(1); // b
		expect(summary.other).toBe(0);
		expect(summary.totalTokens).toBe(1000);
		expect(summary.totalUsd).toBeCloseTo(0.5);
	});

	it("не считает L0-ствол (status unknown) сабагентом", () => {
		const summary = summarize(
			reconstructTree([entry({ event: "spawn", nodeId: "L1/a", parentId: "L0" })]),
		);
		expect(summary.running).toBe(1);
		expect(summary.other).toBe(0); // L0 (unknown) выпадает из счётчиков
	});

	it("abort попадает в other", () => {
		const summary = summarize(
			reconstructTree([
				entry({ event: "spawn", nodeId: "L1/a", parentId: "L0" }),
				entry({ event: "abort", nodeId: "L1/a", parentId: "L0" }),
			]),
		);
		expect(summary.running).toBe(0);
		expect(summary.other).toBe(1);
	});
});

describe("renderCompact", () => {
	it("формат «⚡ Сабагенты: N● / N✓ / N✗ │ N tok (F8 — дерево)»", () => {
		expect(
			renderCompact({ running: 3, done: 2, failed: 1, other: 0, totalTokens: 1_234_567, totalUsd: 0 }),
		).toBe("⚡ Сабагенты: 3● / 2✓ / 1✗ │ 1.2M tok (F8 — дерево)");
	});

	it("без токенов и пустых счётчиков части опускаются", () => {
		expect(renderCompact({ running: 1, done: 0, failed: 0, other: 0, totalTokens: 0, totalUsd: 0 })).toBe(
			"⚡ Сабагенты: 1● (F8 — дерево)",
		);
	});
});

describe("renderTreeLines", () => {
	it("DFS-порядок, отступы 2 пробела/depth и иконки via", () => {
		const entries = [
			entry({ event: "spawn", nodeId: "L1/so", parentId: "L0", via: "http_delegate", task: "SO анализа" }),
			entry({ event: "spawn", nodeId: "L2/w", parentId: "L1/so", via: "spawn", task: "Работа", port: 7001 }),
			entry({ event: "complete", nodeId: "L2/w", parentId: "L1/so", usage: { tokens: 2500 } }),
		];
		const lines = renderTreeLines(entries);
		expect(lines).toHaveLength(4); // шапка + L0 + L1/so + L2/w
		expect(lines[0]).toContain("⚡ Дерево сабагентов: 1● / 1✓");
		expect(lines[0]).toContain("2.5k tok");
		expect(lines[1]?.startsWith("⬡ L0 ○")).toBe(true); // ствол depth 0
		expect(lines[2]?.startsWith("  ✦ L1/so ●")).toBe(true); // SO depth 1
		expect(lines[3]?.startsWith("    ⬡ L2/w ✓")).toBe(true); // worker depth 2
		expect(lines[3]).toContain(":7001");
		expect(lines[3]).toContain("2.5k"); // токены узла k-форматом
	});

	it("глубина до 4: отступы 2/4/6/8 пробелов", () => {
		const entries = [
			entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", via: "http_delegate" }),
			entry({ event: "spawn", nodeId: "L2/b", parentId: "L1/a", via: "spawn" }),
			entry({ event: "spawn", nodeId: "L3/c", parentId: "L2/b", via: "http_delegate" }),
			entry({ event: "spawn", nodeId: "L4/d", parentId: "L3/c", via: "spawn" }),
		];
		const lines = renderTreeLines(entries);
		expect(lines.find((l) => l.includes("L1/a"))?.startsWith("  ✦")).toBe(true);
		expect(lines.find((l) => l.includes("L2/b"))?.startsWith("    ⬡")).toBe(true);
		expect(lines.find((l) => l.includes("L3/c"))?.startsWith("      ✦")).toBe(true);
		expect(lines.find((l) => l.includes("L4/d"))?.startsWith("        ⬡")).toBe(true);
	});

	it("иконки статусов: fail → ✗, abort → ⊘", () => {
		const lines = renderTreeLines([
			entry({ event: "fail", nodeId: "L1/f", parentId: "L0" }),
			entry({ event: "abort", nodeId: "L1/ab", parentId: "L0" }),
		]);
		expect(lines.find((l) => l.includes("L1/f"))).toContain("✗");
		expect(lines.find((l) => l.includes("L1/ab"))).toContain("⊘");
	});

	it("задача обрезается до ~30 символов + «…»", () => {
		const long = "Очень длинное описание задачи, которое точно не влезает в лимит";
		expect(truncateTask(long)).toBe(`${long.slice(0, 30)}…`);
		const lines = renderTreeLines([entry({ event: "spawn", nodeId: "L1/x", parentId: "L0", task: long })]);
		const line = lines.find((l) => l.includes("L1/x")) ?? "";
		expect(line).not.toContain(long);
		expect(line).toContain("…");
	});

	it("лимит 9 строк: приоритет running-узлам + хвост «… +N ещё»", () => {
		const now = Date.now();
		const entries: TreeJournalEntry[] = [];
		for (let i = 1; i <= 12; i++) {
			entries.push(
				entry({
					event: "spawn",
					nodeId: `L1/n${i}`,
					parentId: "L0",
					task: `t${i}`,
					timestamp: new Date(now - 100_000 + i * 1000).toISOString(),
				}),
			);
			if (i < 12) {
				entries.push(
					entry({
						event: "complete",
						nodeId: `L1/n${i}`,
						parentId: "L0",
						timestamp: new Date(now - 90_000 + i * 1000).toISOString(),
					}),
				);
			}
		}
		const lines = renderTreeLines(entries, 9);
		expect(lines).toHaveLength(9); // шапка + 7 узлов + хвост
		expect(lines[lines.length - 1]).toBe("… +6 ещё"); // (12 детей + L0-ствол) − 7
		// running-узел (n12, единственный ●) присутствует несмотря на позицию
		expect(lines.some((l) => l.includes("L1/n12 ●"))).toBe(true);
	});

	it("пустой журнал → пустой массив", () => {
		expect(renderTreeLines([])).toEqual([]);
	});

	it("мусорные записи не роняют рендер", () => {
		const garbage = [
			entry({ event: "spawn", nodeId: "L1/g", parentId: "L0", via: "spawn" }),
			"junk",
			null,
			{ foo: 1 },
			{ event: 42, nodeId: 7 },
		] as unknown as TreeJournalEntry[];
		expect(() => renderTreeLines(garbage)).not.toThrow();
		const lines = renderTreeLines(garbage);
		expect(lines.some((l) => l.includes("L1/g"))).toBe(true);
		expect(lines.some((l) => l.includes("junk"))).toBe(false);
	});
});

describe("registerAgentTreeWidget", () => {
	it("авто-появление статуса при первом spawn + diff-кэш", () => {
		const ui = createUiMock();
		let journal: TreeJournalEntry[] = [];
		const handle = registerAgentTreeWidget({
			ui,
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => journal,
			registerShortcut: () => {},
		});
		expect(ui.setStatus).not.toHaveBeenCalled(); // пустой журнал — тишина

		journal = [entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", task: "Проектирование" })];
		handle.refreshNow();
		expect(lastStatusText(ui)).toContain("1●");
		expect(lastStatusText(ui)).toContain("(F8 — дерево)");

		const callsBefore = ui.setStatus.mock.calls.length;
		handle.refreshNow(); // те же данные — UI не дёргается
		expect(ui.setStatus.mock.calls.length).toBe(callsBefore);
		handle.dispose();
	});

	it("F8 toggle: разворот дерева и сворачивание", async () => {
		const ui = createUiMock();
		let f8: { description: string; handler: () => Promise<void> | void } | undefined;
		const handle = registerAgentTreeWidget({
			ui,
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => [entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", task: "Задача" })],
			registerShortcut: (key, def) => {
				if (key === "f8") f8 = def;
			},
		});
		expect(f8?.description).toContain("дерево");

		await f8?.handler(); // разворот
		const expandCall = ui.setWidget.mock.calls.find(([, lines]) => Array.isArray(lines));
		expect(expandCall?.[0]).toBe("agent-tree");
		expect(expandCall?.[2]).toEqual({ placement: "belowEditor" });
		expect((expandCall?.[1] as string[])[0]).toContain("⚡ Дерево сабагентов");

		await f8?.handler(); // сворачивание
		const lastCall = ui.setWidget.mock.calls[ui.setWidget.mock.calls.length - 1];
		expect(lastCall?.[0]).toBe("agent-tree");
		expect(lastCall?.[1]).toBeUndefined();
		handle.dispose();
	});

	it("авто-скрытие: статус живёт 30с после all-terminal", () => {
		const ui = createUiMock();
		const now = Date.now();
		const handle = registerAgentTreeWidget({
			ui,
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => [
				entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", timestamp: new Date(now - 2000).toISOString() }),
				entry({ event: "complete", nodeId: "L1/a", parentId: "L0", timestamp: new Date(now).toISOString() }),
			],
			registerShortcut: () => {},
			pollIntervalMs: 500,
		});
		// Нет running, но событие свежее → статус показывается (1✓)
		expect(lastStatusText(ui)).toContain("1✓");

		vi.advanceTimersByTime(29_000);
		expect(lastStatusText(ui)).toContain("1✓"); // ещё в грейс-окне

		vi.advanceTimersByTime(1_000); // 30с от последнего события
		expect(lastStatusText(ui)).toBeUndefined();
		handle.dispose();
	});

	it("новый spawn после авто-скрытия возвращает статус", () => {
		const ui = createUiMock();
		const now = Date.now();
		let journal: TreeJournalEntry[] = [
			entry({ event: "spawn", nodeId: "L1/a", parentId: "L0", timestamp: new Date(now - 60_000).toISOString() }),
			entry({ event: "complete", nodeId: "L1/a", parentId: "L0", timestamp: new Date(now - 60_000).toISOString() }),
		];
		const handle = registerAgentTreeWidget({
			ui,
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => journal,
			registerShortcut: () => {},
			pollIntervalMs: 500,
		});
		expect(lastStatusText(ui)).toBeUndefined(); // протухший журнал — тишина

		journal = [
			...journal,
			entry({ event: "spawn", nodeId: "L1/b", parentId: "L0", timestamp: new Date().toISOString() }),
		];
		handle.refreshNow();
		expect(lastStatusText(ui)).toContain("1●");
		handle.dispose();
	});

	it("dispose: очищает ключи UI и останавливает таймеры", () => {
		const ui = createUiMock();
		const handle = registerAgentTreeWidget({
			ui,
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => [entry({ event: "spawn", nodeId: "L1/a", parentId: "L0" })],
			registerShortcut: () => {},
			pollIntervalMs: 500,
		});
		ui.setStatus.mockClear();
		ui.setWidget.mockClear();
		handle.dispose();
		expect(ui.setStatus).toHaveBeenCalledWith("agents", undefined);
		expect(ui.setWidget).toHaveBeenCalledWith("agent-tree", undefined);

		const after = ui.setStatus.mock.calls.length;
		vi.advanceTimersByTime(60_000); // ни poll, ни таймеры больше не дёргают UI
		expect(ui.setStatus.mock.calls.length).toBe(after);
	});

	it("бросающий UI деградирует молча", () => {
		const handle = registerAgentTreeWidget({
			ui: {
				setStatus: () => {
					throw new Error("boom");
				},
				setWidget: () => {
					throw new Error("boom");
				},
			},
			journalPath: "/tmp/agent-tree-test.jsonl",
			readJournal: () => [entry({ event: "spawn", nodeId: "L1/a", parentId: "L0" })],
			registerShortcut: () => {},
		});
		expect(() => handle.refreshNow()).not.toThrow();
		expect(() => handle.dispose()).not.toThrow();
	});
});
