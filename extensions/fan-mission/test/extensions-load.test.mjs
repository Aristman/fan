// F-LOAD: Интеграционный тест загрузки всех трёх entry-points (fan-mission,
// fan-scheduler, fan-webhook) — validation/Green-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-11..§F-14
//
// Цель: доказать, что все три entry-point корректны для FAN loader и совместимы
// друг с другом:
//   • default export каждой — функция (ExtensionFactory);
//   • три фабрики вызываются на ОДНОМ общем mock fan без конфликтов;
//   • хуки session_start/session_shutdown регистрируются всеми тремя
//     (множественная подписка на одно событие допустима);
//   • команды /mission:* уникальны (нет дублей имён);
//   • shortcut f9 зарегистрирован;
//   • полный lifecycle (session_start → session_shutdown) не падает и чистит
//     ресурсы (scheduler interval, webhook-сервер, mission loop).
//
// Это validation-тест (Green): модули уже реализованы, тест должен PASS сразу.
// Продакшен-код НЕ меняется — только тест.
//
// ─── Как loader находит эти entry-points ─────────────────────────────────────
// loader.ts → resolveExtensionEntries(dir):
//   1) package.json с полем "fan.extensions" (массив путей) — НЕТ в этих пакетах
//      (у них "fan" несёт только store-метаданные: name/type/displayName/tags);
//   2) fallback на index.ts (предпочтительно) или index.js в каталоге расширения.
// Значит index.ts fallback ДОСТАТОЧЕН: "fan"-поле в package.json не обязано
// перечислять пути — loader сам находит index.ts. Тест импортирует именно так,
// как loader (default export): ../index.js, ../../fan-scheduler/index.js,
// ../../fan-webhook/index.js (Vite резолвит .js → .ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";

// ─── Динамический импорт трёх entry-points (как делает loader: default export) ──

let missionFactory;
let schedulerFactory;
let webhookFactory;

beforeAll(async () => {
	const [missionMod, schedulerMod, webhookMod] = await Promise.all([
		import("../index.js"),
		import("../../fan-scheduler/index.js"),
		import("../../fan-webhook/index.js"),
	]);
	missionFactory = missionMod.default;
	schedulerFactory = schedulerMod.default;
	webhookFactory = webhookMod.default;
});

// ─── Общий mock fan (разделённый event bus, поддерживает множественную подписку) ──
//
// Контракт (по задаче): { on, registerCommand, registerShortcut, registerTool,
//   sendUserMessage, sendMessage, appendEntry, getCustomEntries,
//   events:{on,off,emit}, exec } — vi.fn() + записи в Map.
//
// Ключевое отличие от test/index-wiring.test.mjs: top-level on() хранит МАССИВ
// хендлеров на событие (три фабрики подписываются на одно и то же
// session_start/session_shutdown). _emit() await-ит ВСЕ хендлеры по порядку —
// именно так ведёт себя реальный EventBus loader'а при множественной подписке.

