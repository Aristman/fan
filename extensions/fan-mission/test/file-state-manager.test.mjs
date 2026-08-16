// F-08: File-state-manager — Red-фаза (TC-F08-1, TC-F08-2, TC-F08-3)
//
// Все тесты ожидают модуль `extensions/fan-mission/file-state-manager.ts`,
// компилируемый в `file-state-manager.js`. На момент Red-фазы модуль ещё
// не существует, поэтому `import` падает, и каждый `it` помечается как
// failing. После реализации модуля по контракту ниже тесты должны проходить.
//
// Контракт API (по карточке F-08 + спека §3.1.2):
//   initMission(slug, opts?) -> Promise<missionDir>
//     opts.baseDir: родительский каталог (по умолчанию `docs/missions`)
//     Создаёт каталог `missionDir` с 5 файлами: MISSION.md, ROADMAP.md,
//     STATE.md, BACKLOG.md, DECISIONS.md. Возвращает абсолютный путь.
//
//   readState(missionDir) -> Promise<{ done: string[], blockers: string[], nextSteps: string[] }>
//   writeState(missionDir, state) -> Promise<void>
//     STATE.md: 3 секции («Сделано», «Блокеры», «Следующие шаги»), ≤ 5 KB.
//
//   readMission(missionDir) -> Promise<{ frontmatter: MissionFrontmatter, body: string }>
//   updateMission(...) -> throws MissionFileImmutable  // TC-F08-3
//
//   readBacklog(missionDir)   -> Promise<BacklogEntry[]>
//   appendBacklog(missionDir, entry) -> Promise<void>   // append-only
//   readDecisions(missionDir) -> Promise<DecisionEntry[]>
//   appendDecision(missionDir, entry) -> Promise<void>  // append-only
//   readRoadmap(missionDir)   -> Promise<string>
//   writeRoadmap(missionDir, content) -> Promise<void>
//
//   canTransition(from, to) -> boolean                  // TC-F08-2
//
//   validateSlug(slug) -> void  // throws InvalidSlug на path-traversal / reserved
//
//   Экспортируются классы ошибок:
//     MissionFileImmutable, StateFileTooLarge, InvalidStateSchema, InvalidSlug,
//     MissionNotFound, DuplicateSection
//   И константы:
//     MAX_STATE_BYTES = 5 * 1024
//     MAX_SLUG_LENGTH = 100
//     MISSION_FILES = ['MISSION.md', 'ROADMAP.md', 'STATE.md', 'BACKLOG.md', 'DECISIONS.md']
//
// Файлы миссии располагаются в `<baseDir>/<slug>/` (по умолчанию
// `docs/missions/<slug>/` — спека §3.1.2).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendBacklog,
	appendDecision,
	canTransition,
	DuplicateSection,
	extractGoal,
	hasUncheckedRoadmapItems,
	initMission,
	InvalidSlug,
	InvalidStateSchema,
	InvalidTransitionError,
	MISSION_FILES,
	MAX_SLUG_LENGTH,
	MAX_STATE_BYTES,
	MissionFileImmutable,
	MissionNotFound,
	parseFirstUnchecked,
	readBacklog,
	readDecisions,
	readMission,
	readRoadmap,
	readState,
	StateFileTooLarge,
	updateMission,
	validateSlug,
	writeMissionStatus,
	writeRoadmap,
	writeState,
} from "../file-state-manager.js";

/**
 * Создать временный корневой каталог для миссии.
 * `fs.mkdtemp` гарантирует уникальность; cleanup делается в afterEach.
 */
function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f08-red-"));
}

/**
 * Записать готовый STATE.md с тремя секциями на диск. Полезно для тестов
 * валидации/парсинга, где мы хотим управлять содержимым файла напрямую.
 */
