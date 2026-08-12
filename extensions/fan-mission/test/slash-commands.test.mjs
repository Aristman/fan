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
//   Регистрируются 7 команд (спека §6.3 таблица):
//     /mission:start   — запуск контура (MissionLoop.tick() или no-op)
//     /mission:stop    — I0 abort
//     /mission:pause   — I1 drain (setDrainAfterCurrentTurn(true))
//     /mission:resume  — resume drain (setDrainAfterCurrentTurn(false) + resume())
//     /mission:status  — вывод статуса через ctx.output
//     /mission:steer   — I2 sendMessage("...", { streamingBehavior: "steer" })
//     /mission:decide  — I3 sendMessage("...", { streamingBehavior: "followUp" })
//
// Этап 0: skip реальный fan.registerCommand — только DI-контракт. Это позволяет
// тестировать логику маршрутизации (I0/I1/I2/I3) без зависимости от TUI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";

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

	it("TC-F11-extra: /mission:decide \"yes\" → sendMessage с streamingBehavior=followUp", async () => {
		await reg.dispatch('/mission:decide "Да, миграции без изменения схемы"', ctx);
		expect(ctx.actionsCalls.sendMessage.length).toBe(1);
		const call = ctx.actionsCalls.sendMessage[0];
		expect(call.opts.streamingBehavior).toBe("followUp");
		expect(call.message).toMatch(/миграции/);
	});

	it("TC-F11-extra: /mission:decide без аргументов → сообщение об ошибке или пустой followUp", async () => {
		await reg.dispatch("/mission:decide", ctx);
		const totalCalls = ctx.actionsCalls.sendMessage.length;
		const totalOutput = ctx.output.lines.length;
		expect(totalCalls + totalOutput).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Регистрация: все 7 команд зарегистрированы за один вызов
// ────────────────────────────────────────────────────────────────────────────

describe("F-11 / TC-F11-registry: registerMissionSlashCommands регистрирует все 7 команд", () => {
	it("TC-F11-registry: после registerMissionSlashCommands зарегистрированы все 7 команд", () => {
		const ctx = makeCtx();
		const reg = makeMockRegister();
		registerMissionSlashCommands(reg.register, ctx);

		const expected = [
			"mission:start",
			"mission:stop",
			"mission:pause",
			"mission:resume",
			"mission:status",
			"mission:steer",
			"mission:decide",
		];
		for (const name of expected) {
			expect(reg.commands.has(name), `command ${name} not registered`).toBe(true);
			const cmd = reg.commands.get(name);
			expect(typeof cmd.handler, `command ${name} handler not a function`).toBe("function");
			expect(cmd.description, `command ${name} description empty`).toBeTruthy();
		}
		expect(reg.commands.size).toBe(7);
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

	it("TC-F11-registry: register вызывается ровно 7 раз", () => {
		const ctx = makeCtx();
		const calls = [];
		const registerSpy = (name, opts) => {
			calls.push(name);
		};
		registerMissionSlashCommands(registerSpy, ctx);
		expect(calls.length).toBe(7);
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

	it("TC-F11-routing: I3 decide — вызывает sendMessage(followUp), НЕ abort/setDrain", async () => {
		await reg.dispatch('/mission:decide "yes"', ctx);
		expect(ctx.actionsCalls.sendMessage[0].opts.streamingBehavior).toBe("followUp");
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
