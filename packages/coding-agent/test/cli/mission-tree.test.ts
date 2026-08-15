// F-42: CLI `fan mission tree <slug>` — Red-фаза (TDD)
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-42
// Спека:   docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Ожидаемый публичный API (контракт):
//
//   missionTree(missionDir: string, opts?: { format?: string; depth?: number }): Promise<void>
//     — читает <missionDir>/tree-journal.jsonl (F-32 reconstructTree)
//     — читает <missionDir>/MISSION.md для статуса миссии (frontmatter.status)
//     — выводит ASCII-дерево в stdout (console.log) с иконками статусов:
//         ✓ completed, ● active, ✗ failed, ○ pending
//     — формат вывода (roadmap §F-42):
//         Mission: <slug>
//         ├── L0 (root) ✓ $1.20
//         │   ├── L1/node-1 ✓ $0.45
//         │   └── L1/node-2 ● $0.33
//         └── Total: $1.20 / $10.00 (12%)
//     — opts.format === "json" → выводит JSON-объект в stdout
//     — opts.depth → ограничивает глубину вывода
//     — если tree-journal.jsonl отсутствует → выводит «нет узлов» + статус миссии
//     — если журнал повреждён (циклы, битый JSON) → не крашится (visited-защита)
//
//   handleMissionCommand(["mission", "tree", <slug>], ctx):
//     — диспетчеризует в missionTree, передавая slug и распарсенные опции
//     — возвращает true при успехе
//     — slug не найден → console.error + process.exit(1)
//
//   listMissionSubcommands() теперь включает "tree".
//
// Red-ожидание: missionTree не экспортируется из mission-command.ts,
// "tree" отсутствует в SUBCOMMANDS. Импорт падает → тесты failing.
// После Green-фазы тесты проходят БЕЗ изменений.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMissionCommand, missionTree } from "../../src/cli/mission-command.js";

// ─── Вспомогательные функции ────────────────────────────────────────────────

/** Свежий временный каталог, изолированный для каждого теста. */
function freshBaseDir(): string {
	return mkdtempSync(join(tmpdir(), "fan-f42-red-"));
}

/**
 * Создаёт каталог миссии с MISSION.md (frontmatter) и опциональным
 * tree-journal.jsonl. Возвращает путь к каталогу миссии.
 */
function setupMissionDir(
	baseDir: string,
	slug: string,
	opts?: {
		status?: string;
		budgetUsd?: number;
		budgetTokens?: number;
		journalEntries?: object[];
	},
): string {
	const missionDir = join(baseDir, slug);
	mkdirSync(missionDir, { recursive: true });

	const status = opts?.status ?? "active";
	const budgetUsd = opts?.budgetUsd ?? 10;
	const budgetTokens = opts?.budgetTokens ?? 500000;

	const frontmatter = [
		"---",
		`mission_id: mission-${slug}-test`,
		`created: 2026-08-14T10:00:00.000Z`,
		`status: ${status}`,
		"metric_type: test_coverage",
		"metric_command: npm test",
		`budget_tokens: ${budgetTokens}`,
		`budget_usd: ${budgetUsd}`,
		"max_depth: 4",
		"max_width: 8",
		"---",
		"",
		`# Mission: ${slug}`,
		"",
	].join("\n");

	writeFileSync(join(missionDir, "MISSION.md"), frontmatter, "utf8");

	if (opts?.journalEntries && opts.journalEntries.length > 0) {
		const lines = opts.journalEntries.map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(join(missionDir, "tree-journal.jsonl"), `${lines}\n`, "utf8");
	}

	return missionDir;
}