function writeRawState(missionDir, content) {
	writeFileSync(join(missionDir, "STATE.md"), content, "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// Общий сценарий: init() создаёт структуру каталога и 5 файлов-шаблонов
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / initMission(slug)", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC: создаёт каталог <baseDir>/<slug>/ с 5 файлами-шаблонами", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		expect(missionDir).toBe(join(baseDir, "auth-refactor"));
		expect(existsSync(missionDir)).toBe(true);
		for (const file of MISSION_FILES) {
			expect(existsSync(join(missionDir, file))).toBe(true);
		}
	});

	it("TC: MISSION.md содержит валидный YAML frontmatter (mission_id, status, metric_type, metric_command, budget_tokens, budget_usd, max_depth, max_width)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw.startsWith("---\n")).toBe(true);
		const fmEnd = raw.indexOf("\n---\n", 4);
		expect(fmEnd).toBeGreaterThan(4);
		const fmBlock = raw.slice(4, fmEnd);
		// Минимальный набор обязательных полей из спеки §3.1.2.
		for (const key of [
			"mission_id",
			"created",
			"status",
			"metric_type",
			"metric_command",
			"budget_tokens",
			"budget_usd",
			"max_depth",
			"max_width",
		]) {
			expect(fmBlock).toContain(`${key}:`);
		}
	});

	it("TC: mission_id uses mission-<uuid> format", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const { frontmatter } = await readMission(missionDir);
		// UUID v4 format: 8-4-4-4-12 hex digits
		expect(frontmatter.mission_id).toMatch(/^mission-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("TC: STATE.md после init содержит ровно 3 секции («Сделано», «Блокеры», «Следующие шаги»)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const state = await readState(missionDir);
		expect(state).toHaveProperty("done");
		expect(state).toHaveProperty("blockers");
		expect(state).toHaveProperty("nextSteps");
		expect(Array.isArray(state.done)).toBe(true);
		expect(Array.isArray(state.blockers)).toBe(true);
		expect(Array.isArray(state.nextSteps)).toBe(true);
	});

	it("TC: повторный init для того же slug отказывается перетирать существующую миссию", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const before = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		// Вторая попытка не должна ломать файлы — бросает либо no-op, либо ошибку,
		// но в любом случае НЕ перезаписывает существующий MISSION.md.
		await initMission("auth-refactor", { baseDir }).catch(() => {});
		const after = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(after).toBe(before);
	});

	// ── 0.7.0: описание миссии при init → {{description}} → ## Goal ──────

	it("TC: init с описанием → секция ## Goal содержит текст описания", async () => {
		const missionDir = await initMission("desc-mission", {
			baseDir,
			description: "Build a REST API for user profiles with tests",
		});
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal");
		expect(raw).toContain("Build a REST API for user profiles with tests");
		// Описание не попало в шапку/frontmatter
		expect(raw.indexOf("Build a REST API")).toBeGreaterThan(raw.indexOf("## Goal"));
		// readMission видит описание в body
		const { body } = await readMission(missionDir);
		expect(extractGoal(body)).toBe("Build a REST API for user profiles with tests");
	});

	it("TC: init с многострочным описанием → Goal сохраняет строки", async () => {
		const missionDir = await initMission("multiline-desc", {
			baseDir,
			description: "Ship the dashboard.\n\nScope: charts only",
		});
		const { body } = await readMission(missionDir);
		expect(extractGoal(body)).toBe("Ship the dashboard.\n\nScope: charts only");
	});

	it("TC: init без описания → Goal пустой (обратная совместимость)", async () => {
		const missionDir = await initMission("no-desc", { baseDir });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal");
		const { body } = await readMission(missionDir);
		expect(extractGoal(body)).toBe("");
		// Прежний layout секций сохранён: между ## Goal и ## Scope только пустая строка
		expect(raw).toContain("## Goal\n\n## Scope");
	});

	it("TC: init с пустой строкой в описании → Goal пустой", async () => {
		const missionDir = await initMission("blank-desc", { baseDir, description: "   " });
		const { body } = await readMission(missionDir);
		expect(extractGoal(body)).toBe("");
	});
});

// ──────────────────────────────────────────────────────────────────────────────────
// 0.7.0: extractGoal — извлечение секции ## Goal из body MISSION.md
// ──────────────────────────────────────────────────────────────────────────────────

