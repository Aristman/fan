// F-10: CLI `fan mission init` + subcommands — Red-фаза (TDD)
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-10
// Спека:   docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.2, §6.1
//
// Назначение модуля (Red — должен быть реализован в Green-фазе):
//   packages/coding-agent/src/cli/mission-command.ts
//   Экспортирует `handleMissionCommand(args, ctx?)` — диспетчер `fan mission <sub>`.
//   Субкоманды: init, start, stop, status, pause, resume.
//
// Ожидаемый публичный API (контракт):
//
//   handleMissionCommand(args: string[], ctx?: MissionContext): Promise<boolean>
//     — если args[0] !== "mission", возвращает false (другие хендлеры продолжат).
//     — если ctx.isExtensionLoaded("fan-mission") === false →
//         печатает ошибку про отсутствующее расширение, process.exit(1), возвращает false.
//     — иначе диспетчеризует по args[1] (subcommand).
//     — успех: возвращает true.
//
//   missionInit(slug: string, opts?: { baseDir?: string }): Promise<string>
//     — создаёт <baseDir>/<slug>/ с 5 файлами (MISSION.md, ROADMAP.md, STATE.md,
//       BACKLOG.md, DECISIONS.md). MISSION.md содержит валидный YAML frontmatter
//       с mission_id, created, status: active, и пр. Возвращает абсолютный путь.
//     — если миссия уже существует → бросает MissionAlreadyExistsError.
//
//   missionStart(missionDir?: string): Promise<void>
//   missionStop(missionDir?: string): Promise<void>
//   missionStatus(missionDir?: string): Promise<void>
//   missionPause(missionDir?: string): Promise<void>
//   missionResume(missionDir?: string): Promise<void>
//     — если миссия не инициализирована → бросают MissionNotInitializedError.
//
//   listMissionSubcommands(): string[]
//     — возвращает канонический список субкоманд: ["init", "start", "stop",
//       "status", "pause", "resume"] (для проверки регистрации).
//
//   MISSION_FILES: readonly string[] — ["MISSION.md", "ROADMAP.md", "STATE.md",
//       "BACKLOG.md", "DECISIONS.md"].
//
//   MissionContext: { isExtensionLoaded?: (name: string) => boolean }
//     — DI для тестирования условной регистрации.
//
// Ошибки:
//   MissionAlreadyExistsError   — slug уже инициализирован (exit 1).
//   MissionNotInitializedError  — субкоманда без init (exit 1).
//   MissionExtensionMissingError — расширение fan-mission не загружено (exit 1).
//
// Red-ожидание: файл `src/cli/mission-command.ts` ещё не существует,
// поэтому `import` падает с module-not-found, и весь набор тестов помечается
// как failing. После Green-фазы тесты должны проходить.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the dynamic loader to the real extension source (monorepo dev).
process.env.FAN_MISSION_DIR = resolve(import.meta.dirname ?? __dirname, "../../../../extensions/fan-mission");

import {
	handleMissionCommand,
	InvalidTransitionError,
	listMissionSubcommands,
	MISSION_FILES,
	MissionAlreadyExistsError,
	MissionExtensionMissingError,
	MissionNotInitializedError,
	missionInit,
	missionPause,
	missionResume,
	missionStart,
	missionStatus,
	missionStop,
} from "../../src/cli/mission-command.js";

// ─── Вспомогательные функции ────────────────────────────────────────────────

/** Свежий временный каталог, изолированный для каждого теста. */
function freshBaseDir(): string {
	return mkdtempSync(join(tmpdir(), "fan-f10-red-"));
}

/** Чтение frontmatter блока между двумя `---` маркерами. */
function readFrontmatter(content: string): Record<string, string> {
	if (!content.startsWith("---\n")) return {};
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx < 4) return {};
	const block = content.slice(4, endIdx);
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx < 1) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line.slice(colonIdx + 1).trim();
		if (key) out[key] = val;
	}
	return out;
}

// ─── TC-F10-1: init создаёт 5 файлов валидного формата ─────────────────────