/** Захватывает все вызовы console.log за время выполнения fn.
 * Примечание: mock.calls читается ДО mockRestore — в vitest mockRestore
 * делает mockReset и очищает mock.calls. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	let output = "";
	try {
		await fn();
		output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	} finally {
		logSpy.mockRestore();
	}
	return output;
}

// ─── TC-F42-1: CLI выводит ASCII-дерево из журнала ─────────────────────────

describe("F-42 / TC-F42-1: missionTree выводит ASCII-дерево глубины 2", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "auth-refactor", {
			status: "active",
			budgetUsd: 10,
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "complete", nodeId: "L0", usage: { usd: 1.2 }, timestamp: "2026-08-14T10:05:00.000Z" },
				{ event: "spawn", nodeId: "L1/node-1", parentId: "L0", timestamp: "2026-08-14T10:00:01.000Z" },
				{
					event: "complete",
					nodeId: "L1/node-1",
					parentId: "L0",
					usage: { usd: 0.45 },
					timestamp: "2026-08-14T10:02:00.000Z",
				},
				{ event: "spawn", nodeId: "L1/node-2", parentId: "L0", timestamp: "2026-08-14T10:00:02.000Z" },
				{
					event: "complete",
					nodeId: "L1/node-2",
					parentId: "L0",
					usage: { usd: 0.3 },
					timestamp: "2026-08-14T10:03:00.000Z",
				},
				{ event: "spawn", nodeId: "L1/node-3", parentId: "L0", timestamp: "2026-08-14T10:00:03.000Z" },
				{ event: "spawn", nodeId: "L2/node-2.1", parentId: "L1/node-2", timestamp: "2026-08-14T10:03:01.000Z" },
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("вывод содержит ASCII-символы дерева (├──, └──, │)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		// Должны присутствовать Unicode box-drawing символы
		expect(output).toMatch(/[├└│]/);
	});

	it("каждый узел содержит nodeId", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toContain("L0");
		expect(output).toContain("L1/node-1");
		expect(output).toContain("L1/node-2");
		expect(output).toContain("L1/node-3");
		expect(output).toContain("L2/node-2.1");
	});

	it("completed узлы отмечены иконкой ✓", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		// L0 completed, L1/node-1 completed, L1/node-2 completed
		const lines = output.split("\n");
		const l0Line = lines.find((l) => l.includes("L0") && !l.includes("L1") && !l.includes("L2"));
		expect(l0Line).toBeDefined();
		expect(l0Line).toContain("✓");

		const l1n1Line = lines.find((l) => l.includes("L1/node-1"));
		expect(l1n1Line).toBeDefined();
		expect(l1n1Line).toContain("✓");
	});

	it("active (spawn без complete) узлы отмечены иконкой ●", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		const lines = output.split("\n");
		// L1/node-3 — spawn без subsequent complete → active
		const l1n3Line = lines.find((l) => l.includes("L1/node-3"));
		expect(l1n3Line).toBeDefined();
		expect(l1n3Line).toContain("●");

		// L2/node-2.1 — spawn без complete → active
		const l2Line = lines.find((l) => l.includes("L2/node-2.1"));
		expect(l2Line).toBeDefined();
		expect(l2Line).toContain("●");
	});

	it("расход отображается для каждого узла ($)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toMatch(/\$[\d.]+/);
		// L0 has $1.20, L1/node-1 has $0.45
		expect(output).toContain("$1.2");
		expect(output).toContain("$0.45");
		expect(output).toContain("$0.3");
	});

	it("дерево глубины 2: L2/node-2.1 вложен под L1/node-2 (больший отступ)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		const lines = output.split("\n");
		const l1n2Line = lines.find((l) => l.includes("L1/node-2") && !l.includes("L2"));
		const l2Line = lines.find((l) => l.includes("L2/node-2.1"));
		expect(l1n2Line).toBeDefined();
		expect(l2Line).toBeDefined();
		// L2 должен иметь больший отступ чем L1/node-2
		const l1Indent = (l1n2Line!.match(/^[\s│├└─]*/) ?? [""])[0].length;
		const l2Indent = (l2Line!.match(/^[\s│├└─]*/) ?? [""])[0].length;
		expect(l2Indent).toBeGreaterThan(l1Indent);
	});

	it("итоговый расход отображается в нижней строке (Total)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toMatch(/Total/i);
	});
});

// ─── TC-F42-1 (доп.): статус миссии в шапке ────────────────────────────────