describe("F-08 / extractGoal(body)", () => {
	it("извлекает текст между ## Goal и следующим ## заголовком", () => {
		const body = "# Mission: x\n\n## Goal\nDo the thing\n\n## Scope\nout of scope\n";
		expect(extractGoal(body)).toBe("Do the thing");
	});

	it("многострочный Goal обрезается по следующему заголовку", () => {
		const body = "## Goal\nline1\nline2\n## Unbreakable Metric\ntests";
		expect(extractGoal(body)).toBe("line1\nline2");
	});

	it("пустая секция → пустая строка", () => {
		expect(extractGoal("## Goal\n\n## Scope\n")).toBe("");
	});

	it("нет секции Goal → пустая строка", () => {
		expect(extractGoal("# Mission\n## Scope\nstuff")).toBe("");
	});

	it("Goal — последний раздел (нет следующего заголовка)", () => {
		expect(extractGoal("## Goal\nfinal goal text")).toBe("final goal text");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F08-1: STATE.md — парсинг, 3 секции, лимит 5 KB (в байтах)
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / TC-F08-1: STATE.md парсинг и лимит 5 KB", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F08-1.happy: readState возвращает { done, blockers, nextSteps } из трёх секций", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		writeRawState(
			missionDir,
			[
				"## Сделано",
				"- step 1 done",
				"- step 2 done",
				"",
				"## Блокеры",
				"- waiting for review",
				"",
				"## Следующие шаги",
				"- next: integration test",
				"",
			].join("\n"),
		);
		const state = await readState(missionDir);
		expect(state.done).toEqual(["step 1 done", "step 2 done"]);
		expect(state.blockers).toEqual(["waiting for review"]);
		expect(state.nextSteps).toEqual(["next: integration test"]);
	});

	it("TC-F08-1.edge: отсутствие одной из обязательных секций -> InvalidStateSchema", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		// Только две секции — «Сделано» и «Блокеры», «Следующие шаги» отсутствует.
		writeRawState(
			missionDir,
			["## Сделано", "- a", "", "## Блокеры", "- b"].join("\n"),
		);
		await expect(readState(missionDir)).rejects.toBeInstanceOf(InvalidStateSchema);
	});

	it("TC-F08-1.edge: STATE.md > 5 KB (байт) -> StateFileTooLarge", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const padding = "x".repeat(MAX_STATE_BYTES); // строго больше лимита
		const content = `## Сделано\n${padding}\n## Блокеры\n\n## Следующие шаги\n`;
		writeRawState(missionDir, content);
		await expect(readState(missionDir)).rejects.toBeInstanceOf(StateFileTooLarge);
	});

	it("TC-F08-1.edge: STATE.md точно на лимите 5 KB (байт) -> успех", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		// Use ASCII-only header to make byte counting predictable.
		// We write raw content, so parseSections will match exact header names.
		// Use Cyrillic headers (as in real usage) but account for their byte sizes.
		const header = "## Сделано\n## Блокеры\n## Следующие шаги\n";
		const headerBytes = Buffer.byteLength(header, "utf8");
		const padBytes = MAX_STATE_BYTES - headerBytes;
		// Fill with ASCII 'x' characters (1 byte each)
		const padding = "x".repeat(Math.max(0, padBytes));
		const content = header + padding;
		// Verify exact byte size
		expect(Buffer.byteLength(content, "utf8")).toBe(MAX_STATE_BYTES);
		writeRawState(missionDir, content);
		await expect(readState(missionDir)).resolves.toBeDefined();
	});

	it("TC-F08-1.edge: STATE.md 5121 байт (1 байт сверх лимита) -> StateFileTooLarge", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const header = "## Сделано\n## Блокеры\n## Следующие шаги\n";
		const headerBytes = Buffer.byteLength(header, "utf8");
		const padBytes = MAX_STATE_BYTES - headerBytes + 1; // 1 byte over
		const content = header + "x".repeat(padBytes);
		expect(Buffer.byteLength(content, "utf8")).toBe(MAX_STATE_BYTES + 1);
		writeRawState(missionDir, content);
		await expect(readState(missionDir)).rejects.toBeInstanceOf(StateFileTooLarge);
	});

	it("TC-F08-1.edge: кириллица считается в байтах (2 байта на символ UTF-8)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		// Create content where character count < 5120 but byte count > 5120
		// "ы" = 2 bytes in UTF-8. 2600 chars of "ы" = 5200 bytes > 5120
		// But 2600 < 5120 character count
		const header = "## Сделано\n## Блокеры\n## Следующие шаги\n";
		const headerBytes = Buffer.byteLength(header, "utf8");
		// Use cyrillic "ы" (2 bytes each) to fill
		const remaining = MAX_STATE_BYTES - headerBytes;
		// Fill with cyrillic that pushes byte count over limit
		const cyrillicCount = Math.floor(remaining / 2) + 1; // This will exceed in bytes
		const content = header + "ы".repeat(cyrillicCount);
		// Verify: character count may be under MAX_STATE_BYTES, but bytes exceed
		expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(MAX_STATE_BYTES);
		writeRawState(missionDir, content);
		await expect(readState(missionDir)).rejects.toBeInstanceOf(StateFileTooLarge);
	});

	it("TC-F08-1.edge: writeState пишет в файл (roundtrip)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const next = {
			done: ["iter-1 finished"],
			blockers: [],
			nextSteps: ["iter-2: smoke"],
		};
		await writeState(missionDir, next);
		const round = await readState(missionDir);
		expect(round).toEqual(next);
	});

	it("TC-F08-1.edge: writeState > 5KB (байт) -> StateFileTooLarge", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		// Create items that will push STATE.md over 5KB in bytes
		const bigItem = "x".repeat(MAX_STATE_BYTES);
		await expect(
			writeState(missionDir, { done: [bigItem], blockers: [], nextSteps: [] }),
		).rejects.toBeInstanceOf(StateFileTooLarge);
	});

	it("TC-F08-1.edge: writeState item с \\n -> заменяется на пробел", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await writeState(missionDir, {
			done: ["line1\nline2"],
			blockers: [],
			nextSteps: [],
		});
		const state = await readState(missionDir);
		expect(state.done).toEqual(["line1 line2"]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F08-3: MISSION.md immutable после init
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / TC-F08-3: MISSION.md immutable после init", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F08-3: попытка изменить frontmatter после init -> MissionFileImmutable", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await expect(
			updateMission(missionDir, { status: "aborted" }),
		).rejects.toBeInstanceOf(MissionFileImmutable);
	});

	it("TC-F08-3: MISSION.md на диске остаётся неизменным после неудачной попытки обновления", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const before = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		await updateMission(missionDir, { status: "aborted" }).catch(() => {});
		const after = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(after).toBe(before);
	});

	it("TC-F08-3.readMission: возвращает распарсенный frontmatter и тело", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const { frontmatter, body } = await readMission(missionDir);
		expect(frontmatter.mission_id).toMatch(/^mission-/);
		expect(typeof frontmatter.status).toBe("string");
		expect(typeof body).toBe("string");
		expect(body.length).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// BACKLOG.md / DECISIONS.md — append-only семантика
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / BACKLOG.md и DECISIONS.md append-only", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("BACKLOG: первая запись создаёт таблицу с заголовком", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "JWT middleware refactor",
			source: "iteration #5",
			fit: 0.9,
			value: 0.8,
			risk: 0.3,
			cost: 0.4,
			score: 0.75,
			status: "ROADMAP",
		});
		const entries = await readBacklog(missionDir);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("idea-001");
	});

	it("BACKLOG: вторая запись НЕ удаляет первую (порядок сохраняется, длина растёт)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "JWT middleware refactor",
			source: "iteration #5",
			fit: 0.9,
			value: 0.8,
			risk: 0.3,
			cost: 0.4,
			score: 0.75,
			status: "ROADMAP",
		});
		await appendBacklog(missionDir, {
			id: "idea-002",
			date: "2026-08-11",
			idea: "Add rate limiting",
			source: "iteration #6",
			fit: 0.7,
			value: 0.7,
			risk: 0.4,
			cost: 0.5,
			score: 0.6,
			status: "DECIDE",
		});
		const entries = await readBacklog(missionDir);
		expect(entries.map((e) => e.id)).toEqual(["idea-001", "idea-002"]);
	});

	it("BACKLOG: файл на диске содержит обе записи после двух append (нет перезаписи)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "JWT middleware refactor",
			source: "iteration #5",
			fit: 0.9,
			value: 0.8,
			risk: 0.3,
			cost: 0.4,
			score: 0.75,
			status: "ROADMAP",
		});
		await appendBacklog(missionDir, {
			id: "idea-002",
			date: "2026-08-11",
			idea: "Add rate limiting",
			source: "iteration #6",
			fit: 0.7,
			value: 0.7,
			risk: 0.4,
			cost: 0.5,
			score: 0.6,
			status: "DECIDE",
		});
		const raw = readFileSync(join(missionDir, "BACKLOG.md"), "utf8");
		expect(raw).toContain("idea-001");
		expect(raw).toContain("idea-002");
		// Append-only: первая запись по-прежнему в начале файла.
		expect(raw.indexOf("idea-001")).toBeLessThan(raw.indexOf("idea-002"));
	});

	it("BACKLOG: нет tmp-файлов после успешного append", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "Test",
			source: "test",
			fit: 0.9,
			value: 0.8,
			risk: 0.3,
			cost: 0.4,
			score: 0.75,
			status: "ROADMAP",
		});
		const files = readdirSync(missionDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp-"));
		expect(tmpFiles).toHaveLength(0);
	});

	it("DECISIONS: нет tmp-файлов после успешного append", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendDecision(missionDir, {
			id: "ADR-001",
			date: "2026-08-10",
			status: "accepted",
			context: "Test context",
			decision: "Test decision",
			consequences: "Test consequences",
		});
		const files = readdirSync(missionDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp-"));
		expect(tmpFiles).toHaveLength(0);
	});

	it("STATE: нет tmp-файлов после успешного writeState", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await writeState(missionDir, { done: ["a"], blockers: [], nextSteps: [] });
		const files = readdirSync(missionDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp-"));
		expect(tmpFiles).toHaveLength(0);
	});

	it("BACKLOG: roundtrip с pipe (|) и \\n в idea — поля читаются без потерь", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendBacklog(missionDir, {
			id: "idea-003",
			date: "2026-08-11",
			idea: "Use Redis | Memcached\nfor caching",
			source: "iteration #7",
			fit: 0.8,
			value: 0.9,
			risk: 0.2,
			cost: 0.3,
			score: 0.85,
			status: "ROADMAP",
		});
		const entries = await readBacklog(missionDir);
		expect(entries).toHaveLength(1);
		// Pipe should be preserved (escaped/unescaped transparently)
		expect(entries[0].idea).toContain("|");
		// Newline is replaced with space (table cells must be single-line)
		expect(entries[0].idea).not.toContain("\n");
		expect(entries[0].idea).toBe("Use Redis | Memcached for caching");
	});

	it("DECISIONS: ADR-формат, добавление в конец", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await appendDecision(missionDir, {
			id: "ADR-001",
			date: "2026-08-10",
			status: "accepted",
			context: "Need refresh-token rotation strategy",
			decision: "Use sliding refresh with reuse detection",
			consequences: "More complex client SDK; better security",
		});
		await appendDecision(missionDir, {
			id: "ADR-002",
			date: "2026-08-11",
			status: "rejected",
			context: "Add MongoDB session store",
			decision: "Stick with Postgres for one quarter more",
			consequences: "Lower infra complexity",
		});
		const raw = readFileSync(join(missionDir, "DECISIONS.md"), "utf8");
		expect(raw.indexOf("ADR-001")).toBeLessThan(raw.indexOf("ADR-002"));
		const entries = await readDecisions(missionDir);
		expect(entries.map((e) => e.id)).toEqual(["ADR-001", "ADR-002"]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// ROADMAP.md — базовый read/write
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / ROADMAP.md", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("roundtrip: writeRoadmap -> readRoadmap возвращает идентичный текст", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const content = [
			"# ROADMAP",
			"",
			"- [ ] F-08 File-state-manager",
			"- [ ] F-09 Mission loop",
			"- [x] bootstrap mission dir",
			"",
		].join("\n");
		await writeRoadmap(missionDir, content);
		const got = await readRoadmap(missionDir);
		expect(got).toBe(content);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F08-2: FSM переходов статусов миссии — таблица переходов из §3.1.2
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / TC-F08-2: FSM переходов статусов миссии", () => {
	// Полная таблица переходов из спеки §3.1.2 (источник истины — спека).
	// Матрица «from → to»: true = разрешён, false = запрещён.
	const ALLOWED = {
		active: {
			active: false,        // самопереход не рассматривается как «переход»
			paused: true,         // I1 (оператор/watchdog)
			completed: true,      // контур: все этапы ✓
			aborted: true,        // I0 (оператор)
			failed: true,         // контур: circuit breaker
			budget_exhausted: true, // BudgetTracker
		},
		paused: {
			active: true,         // /mission:resume (оператор)
			paused: false,
			completed: false,
			aborted: true,        // I0 (оператор)
			failed: false,
			budget_exhausted: false,
		},
		completed: {
			active: true,         // реактивация при unchecked ROADMAP-пунктах
			paused: false,
			completed: false,
			aborted: false,
			failed: false,
			budget_exhausted: false,
		},
		aborted: {
			active: true,         // оператор (явный перезапуск)
			paused: false,
			completed: false,
			aborted: false,
			failed: false,
			budget_exhausted: false,
		},
		failed: {
			active: true,         // оператор (явный перезапуск)
			paused: false,
			completed: false,
			aborted: false,
			failed: false,
			budget_exhausted: false,
		},
		budget_exhausted: {
			active: true,         // пополнение бюджета (оператор)
			paused: false,
			completed: false,
			aborted: false,
			failed: false,
			budget_exhausted: false,
		},
	};

	const STATUSES = Object.keys(ALLOWED);

	for (const from of STATUSES) {
		for (const to of STATUSES) {
			if (from === to) continue; // самопереход не входит в таблицу переходов
			const allowed = ALLOWED[from][to];
			it(`canTransition: ${from} -> ${to} = ${allowed}`, () => {
				expect(canTransition(from, to)).toBe(allowed);
			});
		}
	}

	it("TC-F08-2.invariant: completed — разрешён только переход в active (реактивация)", () => {
		for (const to of STATUSES) {
			if (to === "completed") continue;
			if (to === "active") {
				expect(canTransition("completed", to)).toBe(true);
			} else {
				expect(canTransition("completed", to)).toBe(false);
			}
		}
	});

	// Расширенный инвариант: I0 (aborted) из ВСЕХ не-терминальных статусов.
	// Не-терминальные по спеке: active, paused.
	// failed, budget_exhausted, aborted — не считаются не-терминальными для I0
	// (они уже являются завершёнными/ошибочными состояниями).
	// Примечание: спека §3.1.2 говорит «Любой не-терминальный статус → aborted»,
	// но таблица переходов показывает, что failed/budget_exhausted → aborted = ✗.
	// Это известное противоречие спеки — текстовое правило «любой» сужается
	// таблицей переходов, которая является источником истины.
	it("TC-F08-2.invariant: I0 из всех не-терминальных → aborted; failed/budget_exhausted → aborted = false", () => {
		// Не-терминальные (по таблице спеки): active, paused
		const nonTerminal = ["active", "paused"];
		for (const from of nonTerminal) {
			expect(canTransition(from, "aborted")).toBe(true);
		}
		// failed/budget_exhausted → aborted = false (по таблице спеки)
		// Это противоречит текстовому правилу «любой не-терминальный»,
		// но таблица переходов — источник истины.
		expect(canTransition("failed", "aborted")).toBe(false);
		expect(canTransition("budget_exhausted", "aborted")).toBe(false);
		// completed, aborted — терминальные/уже завершённые
		expect(canTransition("completed", "aborted")).toBe(false);
		expect(canTransition("aborted", "aborted")).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Slug-валидация: расширенная защита (dot-only, leading-dot, Windows reserved,
// trailing dots/spaces, length limit)
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / slug validation (расширенная защита)", () => {
	it("validateSlug: принимает нормальный kebab-case", () => {
		expect(() => validateSlug("auth-refactor")).not.toThrow();
		expect(() => validateSlug("feature_x-2026")).not.toThrow();
	});

	it("validateSlug: '../evil' -> InvalidSlug", () => {
		expect(() => validateSlug("../evil")).toThrow(InvalidSlug);
		expect(() => validateSlug("..")).toThrow(InvalidSlug);
	});

	it("validateSlug: абсолютный путь '/etc/passwd' -> InvalidSlug", () => {
		expect(() => validateSlug("/etc/passwd")).toThrow(InvalidSlug);
		expect(() => validateSlug("C:\\Windows")).toThrow(InvalidSlug);
	});

	it("validateSlug: пустая строка -> InvalidSlug", () => {
		expect(() => validateSlug("")).toThrow(InvalidSlug);
	});

	it("validateSlug: пробелы и спецсимволы -> InvalidSlug", () => {
		expect(() => validateSlug("auth refactor")).toThrow(InvalidSlug);
		expect(() => validateSlug("auth;rm -rf")).toThrow(InvalidSlug);
		expect(() => validateSlug("auth/refactor")).toThrow(InvalidSlug);
	});

	it("validateSlug: '.' (single dot) -> InvalidSlug", () => {
		expect(() => validateSlug(".")).toThrow(InvalidSlug);
	});

	it("validateSlug: '...' (triple dot) -> InvalidSlug", () => {
		expect(() => validateSlug("...")).toThrow(InvalidSlug);
	});

	it("validateSlug: leading dot '.foo' -> InvalidSlug", () => {
		expect(() => validateSlug(".foo")).toThrow(InvalidSlug);
		expect(() => validateSlug(".hidden")).toThrow(InvalidSlug);
	});

	it("validateSlug: trailing dot 'foo.' -> InvalidSlug", () => {
		expect(() => validateSlug("foo.")).toThrow(InvalidSlug);
		expect(() => validateSlug("my-mission.")).toThrow(InvalidSlug);
	});

	it("validateSlug: trailing space 'foo ' -> InvalidSlug", () => {
		expect(() => validateSlug("foo ")).toThrow(InvalidSlug);
		expect(() => validateSlug("my-mission ")).toThrow(InvalidSlug);
	});

	it("validateSlug: Windows reserved names (case-insensitive) -> InvalidSlug", () => {
		expect(() => validateSlug("CON")).toThrow(InvalidSlug);
		expect(() => validateSlug("con")).toThrow(InvalidSlug);
		expect(() => validateSlug("NUL")).toThrow(InvalidSlug);
		expect(() => validateSlug("nul")).toThrow(InvalidSlug);
		expect(() => validateSlug("PRN")).toThrow(InvalidSlug);
		expect(() => validateSlug("AUX")).toThrow(InvalidSlug);
		expect(() => validateSlug("COM1")).toThrow(InvalidSlug);
		expect(() => validateSlug("com1")).toThrow(InvalidSlug);
		expect(() => validateSlug("LPT9")).toThrow(InvalidSlug);
		expect(() => validateSlug("lpt9")).toThrow(InvalidSlug);
	});

	it("validateSlug: Windows reserved names with extension -> InvalidSlug", () => {
		expect(() => validateSlug("CON.txt")).toThrow(InvalidSlug);
		expect(() => validateSlug("nul.md")).toThrow(InvalidSlug);
		expect(() => validateSlug("COM1.bat")).toThrow(InvalidSlug);
		expect(() => validateSlug("aux.json")).toThrow(InvalidSlug);
	});

	it("validateSlug: length > 100 -> InvalidSlug", () => {
		const longSlug = "a".repeat(MAX_SLUG_LENGTH + 1);
		expect(() => validateSlug(longSlug)).toThrow(InvalidSlug);
	});

	it("validateSlug: exactly 100 chars -> OK", () => {
		const slug = "a".repeat(MAX_SLUG_LENGTH);
		expect(() => validateSlug(slug)).not.toThrow();
	});

	it("initMission: path-traversal slug -> InvalidSlug и НЕ создаёт каталог", async () => {
		const baseDir = freshBaseDir();
		try {
			await expect(initMission("../escape", { baseDir })).rejects.toBeInstanceOf(InvalidSlug);
			// Каталог миссии вне baseDir не должен существовать.
			expect(existsSync(join(baseDir, "escape"))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("initMission: '.' slug -> InvalidSlug и НЕ пишет в baseDir", async () => {
		const baseDir = freshBaseDir();
		try {
			await expect(initMission(".", { baseDir })).rejects.toBeInstanceOf(InvalidSlug);
			// baseDir не должен содержать MISSION.md (initMission не писал в корень)
			expect(existsSync(join(baseDir, "MISSION.md"))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("initMission: Windows reserved slug 'CON' -> InvalidSlug", async () => {
		const baseDir = freshBaseDir();
		try {
			await expect(initMission("CON", { baseDir })).rejects.toBeInstanceOf(InvalidSlug);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Граничные случаи: повреждённый frontmatter и несуществующая миссия
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / диагностика схемы", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("readMission на несуществующем каталоге -> MissionNotFound", async () => {
		await expect(readMission(join(baseDir, "ghost"))).rejects.toBeInstanceOf(MissionNotFound);
	});

	it("readState на несуществующем каталоге -> MissionNotFound", async () => {
		await expect(readState(join(baseDir, "ghost"))).rejects.toBeInstanceOf(MissionNotFound);
	});

	it("readMission с битым frontmatter -> ошибка валидации", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		// Сломали frontmatter, убрав обязательное поле status.
		writeFileSync(
			join(missionDir, "MISSION.md"),
			[
				"---",
				"mission_id: mission-x",
				"created: 2026-08-10T00:00:00Z",
				"metric_type: test_pass_rate",
				"metric_command: npm test",
				"budget_tokens: 1000",
				"budget_usd: 1.0",
				"max_depth: 2",
				"max_width: 2",
				"---",
				"",
				"# body",
				"",
			].join("\n"),
			"utf8",
		);
		await expect(readMission(missionDir)).rejects.toBeDefined();
	});

	it("writeState с пустыми массивами — допустимо (нет ни одной выполненной задачи)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });
		const state = await readState(missionDir);
		expect(state).toEqual({ done: [], blockers: [], nextSteps: [] });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Frontmatter: кавычки, inline-комментарии, CRLF
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / frontmatter parsing", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("status: \"active\" -> strips quotes to 'active'", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		writeFileSync(
			join(missionDir, "MISSION.md"),
			[
				"---",
				'mission_id: "mission-test"',
				"created: 2026-08-10T00:00:00Z",
				'status: "active"',
				"metric_type: test_pass_rate",
				"metric_command: npm test",
				"budget_tokens: 500000",
				"budget_usd: 10.00",
				"max_depth: 4",
				"max_width: 4",
				"---",
				"",
				"# body",
				"",
			].join("\n"),
			"utf8",
		);
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.status).toBe("active");
		expect(frontmatter.mission_id).toBe("mission-test");
	});

	it("budget_tokens: 500000 # комментарий -> число 500000", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		writeFileSync(
			join(missionDir, "MISSION.md"),
			[
				"---",
				"mission_id: mission-test",
				"created: 2026-08-10T00:00:00Z",
				"status: active",
				"metric_type: test_pass_rate",
				"metric_command: npm test",
				"budget_tokens: 500000 # max budget",
				"budget_usd: 10.00",
				"max_depth: 4 # depth limit",
				"max_width: 4",
				"---",
				"",
				"# body",
				"",
			].join("\n"),
			"utf8",
		);
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.budget_tokens).toBe(500000);
		expect(frontmatter.max_depth).toBe(4);
	});

	it("CRLF file reads correctly (\\r\\n normalized to \\n)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		const content = [
			"---",
			"mission_id: mission-test",
			"created: 2026-08-10T00:00:00Z",
			"status: active",
			"metric_type: test_pass_rate",
			"metric_command: npm test",
			"budget_tokens: 500000",
			"budget_usd: 10.00",
			"max_depth: 4",
			"max_width: 4",
			"---",
			"",
			"# body",
			"",
		].join("\r\n");
		writeFileSync(join(missionDir, "MISSION.md"), content, "utf8");
		const { frontmatter, body } = await readMission(missionDir);
		expect(frontmatter.status).toBe("active");
		expect(frontmatter.budget_tokens).toBe(500000);
		expect(body.length).toBeGreaterThan(0);
	});

	it("inline comment with # inside quotes is preserved", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		writeFileSync(
			join(missionDir, "MISSION.md"),
			[
				"---",
				'mission_id: "mission-#1"',
				"created: 2026-08-10T00:00:00Z",
				"status: active",
				"metric_type: test_pass_rate",
				"metric_command: npm test",
				"budget_tokens: 500000",
				"budget_usd: 10.00",
				"max_depth: 4",
				"max_width: 4",
				"---",
				"",
				"# body",
				"",
			].join("\n"),
			"utf8",
		);
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.mission_id).toBe("mission-#1");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Дубликаты секций STATE.md
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / duplicate sections in STATE.md", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("duplicate section header -> DuplicateSection (InvalidStateSchema name)", async () => {
		const missionDir = await initMission("auth-refactor", { baseDir });
		writeRawState(
			missionDir,
			[
				"## Сделано",
				"- a",
				"",
				"## Блокеры",
				"- b",
				"",
				"## Сделано",
				"- c",
				"",
				"## Следующие шаги",
				"- d",
				"",
			].join("\n"),
		);
		await expect(readState(missionDir)).rejects.toThrow(/duplicate|Сделано/i);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// P-3: Template selection — initMission with { template: 'refactor' }

describe("F-08 / P-3: Template selection", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("initMission(slug, { template: 'refactor' }) creates MISSION.md with template: refactor frontmatter", async () => {
		const missionDir = await initMission("refactor-test", { baseDir, template: "refactor" });
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.template).toBe("refactor");
		expect(frontmatter.metric_type).toBe("code_complexity_reduction");
	});

	it("refactor MISSION.md body contains 'Refactor Mission'", async () => {
		const missionDir = await initMission("refactor-body", { baseDir, template: "refactor" });
		const { body } = await readMission(missionDir);
		expect(body).toContain("Refactor Mission: refactor-body");
	});

	it("default template (no template opt) has no template field in frontmatter", async () => {
		const missionDir = await initMission("default-test", { baseDir });
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.template).toBeUndefined();
	});

	it("default template metric_type is test_pass_rate", async () => {
		const missionDir = await initMission("default-metric", { baseDir });
		const { frontmatter } = await readMission(missionDir);
		expect(frontmatter.metric_type).toBe("test_pass_rate");
	});

	it("refactor template creates all 5 mission files", async () => {
		const missionDir = await initMission("refactor-files", { baseDir, template: "refactor" });
		for (const file of MISSION_FILES) {
			expect(existsSync(join(missionDir, file))).toBe(true);
		}
	});

	it("unknown template name throws", async () => {
		await expect(initMission("bad-template", { baseDir, template: "nonexistent" })).rejects.toThrow(
			/[Uu]nknown.*template/i,
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// P-5/P-6: InvalidTransitionError — writeMissionStatus throws typed error

describe("F-08 / P-5/P-6: InvalidTransitionError from writeMissionStatus", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("writeMissionStatus throws InvalidTransitionError for invalid transition", async () => {
		const missionDir = await initMission("trans-test", { baseDir });
		// Set status to completed
		await writeMissionStatus(missionDir, "completed");
		// completed → paused is invalid
		await expect(writeMissionStatus(missionDir, "paused")).rejects.toThrow();
		try {
			await writeMissionStatus(missionDir, "paused");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidTransitionError);
			expect(err.name).toBe("InvalidTransitionError");
		}
	});

	it("InvalidTransitionError has from and to properties", async () => {
		const err = new InvalidTransitionError("completed", "paused");
		expect(err.from).toBe("completed");
		expect(err.to).toBe("paused");
		expect(err.message).toContain("completed");
		expect(err.message).toContain("paused");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// parseFirstUnchecked — single source of truth for ROADMAP checkbox parsing
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / parseFirstUnchecked: shared ROADMAP checkbox parser", () => {
	it("returns null for empty string", () => {
		expect(parseFirstUnchecked("")).toBeNull();
	});

	it("returns null when all items are checked", () => {
		const raw = "# Roadmap\n\n- [x] step 1\n- [x] step 2\n";
		expect(parseFirstUnchecked(raw)).toBeNull();
	});

	it("returns first unchecked item with dash marker", () => {
		const raw = "# Roadmap\n\n- [x] step 1\n- [ ] step 2\n- [ ] step 3\n";
		const result = parseFirstUnchecked(raw);
		expect(result).not.toBeNull();
		expect(result.text).toBe("step 2");
		expect(result.index).toBe(3);
	});

	it("returns first unchecked item with asterisk marker", () => {
		const raw = "# Roadmap\n\n* [x] step 1\n* [ ] step 2\n";
		const result = parseFirstUnchecked(raw);
		expect(result).not.toBeNull();
		expect(result.text).toBe("step 2");
	});

	it("skips non-checkbox lines", () => {
		const raw = "# Roadmap\n\nSome text\n- Not a checkbox\n- [ ] real item\n";
		const result = parseFirstUnchecked(raw);
		expect(result).not.toBeNull();
		expect(result.text).toBe("real item");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// hasUncheckedRoadmapItems — async ROADMAP checker
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / hasUncheckedRoadmapItems: async ROADMAP checker", () => {
	let baseDir;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("returns true when ROADMAP has unchecked items", async () => {
		const missionDir = await initMission("unchecked-yes", { baseDir });
		await writeRoadmap(missionDir, "# Roadmap\n\n- [x] done\n- [ ] todo\n");
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(true);
	});

	it("returns false when all items are checked", async () => {
		const missionDir = await initMission("unchecked-no", { baseDir });
		await writeRoadmap(missionDir, "# Roadmap\n\n- [x] done 1\n- [x] done 2\n");
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(false);
	});

	it("returns false when ROADMAP has no checklist items", async () => {
		const missionDir = await initMission("unchecked-empty", { baseDir });
		await writeRoadmap(missionDir, "# Roadmap\n\nNo items here.\n");
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// completed → active transition (reactivation)
// ────────────────────────────────────────────────────────────────────────────

describe("F-08 / canTransition: completed → active (reactivation)", () => {
	it("completed → active is allowed", () => {
		expect(canTransition("completed", "active")).toBe(true);
	});

	it("completed → paused is still forbidden", () => {
		expect(canTransition("completed", "paused")).toBe(false);
	});

	it("completed → aborted is still forbidden", () => {
		expect(canTransition("completed", "aborted")).toBe(false);
	});

	it("writeMissionStatus allows completed → active", async () => {
		const baseDir = freshBaseDir();
		const missionDir = await initMission("reactivate-test", { baseDir });
		await writeMissionStatus(missionDir, "completed");
		await expect(writeMissionStatus(missionDir, "active")).resolves.toBeUndefined();
		const { frontmatter } = await readMission(missionDir);
		expect(String(frontmatter.status)).toBe("active");
		rmSync(baseDir, { recursive: true, force: true });
	});
});