describe("F-10 / TC-F10-1: mission init <slug> создаёт 5 файлов", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F10-1.happy: создаёт каталог <baseDir>/<slug>/ с 5 файлами шаблонов", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		expect(missionDir).toBe(join(baseDir, "auth-refactor"));
		expect(existsSync(missionDir)).toBe(true);
		for (const file of MISSION_FILES) {
			expect(existsSync(join(missionDir, file))).toBe(true);
		}
	});

	it("TC-F10-1.happy: MISSION_FILES = [MISSION.md, ROADMAP.md, STATE.md, BACKLOG.md, DECISIONS.md]", () => {
		expect(MISSION_FILES).toEqual(["MISSION.md", "ROADMAP.md", "STATE.md", "BACKLOG.md", "DECISIONS.md"]);
	});

	it("TC-F10-1.happy: MISSION.md содержит валидный YAML frontmatter", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw.startsWith("---\n")).toBe(true);
		const fmEnd = raw.indexOf("\n---\n", 4);
		expect(fmEnd).toBeGreaterThan(4);

		const fm = readFrontmatter(raw);
		// Обязательные поля из спеки §3.1.2.
		expect(fm.mission_id).toMatch(/^mission-[0-9a-f-]{36}$/);
		expect(fm.status).toBe("active");
		expect(fm.created).toBeTruthy();
		expect(fm.metric_type).toBeTruthy();
		expect(fm.metric_command).toBeTruthy();
		expect(fm.budget_tokens).toBeTruthy();
		expect(fm.budget_usd).toBeTruthy();
	});

	it("TC-F10-1.happy: возвращает абсолютный путь к каталогу миссии", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		// resolve() даёт абсолютный путь — на Windows включает диск.
		expect(missionDir).toMatch(/^[A-Za-z]:[\\/]|^[\\/]/);
		expect(missionDir.endsWith(join("auth-refactor"))).toBe(true);
	});

	it("TC-F10-1.happy: все 5 файлов непустые после init", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		for (const file of MISSION_FILES) {
			const content = readFileSync(join(missionDir, file), "utf8");
			expect(content.length).toBeGreaterThan(0);
		}
	});

	it("TC-F10-1.edge: разные slug дают разные mission_id", async () => {
		const dir1 = await missionInit("mission-a", { baseDir });
		const dir2 = await missionInit("mission-b", { baseDir });
		const id1 = readFrontmatter(readFileSync(join(dir1, "MISSION.md"), "utf8")).mission_id;
		const id2 = readFrontmatter(readFileSync(join(dir2, "MISSION.md"), "utf8")).mission_id;
		expect(id1).toBeTruthy();
		expect(id2).toBeTruthy();
		expect(id1).not.toBe(id2);
	});

	it("TC-F10-1.edge: невалидный slug (path-traversal) → InvalidSlug (и каталог НЕ создаётся)", async () => {
		// missionInit должен делегировать валидацию в file-state-manager.validateSlug.
		await expect(missionInit("../escape", { baseDir })).rejects.toThrow(/Invalid slug/i);
		// Каталог миссии вне baseDir не должен существовать.
		expect(existsSync(join(baseDir, "escape"))).toBe(false);
	});

	it("TC-F10-1.edge: пустой slug → InvalidSlug", async () => {
		await expect(missionInit("", { baseDir })).rejects.toThrow(/Invalid slug/i);
	});

	it("TC-F10-1.desc: missionInit с описанием → текст в ## Goal MISSION.md", async () => {
		const missionDir = await missionInit("desc-mission", {
			baseDir,
			description: "Automate the release pipeline",
		});
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal");
		expect(raw).toContain("Automate the release pipeline");
	});

	it("TC-F10-1.desc: missionInit без описания → Goal пустой (как раньше)", async () => {
		const missionDir = await missionInit("plain-mission", { baseDir });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal\n\n## Scope");
	});
});

// ─── TC-F10-2: повторный init с тем же slug → ошибка ────────────────────────

describe("F-10 / TC-F10-2: повторный init с тем же slug → ошибка", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F10-2.happy: повторный missionInit с тем же slug → MissionAlreadyExistsError", async () => {
		const slug = "auth-refactor";
		await missionInit(slug, { baseDir });
		await expect(missionInit(slug, { baseDir })).rejects.toBeInstanceOf(MissionAlreadyExistsError);
	});

	it("TC-F10-2.happy: сообщение ошибки содержит имя slug", async () => {
		const slug = "auth-refactor";
		await missionInit(slug, { baseDir });
		try {
			await missionInit(slug, { baseDir });
			expect.unreachable("expected MissionAlreadyExistsError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(MissionAlreadyExistsError);
			expect((err as Error).message).toContain(slug);
			expect((err as Error).message.toLowerCase()).toContain("already exists");
		}
	});

	it("TC-F10-2.happy: существующая миссия не перезаписывается (mission_id сохраняется)", async () => {
		const slug = "auth-refactor";
		const firstDir = await missionInit(slug, { baseDir });
		const before = readFrontmatter(readFileSync(join(firstDir, "MISSION.md"), "utf8"));

		await missionInit(slug, { baseDir }).catch(() => {});

		const after = readFrontmatter(readFileSync(join(firstDir, "MISSION.md"), "utf8"));
		expect(after.mission_id).toBe(before.mission_id);
	});

	it("TC-F10-2.edge: разные slug не конфликтуют", async () => {
		const a = await missionInit("mission-a", { baseDir });
		const b = await missionInit("mission-b", { baseDir });
		expect(a).not.toBe(b);
		expect(existsSync(a)).toBe(true);
		expect(existsSync(b)).toBe(true);
	});
});