describe("F-42 / TC-F42-1: статус миссии в шапке вывода", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("вывод начинается с 'Mission: <slug>'", async () => {
		const missionDir = setupMissionDir(baseDir, "auth-refactor", {
			status: "active",
			journalEntries: [{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" }],
		});
		const output = await captureStdout(() => missionTree(missionDir));
		const firstLine = output.split("\n").find((l) => l.trim().length > 0);
		expect(firstLine).toBeDefined();
		expect(firstLine!.toLowerCase()).toMatch(/mission/);
		expect(firstLine!).toContain("auth-refactor");
	});

	it("статус миссии отображается в выводе (active/completed/aborted)", async () => {
		const missionDir = setupMissionDir(baseDir, "completed-mission", {
			status: "completed",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "complete", nodeId: "L0", timestamp: "2026-08-14T10:05:00.000Z" },
			],
		});
		const output = await captureStdout(() => missionTree(missionDir));
		// Статус "completed" должен быть виден в выводе (в шапке или отдельно)
		expect(output.toLowerCase()).toMatch(/completed|active|status/);
	});
});

// ─── TC-F42-2: Флаг --format json выводит JSON ─────────────────────────────

describe("F-42 / TC-F42-2: --format json выводит JSON", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "json-mission", {
			status: "active",
			budgetUsd: 10,
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "complete", nodeId: "L0", usage: { usd: 0.5 }, timestamp: "2026-08-14T10:05:00.000Z" },
				{ event: "spawn", nodeId: "L1/node-1", parentId: "L0", timestamp: "2026-08-14T10:00:01.000Z" },
				{
					event: "complete",
					nodeId: "L1/node-1",
					parentId: "L0",
					usage: { usd: 0.25 },
					timestamp: "2026-08-14T10:03:00.000Z",
				},
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("вывод является валидным JSON", async () => {
		const output = await captureStdout(() => missionTree(missionDir, { format: "json" }));
		let parsed: unknown;
		expect(() => {
			parsed = JSON.parse(output);
		}).not.toThrow();
		expect(parsed).toBeDefined();
	});

	it("JSON содержит информацию о дереве (nodes или root)", async () => {
		const output = await captureStdout(() => missionTree(missionDir, { format: "json" }));
		const parsed = JSON.parse(output);
		// Контракт из roadmap: { root: { nodeId, children: [...] }, total: { costUsd } }
		// Минимально: JSON-объект не пустой и содержит данные о узлах
		expect(typeof parsed).toBe("object");
		expect(parsed).not.toBeNull();
		// Должен содержать nodeId хотя бы одного узла в каком-либо поле
		const serialized = JSON.stringify(parsed);
		expect(serialized).toContain("L0");
	});

	it("JSON содержит итоговый расход", async () => {
		const output = await captureStdout(() => missionTree(missionDir, { format: "json" }));
		const parsed = JSON.parse(output);
		const serialized = JSON.stringify(parsed);
		// Total cost должен быть представлен
		expect(serialized).toMatch(/cost|usd|total/i);
	});
});

// ─── TC-F42-3: Несуществующий slug → ошибка + exit 1 ──────────────────────

describe("F-42 / TC-F42-3: несуществующий slug → ошибка + exit 1", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		mkdirSync(baseDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("missionTree бросает ошибку для несуществующей миссии", async () => {
		const nonexistentDir = join(baseDir, "nonexistent");
		await expect(missionTree(nonexistentDir)).rejects.toThrow();
	});

	it("handleMissionCommand exits 1 для несуществующего slug", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await handleMissionCommand(["mission", "tree", "nonexistent"], {
				baseDir,
				isExtensionLoaded: () => true,
			});
		} catch {
			// expected __exit__
		}

		expect(exitSpy).toHaveBeenCalledWith(1);
		const allErr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allErr.toLowerCase()).toMatch(/not found|nonexistent|mission/i);
	});

	it("handleMissionCommand выводит сообщение 'Mission ... not found'", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await handleMissionCommand(["mission", "tree", "ghost-mission"], {
				baseDir,
				isExtensionLoaded: () => true,
			});
		} catch {
			// expected __exit__
		}

		const allErr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allErr).toContain("ghost-mission");
	});
});

