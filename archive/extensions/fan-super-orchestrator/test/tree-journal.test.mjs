// F-32: Tree journal (JSONL) — RED-фаза TDD.
//
// Модуль ../tree-journal.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-32
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт модуля:
//   type TreeJournalEventType = "spawn" | "complete" | "fail" | "abort" | "orphan_cleanup";
//   interface TreeJournalEntry {
//     timestamp: string;            // ISO-8601 (авто, если не задан)
//     event: TreeJournalEventType;
//     nodeId: string;
//     parentId?: string;
//     correlationId?: string;
//     task?: string;
//     depth?: number;
//     port?: number;
//     pid?: number;
//     usage?: { tokens?: number; usd?: number };
//   }
//   interface TreeJournal {
//     write(entry: Omit<TreeJournalEntry, "timestamp"> & { timestamp?: string }): TreeJournalEntry;
//     readAll(): TreeJournalEntry[];   // повреждённые строки пропускаются
//     path: string;
//   }
//
//   createTreeJournal(filePath: string): TreeJournal
//     // родительский каталог создаётся; файл создаётся при create пустым;
//     // запись через openSync(append) + fsyncSync (durability).
//
//   reconstructTree(entries: TreeJournalEntry[]): {
//     nodes: Record<string, { parentId: string | null; children: string[]; status: string;
//                            correlationId?: string; usage?: { tokens?: number; usd?: number } }>;
//     roots: string[];   // узлы без parentId
//   }
//     // spawn создаёт узел; complete/fail/abort обновляют status; дети по parentId;
//     // последняя запись статуса wins; пустой список → { nodes: {}, roots: [] }.
//
// Продакшн-путь файла: docs/missions/<slug>/tree-journal.jsonl (в тестах — tempdir).
//
// Покрытие (TC-карточки roadmap):
//   TC-F32-1  write spawn → write complete с usage: 2 JSON-строки, correlationId/nodeId/parentId,
//             readAll возвращает обе, timestamp ISO
//   TC-F32-2  5 записей дерева → reconstructTree: топология L1/L2, статусы complete
//   TC-F32-3  durability: readFileSync сразу после write видит строку (fsync, без буферизации)
//   Доп.      timestamp авто/заданный; повреждённая строка пропускается; нет файла → readAll [];
//             create создаёт пустой файл; последний статус wins; usage roundtrip;
//             append-only (строки не затираются); orphan_cleanup; родительский каталог создаётся

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let createTreeJournal;
let reconstructTree;

beforeAll(async () => {
	const mod = await import("../tree-journal.js");
	createTreeJournal = mod.createTreeJournal;
	reconstructTree = mod.reconstructTree;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-tj-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Путь к tree-journal.jsonl в свежем tempdir. */
function makeJournalPath(fileName = "tree-journal.jsonl") {
	return join(makeTmpDir(), fileName);
}

/** Проверка ISO-8601 timestamp: валидный Date.parse + формат ISO. */
function expectIsoTimestamp(ts) {
	expect(typeof ts).toBe("string");
	expect(Number.isNaN(Date.parse(ts))).toBe(false);
	// ISO-формат: YYYY-MM-DDTHH:mm:ss (допускаем смещение/мс)
	expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
}

// ─── TC-F32-1: spawn → complete с usage, JSONL-строки, readAll ─────────────

describe("TC-F32-1: write spawn L1/node-1 → write complete с usage", () => {
	it("файл содержит 2 JSON-строки", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "root",
			correlationId: "corr-1",
			task: "task A",
		});
		journal.write({
			event: "complete",
			nodeId: "L1/node-1",
			parentId: "root",
			correlationId: "corr-1",
			usage: { tokens: 12_000, usd: 0.45 },
		});

		const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("readAll возвращает обе записи с correlationId/nodeId/parentId", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "root",
			correlationId: "corr-1",
			task: "task A",
		});
		journal.write({
			event: "complete",
			nodeId: "L1/node-1",
			parentId: "root",
			correlationId: "corr-1",
			usage: { tokens: 12_000, usd: 0.45 },
		});

		const entries = journal.readAll();
		expect(entries).toHaveLength(2);

		expect(entries[0].event).toBe("spawn");
		expect(entries[0].nodeId).toBe("L1/node-1");
		expect(entries[0].parentId).toBe("root");
		expect(entries[0].correlationId).toBe("corr-1");

		expect(entries[1].event).toBe("complete");
		expect(entries[1].nodeId).toBe("L1/node-1");
		expect(entries[1].parentId).toBe("root");
		expect(entries[1].correlationId).toBe("corr-1");
	});

	it("обе записи имеют ISO-8601 timestamp", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "spawn", nodeId: "L1/node-1", parentId: "root", correlationId: "corr-1" });
		journal.write({ event: "complete", nodeId: "L1/node-1", correlationId: "corr-1" });

		const entries = journal.readAll();
		for (const entry of entries) {
			expectIsoTimestamp(entry.timestamp);
		}
	});
});

