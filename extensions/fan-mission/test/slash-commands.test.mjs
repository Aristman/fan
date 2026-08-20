// F-11: Slash-команды `/mission:*` — Red-фаза.
//
// Контракт API (по карточке F-11 + спека §3.2.2 I0–I3, §3.2.4, §6.3):
//
//   Регистрация через DI-колбэк (тестируемо без fan.registerCommand):
//
//     registerMissionSlashCommands(register, ctx): void
//
//       register(name, opts) — DI-функция регистрации команды.
//         В проде это обёртка над fan.registerCommand; в тестах
//         мок собирает имя+handler для проверок.
//
//       ctx: MissionSlashContext
//         missionLoop: MissionLoop | null   — активный цикл миссии (для status/start/stop)
//         actions: {
//           sendMessage(message, opts?: { streamingBehavior?: "steer"|"followUp" }): void | Promise<void>
//           abort(): void | Promise<void>                  // I0
//           setDrainAfterCurrentTurn(value: boolean): void // F-06 / I1
//           resume(): void                                 // F-06 resume
//         }
//         output?: (line: string) => void  — вывод статуса (TUI/notify)
//         getStatusSnapshot?: () => Promise<MissionStatusSnapshot>
//
//       MissionStatusSnapshot = {
//         status: MissionStatus,
//         iteration: number,
//         budgetUsed: { tokens: number; usd: number },
//         currentStep: string,
//       }
//
//   Регистрируются 9 команд (спека §6.3 таблица + /mission:init из 0.7.0
//   + /mission:complete — завершение из awaiting_decision):
//     /mission:init    — создание миссии (описание позиционально или диалогами)
//     /mission:start   — запуск контура (MissionLoop.tick() или no-op)
//     /mission:stop    — I0 abort
//     /mission:pause   — I1 drain (setDrainAfterCurrentTurn(true))
//     /mission:resume  — resume drain (setDrainAfterCurrentTurn(false) + resume())
//     /mission:status  — вывод статуса через ctx.output
//     /mission:steer   — I2 sendMessage("...", { streamingBehavior: "steer" })
//     /mission:decide  — I3 sendMessage("...", { streamingBehavior: "followUp" })
//     /mission:complete — завершение из awaiting_decision (дежурство продолжается)
//
// Этап 0: skip реальный fan.registerCommand — только DI-контракт. Это позволяет
// тестировать логику маршрутизации (I0/I1/I2/I3) без зависимости от TUI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, writeMissionStatus } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля, который ещё не существует → ERR_MODULE_NOT_FOUND.
// Все it-блоки должны падать на отсутствии API.
// ────────────────────────────────────────────────────────────────────────────

import { registerMissionSlashCommands } from "../slash-commands.js";

// ────────────────────────────────────────────────────────────────────────────
// DI-хелперы: мок ctx (actions + missionLoop + output + register)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт in-memory missionLoop с минимальным контрактом, который
 * используется slash-командами: tick(), abort(), status().
 * Возвращаемый объект — мок, который можно подменить через overrides.
 */
function makeMockMissionLoop(overrides = {}) {
	const calls = {
		tick: [],
		abort: [],
		status: [],
		resolveDecision: [],
	};
	const mock = {
		_calls: calls,
		async tick() {
			calls.tick.push(Date.now());
			return {
				iteration: 1,
				steps: {
					wake: true, read: true, decide: true,
					iterate: true, verify: true, commit: true, backlog: true,
				},
				status: "active",
			};
		},
		async abort() {
			calls.abort.push(Date.now());
		},
		async status() {
			calls.status.push(Date.now());
			return "active";
		},
		// F-22: resolveDecision called by /mission:decide.
		async resolveDecision(answer) {
			calls.resolveDecision.push({ answer });
		},
		...overrides,
	};
	return mock;
}

/**
 * Создаёт мок ctx.actions с sendMessage/abort/setDrainAfterCurrentTurn/resume.
 * Каждый вызов логируется в `calls` для ассертов.
 */
function makeMockActions(overrides = {}) {
	const calls = {
		sendMessage: [],
		abort: [],
		setDrain: [],
		resume: [],
	};
	return {
		calls,
		async sendMessage(message, opts) {
			calls.sendMessage.push({ message, opts: opts ?? {} });
		},
		async abort() {
			calls.abort.push(Date.now());
		},
		setDrainAfterCurrentTurn(value) {
			calls.setDrain.push(value);
		},
		resume() {
			calls.resume.push(Date.now());
		},
		...overrides,
	};
}

/**
 * Создаёт мок output() — собирает строки в массив для проверок.
 */
function makeMockOutput() {
	const lines = [];
	const fn = (line) => {
		lines.push(String(line));
	};
	fn.lines = lines;
	return fn;
}

/**
 * Создаёт DI-колбэк register, который записывает все зарегистрированные
 * команды в `commands` (Map<name, { description, handler }>) и возвращает
 * функцию-диспетчер dispatch(slashText) для эмуляции пользовательского ввода.
 */