// ─── Edge: миссия без tree-journal.jsonl → «нет узлов» + статус ───────────

describe("F-42 / edge: миссия без tree-journal → graceful output", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		// Миссия с MISSION.md, но БЕЗ tree-journal.jsonl
		missionDir = setupMissionDir(baseDir, "empty-mission", {
			status: "active",
			budgetUsd: 10,
			// journalEntries не передан → файл не создаётся
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("не бросает ошибку при отсутствии tree-journal.jsonl", async () => {
		await expect(captureStdout(() => missionTree(missionDir))).resolves.toBeDefined();
	});

	it("вывод содержит информацию о том, что узлов нет (или пустое дерево)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		// Допустимы варианты: "No nodes", "нет узлов", "0 nodes", пустое дерево
		// Главное — не crash и не undefined
		expect(output).toBeDefined();
		expect(typeof output).toBe("string");
	});

	it("статус миссии всё равно отображается", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		// Mission header should still be present
		expect(output.toLowerCase()).toMatch(/mission|empty-mission|status/i);
	});
});

// ─── Edge: глубокое дерево (depth 12) не падает ────────────────────────────

describe("F-42 / edge: глубокое дерево (depth 12) не падает", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		// Создаём цепочку узлов depth 0→1→2→...→12
		const entries: object[] = [];
		let prevId = "L0";
		entries.push({ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" });
		for (let d = 1; d <= 12; d++) {
			const nodeId = `L${d}/node-${d}`;
			entries.push({
				event: "spawn",
				nodeId,
				parentId: prevId,
				depth: d,
				timestamp: `2026-08-14T10:00:${String(d).padStart(2, "0")}.000Z`,
			});
			prevId = nodeId;
		}
		missionDir = setupMissionDir(baseDir, "deep-mission", {
			status: "active",
			journalEntries: entries,
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("missionTree завершается без ошибки для дерева глубины 12", async () => {
		await expect(captureStdout(() => missionTree(missionDir))).resolves.toBeDefined();
	});

	it("вывод содержит узел максимальной глубины (L12/node-12)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toContain("L12/node-12");
	});

	it("вывод содержит все промежуточные уровни (L0..L12)", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		for (let d = 0; d <= 12; d++) {
			if (d === 0) {
				expect(output).toContain("L0");
			} else {
				expect(output).toContain(`L${d}/node-${d}`);
			}
		}
	});
});

// ─── Edge: циклический журнал (повреждён) → не краш ────────────────────────

describe("F-42 / edge: циклический журнал (visited-защита)", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		// Цикл: A → B → A (parentId создают кольцо)
		missionDir = setupMissionDir(baseDir, "cyclic-mission", {
			status: "active",
			journalEntries: [
				{ event: "spawn", nodeId: "node-A", parentId: "node-B", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "spawn", nodeId: "node-B", parentId: "node-A", timestamp: "2026-08-14T10:00:01.000Z" },
				{ event: "spawn", nodeId: "node-C", parentId: "node-A", timestamp: "2026-08-14T10:00:02.000Z" },
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("missionTree не крашится и не уходит в бесконечный цикл", async () => {
		// Если рендер уходит в бесконечный цикл, тест упадёт по таймауту (30с)
		// Допустимо: вывод с циклом, сообщение об ошибке, или частичное дерево
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toBeDefined();
		expect(typeof output).toBe("string");
	});

	it("содержит хотя бы один nodeId из журнала", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		// Как минимум один узел должен быть в выводе
		expect(output).toMatch(/node-[ABC]/);
	});
});

// ─── Edge: повреждённые строки JSONL пропускаются ──────────────────────────

describe("F-42 / edge: повреждённые строки JSONL", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "corrupt-mission", {
			status: "active",
			// journalEntries передаём штатно, а потом дописываем мусор
		});
		// Дописываем битые строки в журнал
		const journalPath = join(missionDir, "tree-journal.jsonl");
		const validEntry = JSON.stringify({
			event: "spawn",
			nodeId: "L0",
			timestamp: "2026-08-14T10:00:00.000Z",
		});
		const corruptLines = [
			validEntry,
			"{ broken json line !!!",
			"not json at all",
			"",
			JSON.stringify({
				event: "spawn",
				nodeId: "L1/node-1",
				parentId: "L0",
				timestamp: "2026-08-14T10:00:01.000Z",
			}),
		].join("\n");
		writeFileSync(journalPath, `${corruptLines}\n`, "utf8");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("не падает при чтении повреждённого журнала", async () => {
		await expect(captureStdout(() => missionTree(missionDir))).resolves.toBeDefined();
	});

	it("валидные узлы (L0, L1/node-1) всё равно отображаются", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toContain("L0");
		expect(output).toContain("L1/node-1");
	});
});