// ─── TC-F10-3: start без инициализированной миссии → ошибка ─────────────────

describe("F-10 / TC-F10-3: mission start без init → ошибка", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F10-3.happy: missionStart() без init → MissionNotInitializedError", async () => {
		await expect(missionStart(baseDir)).rejects.toBeInstanceOf(MissionNotInitializedError);
	});

	it("TC-F10-3.happy: сообщение содержит 'fan mission init'", async () => {
		try {
			await missionStart(baseDir);
			expect.unreachable("expected MissionNotInitializedError");
		} catch (err) {
			expect(err).toBeInstanceOf(MissionNotInitializedError);
			expect((err as Error).message).toMatch(/fan mission init/i);
		}
	});

	it("TC-F10-3.edge: missionStop/Status/Pause/Resume без init → MissionNotInitializedError", async () => {
		await expect(missionStop(baseDir)).rejects.toBeInstanceOf(MissionNotInitializedError);
		await expect(missionStatus(baseDir)).rejects.toBeInstanceOf(MissionNotInitializedError);
		await expect(missionPause(baseDir)).rejects.toBeInstanceOf(MissionNotInitializedError);
		await expect(missionResume(baseDir)).rejects.toBeInstanceOf(MissionNotInitializedError);
	});
});

// ─── Регистрация подкоманд (по карточке F-10: listMissionSubcommands) ──────

describe("F-10 / регистрация подкоманд", () => {
	it("listMissionSubcommands содержит init, start, stop, status, pause, resume", () => {
		const subs = listMissionSubcommands();
		expect(subs).toContain("init");
		expect(subs).toContain("start");
		expect(subs).toContain("stop");
		expect(subs).toContain("status");
		expect(subs).toContain("pause");
		expect(subs).toContain("resume");
	});

	it("listMissionSubcommands возвращает 7 субкоманд (init + 5 операторов + tree)", () => {
		expect(listMissionSubcommands().length).toBe(7);
	});
});

// ─── handleMissionCommand: диспетчер CLI ────────────────────────────────────

