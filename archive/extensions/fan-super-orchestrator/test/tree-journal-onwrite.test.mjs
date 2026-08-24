// F-47: хук onJournalWrite на tree-journal — механизм WS-продюсера.
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-47
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.2
//
// Контракт (расширение F-32, обратно совместимое):
//   journal.onJournalWrite(listener) → unsubscribe
//   listener(fullEntry) вызывается после каждой успешной записи (после fsync),
//   включая авто-сгенерированный timestamp. Ошибка listener'а не ломает запись.
//
// Продакшн-подключение gateway (F-48.5) здесь НЕ тестируется — только механизм.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let createTreeJournal;

beforeAll(async () => {
	const mod = await import("../tree-journal.js");
	createTreeJournal = mod.createTreeJournal;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
});

/** Путь к tree-journal.jsonl в свежем tempdir. */
function makeJournalPath() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-tj-hook-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return join(tmp, "tree-journal.jsonl");
}

// ─── write → колбэк вызван с entry ─────────────────────────────────────────

describe("F-47: onJournalWrite — write уведомляет подписчика", () => {
	it("write → listener вызван с полным entry (включая авто-timestamp)", () => {
		const journal = createTreeJournal(makeJournalPath());
		const received = [];
		journal.onJournalWrite((entry) => received.push(entry));

		const written = journal.write({
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "L0",
			correlationId: "test-slug/L1/node-1",
			depth: 1,
		});

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual(written);
		expect(received[0].event).toBe("spawn");
		expect(received[0].nodeId).toBe("L1/node-1");
		expect(received[0].parentId).toBe("L0");
		expect(received[0].correlationId).toBe("test-slug/L1/node-1");
		expect(typeof received[0].timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(received[0].timestamp))).toBe(false);
	});

	it("каждый write уведомляет: 3 записи → 3 вызова", () => {
		const journal = createTreeJournal(makeJournalPath());
		const events = [];
		journal.onJournalWrite((entry) => events.push(entry.event));

		journal.write({ event: "spawn", nodeId: "L1/node-1" });
		journal.write({ event: "complete", nodeId: "L1/node-1", usage: { tokens: 100, usd: 0.01 } });
		journal.write({ event: "fail", nodeId: "L1/node-2" });

		expect(events).toEqual(["spawn", "complete", "fail"]);
	});
});

describe("F-47: onJournalWrite — несколько подписчиков и отписка", () => {
	it("несколько listener'ов получают событие; unsubscribe останавливает доставку", () => {
		const journal = createTreeJournal(makeJournalPath());
		const a = [];
		const b = [];
		const unsubA = journal.onJournalWrite((e) => a.push(e));
		journal.onJournalWrite((e) => b.push(e));

		journal.write({ event: "spawn", nodeId: "L1/node-1" });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);

		unsubA();
		journal.write({ event: "complete", nodeId: "L1/node-1" });
		expect(a).toHaveLength(1); // отписан — вторая запись не доставлена
		expect(b).toHaveLength(2);
	});

	it("повторный unsubscribe идемпотентен (не бросает)", () => {
		const journal = createTreeJournal(makeJournalPath());
		const received = [];
		const unsub = journal.onJournalWrite((e) => received.push(e));

		unsub();
		expect(() => unsub()).not.toThrow();
		journal.write({ event: "spawn", nodeId: "L1/node-1" });
		expect(received).toHaveLength(0);
	});
});

describe("F-47: onJournalWrite — устойчивость", () => {
	it("ошибка listener'а не ломает запись и других подписчиков", () => {
		const journal = createTreeJournal(makeJournalPath());
		const ok = [];
		journal.onJournalWrite(() => {
			throw new Error("boom");
		});
		journal.onJournalWrite((e) => ok.push(e));

		const written = journal.write({ event: "spawn", nodeId: "L1/node-1" });

		expect(ok).toHaveLength(1); // второй подписчик получил событие
		expect(written.nodeId).toBe("L1/node-1");
		expect(journal.readAll()).toHaveLength(1); // строка на диске
	});

	it("без подписчиков write работает как прежде (обратная совместимость)", () => {
		const journal = createTreeJournal(makeJournalPath());
		expect(() => journal.write({ event: "spawn", nodeId: "L1/node-1" })).not.toThrow();
		expect(journal.readAll()).toHaveLength(1);
	});
});