function makeSharedMockFan(overrides = {}) {
	// Топ-level event bus: event -> handler[] (множественная подписка!)
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		if (!hooks.has(event)) hooks.set(event, []);
		hooks.get(event).push(handler);
	});

	// Отдельный events-bus (mission-widget uiEvents: on/off/emit).
	const eventsBus = new Map();
	const eventsOn = vi.fn((name, handler) => {
		if (!eventsBus.has(name)) eventsBus.set(name, []);
		eventsBus.get(name).push(handler);
	});
	const eventsOff = vi.fn((name, handler) => {
		const arr = eventsBus.get(name);
		if (arr) {
			const idx = arr.indexOf(handler);
			if (idx >= 0) arr.splice(idx, 1);
		}
	});
	const eventsEmit = vi.fn(async (name, ...args) => {
		const arr = eventsBus.get(name) ?? [];
		for (const h of arr) await h(...args);
	});

	const commands = new Map();
	const registerCommand = vi.fn((name, def) => {
		commands.set(name, def);
	});

	const shortcuts = new Map();
	const registerShortcut = vi.fn((key, def) => {
		shortcuts.set(key, def);
	});

	return {
		on,
		registerCommand,
		registerShortcut,
		registerTool: vi.fn(),
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getCustomEntries: vi.fn(() => []),
		events: { on: eventsOn, off: eventsOff, emit: eventsEmit },
		exec: vi.fn(),
		_hooks: hooks,
		_commands: commands,
		_shortcuts: shortcuts,
		_eventsBus: eventsBus,
		/** Эмит: вызывает ВСЕ зарегистрированные хуки по порядку и await-ит каждый. */
		async _emit(event, ...args) {
			const arr = hooks.get(event) ?? [];
			for (const h of arr) {
				await h(...args);
			}
		},
		...overrides,
	};
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────
//
// beforeEach: свежий mock fan + вызов всех трёх фабрик подряд (как loader).
//   missionFactory возвращает wiring-handle — сохраняем для inspections.
// afterEach: гарантированный session_shutdown (чистит scheduler interval и
//   webhook-порт, если session_start эмитился) + rm tempdir. Хуки shutdown
//   идемпотентны — повторный вызов безопасен даже без предшествующего start.
//
// Webhook: default-фабрика на session_start пытается bind 9090; если порт занят
// (EADDRINUSE) — фабрика глотает ошибку (try/catch + console.warn), поэтому
// эмит session_start детерминированно не падает. session_shutdown → wiring.stop()
// → server.close() освобождает порт. Это и есть "обрабатывай EADDRINUSE gracefully"
// (вариант b) — реальный сервер поднимать не требуется, доказывается совместимость.

let fan;
let tempDir;
let missionHandle;

beforeEach(() => {
	fan = makeSharedMockFan();
	tempDir = mkdtempSync(join(tmpdir(), "fan-load-"));
	// Вызов всех трёх фабрик на одном mock fan (как делает loader). Ни одна не бросает.
	missionHandle = missionFactory(fan);
	schedulerFactory(fan);
	webhookFactory(fan);
});