describe("F-10 / handleMissionCommand(args) — диспетчер CLI", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("возвращает false если args[0] !== 'mission' (другие хендлеры продолжают)", async () => {
		const handled = await handleMissionCommand(["server", "status"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(false);
	});

	it("'fan mission init <slug>' возвращает true и создаёт 5 файлов", async () => {
		const handled = await handleMissionCommand(["mission", "init", "auth-refactor"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		const missionDir = join(baseDir, "auth-refactor");
		expect(existsSync(missionDir)).toBe(true);
		for (const file of MISSION_FILES) {
			expect(existsSync(join(missionDir, file))).toBe(true);
		}
	});

	// ── 0.7.0: описание миссии позициональными аргументами ─────────────────

	it("'fan mission init <slug> <описание...>' склеивает остаток слов в описание → ## Goal", async () => {
		const handled = await handleMissionCommand(["mission", "init", "desc-cli", "Build", "a", "REST", "API"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		const raw = readFileSync(join(baseDir, "desc-cli", "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal");
		expect(raw).toContain("Build a REST API");
	});

	it("'fan mission init <slug>' без описания → Goal пустой (обратная совместимость)", async () => {
		const handled = await handleMissionCommand(["mission", "init", "no-desc-cli"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		const raw = readFileSync(join(baseDir, "no-desc-cli", "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal\n\n## Scope");
	});

	it("описание не захватывает значение флага --template", async () => {
		const handled = await handleMissionCommand(
			["mission", "init", "--template", "default", "tmpl-desc", "Ship", "it"],
			{ baseDir, isExtensionLoaded: () => true },
		);
		expect(handled).toBe(true);
		const raw = readFileSync(join(baseDir, "tmpl-desc", "MISSION.md"), "utf8");
		expect(raw).toContain("Ship it");
		expect(raw).not.toContain("default Ship");
	});

	it("'fan mission start' без init → process.exit(1)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		// handleMissionCommand должен вызвать process.exit(1).
		// Поскольку мы мокаем exit броском, обработчик бросит нашу метку.
		await expect(
			handleMissionCommand(["mission", "start"], {
				baseDir,
				isExtensionLoaded: () => true,
			}),
		).rejects.toThrow("__exit__");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("'fan mission start' без init → сообщение содержит 'No mission initialized'", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		try {
			await handleMissionCommand(["mission", "start"], {
				baseDir,
				isExtensionLoaded: () => true,
			});
		} catch {
			// expected __exit__
		}
		const allErrorOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allErrorOutput).toMatch(/no mission initialized/i);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("неизвестная субкоманда → не считается обработанной (false)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const handled = await handleMissionCommand(["mission", "bogus"], {
				baseDir,
				isExtensionLoaded: () => true,
			});
			expect(handled).toBe(false);
		} catch (err) {
			// допустим, если реализация решит бросить после выхода — нам важен только факт false
			if (!(err as Error).message.includes("__exit__")) throw err;
		}
		// В любом случае exit НЕ должен быть с кодом 0 (обработка не штатная).
		if (exitSpy.mock.calls.length > 0) {
			expect(exitSpy.mock.calls[0]?.[0]).not.toBe(0);
		}
		// Либо сообщение об ошибке было выведено.
		const allErrorOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		if (allErrorOutput.length > 0) {
			expect(allErrorOutput.toLowerCase()).toMatch(/unknown|invalid|usage/);
		}
	});
});

// ─── Условная регистрация: без расширения fan-mission ──────────────────────

describe("F-10 / условная регистрация: расширение fan-mission", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("без fan-mission: handleMissionCommand возвращает false (не регистрирует команду)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await handleMissionCommand(["mission", "init", "auth-refactor"], {
			baseDir,
			isExtensionLoaded: (name) => name !== "fan-mission",
		});

		// Контракт карточки: "Команда условна: проверяет наличие расширения fan-mission".
		// Без расширения команда НЕ должна выполняться — ни создавать файлы,
		// ни бросать success. Либо false + сообщение, либо exit(1).
		if (handled) {
			// Если реализация решит всё-таки обработать — должен быть выход с ошибкой.
			expect(exitSpy).toHaveBeenCalledWith(1);
		} else {
			// false + понятный отказ.
			const allErrorOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(allErrorOutput.toLowerCase()).toMatch(/fan-mission|extension/);
		}
		// В любом случае файлы миссии НЕ должны быть созданы.
		expect(existsSync(join(baseDir, "auth-refactor"))).toBe(false);
	});

	it("без fan-mission: прямой вызов missionInit также отказывает (либо throws, либо no-op)", async () => {
		// Допустимы две интерпретации:
		//   (a) missionInit проверяет наличие расширения внутри и бросает MissionExtensionMissingError;
		//   (b) missionInit не знает про расширение, проверка делается только в диспетчере.
		// Карточка говорит про диспетчер. Если (a) — тест пройдёт через throws;
		// если (b) — тест проверит, что missionInit как минимум не падает с
		// непонятной ошибкой, а либо работает, либо бросает осмысленно.
		try {
			await missionInit("auth-refactor", { baseDir });
			// Если missionInit проигнорировал условие — нормально,
			// основная защита лежит на диспетчере (предыдущий тест).
		} catch (err) {
			// Если бросил — должен бросить MissionExtensionMissingError, а не что-то невнятное.
			if (!(err instanceof Error)) throw err;
			expect(err.name === "MissionExtensionMissingError" || /fan-mission|extension/i.test(err.message)).toBe(true);
		}
	});

	it("с fan-mission: handleMissionCommand работает штатно", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const handled = await handleMissionCommand(["mission", "init", "auth-refactor"], {
			baseDir,
			isExtensionLoaded: (name) => name === "fan-mission",
		});
		expect(handled).toBe(true);
		expect(existsSync(join(baseDir, "auth-refactor"))).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("MissionExtensionMissingError экспортируется как класс ошибки", () => {
		// Проверяем, что ошибка — настоящий класс с name === MissionExtensionMissingError.
		const err = new MissionExtensionMissingError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("MissionExtensionMissingError");
		expect(err.message).toContain("fan-mission");
	});
});

// ─── MISSION.md формат: полный набор полей frontmatter (спека §3.1.2) ──────

describe("F-10 / MISSION.md frontmatter содержит все обязательные поля", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("frontmatter имеет все 9 обязательных полей из спеки §3.1.2", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		const required = [
			"mission_id",
			"created",
			"status",
			"metric_type",
			"metric_command",
			"budget_tokens",
			"budget_usd",
			"max_depth",
			"max_width",
		];
		for (const key of required) {
			expect(fm[key], `missing frontmatter field: ${key}`).toBeTruthy();
		}
	});

	it("frontmatter status: 'active' (стартовое значение FSM)", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		expect(fm.status).toBe("active");
	});

	it("mission_id имеет формат mission-<uuid>", async () => {
		const missionDir = await missionInit("auth-refactor", { baseDir });
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		expect(fm.mission_id).toMatch(/^mission-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

// ─── writeFileSync direct manipulation — поддержка existing-mission guard ──

describe("F-10 / дополнительная семантика init", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("повторный init не перетирает содержимое STATE.md, ROADMAP.md, BACKLOG.md, DECISIONS.md", async () => {
		const slug = "auth-refactor";
		const missionDir = await missionInit(slug, { baseDir });

		// Модифицируем файлы (имитация работы итераций).
		const customState = "## Сделано\n- iter 1\n- iter 2\n\n## Блокеры\n\n## Следующие шаги\n- iter 3\n";
		const customRoadmap = "# Roadmap\n\n- [x] Bootstrap mission: auth-refactor\n- [ ] Step 2\n";
		const customBacklog = "# Backlog\n\n| id | date | idea | source | fit | value | risk | cost | score | status |\n";
		const customDecisions = "# Decisions\n\n### dec-001\n- **Date**: 2026-08-10\n- **Status**: accepted\n";

		writeFileSync(join(missionDir, "STATE.md"), customState, "utf8");
		writeFileSync(join(missionDir, "ROADMAP.md"), customRoadmap, "utf8");
		writeFileSync(join(missionDir, "BACKLOG.md"), customBacklog, "utf8");
		writeFileSync(join(missionDir, "DECISIONS.md"), customDecisions, "utf8");

		// Повторный init должен бросить ошибку, не перетирая файлы.
		await expect(missionInit(slug, { baseDir })).rejects.toBeInstanceOf(MissionAlreadyExistsError);

		expect(readFileSync(join(missionDir, "STATE.md"), "utf8")).toBe(customState);
		expect(readFileSync(join(missionDir, "ROADMAP.md"), "utf8")).toBe(customRoadmap);
		expect(readFileSync(join(missionDir, "BACKLOG.md"), "utf8")).toBe(customBacklog);
		expect(readFileSync(join(missionDir, "DECISIONS.md"), "utf8")).toBe(customDecisions);
	});
});

// ─── P-2/P-3: template selection via --template flag ────────────────────────

describe("F-10 / P-2/P-3: --template flag and template selection", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("P-3: initMission(slug, {template:'refactor'}) creates MISSION.md with template: refactor", async () => {
		const missionDir = await missionInit("my-refactor", { baseDir, template: "refactor" });
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		expect(fm.template).toBe("refactor");
		expect(fm.metric_type).toBe("code_complexity_reduction");
	});

	it("P-3: refactor template body contains 'Refactor Mission'", async () => {
		const missionDir = await missionInit("my-refactor", { baseDir, template: "refactor" });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("Refactor Mission: my-refactor");
	});

	it("P-3: default template is used when no template specified", async () => {
		const missionDir = await missionInit("my-default", { baseDir });
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("# Mission: my-default");
		expect(raw).not.toContain("template:");
	});

	it("P-2: handleMissionCommand parses --template <name>", async () => {
		const handled = await handleMissionCommand(["mission", "init", "my-slug", "--template", "refactor"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		const missionDir = join(baseDir, "my-slug");
		expect(existsSync(missionDir)).toBe(true);
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		expect(fm.template).toBe("refactor");
	});

	it("P-2: handleMissionCommand parses --template=<name>", async () => {
		const handled = await handleMissionCommand(["mission", "init", "my-slug", "--template=refactor"], {
			baseDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		const missionDir = join(baseDir, "my-slug");
		const fm = readFrontmatter(readFileSync(join(missionDir, "MISSION.md"), "utf8"));
		expect(fm.template).toBe("refactor");
	});
});

// ─── P-5: missionStart — FSM-переходы в active ─────────────────────────────
// aborted/failed/budget_exhausted/paused → active разрешены (TRANSITIONS в
// extensions/fan-mission/file-state-manager.ts); completed — терминальный.

describe("F-10 / P-5: missionStart переводит миссию в active по FSM", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("start из aborted → writeMissionStatus('active'), вывод содержит 'started'", async () => {
		const missionDir = await missionInit("aborted-test", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1aborted");
		writeFileSync(missionPath, raw, "utf8");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await missionStart(missionDir);

		const fm = readFrontmatter(readFileSync(missionPath, "utf8"));
		expect(fm.status).toBe("active");
		const allLog = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allLog).toContain("started");
	});

	it("handleMissionCommand start на aborted → успех без exit", async () => {
		const missionDir = await missionInit("aborted-dispatch", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1aborted");
		writeFileSync(missionPath, raw, "utf8");

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const handled = await handleMissionCommand(["mission", "start"], {
			baseDir: missionDir,
			isExtensionLoaded: () => true,
		});
		expect(handled).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
		const fm = readFrontmatter(readFileSync(missionPath, "utf8"));
		expect(fm.status).toBe("active");
		const allLog = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allLog).toContain("started");
	});

	it("start из completed + unchecked ROADMAP → реактивация (active)", async () => {
		const missionDir = await missionInit("completed-reactivate", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1completed");
		writeFileSync(missionPath, raw, "utf8");
		// Default ROADMAP has unchecked item → reactivation expected

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await missionStart(missionDir);

		const fm = readFrontmatter(readFileSync(missionPath, "utf8"));
		expect(fm.status).toBe("active");
		const allLog = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allLog).toContain("reactivated");
	});

	it("start из completed без unchecked → подсказка, статус остаётся completed", async () => {
		const missionDir = await missionInit("completed-hint", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1completed");
		writeFileSync(missionPath, raw, "utf8");
		// Set ROADMAP with all items checked
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] done item\n", "utf8");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await missionStart(missionDir);

		const fm = readFrontmatter(readFileSync(missionPath, "utf8"));
		expect(fm.status).toBe("completed");
		const allLog = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allLog).toMatch(/completed/i);
	});

	it("start из active → 'is active', writeMissionStatus НЕ вызвана", async () => {
		const missionDir = await missionInit("active-test", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		const before = readFileSync(missionPath, "utf8");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await missionStart(missionDir);

		const allLog = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allLog).toContain("active");
		expect(allLog).not.toContain("started");
		expect(readFileSync(missionPath, "utf8")).toBe(before);
	});
});

// ─── P-6: pause/stop/resume on failed → InvalidTransitionError, exit 1 ─────

describe("F-10 / P-6: lifecycle on failed mission → exit 1, not unhandled", () => {
	let baseDir: string;
	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("pause on failed mission throws InvalidTransitionError", async () => {
		const missionDir = await missionInit("failed-pause", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1failed");
		writeFileSync(missionPath, raw, "utf8");

		await expect(missionPause(missionDir)).rejects.toBeInstanceOf(InvalidTransitionError);
	});

	it("handleMissionCommand exits 1 on pause of failed mission", async () => {
		const missionDir = await missionInit("failed-dispatch", { baseDir });
		const missionPath = join(missionDir, "MISSION.md");
		let raw = readFileSync(missionPath, "utf8");
		raw = raw.replace(/^(status:\s*).*$/m, "$1failed");
		writeFileSync(missionPath, raw, "utf8");

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await handleMissionCommand(["mission", "pause"], {
				baseDir: missionDir,
				isExtensionLoaded: () => true,
			});
		} catch {
			// expected __exit__
		}
		expect(exitSpy).toHaveBeenCalledWith(1);
		const allErr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allErr.toLowerCase()).toMatch(/invalid|transition|cannot/);
	});
});

// ─── P-7: InvalidTransitionError class exported ─────────────────────────────

describe("F-10 / P-7: InvalidTransitionError class", () => {
	it("is exported with correct name and message", () => {
		const err = new InvalidTransitionError("aborted", "active");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("InvalidTransitionError");
		expect(err.message).toContain("aborted");
		expect(err.message).toContain("active");
		expect(err.from).toBe("aborted");
		expect(err.to).toBe("active");
	});
});