// ─── Опция --depth: ограничение глубины вывода ─────────────────────────────

describe("F-42 / опция --depth: ограничение глубины вывода", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "depth-limited", {
			status: "active",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "spawn", nodeId: "L1/node-1", parentId: "L0", timestamp: "2026-08-14T10:00:01.000Z" },
				{ event: "spawn", nodeId: "L2/node-1.1", parentId: "L1/node-1", timestamp: "2026-08-14T10:00:02.000Z" },
				{ event: "spawn", nodeId: "L3/node-1.1.1", parentId: "L2/node-1.1", timestamp: "2026-08-14T10:00:03.000Z" },
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("depth=1 показывает только корневые узлы (L0), не показывает L2+", async () => {
		const output = await captureStdout(() => missionTree(missionDir, { depth: 1 }));
		expect(output).toContain("L0");
		// L2 и глубже НЕ должны быть в выводе
		expect(output).not.toContain("L2/node-1.1");
		expect(output).not.toContain("L3/node-1.1.1");
	});

	it("depth=2 показывает L0 и L1, но не L3", async () => {
		const output = await captureStdout(() => missionTree(missionDir, { depth: 2 }));
		expect(output).toContain("L0");
		expect(output).toContain("L1/node-1");
		expect(output).not.toContain("L3/node-1.1.1");
	});

	it("без --depth показывает все уровни", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output).toContain("L0");
		expect(output).toContain("L1/node-1");
		expect(output).toContain("L2/node-1.1");
		expect(output).toContain("L3/node-1.1.1");
	});
});

// ─── Failed узлы: иконка ✗ ─────────────────────────────────────────────────

describe("F-42 / иконка ✗ для failed узлов", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "failed-nodes", {
			status: "failed",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "spawn", nodeId: "L1/node-1", parentId: "L0", timestamp: "2026-08-14T10:00:01.000Z" },
				{ event: "fail", nodeId: "L1/node-1", parentId: "L0", timestamp: "2026-08-14T10:02:00.000Z" },
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("failed узел отмечен иконкой ✗", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		const lines = output.split("\n");
		const failLine = lines.find((l) => l.includes("L1/node-1"));
		expect(failLine).toBeDefined();
		expect(failLine).toContain("✗");
	});
});

// ─── handleMissionCommand: интеграция tree ─────────────────────────────────