function makeMockRegister() {
	const commands = new Map();
	const register = (name, opts) => {
		commands.set(name, { description: opts.description, handler: opts.handler });
	};

	/**
	 * Парсит "/mission:start" → { name: "mission:start", args: "" }.
	 * Поддерживает аргументы в кавычках: `/mission:steer "msg with spaces"`.
	 */
	function parse(text) {
		const trimmed = text.replace(/^\//, "");
		const spaceIndex = trimmed.indexOf(" ");
		if (spaceIndex === -1) {
			return { name: trimmed, args: "" };
		}
		return { name: trimmed.slice(0, spaceIndex), args: trimmed.slice(spaceIndex + 1) };
	}

	async function dispatch(text, ctx) {
		const { name, args } = parse(text);
		const cmd = commands.get(name);
		if (!cmd) {
			throw new Error(`Unknown command: /${name}`);
		}
		return await cmd.handler(args, ctx);
	}

	return { register, commands, dispatch };
}

/**
 * Полный набор DI-зависимостей для теста. Любую можно переопределить.
 */
function makeCtx(overrides = {}) {
	const actions = makeMockActions();
	const missionLoop = makeMockMissionLoop();
	const output = makeMockOutput();
	const ctx = {
		actions,
		missionLoop,
		output,
		...overrides,
	};
	ctx.actionsCalls = actions.calls;
	return ctx;
}

/**
 * Временный корневой каталог для миссии.
 */
function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f11-red-"));
}

/**
 * Записать готовый ROADMAP.md (одна галочка для старта).
 */
function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F11-1: /mission:stop → actions.abort() + MissionLoop.abort()
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-1: /mission:stop → abort (I0)", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("stop-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-1: команда 'mission:stop' зарегистрирована с handler", () => {
		expect(reg.commands.has("mission:stop")).toBe(true);
		const cmd = reg.commands.get("mission:stop");
		expect(typeof cmd.handler).toBe("function");
		expect(cmd.description).toMatch(/stop|abort|stop/i);
	});

	it("TC-F11-1: /mission:stop → ctx.actions.abort() вызван", async () => {
		await reg.dispatch("/mission:stop", ctx);
		expect(ctx.actionsCalls.abort.length).toBe(1);
	});

	it("TC-F11-1: /mission:stop → missionLoop.abort() тоже вызван (status → aborted)", async () => {
		await reg.dispatch("/mission:stop", ctx);
		expect(ctx.missionLoop._calls.abort.length).toBe(1);
	});

	it("TC-F11-1: /mission:stop → MISSION.md status обновлён на aborted", async () => {
		await reg.dispatch("/mission:stop", ctx);
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*aborted/);
	});

	it("TC-F11-1: /mission:stop выполняется за <1 сек (через F-01 abort)", async () => {
		const t0 = Date.now();
		await reg.dispatch("/mission:stop", ctx);
		const elapsed = Date.now() - t0;
		expect(elapsed).toBeLessThan(1000);
	});

	it("TC-F11-1: /mission:stop без missionLoop → только actions.abort() (no throw)", async () => {
		const ctx2 = makeCtx({ missionLoop: null });
		const reg2 = makeMockRegister();
		registerMissionSlashCommands(reg2.register, ctx2);
		await expect(reg2.dispatch("/mission:stop", ctx2)).resolves.toBeUndefined();
		expect(ctx2.actionsCalls.abort.length).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F11-2: /mission:steer <msg> → sendMessage с streamingBehavior="steer"
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-2: /mission:steer <msg> → steer-очередь (I2)", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("steer-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-2: команда 'mission:steer' зарегистрирована", () => {
		expect(reg.commands.has("mission:steer")).toBe(true);
	});

	it("TC-F11-2: /mission:steer \"msg\" → actions.sendMessage с streamingBehavior=steer", async () => {
		await reg.dispatch('/mission:steer "Сфокусируйся на auth middleware"', ctx);
		expect(ctx.actionsCalls.sendMessage.length).toBe(1);
		const call = ctx.actionsCalls.sendMessage[0];
		expect(call.opts.streamingBehavior).toBe("steer");
		expect(call.message).toMatch(/auth middleware/);
	});

	it("TC-F11-2: /mission:steer без аргументов → сообщение об ошибке или пустой steer", async () => {
		await reg.dispatch("/mission:steer", ctx);
		// Контракт: либо вызов sendMessage с пустым сообщением + warning в output,
		// либо throw. В обоих случаях — НЕ silent fail.
		const totalCalls = ctx.actionsCalls.sendMessage.length;
		const totalOutput = ctx.output.lines.length;
		expect(totalCalls + totalOutput).toBeGreaterThan(0);
	});

	it("TC-F11-2: /mission:steer \"msg with spaces\" — кавычки корректно снимаются", async () => {
		await reg.dispatch('/mission:steer "Use PostgreSQL not MongoDB"', ctx);
		expect(ctx.actionsCalls.sendMessage[0].message).toBe("Use PostgreSQL not MongoDB");
	});

	it("TC-F11-2: /mission:steer 'msg' (одинарные кавычки) тоже работают", async () => {
		await reg.dispatch("/mission:steer 'Focus on tests'", ctx);
		expect(ctx.actionsCalls.sendMessage[0].message).toBe("Focus on tests");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F11-3: /mission:status → вывод статуса
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-3: /mission:status → вывод состояния", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("status-mission", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [x] step 1",
			"- [x] step 2",
			"- [x] step 3",
			"- [x] step 4",
			"- [ ] step 5",
			"",
		]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-3: команда 'mission:status' зарегистрирована", () => {
		expect(reg.commands.has("mission:status")).toBe(true);
	});

	it("TC-F11-3: /mission:status → ctx.output получает строку со статусом", async () => {
		await reg.dispatch("/mission:status", ctx);
		expect(ctx.output.lines.length).toBeGreaterThan(0);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/status/i);
	});

	it("TC-F11-3: /mission:status → выводит номер итерации", async () => {
		await reg.dispatch("/mission:status", ctx);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/iteration|iter/i);
	});

	it("TC-F11-3: /mission:status → выводит расход бюджета (USD/токены)", async () => {
		await reg.dispatch("/mission:status", ctx);
		const text = ctx.output.lines.join("\n");
		// Либо USD, либо токены, либо "budget"
		expect(text).toMatch(/budget|tokens?|usd|\$/i);
	});

	it("TC-F11-3: /mission:status → выводит текущий этап (step)", async () => {
		await reg.dispatch("/mission:status", ctx);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/step|stage|этап/i);
	});

	it("TC-F11-3: /mission:status без missionLoop → output сообщает об отсутствии миссии (no throw)", async () => {
		const ctx2 = makeCtx({ missionLoop: null });
		const reg2 = makeMockRegister();
		registerMissionSlashCommands(reg2.register, ctx2);
		await expect(reg2.dispatch("/mission:status", ctx2)).resolves.toBeUndefined();
		expect(ctx2.output.lines.length).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Дополнительно: /mission:start (tick), /mission:pause (drain),
//                /mission:resume (resume), /mission:decide (followUp)
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-extra: /mission:start → tick", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("start-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-extra: команда 'mission:start' зарегистрирована", () => {
		expect(reg.commands.has("mission:start")).toBe(true);
	});

	it("TC-F11-extra: /mission:start → missionLoop.tick() вызван", async () => {
		await reg.dispatch("/mission:start", ctx);
		expect(ctx.missionLoop._calls.tick.length).toBe(1);
	});

	it("TC-F11-extra: /mission:start без missionLoop → no-op (no throw)", async () => {
		const ctx2 = makeCtx({ missionLoop: null });
		const reg2 = makeMockRegister();
		registerMissionSlashCommands(reg2.register, ctx2);
		await expect(reg2.dispatch("/mission:start", ctx2)).resolves.toBeUndefined();
	});
});