// ─── TC-F32-2: reconstructTree по 5 записям ─────────────────────────────────

describe("TC-F32-2: reconstructTree — топология дерева из 5 записей", () => {
	function writeFiveEntries() {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);
		journal.write({ event: "spawn", nodeId: "L1/node-1", correlationId: "corr-1" });
		journal.write({ event: "spawn", nodeId: "L1/node-2", parentId: "root", correlationId: "corr-1" });
		journal.write({ event: "complete", nodeId: "L1/node-1", usage: { tokens: 5_000, usd: 0.1 } });
		journal.write({ event: "spawn", nodeId: "L2/node-1.1", parentId: "L1/node-2", correlationId: "corr-1" });
		journal.write({ event: "complete", nodeId: "L1/node-2", usage: { tokens: 8_000, usd: 0.3 } });
		return journal.readAll();
	}

	it("L1/node-1 и L1/node-2 — дети root (привязка по parentId)", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.nodes["root"].children).toEqual(expect.arrayContaining(["L1/node-1", "L1/node-2"]));
		expect(tree.nodes["root"].children).toHaveLength(2);
	});

	it("L1/node-1 без parentId — корневой узел (roots)", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.roots).toContain("L1/node-1");
	});

	it("L2/node-1.1 — ребёнок L1/node-2", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.nodes["L1/node-2"].children).toContain("L2/node-1.1");
		expect(tree.nodes["L2/node-1.1"].parentId).toBe("L1/node-2");
	});

	it("статусы: L1/node-1 и L1/node-2 → complete", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.nodes["L1/node-1"].status).toBe("complete");
		expect(tree.nodes["L1/node-2"].status).toBe("complete");
	});

	it("L2/node-1.1 остаётся в статусе spawn (нет терминальной записи)", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.nodes["L2/node-1.1"].status).toBe("spawn");
	});

	it("correlationId сквозной: доступен в узлах дерева", () => {
		const tree = reconstructTree(writeFiveEntries());
		expect(tree.nodes["L1/node-1"].correlationId).toBe("corr-1");
		expect(tree.nodes["L1/node-2"].correlationId).toBe("corr-1");
		expect(tree.nodes["L2/node-1.1"].correlationId).toBe("corr-1");
	});
});

// ─── TC-F32-3: durability — fsync, данные на диске сразу ───────────────────

describe("TC-F32-3: durability — write → файл на диске сразу содержит строку", () => {
	it("readFileSync сразу после write видит данные (без close-буферизации)", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "spawn", nodeId: "L1/node-1", correlationId: "corr-1" });

		const content = readFileSync(filePath, "utf8");
		expect(content).not.toBe("");
		const parsed = JSON.parse(content.split("\n").filter((l) => l.trim() !== "")[0]);
		expect(parsed.event).toBe("spawn");
		expect(parsed.nodeId).toBe("L1/node-1");
	});

	it("каждый write виден отдельно: после 2-го write в файле 2 строки", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "spawn", nodeId: "L1/node-1" });
		const after1 = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
		expect(after1).toHaveLength(1);

		journal.write({ event: "complete", nodeId: "L1/node-1" });
		const after2 = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
		expect(after2).toHaveLength(2);
	});

	it("свежий journal поверх того же файла читает записи предыдущего (данные пережили жизнь объекта)", () => {
		const filePath = makeJournalPath();
		const journal1 = createTreeJournal(filePath);
		journal1.write({ event: "spawn", nodeId: "L1/node-1", correlationId: "corr-1" });
		journal1.write({ event: "fail", nodeId: "L1/node-1", correlationId: "corr-1" });

		const journal2 = createTreeJournal(filePath);
		const entries = journal2.readAll();
		expect(entries).toHaveLength(2);
		expect(entries[1].event).toBe("fail");
	});
});

// ─── Доп: timestamp — авто-генерация и заданный ─────────────────────────────