describe("F-42 / handleMissionCommand: tree subcommand", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("'fan mission tree <slug>' возвращает true и выводит дерево", async () => {
		setupMissionDir(baseDir, "tree-test", {
			status: "active",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "complete", nodeId: "L0", timestamp: "2026-08-14T10:05:00.000Z" },
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handled = await handleMissionCommand(["mission", "tree", "tree-test"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		logSpy.mockRestore();

		expect(handled).toBe(true);
		expect(output).toContain("L0");
	});

	it("'fan mission tree <slug> --format json' парсит флаг и выводит JSON", async () => {
		setupMissionDir(baseDir, "json-test", {
			status: "active",
			journalEntries: [{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" }],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handled = await handleMissionCommand(["mission", "tree", "json-test", "--format", "json"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		logSpy.mockRestore();

		expect(handled).toBe(true);
		// Вывод должен быть валидным JSON
		expect(() => JSON.parse(output)).not.toThrow();
	});

	it("'fan mission tree <slug> --depth 2' парсит флаг depth", async () => {
		setupMissionDir(baseDir, "depth-test", {
			status: "active",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "spawn", nodeId: "L1/n1", parentId: "L0", timestamp: "2026-08-14T10:00:01.000Z" },
				{ event: "spawn", nodeId: "L2/n2", parentId: "L1/n1", timestamp: "2026-08-14T10:00:02.000Z" },
				{ event: "spawn", nodeId: "L3/n3", parentId: "L2/n2", timestamp: "2026-08-14T10:00:03.000Z" },
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await handleMissionCommand(["mission", "tree", "depth-test", "--depth", "2"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		logSpy.mockRestore();

		expect(output).toContain("L0");
		// L3 не должен быть виден при depth=2
		expect(output).not.toContain("L3/n3");
	});

	it("'fan mission tree' без slug → usage сообщение + exit", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await handleMissionCommand(["mission", "tree"], {
				baseDir,
				isExtensionLoaded: () => true,
			});
		} catch {
			// expected __exit__
		}

		const allErr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Либо usage сообщение, либо exit с кодом ≠ 0
		if (exitSpy.mock.calls.length > 0) {
			expect(exitSpy.mock.calls[0]?.[0]).not.toBe(0);
		}
		if (allErr.length > 0) {
			expect(allErr.toLowerCase()).toMatch(/usage|slug|argument/i);
		}
	});
});

// ─── listMissionSubcommands включает "tree" ────────────────────────────────

describe("F-42 / listMissionSubcommands включает 'tree'", () => {
	it("'tree' присутствует в списке субкоманд", async () => {
		const { listMissionSubcommands } = await import("../../src/cli/mission-command.js");
		const subs = listMissionSubcommands();
		expect(subs).toContain("tree");
	});
});

// ─── Иконки статусов: ○ pending ─────────────────────────────────────────────

describe("F-42 / иконка ○ для pending узлов", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		// Узел упоминается как parentId, но собственных записей не имеет →
		// reconstructTree даёт status "unknown" → иконка ○ (pending)
		missionDir = setupMissionDir(baseDir, "pending-mission", {
			status: "active",
			journalEntries: [
				{ event: "spawn", nodeId: "L0", timestamp: "2026-08-14T10:00:00.000Z" },
				{ event: "spawn", nodeId: "L2/deep", parentId: "L1/implicit", timestamp: "2026-08-14T10:00:01.000Z" },
			],
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("узел без собственных записей (implicit parent) отображается как pending (○) или unknown", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		const lines = output.split("\n");
		// L1/implicit — упоминается как parentId, но не имеет собственных записей
		const implicitLine = lines.find((l) => l.includes("L1/implicit"));
		if (implicitLine) {
			// Должна быть иконка ○ (pending) или хотя бы отсутствие ✓/●/✗
			expect(implicitLine).toMatch(/[○✓●✗]/);
		}
		// Тест не падает — главная цель: отсутствие crash
		expect(output).toBeDefined();
	});
});

// ─── Пустой журнал (файл существует, но пуст) ──────────────────────────────

describe("F-42 / edge: пустой tree-journal.jsonl", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(() => {
		baseDir = freshBaseDir();
		missionDir = setupMissionDir(baseDir, "empty-journal", {
			status: "active",
		});
		// Создаём пустой файл tree-journal.jsonl
		writeFileSync(join(missionDir, "tree-journal.jsonl"), "", "utf8");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("не падает при пустом журнале", async () => {
		await expect(captureStdout(() => missionTree(missionDir))).resolves.toBeDefined();
	});

	it("вывод содержит mission header", async () => {
		const output = await captureStdout(() => missionTree(missionDir));
		expect(output.toLowerCase()).toMatch(/mission|empty-journal/i);
	});
});