describe("F-11 / TC-F11-extra: /mission:pause → setDrainAfterCurrentTurn(true) (I1)", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("pause-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-extra: команда 'mission:pause' зарегистрирована", () => {
		expect(reg.commands.has("mission:pause")).toBe(true);
	});

	it("TC-F11-extra: /mission:pause → setDrainAfterCurrentTurn(true) вызван", async () => {
		await reg.dispatch("/mission:pause", ctx);
		expect(ctx.actionsCalls.setDrain.length).toBe(1);
		expect(ctx.actionsCalls.setDrain[0]).toBe(true);
	});

	it("TC-F11-extra: /mission:pause → MISSION.md status → paused", async () => {
		await reg.dispatch("/mission:pause", ctx);
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*paused/);
	});
});

describe("F-11 / TC-F11-extra: /mission:resume → resume (drain resume)", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("resume-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-extra: команда 'mission:resume' зарегистрирована", () => {
		expect(reg.commands.has("mission:resume")).toBe(true);
	});

	it("TC-F11-extra: /mission:resume → resume() + setDrainAfterCurrentTurn(false)", async () => {
		await reg.dispatch("/mission:resume", ctx);
		expect(ctx.actionsCalls.resume.length).toBe(1);
		expect(ctx.actionsCalls.setDrain.length).toBe(1);
		expect(ctx.actionsCalls.setDrain[0]).toBe(false);
	});
});