describe("timestamp: авто-генерация и явное значение", () => {
	it("timestamp не задан → авто-генерируется валидный ISO-8601", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		const written = journal.write({ event: "spawn", nodeId: "L1/node-1" });
		expectIsoTimestamp(written.timestamp);
	});

	it("заданный timestamp сохраняется как есть", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		const ts = "2026-08-14T12:00:00.000Z";
		const written = journal.write({ event: "spawn", nodeId: "L1/node-1", timestamp: ts });
		expect(written.timestamp).toBe(ts);
		expect(journal.readAll()[0].timestamp).toBe(ts);
	});

	it("авто-timestamp монотонно не убывает при последовательных write", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		const a = journal.write({ event: "spawn", nodeId: "L1/node-1" });
		const b = journal.write({ event: "complete", nodeId: "L1/node-1" });
		expect(Date.parse(b.timestamp)).toBeGreaterThanOrEqual(Date.parse(a.timestamp));
	});
});

// ─── Доп: write возвращает entry с timestamp ───────────────────────────────

describe("write: возвращаемое значение", () => {
	it("write возвращает записанный entry (с timestamp)", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		const written = journal.write({
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "root",
			correlationId: "corr-1",
			task: "task A",
			depth: 1,
			port: 4001,
			pid: 12345,
		});

		expectIsoTimestamp(written.timestamp);
		expect(written.event).toBe("spawn");
		expect(written.nodeId).toBe("L1/node-1");
		expect(written.parentId).toBe("root");
		expect(written.correlationId).toBe("corr-1");
		expect(written.task).toBe("task A");
		expect(written.depth).toBe(1);
		expect(written.port).toBe(4001);
		expect(written.pid).toBe(12345);
	});
});

// ─── Доп: повреждённые строки пропускаются ─────────────────────────────────

describe("readAll: повреждённые строки", () => {
	it("повреждённая строка в середине файла пропускается, остальные читаются", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "spawn", nodeId: "L1/node-1", correlationId: "corr-1" });
		journal.write({ event: "complete", nodeId: "L1/node-1" });
		// Повреждённая строка в середине файла (сдвигаем: переписываем файл с мусором между строками)
		const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
		const corrupted = [lines[0], "{ not valid json !!!", lines[1], ""].join("\n");
		// writeFileSync перезапишет — это допустимо: мы моделируем повреждённый файл с диска
		// (readAll читает с диска, а не из памяти)
		rmSync(filePath);
		appendFileSync(filePath, corrupted, "utf8");
		journal.write({ event: "spawn", nodeId: "L1/node-2", correlationId: "corr-2" });

		const entries = journal.readAll();
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.event)).toEqual(["spawn", "complete", "spawn"]);
		expect(entries.map((e) => e.nodeId)).toEqual(["L1/node-1", "L1/node-1", "L1/node-2"]);
	});

	it("файл целиком из мусора → readAll [] (не бросает)", () => {
		const filePath = makeJournalPath();
		appendFileSync(filePath, "garbage\nnot json at all\n", "utf8");

		const journal = createTreeJournal(filePath);
		expect(() => journal.readAll()).not.toThrow();
		expect(journal.readAll()).toEqual([]);
	});
});

// ─── Доп: файла нет → readAll []; create создаёт пустой файл ───────────────

describe("readAll: отсутствующий файл; create создаёт файл", () => {
	it("журнал ещё не писал → readAll []", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);
		expect(journal.readAll()).toEqual([]);
	});

	it("create создаёт файл пустым (до первой записи)", () => {
		const filePath = makeJournalPath();
		createTreeJournal(filePath);
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("");
	});

	it("родительский каталог создаётся при create (вложенный путь)", () => {
		const filePath = join(makeTmpDir(), "docs", "missions", "slug-x", "tree-journal.jsonl");
		expect(() => createTreeJournal(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(true);
	});

	it("journal.path === переданному filePath", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);
		expect(journal.path).toBe(filePath);
	});
});

// ─── Доп: append-only ───────────────────────────────────────────────────────