afterEach(async () => {
	try {
		// Идемпотентный shutdown: чистит scheduler interval / webhook-порт / mission loop.
		await fan._emit("session_shutdown", { type: "session_shutdown" });
	} catch {
		// best-effort cleanup — не валидируем в teardown
	}
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

// ─── TC-1: все три entry-point экспортируют default-функцию (ExtensionFactory) ──

describe("F-LOAD / TC-1: default export каждой — функция (ExtensionFactory)", () => {
	it("TC-1a: fan-mission default export — функция", () => {
		expect(typeof missionFactory).toBe("function");
	});

	it("TC-1b: fan-scheduler default export — функция", () => {
		expect(typeof schedulerFactory).toBe("function");
	});

	it("TC-1c: fan-webhook default export — функция", () => {
		expect(typeof webhookFactory).toBe("function");
	});
});

// ─── TC-2: три фабрики на одном mock fan — совместимость (ни одна не бросает) ──

describe("F-LOAD / TC-2: три фабрики на одном mock fan — совместимость", () => {
	it("TC-2a: вызов всех трёх фабрик подряд не бросает и каждая что-то регистрирует", () => {
		// beforeEach уже вызвал все три; если бы бросили — beforeEach упал бы до теста.
		// Проверяем побочные эффекты: fan.on (6 хуков = 2×3), ≥8 команд, ≥1 shortcut,
		// fan.events.on (mission-widget подписывается на mission_iteration_end).
		expect(fan.on).toHaveBeenCalled();
		expect(fan.on.mock.calls.length).toBeGreaterThanOrEqual(6); // 2 хука × 3 фабрики
		expect(fan.registerCommand.mock.calls.length).toBeGreaterThanOrEqual(8);
		expect(fan.registerShortcut.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(fan.events.on).toHaveBeenCalled(); // mission-widget uiEvents
	});

	it("TC-2b: fan-mission factory возвращает wiring-handle (attach/getMissionLoop/shutdown)", () => {
		expect(missionHandle).toBeDefined();
		expect(typeof missionHandle.attachMission).toBe("function");
		expect(typeof missionHandle.getMissionLoop).toBe("function");
		expect(typeof missionHandle.shutdown).toBe("function");
	});
});

// ─── TC-3: хуки session_start/session_shutdown — по подписчику от каждой фабрики ──

describe("F-LOAD / TC-3: хуки lifecycle — множественная подписка (3×session_start, 3×session_shutdown)", () => {
	it("TC-3a: session_start — ровно 3 подписчика (по одному от каждой фабрики)", () => {
		const subs = fan._hooks.get("session_start") ?? [];
		expect(subs.length).toBe(3);

		const startCalls = fan.on.mock.calls.filter((c) => c[0] === "session_start");
		expect(startCalls.length).toBe(3);
		expect(startCalls.every((c) => typeof c[1] === "function")).toBe(true);
	});

	it("TC-3b: session_shutdown — ровно 3 подписчика (по одному от каждой фабрики)", () => {
		const subs = fan._hooks.get("session_shutdown") ?? [];
		expect(subs.length).toBe(3);

		const stopCalls = fan.on.mock.calls.filter((c) => c[0] === "session_shutdown");
		expect(stopCalls.length).toBe(3);
		expect(stopCalls.every((c) => typeof c[1] === "function")).toBe(true);
	});
});

// ─── TC-4: ≥8 команд /mission:* (от fan-mission), все имена уникальны ──────────

describe("F-LOAD / TC-4: команды /mission:* — ≥9, без дублей", () => {
	const EXPECTED_COMMANDS = [
		"mission:init",
		"mission:start",
		"mission:stop",
		"mission:status",
		"mission:pause",
		"mission:resume",
		"mission:steer",
		"mission:decide",
		"mission:complete",
		"idea",
		"mission",
	];

	it("TC-4a: зарегистрированы все 9 команд /mission:* с handler+description", () => {
		for (const name of EXPECTED_COMMANDS) {
			expect(fan._commands.has(name), `command ${name} not registered`).toBe(true);
			const cmd = fan._commands.get(name);
			expect(typeof cmd.handler, `${name} handler not a function`).toBe("function");
			expect(cmd.description, `${name} description empty`).toBeTruthy();
		}
		// Суммарно ≥9 команд /mission:* (по контракту задачи).
		const missionCmds = [...fan._commands.keys()].filter((n) => n.startsWith("mission:"));
		expect(missionCmds.length).toBeGreaterThanOrEqual(9);
	});

	it("TC-4b: нет дублей команд — каждое имя registerCommand уникально", () => {
		const names = fan.registerCommand.mock.calls.map((c) => c[0]);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length); // ни одно имя не перезаписало другое
		expect(names.length).toBe(11); // 9 /mission:* + /idea + /mission dispatcher
	});
});

// ─── TC-5: shortcut f9 (виджет миссии) ─────────────────────────────────────────

describe("F-LOAD / TC-5: shortcut f9", () => {
	it("TC-5: зарегистрирован shortcut 'f9' с handler и description", () => {
		expect(fan.registerShortcut).toHaveBeenCalledWith("f9", expect.any(Object));
		expect(fan._shortcuts.has("f9")).toBe(true);

		const def = fan._shortcuts.get("f9");
		expect(typeof def.handler).toBe("function");
		expect(def.description).toBeTruthy();
		expect(def.description).toMatch(/toggle|widget|виджет|миссия|status/i);
	});
});

// ─── TC-6: lifecycle session_start → session_shutdown на общем fan ────────────
//
// session_start с mock ctx (tempdir БЕЗ миссии): fan-mission no-op (миссии нет →
// getMissionLoop() null); scheduler стартует (setInterval 5 мин — не успевает
// тикнуть); webhook пытается bind 9090 (EADDRINUSE глотается). session_shutdown
// вызывает stop() у всех трёх — cleanup без падения.

describe("F-LOAD / TC-6: lifecycle session_start → session_shutdown на общем fan", () => {
	it("TC-6a: session_start с mock ctx (tempdir без миссии) не бросает", async () => {
		const ctx = {
			cwd: tempDir,
			hasUI: true,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
		await expect(
			fan._emit("session_start", { type: "session_start", cwd: tempDir }, ctx),
		).resolves.toBeUndefined();
	});

	it("TC-6b: session_start без миссии → fan-mission no-op (getMissionLoop() null)", async () => {
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: tempDir },
			{ cwd: tempDir, hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } },
		);
		// Миссии в tempDir нет → findActiveMissionDir вернул null → attachMission не звался.
		expect(missionHandle.getMissionLoop()).toBeNull();
	});

	it("TC-6c: session_shutdown после session_start не бросает и чистит ресурсы", async () => {
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: tempDir },
			{ cwd: tempDir, hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } },
		);
		await expect(fan._emit("session_shutdown", { type: "session_shutdown" })).resolves.toBeUndefined();
		// mission loop остался null (его и не было) — shutdown идемпотентен.
		expect(missionHandle.getMissionLoop()).toBeNull();
	});
});