describe("F-11 / TC-F11-extra: /mission:decide <answer> → followUp-очередь (I3)", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F11-extra: команда 'mission:decide' зарегистрирована", () => {
		expect(reg.commands.has("mission:decide")).toBe(true);
	});

	it("TC-F11-extra: /mission:decide \"yes\" → resolveDecision вызван (F-22: proper F-17 transition)", async () => {
		await reg.dispatch('/mission:decide "Да, миграции без изменения схемы"', ctx);
		// F-22: /mission:decide now calls resolveDecision instead of sendMessage.
		expect(ctx.missionLoop._calls.resolveDecision.length).toBe(1);
		expect(ctx.missionLoop._calls.resolveDecision[0].answer).toMatch(/миграции/);
		// sendMessage NOT called (old behavior replaced).
		expect(ctx.actionsCalls.sendMessage.length).toBe(0);
	});

	it("TC-F11-extra: /mission:decide без аргументов → сообщение об ошибке или пустой followUp", async () => {
		await reg.dispatch("/mission:decide", ctx);
		const totalCalls = ctx.actionsCalls.sendMessage.length;
		const totalOutput = ctx.output.lines.length;
		expect(totalCalls + totalOutput).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Регистрация: все 8 команд зарегистрированы за один вызов
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────────
// Lazy-attach (0.6.0): /mission:start|resume|status подхватывают контур в
// запущенной сессии, если session_start не аттачил loop (миссию остановили или
// активировали через CLI после старта fan). DI: ctx.findAttachableMission /
// ctx.attach / ctx.writeStatus (в проде заполняются index.ts).
// ────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-lazy: lazy-attach контура в запущенной сессии", () => {
	let baseDir;
	let missionDir;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("lazy-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] lazy step", ""]);
		reg = makeMockRegister();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	/**
	 * ctx БЕЗ аттаченного loop, но с DI lazy-attach.
	 * foundStatus — статус, который "находит" скан; null — миссий нет.
	 */
	function makeLazyCtx(foundStatus, overrides = {}) {
		const attachCalls = [];
		const writeStatusCalls = [];
		const attachedLoop = makeMockMissionLoop();
		const ctx = makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => (foundStatus ? { missionDir, status: foundStatus } : null),
			attach: (dir) => {
				attachCalls.push(dir);
				ctx.missionLoop = attachedLoop;
				ctx.missionDir = dir;
				return attachedLoop;
			},
			writeStatus: async (dir, status) => {
				writeStatusCalls.push({ dir, status });
			},
			...overrides,
		});
		ctx.attachCalls = attachCalls;
		ctx.writeStatusCalls = writeStatusCalls;
		ctx.attachedLoop = attachedLoop;
		return ctx;
	}

	it("TC-F11-lazy-1: /mission:start без аттача, миссия aborted → writeStatus(active) + attach + tick", async () => {
		const ctx = makeLazyCtx("aborted");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(ctx.writeStatusCalls).toEqual([{ dir: missionDir, status: "active" }]);
		expect(ctx.attachCalls).toEqual([missionDir]);
		expect(ctx.missionLoop).toBe(ctx.attachedLoop);
		expect(ctx.missionDir).toBe(missionDir);
		expect(ctx.attachedLoop._calls.tick.length).toBe(1);
	});

	it("TC-F11-lazy-2: /mission:start без аттача, миссии нет → 'No mission found', attach НЕ вызван", async () => {
		const ctx = makeLazyCtx(null);
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(ctx.attachCalls.length).toBe(0);
		expect(ctx.writeStatusCalls.length).toBe(0);
		expect(ctx.missionLoop).toBeNull();
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("No mission found");
		expect(text).toContain(baseDir); // "No mission found in <cwd>"
		expect(text).toContain("fan mission init");
	});

	it("TC-F11-lazy-3: /mission:status без аттача, миссия active → attach + статус показан", async () => {
		const ctx = makeLazyCtx("active");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:status", ctx);

		expect(ctx.attachCalls).toEqual([missionDir]);
		expect(ctx.writeStatusCalls.length).toBe(0); // read-only: статус не меняем
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/active/);
		expect(text).toMatch(/iteration/i);
	});

	it("TC-F11-lazy-4: /mission:resume без аттача, миссия paused → transition active + attach", async () => {
		const ctx = makeLazyCtx("paused");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:resume", ctx);

		expect(ctx.writeStatusCalls.some((c) => c.dir === missionDir && c.status === "active")).toBe(true);
		expect(ctx.attachCalls).toEqual([missionDir]);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/resumed/i);
	});

	it("TC-F11-lazy-5: /mission:start без аттача, миссия completed + unchecked → writeStatus(active) + attach + tick + reactivated message", async () => {
		const ctx = makeLazyCtx("completed");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(ctx.writeStatusCalls).toEqual([{ dir: missionDir, status: "active" }]);
		expect(ctx.attachCalls).toEqual([missionDir]);
		expect(ctx.missionLoop).toBe(ctx.attachedLoop);
		expect(ctx.missionDir).toBe(missionDir);
		expect(ctx.attachedLoop._calls.tick.length).toBe(1);
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission reactivated — new unchecked items found.");
	});

	it("TC-F11-lazy-5b: /mission:start без аттача, миссия completed без unchecked → подсказка ROADMAP/init, attach НЕ вызван", async () => {
		// ROADMAP with all items checked → no unchecked items
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] done item\n", "utf8");
		const ctx = makeLazyCtx("completed");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(ctx.attachCalls.length).toBe(0);
		expect(ctx.writeStatusCalls.length).toBe(0);
		expect(ctx.missionLoop).toBeNull();
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/completed/i);
		expect(text).toContain("fan mission init");
	});

	it("TC-F11-lazy-6: /mission:resume без аттача, миссия не paused → понятный отказ, attach НЕ вызван", async () => {
		const ctx = makeLazyCtx("aborted");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:resume", ctx);

		expect(ctx.attachCalls.length).toBe(0);
		expect(ctx.writeStatusCalls.length).toBe(0);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/not paused/i);
	});

	it("TC-F11-lazy-7: /mission:status без аттача и без миссии → 'No active mission' (прежнее сообщение)", async () => {
		const ctx = makeLazyCtx(null);
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:status", ctx);

		expect(ctx.attachCalls.length).toBe(0);
		expect(ctx.output.lines.join("\n")).toContain("No active mission");
	});

	it("TC-F11-lazy-8: /mission:start без DI lazy-attach (нет findAttachableMission) → прежний no-op", async () => {
		const ctx = makeCtx({ missionLoop: null });
		registerMissionSlashCommands(reg.register, ctx);
		await expect(reg.dispatch("/mission:start", ctx)).resolves.toBeUndefined();
		expect(ctx.output.lines.length).toBe(0); // no-op без сообщений
	});

	it("TC-F11-lazy-9: /mission:start c аттаченным loop → scan НЕ вызывается (прежнее поведение)", async () => {
		let scanCalls = 0;
		const existingLoop = makeMockMissionLoop();
		const ctx = makeLazyCtx("aborted", {
			missionLoop: existingLoop,
			findAttachableMission: async () => {
				scanCalls += 1;
				return null;
			},
		});
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(scanCalls).toBe(0);
		expect(ctx.attachCalls.length).toBe(0);
		expect(existingLoop._calls.tick.length).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────────
// Терминальный UX (0.6.1): completed-миссия больше не молчит — status показывает
// реальный статус (read-only attach любого статуса), start даёт подсказку
// ROADMAP/init, stop сообщает "already <status>" вместо InvalidTransitionError.
// ────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-terminal-ux: терминальный UX completed-миссии (0.6.1)", () => {
	let baseDir;
	let missionDir;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("terminal-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] done item", ""]);
		reg = makeMockRegister();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	/** ctx БЕЗ аттача со scan-ом, находящим миссию со статусом foundStatus. */
	function makeScanCtx(foundStatus) {
		const attachCalls = [];
		const attachedLoop = makeMockMissionLoop();
		attachedLoop.status = async () => foundStatus;
		const ctx = makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => ({ missionDir, status: foundStatus }),
			attach: (dir) => {
				attachCalls.push(dir);
				ctx.missionLoop = attachedLoop;
				ctx.missionDir = dir;
				return attachedLoop;
			},
		});
		ctx.attachCalls = attachCalls;
		ctx.attachedLoop = attachedLoop;
		return ctx;
	}

	it("TC-F11-term-1: /mission:status без аттача, миссия completed → attach (read-only) + статус показан", async () => {
		const ctx = makeScanCtx("completed");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:status", ctx);

		expect(ctx.attachCalls).toEqual([missionDir]);
		expect(ctx.missionLoop).toBe(ctx.attachedLoop);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/completed/);
		// read-only: MISSION.md не изменён (статус остался active от initMission)
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*active/);
	});

	it("TC-F11-term-2: /mission:start без аттача, completed → подсказка ROADMAP/init, attach НЕ вызван", async () => {
		const ctx = makeScanCtx("completed");
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(ctx.attachCalls.length).toBe(0);
		expect(ctx.missionLoop).toBeNull();
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("terminal-mission"); // slug миссии
		expect(text).toMatch(/completed/i);
		expect(text).toContain("ROADMAP.md");
		expect(text).toContain("/mission:start");
		expect(text).toContain("fan mission init");
	});

	it("TC-F11-term-3: /mission:start аттачен, миссия completed без unchecked → 'tick skipped' + подсказка, tick НЕ вызван", async () => {
		const loop = makeMockMissionLoop();
		loop.status = async () => "completed";
		const ctx = makeCtx({ missionLoop: loop, missionDir });
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(loop._calls.tick.length).toBe(0);
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission is completed — tick skipped.");
		expect(text).toContain("ROADMAP.md");
		expect(text).toContain("fan mission init");
	});

	it("TC-F11-term-3b: /mission:start аттачен, completed + unchecked → writeStatus(active) + tick + reactivated message", async () => {
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] done\n- [ ] new item\n", "utf8");
		const loop = makeMockMissionLoop();
		loop.status = async () => "completed";
		const writeStatusCalls = [];
		const ctx = makeCtx({
			missionLoop: loop,
			missionDir,
			writeStatus: async (dir, status) => {
				writeStatusCalls.push({ dir, status });
			},
		});
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(writeStatusCalls).toEqual([{ dir: missionDir, status: "active" }]);
		expect(loop._calls.tick.length).toBe(1);
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission reactivated — new unchecked items found.");
	});

	it("TC-F11-term-3c: /mission:start без аттача, completed + unchecked → writeStatus(active) + attach + tick", async () => {
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] done\n- [ ] new item\n", "utf8");
		const attachCalls = [];
		const writeStatusCalls = [];
		const attachedLoop = makeMockMissionLoop();
		attachedLoop.status = async () => "completed";
		const ctx = makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => ({ missionDir, status: "completed" }),
			attach: (dir) => {
				attachCalls.push(dir);
				ctx.missionLoop = attachedLoop;
				ctx.missionDir = dir;
				return attachedLoop;
			},
			writeStatus: async (dir, status) => {
				writeStatusCalls.push({ dir, status });
			},
		});
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:start", ctx);

		expect(writeStatusCalls).toEqual([{ dir: missionDir, status: "active" }]);
		expect(attachCalls).toEqual([missionDir]);
		expect(attachedLoop._calls.tick.length).toBe(1);
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission reactivated — new unchecked items found.");
	});

	it("TC-F11-term-4: /mission:stop при completed → 'Mission already completed.', без исключений и FSM-записи", async () => {
		await writeMissionStatus(missionDir, "completed");
		const loop = makeMockMissionLoop();
		loop.status = async () => "completed";
		const ctx = makeCtx({ missionLoop: loop, missionDir });
		registerMissionSlashCommands(reg.register, ctx);
		await expect(reg.dispatch("/mission:stop", ctx)).resolves.toBeUndefined();

		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission already completed.");
		expect(text).not.toMatch(/Invalid status transition/);
		// статус не изменился (FSM completed терминальный)
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*completed/);
	});

	it("TC-F11-term-5: /mission:stop при active → явный фидбек 'Mission stopped (status: aborted).'", async () => {
		const ctx = makeCtx({ missionDir });
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission:stop", ctx);

		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Mission stopped (status: aborted).");
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*aborted/);
	});
});