describe("append-only: последовательные write не затирают предыдущие строки", () => {
	it("3 write → 3 строки, первая и вторая неизменны", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		const w1 = journal.write({ event: "spawn", nodeId: "L1/node-1" });
		const w2 = journal.write({ event: "spawn", nodeId: "L1/node-2" });
		const w3 = journal.write({ event: "spawn", nodeId: "L1/node-3" });

		const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0])).toEqual(w1);
		expect(JSON.parse(lines[1])).toEqual(w2);
		expect(JSON.parse(lines[2])).toEqual(w3);
	});

	it("readAll порядок = порядку записи", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);
		for (const nodeId of ["L1/node-1", "L1/node-2", "L1/node-3", "L1/node-4"]) {
			journal.write({ event: "spawn", nodeId });
		}
		expect(journal.readAll().map((e) => e.nodeId)).toEqual([
			"L1/node-1", "L1/node-2", "L1/node-3", "L1/node-4",
		]);
	});
});

// ─── Доп: usage roundtrip ───────────────────────────────────────────────────

describe("usage: сохраняется и читается", () => {
	it("usage { tokens, usd } переживает write → readAll", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({
			event: "complete",
			nodeId: "L1/node-1",
			usage: { tokens: 12_345, usd: 0.6789 },
		});

		const entry = journal.readAll()[0];
		expect(entry.usage).toEqual({ tokens: 12_345, usd: 0.6789 });
	});

	it("частичный usage (только tokens) сохраняется", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "complete", nodeId: "L1/node-1", usage: { tokens: 100 } });
		expect(journal.readAll()[0].usage).toEqual({ tokens: 100 });
	});

	it("reconstructTree переносит usage последней терминальной записи в узел", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "complete", nodeId: "L1/node-1", usage: { tokens: 5_000, usd: 0.1 } },
		]);
		expect(tree.nodes["L1/node-1"].usage).toEqual({ tokens: 5_000, usd: 0.1 });
	});
});

// ─── Доп: reconstructTree — статусы и крайние случаи ───────────────────────

describe("reconstructTree: последняя запись статуса wins", () => {
	it("spawn → fail → узел status 'fail'", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "fail", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].status).toBe("fail");
	});

	it("fail → abort → итоговый статус 'abort' (последняя wins)", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "fail", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:02:00.000Z", event: "abort", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].status).toBe("abort");
	});

	it("fail → complete → итоговый статус 'complete'", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "fail", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:02:00.000Z", event: "complete", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].status).toBe("complete");
	});

	it("пустой список → { nodes: {}, roots: [] }", () => {
		expect(reconstructTree([])).toEqual({ nodes: {}, roots: [] });
	});

	it("spawn без parentId → parentId null и узел в roots", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].parentId).toBeNull();
		expect(tree.roots).toEqual(["L1/node-1"]);
	});

	it("несколько корней → все в roots", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:00:01.000Z", event: "spawn", nodeId: "L1/node-2" },
			{ timestamp: "2026-08-14T10:00:02.000Z", event: "spawn", nodeId: "L2/node-1.1", parentId: "L1/node-1" },
		]);
		expect(tree.roots).toEqual(expect.arrayContaining(["L1/node-1", "L1/node-2"]));
		expect(tree.roots).not.toContain("L2/node-1.1");
	});

	it("children у узла без детей — пустой массив", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:00:01.000Z", event: "spawn", nodeId: "L2/node-1.1", parentId: "L1/node-1" },
		]);
		expect(tree.nodes["L2/node-1.1"].children).toEqual([]);
	});

	it("терминальная запись без spawn (восстановление из усечённого журнала) → узел создаётся со статусом", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "fail", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].status).toBe("fail");
	});
});

// ─── Доп: orphan_cleanup (для F-33) ─────────────────────────────────────────

describe("orphan_cleanup: тип события поддерживается (F-33)", () => {
	it("write/readAll roundtrip события orphan_cleanup", () => {
		const filePath = makeJournalPath();
		const journal = createTreeJournal(filePath);

		journal.write({ event: "orphan_cleanup", nodeId: "L1/node-1", correlationId: "corr-1" });

		const entry = journal.readAll()[0];
		expect(entry.event).toBe("orphan_cleanup");
		expect(entry.nodeId).toBe("L1/node-1");
		expect(entry.correlationId).toBe("corr-1");
	});

	it("reconstructTree: orphan_cleanup обновляет status узла", () => {
		const tree = reconstructTree([
			{ timestamp: "2026-08-14T10:00:00.000Z", event: "spawn", nodeId: "L1/node-1" },
			{ timestamp: "2026-08-14T10:01:00.000Z", event: "orphan_cleanup", nodeId: "L1/node-1" },
		]);
		expect(tree.nodes["L1/node-1"].status).toBe("orphan_cleanup");
	});
});