// ─── TC-7: отсутствие конфликтов — повторный lifecycle, двойная подписка, уникальность ──

describe("F-LOAD / TC-7: отсутствие конфликтов (двойная подписка, повторный lifecycle)", () => {
	it("TC-7a: нет дублей команд с одинаковым именем — каждая команда уникальна", () => {
		// Дубль проявился бы как перезапись в Map (commands.size < calls.length).
		// Проверяем: размер Map === числу вызовов registerCommand (никто не перезаписан).
		const calls = fan.registerCommand.mock.calls.length;
		expect(fan._commands.size).toBe(calls);
		expect(calls).toBe(11);
	});

	it("TC-7b: повторный session_start + session_shutdown не падает (идемпотентность, нет конфликта подписок)", async () => {
		const ctx = { cwd: tempDir, hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } };

		// Первый цикл lifecycle.
		await expect(
			fan._emit("session_start", { type: "session_start", cwd: tempDir }, ctx),
		).resolves.toBeUndefined();
		await expect(fan._emit("session_shutdown", { type: "session_shutdown" })).resolves.toBeUndefined();

		// Второй цикл: 3 подписчика на session_start снова отрабатывают без падения
		// (scheduler re-start после stop создаёт новый interval; webhook re-bind после
		// stop; mission shutdown→null уже был no-op). Двойная подписка на одно событие
		// не даёт конфликта — все хуки изолированы внутри своих wiring-ов.
		await expect(
			fan._emit("session_start", { type: "session_start", cwd: tempDir }, ctx),
		).resolves.toBeUndefined();
		await expect(fan._emit("session_shutdown", { type: "session_shutdown" })).resolves.toBeUndefined();
	});
});

// ─── TC-8: lazy-attach (0.6.0) — миссия появилась после session_start ────────────
//
// session_start не аттачил контур (миссии не было); затем в cwd появляется миссия
// (fan mission init / CLI). /mission:status аттачит loop лениво — без рестарта fan.
// Команда read-only (tick не запускается) — безопасно на общем mock fan трёх фабрик.

describe("F-LOAD / TC-8: lazy-attach — миссия появилась после session_start", () => {
	it("TC-8: session_start без миссии → init → /mission:status → loop аттачен (без рестарта)", async () => {
		const ctx = {
			cwd: tempDir,
			hasUI: true,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
		await fan._emit("session_start", { type: "session_start", cwd: tempDir }, ctx);
		expect(missionHandle.getMissionLoop()).toBeNull();

		// Миссия появляется в cwd после session_start.
		const missionDir = await initMission("load-lazy", { baseDir: join(tempDir, "docs", "missions") });
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] step\n", "utf8");

		// /mission:status — ленивый аттач (read-only, без tick).
		const statusCmd = fan._commands.get("mission:status");
		expect(statusCmd).toBeDefined();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let statusCalls;
		try {
			await statusCmd.handler("");
			statusCalls = [...logSpy.mock.calls]; // снять ДО mockRestore (он чистит mock.calls)
		} finally {
			logSpy.mockRestore();
		}

		expect(missionHandle.getMissionLoop()).not.toBeNull();
		const text = statusCalls.map((c) => c.join(" ")).join("\n");
		expect(text).toMatch(/status/i);
	});
});