describe("F-11 / TC-F11-registry: registerMissionSlashCommands регистрирует все 9 команд", () => {
	it("TC-F11-registry: после registerMissionSlashCommands зарегистрированы все 9 команд", () => {
		const ctx = makeCtx();
		const reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);

		const expected = [
			"mission:init",
			"mission:start",
			"mission:stop",
			"mission:pause",
			"mission:resume",
			"mission:status",
			"mission:steer",
			"mission:decide",
			"mission:complete",
			"mission",
			"idea",
			"epic",
		];
		for (const name of expected) {
			expect(reg.commands.has(name), `command ${name} not registered`).toBe(true);
			const cmd = reg.commands.get(name);
			expect(typeof cmd.handler, `command ${name} handler not a function`).toBe("function");
			expect(cmd.description, `command ${name} description empty`).toBeTruthy();
		}
		expect(reg.commands.size).toBe(12);
	});

	it("TC-F11-registry: handler каждой команды принимает args + ctx (async или sync)", async () => {
		const ctx = makeCtx();
		const reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);

		// Sample 1: handler returns Promise<void>
		const stopCmd = reg.commands.get("mission:stop");
		await expect(stopCmd.handler("", ctx)).resolves.toBeUndefined();

		// Sample 2: handler also accepts args
		const steerCmd = reg.commands.get("mission:steer");
		await expect(steerCmd.handler("test msg", ctx)).resolves.toBeUndefined();
	});

	it("TC-F11-registry: register вызывается ровно 9 раз", () => {
		const ctx = makeCtx();
		const calls = [];
		const registerSpy = (name, opts) => {
			calls.push(name);
		};
		registerMissionSlashCommands(registerSpy, ctx);
		expect(calls.length).toBe(12);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Уровни прерываний (спека §3.2.2): правильная маршрутизация I0/I1/I2/I3
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-routing: маршрутизация по уровням прерываний I0–I3", () => {
	let ctx;
	let reg;

	beforeEach(() => {
		ctx = makeCtx();
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	it("TC-F11-routing: I0 stop — НЕ вызывает sendMessage/setDrain", async () => {
		await reg.dispatch("/mission:stop", ctx);
		expect(ctx.actionsCalls.sendMessage.length).toBe(0);
		expect(ctx.actionsCalls.setDrain.length).toBe(0);
	});

	it("TC-F11-routing: I1 pause — вызывает setDrain(true), НЕ abort", async () => {
		await reg.dispatch("/mission:pause", ctx);
		expect(ctx.actionsCalls.setDrain[0]).toBe(true);
		expect(ctx.actionsCalls.abort.length).toBe(0);
	});

	it("TC-F11-routing: I2 steer — вызывает sendMessage(steer), НЕ abort/setDrain", async () => {
		await reg.dispatch('/mission:steer "msg"', ctx);
		expect(ctx.actionsCalls.sendMessage[0].opts.streamingBehavior).toBe("steer");
		expect(ctx.actionsCalls.abort.length).toBe(0);
		expect(ctx.actionsCalls.setDrain.length).toBe(0);
	});

	it("TC-F11-routing: I3 decide — вызывает resolveDecision (F-22), НЕ abort/setDrain/sendMessage", async () => {
		await reg.dispatch('/mission:decide "yes"', ctx);
		// F-22: resolveDecision called instead of sendMessage.
		expect(ctx.missionLoop._calls.resolveDecision.length).toBe(1);
		expect(ctx.actionsCalls.sendMessage.length).toBe(0);
		expect(ctx.actionsCalls.abort.length).toBe(0);
		expect(ctx.actionsCalls.setDrain.length).toBe(0);
	});

	it("TC-F11-routing: status/start — НЕ вызывают abort/sendMessage/setDrain", async () => {
		await reg.dispatch("/mission:start", ctx);
		await reg.dispatch("/mission:status", ctx);
		expect(ctx.actionsCalls.abort.length).toBe(0);
		expect(ctx.actionsCalls.sendMessage.length).toBe(0);
		expect(ctx.actionsCalls.setDrain.length).toBe(0);
	});
});

// ──────────────────────────────────────────────────────────────────────────────────
// 0.7.0: /mission:init <slug> [описание] — создание миссии из сессии.
// Описание позиционально; без него при наличии ctx.ui.input — диалоги
// Goal/Scope/Constraints; без UI (RPC/headless) — миссия без описания.
// ──────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-init: /mission:init <slug> [описание]", () => {
	let baseDir;
	let ctx;
	let reg;

	const missionDirOf = (slug) => join(baseDir, "docs", "missions", slug);

	beforeEach(() => {
		baseDir = freshBaseDir();
		ctx = makeCtx({ cwd: baseDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("команда 'mission:init' зарегистрирована с handler", () => {
		expect(reg.commands.has("mission:init")).toBe(true);
		const cmd = reg.commands.get("mission:init");
		expect(typeof cmd.handler).toBe("function");
		expect(cmd.description).toBeTruthy();
	});

	it("с описанием: миссия создаётся, описание в ## Goal, сообщение про /mission:start", async () => {
		await reg.dispatch("/mission:init my-mission Build the REST API", ctx);
		const missionDir = missionDirOf("my-mission");
		expect(existsSync(join(missionDir, "MISSION.md"))).toBe(true);
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal");
		expect(raw).toContain("Build the REST API");
		expect(ctx.output.lines).toContain(
			`Mission my-mission initialized at ${missionDir}. Start with /mission:start.`,
		);
	});

	it("описание в кавычках снимается", async () => {
		await reg.dispatch('/mission:init qm "Quoted description text"', ctx);
		const raw = readFileSync(join(missionDirOf("qm"), "MISSION.md"), "utf8");
		expect(raw).toContain("Quoted description text");
		expect(raw).not.toContain('"Quoted description text"');
	});

	it("без описания + ctx.ui.input → диалоги Goal/Scope/Constraints", async () => {
		const titles = [];
		ctx.ui = {
			input: async (title) => {
				titles.push(title);
				if (/goal/i.test(title)) return "Ship feature X";
				if (/scope/i.test(title)) return "backend only";
				return ""; // Constraints — пусто
			},
		};
		await reg.dispatch("/mission:init dlg-mission", ctx);
		// Три диалога: Goal, Scope, Constraints
		expect(titles.length).toBe(3);
		const raw = readFileSync(join(missionDirOf("dlg-mission"), "MISSION.md"), "utf8");
		expect(raw).toContain("Ship feature X");
		expect(raw).toContain("Scope: backend only");
		expect(ctx.output.lines.some((l) => l.includes("initialized"))).toBe(true);
	});

	it("отмена диалога Goal → init отменён, миссия не создана", async () => {
		ctx.ui = { input: async () => undefined };
		await reg.dispatch("/mission:init cancel-mission", ctx);
		expect(existsSync(missionDirOf("cancel-mission"))).toBe(false);
		expect(ctx.output.lines.some((l) => /cancelled/i.test(l))).toBe(true);
	});

	it("без описания и без UI → миссия создаётся с пустым Goal (RPC-совместимость)", async () => {
		await reg.dispatch("/mission:init plain-mission", ctx);
		const raw = readFileSync(join(missionDirOf("plain-mission"), "MISSION.md"), "utf8");
		expect(raw).toContain("## Goal\n\n## Scope");
		expect(ctx.output.lines.some((l) => l.includes("initialized"))).toBe(true);
	});

	it("существующая миссия → ошибка через output (already exists)", async () => {
		await initMission("dup-mission", { baseDir: join(baseDir, "docs", "missions") });
		await reg.dispatch("/mission:init dup-mission some description", ctx);
		expect(ctx.output.lines.some((l) => l.startsWith("Error:") && /already exists/.test(l))).toBe(true);
	});

	it("без аргументов → usage-ошибка", async () => {
		await reg.dispatch("/mission:init", ctx);
		expect(ctx.output.lines.some((l) => /usage \/mission:init <slug>/.test(l))).toBe(true);
	});
});

// ──────────────────────────────────────────────────────────────────────────────────
// Space-separated `/mission <subcommand>` dispatcher (Part 1)
// ──────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-space: /mission <subcommand> — space-separated dispatcher", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("space-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step", ""]);
		ctx = makeCtx({ missionDir });
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("команда 'mission' зарегистрирована", () => {
		expect(reg.commands.has("mission")).toBe(true);
	});

	it("bare /mission → выводит help со всеми subcommand'ами", async () => {
		await reg.dispatch("/mission", ctx);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/Usage:\s*\/mission/);
		for (const sub of ["init", "start", "stop", "pause", "resume", "status", "steer", "decide", "complete", "idea", "epic"]) {
			expect(text).toContain(`/mission ${sub}`);
		}
	});

	it("неизвестный subcommand → help + ошибка", async () => {
		await reg.dispatch("/mission unknown", ctx);
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Unknown subcommand: unknown");
		expect(text).toContain("/mission init");
	});

	it("/mission status эквивалентен /mission:status", async () => {
		await reg.dispatch("/mission status", ctx);
		const text = ctx.output.lines.join("\n");
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/active/);
	});

	it("/mission start эквивалентен /mission:start → tick", async () => {
		await reg.dispatch("/mission start", ctx);
		expect(ctx.missionLoop._calls.tick.length).toBe(1);
	});

	it("/mission steer msg эквивалентен /mission:steer msg", async () => {
		await reg.dispatch('/mission steer "focus on auth"', ctx);
		expect(ctx.actionsCalls.sendMessage.length).toBe(1);
		expect(ctx.actionsCalls.sendMessage[0].message).toBe("focus on auth");
	});

	it("/mission init создаёт миссию", async () => {
		const ctx2 = makeCtx({ cwd: baseDir });
		const reg2 = makeMockRegister();
		registerMissionSlashCommands(reg2.register, ctx2);
		await reg2.dispatch("/mission init from-space Build API", ctx2);
		const dir = join(baseDir, "docs", "missions", "from-space");
		expect(existsSync(join(dir, "MISSION.md"))).toBe(true);
		expect(ctx2.output.lines).toContain(`Mission from-space initialized at ${dir}. Start with /mission:start.`);
	});
});

// ──────────────────────────────────────────────────────────────────────────────────
// `/idea <text>` command (Part 2)
// ──────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-idea: /idea <text> — record operator idea", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	function makeIdeaCtx(foundStatus, overrides = {}) {
		return makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => ({ missionDir, status: foundStatus }),
			...overrides,
		});
	}

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("idea-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] done", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("команда 'idea' зарегистрирована", () => {
		ctx = makeIdeaCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		expect(reg.commands.has("idea")).toBe(true);
	});

	it("/idea текст → строка в BACKLOG.md (source=operator, status=IDEA)", async () => {
		ctx = makeIdeaCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/idea Add dark mode", ctx);

		const { readBacklog } = await import("../file-state-manager.js");
		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.idea === "Add dark mode");
		expect(entry).toBeTruthy();
		expect(entry.source).toBe("operator");
		expect(entry.status).toBe("IDEA");
		expect(ctx.output.lines.join("\n")).toContain("Idea recorded.");
	});

	it("completed миссия → /idea реактивирует её в active", async () => {
		await writeMissionStatus(missionDir, "completed");
		ctx = makeIdeaCtx("completed");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/idea Add dark mode", ctx);

		const { readMission } = await import("../file-state-manager.js");
		const mission = await readMission(missionDir);
		expect(mission.frontmatter.status).toBe("active");
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("Idea recorded");
		expect(text).toContain("reactivated");
	});

	it("active миссия → /idea не меняет статус, но записывает идею", async () => {
		ctx = makeIdeaCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/idea Add dark mode", ctx);

		const { readMission, readBacklog } = await import("../file-state-manager.js");
		const mission = await readMission(missionDir);
		expect(mission.frontmatter.status).toBe("active");
		const entries = await readBacklog(missionDir);
		expect(entries.some((e) => e.idea === "Add dark mode" && e.source === "operator")).toBe(true);
	});

	it("нет миссии → понятная ошибка", async () => {
		ctx = makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => null,
		});
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/idea Add dark mode", ctx);
		expect(ctx.output.lines.join("\n")).toContain("No mission found");
	});

	it("/mission idea текст — тот же handler", async () => {
		ctx = makeIdeaCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission idea Add dark mode", ctx);

		const { readBacklog } = await import("../file-state-manager.js");
		const entries = await readBacklog(missionDir);
		expect(entries.some((e) => e.idea === "Add dark mode" && e.source === "operator")).toBe(true);
	});
});

// ──────────────────────────────────────────────────────────────────────────────────
// `/epic <text>` command (Part 3) — [EPIC]-пункт в ROADMAP.md (триггер декомпозиции)
// ──────────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-epic: /epic <text> — add EPIC item to ROADMAP", () => {
	let baseDir;
	let missionDir;
	let ctx;
	let reg;

	function makeEpicCtx(foundStatus, overrides = {}) {
		return makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => ({ missionDir, status: foundStatus }),
			...overrides,
		});
	}

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("epic-mission", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] done", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("команда 'epic' зарегистрирована", () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		expect(reg.commands.has("epic")).toBe(true);
	});

	it("/epic текст → строка '- [ ] [EPIC] текст' в ROADMAP.md", async () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic Implement auth module", ctx);

		const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(raw).toContain("- [ ] [EPIC] Implement auth module");
		expect(ctx.output.lines.join("\n")).toContain("EPIC added to ROADMAP.");
	});

	it("completed миссия → /epic реактивирует её в active", async () => {
		await writeMissionStatus(missionDir, "completed");
		ctx = makeEpicCtx("completed");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic Implement auth module", ctx);

		const { readMission } = await import("../file-state-manager.js");
		const mission = await readMission(missionDir);
		expect(mission.frontmatter.status).toBe("active");
		const text = ctx.output.lines.join("\n");
		expect(text).toContain("EPIC added to ROADMAP");
		expect(text).toContain("reactivated");
	});

	it("active миссия → /epic не меняет статус, но добавляет пункт", async () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic Implement auth module", ctx);

		const { readMission } = await import("../file-state-manager.js");
		const mission = await readMission(missionDir);
		expect(mission.frontmatter.status).toBe("active");
		const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(raw).toContain("- [ ] [EPIC] Implement auth module");
		expect(ctx.output.lines.join("\n")).not.toContain("reactivated");
	});

	it("нет миссии → понятная ошибка", async () => {
		ctx = makeCtx({
			missionLoop: null,
			missionDir: undefined,
			cwd: baseDir,
			findAttachableMission: async () => null,
		});
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic Implement auth module", ctx);
		expect(ctx.output.lines.join("\n")).toContain("No mission found");
	});

	it("/epic без текста → usage-ошибка", async () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic", ctx);
		expect(ctx.output.lines.join("\n")).toContain("usage /epic <text>");
		const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(raw).not.toContain("[EPIC]");
	});

	it("UTF-8 и пробелы: /epic Реализовать X (подзадача 1; подзадача 2) → точная строка", async () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/epic Реализовать X (подзадача 1; подзадача 2)", ctx);

		const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(raw).toContain("- [ ] [EPIC] Реализовать X (подзадача 1; подзадача 2)");
	});

	it("/mission epic текст — тот же handler", async () => {
		ctx = makeEpicCtx("active");
		reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);
		await reg.dispatch("/mission epic Implement auth module", ctx);

		const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(raw).toContain("- [ ] [EPIC] Implement auth module");
		expect(ctx.output.lines.join("\n")).toContain("EPIC added to ROADMAP.");
	});
});
