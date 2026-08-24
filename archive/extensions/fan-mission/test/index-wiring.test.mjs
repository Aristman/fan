// F-MISSION-INDEX: Расширение fan-mission — entry-point (index.ts) wiring — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-11/§F-12
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2 (I0–I3), §3.2.4, §6.3, §6.4
//
// ─── Точные контракты (прочитаны из исходников) ─────────────────────────────
//
// registerMissionSlashCommands(register, registrationCtx: SlashCtx): void
//   (extensions/fan-mission/slash-commands.ts)
//   • SlashCtx = {
//       actions: SlashCtxActions;           // обязательное
//       missionLoop?: MissionLoop | null;   // активный цикл (lazy: устанавливается в attachMission)
//       output: (line: string) => void;    // обязательное
//       missionDir?: string;
//       getStatusSnapshot?: () => Promise<MissionStatusSnapshot>;
//     }
//   • SlashCtxActions = {
//       sendMessage(text, opts?: { streamingBehavior?: "steer" | "followUp" }): void | Promise<void>;
//       abort(): void | Promise<void>;                       // I0
//       setDrainAfterCurrentTurn(value: boolean): void;       // I1 drain
//       resume(): void;                                       // resume
//     }
//   • SlashCommandRegister = (name: string, cmd: { description: string; handler: (args, ctx) => Promise<void> }) => void
//   • Регистрирует ровно 8 команд: mission:init, mission:start, mission:stop, mission:status,
//     mission:pause, mission:resume, mission:steer, mission:decide
//
// registerMissionWidget(args: MissionWidgetArgs): void
//   (extensions/fan-mission/mission-widget.ts)
//   • MissionWidgetArgs = {
//       registerShortcut: (key, def) => void;     // DI: обёртка над fan.registerShortcut
//       ui: { render(lines: string[]): void; toggle(key: string): void };
//       missionLoop?: MissionLoop | null;
//       missionDir?: string;
//       uiEvents: { on(name, handler): void; off(name, handler): void };
//       getStatusSnapshot?: () => Promise<MissionStatusSnapshot>;
//     }
//   • Регистрирует шорткат "f9" (description: "Toggle mission status widget (виджет миссии)")
//
// new MissionLoop(opts): MissionLoop
//   (extensions/fan-mission/mission-loop.ts)
//   • opts = { missionDir: string; deps: MissionLoopDeps; drainFlag?; decideTimeoutMs?; ... }
//   • MissionLoopDeps = { executor: MissionExecutor; git: MissionGit; clock: MissionClock; lock?: MissionLock }
//   • MissionClock = { now(): Date | Promise<Date> }
//   • метод status(): Promise<MissionStatus> — читает MISSION.md frontmatter.status (строка)
//     ("active"|"paused"|"completed"|"aborted"|"failed"|"budget_exhausted"|"awaiting_decision")
//   • конструктор НЕ вызывает executor/git — только tick() делает это; значит attachMission
//     может создать MissionLoop даже с mock/undefined-deps без副作用.
//
// createSessionExecutor({ runAgent }): MissionExecutor
//   (extensions/fan-mission/session-executor.ts) — реализован (Green)
//   • runAgent: (prompt, opts?: { cwd?; steer? }) => Promise<{ response; costTokens?; costUsd? }>
//
// createGitAdapter(opts?: { exec? }): MissionGit  — реализован (Green)
//
// initMission(slug, opts?: { baseDir?; template? }): Promise<string>  — реализован (Green)
//   • возвращает missionDir; idempotent; дефолтный MISSION.md status: "active"
//
// ─── Контракт entry-point index.ts (для Green-фазы) ──────────────────────────
//
//   export function wireMission(fan, opts?): {
//     attachMission(missionDir): MissionLoop;   // создаёт MissionLoop с production-deps:
//                                               //   executor = createSessionExecutor({ runAgent: opts.runAgent ?? fan.runAgent })
//                                               //   git = createGitAdapter()
//                                               //   clock = { now: () => new Date() }
//                                               //   lock = default (createFileLock)
//                                               // сохраняет + возвращает missionLoop
//     getMissionLoop(): MissionLoop | null;
//     shutdown(): void;                         // missionLoop.abort() + очистка stored handle
//   }
//   opts.runAgent? — DI для executor (чтобы тесты не использовали реальный LLM).
//
//   export default function(fan): wiring-handle
//     — фабрика расширения:
//       1. wireMission(fan) → handle (ленивый missionLoop, устанавливается в attachMission);
//       2. registerMissionSlashCommands((name, def) => fan.registerCommand(name, def), sharedCtx)
//          где sharedCtx.missionLoop лениво резолвится из handle.getMissionLoop();
//       3. registerMissionWidget({ registerShortcut: (k,d)=>fan.registerShortcut(k,d), ui, uiEvents, ... });
//       4. fan.on("session_start", (event, ctx) => { определить missionDir из ctx.cwd
//          (сканировать <cwd>/docs/missions/ на предмет каталога с MISSION.md не-терминального
//          статуса) → если найден: handle.attachMission(missionDir) });
//       5. fan.on("session_shutdown", () => handle.shutdown());
//       Возвращает wiring-handle (minor deviation от `: void` — нужно, чтобы session_start
//       hook был тестируем через handle.getMissionLoop(); см. ambiguity-решения ниже).
//
// ─── Ambiguity-решения (зафиксированы в тесте) ───────────────────────────────
//
// 1. Default-фабрика ВОЗВРАЩАЕТ wiring-handle (а не void) — единственный способ
//    наблюдать побочный эффект session_start hook (getMissionLoop() не null) без
//    внешнего side-effect. Разумное отклонение от контракта `: void`.
// 2. session_start handler signature: (event, ctx) — читает ctx.cwd (cwd также
//    продублирован в event-пayload для устойчивости). Сканирует <cwd>/docs/missions/
//    на предмет подкаталога с MISSION.md не-терминального статуса (active/paused/
//    awaiting_decision); первый найденный → attachMission. Нет миссии → no-op
//    (getMissionLoop() остаётся null, без throw, без авто-создания миссии).
// 3. attachMission ИДЕМПОТЕНТЕН для того же missionDir — повторный вызов с тем же
//    путём возвращает тот же экземпляр MissionLoop (без двойного wiring/shutdown).
// 4. shutdown() вызывает missionLoop.abort() и очищает stored handle →
//    getMissionLoop() возвращает null. shutdown() идемпотентен.
// 5. Mock fan включает runAgent (mock) — дефолтная фабрика использует его как
//    runAgent для executor в session_start→attachMission (без него контур не сможет
//    тикать на проде). Тесты TC-3..6 передают runAgent явно через opts.runAgent (DI).
//
// ─── Этап 0 (Red) ────────────────────────────────────────────────────────────
// Модуль `extensions/fan-mission/index.ts` ещё не существует → динамический import
// в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит его, символы
// (wireMission, factory) остаются undefined. Каждый it падает ИНДИВИДУАЛЬНО на
// вызове undefined-функции (правильный TDD Red: тесты запускаются и падают, а не
// «файл не загрузился»). Существующие тесты fan-mission (503) НЕ затронуты —
// отдельный файл, импортирует уже реализованные модули.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readMission, writeMissionStatus } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Динамический import SUT (index.ts → index.js через Vite-резолв .js→.ts).
// На Red-фазе модуля нет → ERR_MODULE_NOT_FOUND → catch → символы undefined.
// ────────────────────────────────────────────────────────────────────────────

let wireMission;
let factory;
let findAttachableMission;

beforeAll(async () => {
	try {
		const mod = await import("../index.js");
		wireMission = mod.wireMission;
		factory = mod.default;
		findAttachableMission = mod.findAttachableMission;
	} catch {
		// Red: index.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Mock fan-объект: on() записывает хуки в Map (для эмуляции через _emit),
// registerCommand/registerShortcut пишут в Map для инспекции, sendUserMessage —
// vi.fn() для assertions, events.{on,off} — vi.fn() (для mission-widget uiEvents),
// appendEntry/getCustomEntries — vi.fn(). Добавлен runAgent (mock) для дефолтной
// фабрики (см. ambiguity-решение №5).
// ────────────────────────────────────────────────────────────────────────────

function makeMockFan(overrides = {}) {
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		hooks.set(event, handler);
	});

	const commands = new Map();
	const registerCommand = vi.fn((name, def) => {
		commands.set(name, def);
	});

	const shortcuts = new Map();
	const registerShortcut = vi.fn((key, def) => {
		shortcuts.set(key, def);
	});

	const sendUserMessage = vi.fn();
	const eventsOn = vi.fn();
	const eventsOff = vi.fn();
	const appendEntry = vi.fn();
	const getCustomEntries = vi.fn(() => []);

	// Mock runAgent (НЕ реальный LLM). Дефолтная фабрика использует его для executor.
	const runAgent = vi.fn().mockResolvedValue({
		response: "<promise>COMPLETE</promise>",
		costTokens: 10,
		costUsd: 0.01,
	});

	return {
		on,
		registerCommand,
		registerShortcut,
		sendUserMessage,
		events: { on: eventsOn, off: eventsOff },
		appendEntry,
		getCustomEntries,
		runAgent,
		_hooks: hooks,
		_commands: commands,
		_shortcuts: shortcuts,
		/** Эмит событие: вызывает зарегистрированный хук и await-ит его. */
		async _emit(event, ...args) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(...args);
			}
		},
		...overrides,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Хелпер: реальная миссия во временном каталоге через initMission.
// Создаёт <baseDir>/docs/missions/<slug>/ с MISSION.md (status: active) + ROADMAP.md.
// Это нужно, чтобы: (а) attachMission(missionDir) имел валидный MISSION.md для
// status(); (б) factory session_start нашёл миссию, сканируя <cwd>/docs/missions/.
// ────────────────────────────────────────────────────────────────────────────

async function makeTempMission(slug = "wiring-mission") {
	const baseDir = mkdtempSync(join(tmpdir(), "fan-mission-idx-"));
	const missionDir = await initMission(slug, { baseDir: join(baseDir, "docs", "missions") });
	writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] wiring step\n", "utf8");
	return { baseDir, missionDir };
}

/** Пустой временный каталог (без docs/missions) — для TC-8 (session_start без миссии). */
function makeEmptyTempDir() {
	return mkdtempSync(join(tmpdir(), "fan-mission-idx-empty-"));
}

// ────────────────────────────────────────────────────────────────────────────
// Cleanup: гарантированный shutdown запущенных wiring-ов + rm tempdir-ов.
// shutdown() идемпотентен — повторный вызов безопасен.
// ────────────────────────────────────────────────────────────────────────────

const liveWirings = [];
const liveTempDirs = [];

afterEach(async () => {
	while (liveWirings.length > 0) {
		const w = liveWirings.pop();
		try {
			await w.shutdown();
		} catch {
			// ignore — тест уже упал или wiring уже остановлен
		}
	}
	while (liveTempDirs.length > 0) {
		const d = liveTempDirs.pop();
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

// ────────────────────────────────────────────────────────────────────────────
// TC-1: factory(fan) — фабрика не бросает, регистрирует хуки session_start /
// session_shutdown и ≥8 slash-команд /mission:* через fan.registerCommand.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-1: фабрика (default export) — регистрация", () => {
	it("TC-1a: factory(fan) не бросает", () => {
		const fan = makeMockFan();
		expect(() => factory(fan)).not.toThrow();
	});

	it("TC-1b: factory регистрирует хуки session_start и session_shutdown через fan.on(...)", () => {
		const fan = makeMockFan();
		factory(fan);

		expect(fan.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(fan.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("TC-1c: factory регистрирует ровно 8 slash-команд /mission:* через fan.registerCommand", () => {
		const fan = makeMockFan();
		factory(fan);

		const expected = [
			"mission:init",
			"mission:start",
			"mission:stop",
			"mission:status",
			"mission:pause",
			"mission:resume",
			"mission:steer",
			"mission:decide",
		];
		for (const name of expected) {
			expect(fan._commands.has(name), `command ${name} not registered`).toBe(true);
			const cmd = fan._commands.get(name);
			expect(typeof cmd.handler, `command ${name} handler not a function`).toBe("function");
			expect(cmd.description, `command ${name} description empty`).toBeTruthy();
		}
		expect(fan.registerCommand.mock.calls.length).toBeGreaterThanOrEqual(8);
	});

	it("TC-1c: каждая зарегистрированная /mission:* команда имеет handler(args, ctx) → Promise<void>", async () => {
		const fan = makeMockFan();
		factory(fan);

		const stopCmd = fan._commands.get("mission:stop");
		// handler принимает (args, ctx) и возвращает Promise (async или sync — await-safe)
		await expect(stopCmd.handler("", { actions: {}, output: () => {} })).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-2: factory(fan) регистрирует виджет-shortcut "f9" через fan.registerShortcut.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-2: фабрика регистрирует виджет-shortcut", () => {
	it("TC-2: factory регистрирует shortcut 'f9' через fan.registerShortcut", () => {
		const fan = makeMockFan();
		factory(fan);

		expect(fan.registerShortcut).toHaveBeenCalledWith("f9", expect.any(Object));
		expect(fan._shortcuts.has("f9")).toBe(true);

		const def = fan._shortcuts.get("f9");
		expect(typeof def.handler).toBe("function");
		expect(def.description).toBeTruthy();
		expect(def.description).toMatch(/toggle|widget|виджет|миссия|status/i);
	});

	it("TC-2: fan.events.on используется для подписки виджета на mission_iteration_end", () => {
		const fan = makeMockFan();
		factory(fan);

		// mission-widget подписывается на 'mission_iteration_end' через uiEvents.on
		// (фабрика прокидывает fan.events как uiEvents)
		expect(fan.events.on).toHaveBeenCalled();
		const subscribeCalls = fan.events.on.mock.calls.filter((c) => c[0] === "mission_iteration_end");
		expect(subscribeCalls.length).toBeGreaterThanOrEqual(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-3: wireMission(fan, {runAgent}).attachMission(tempMissionDir) возвращает
// MissionLoop (не null); getMissionLoop() возвращает тот же инстанс.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-3: wireMission — attachMission возвращает MissionLoop", () => {
	it("TC-3: attachMission(missionDir) возвращает не-null; getMissionLoop() === тот же инстанс", async () => {
		const { baseDir, missionDir } = await makeTempMission("attach-mission");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });
		liveWirings.push(wiring);

		const loop = wiring.attachMission(missionDir);
		expect(loop).toBeDefined();
		expect(loop).not.toBeNull();
		expect(typeof loop.tick).toBe("function");
		expect(typeof loop.status).toBe("function");
		expect(typeof loop.abort).toBe("function");

		// Тот же инстанс хранится и доступен через getMissionLoop()
		expect(wiring.getMissionLoop()).toBe(loop);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-4: созданный MissionLoop использует injected runAgent как executor —
// attachMission с mockRunAgent создаёт рабочий missionLoop (status() → строка).
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-4: executor обёрнут из injected runAgent", () => {
	it("TC-4: attachMission с mockRunAgent → missionLoop.status() возвращает строку ('active')", async () => {
		const { baseDir, missionDir } = await makeTempMission("status-mission");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });
		liveWirings.push(wiring);

		const loop = wiring.attachMission(missionDir);

		// status() читает MISSION.md frontmatter.status (не вызывает executor) → "active"
		const status = await loop.status();
		expect(typeof status).toBe("string");
		expect(status).toBe("active");

		// missionLoop создан (executor не вызывался до tick) — runAgent не должен
		// вызываться без tick
		expect(mockRunAgent).not.toHaveBeenCalled();
	});

	it("TC-4: production-deps собраны — git=createGitAdapter, clock={now}, executor из runAgent (не бросает)", async () => {
		const { baseDir, missionDir } = await makeTempMission("deps-mission");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });
		liveWirings.push(wiring);

		// attachMission не бросает — значит production-deps (git, clock, executor) собраны
		const loop = wiring.attachMission(missionDir);
		expect(loop).toBeDefined();
		expect(wiring.getMissionLoop()).toBe(loop);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-5: повторный attachMission с тем же missionDir → идемпотентен (тот же инстанс).
// Зафиксировано разумное поведение: attachMission идемпотентен для того же пути
// (не пересоздаёт loop, не вызывает shutdown предыдущего).
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-5: повторный attachMission — идемпотентность", () => {
	it("TC-5: повторный attachMission(same dir) возвращает тот же инстанс MissionLoop", async () => {
		const { baseDir, missionDir } = await makeTempMission("idempotent-mission");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });
		liveWirings.push(wiring);

		const loop1 = wiring.attachMission(missionDir);
		const loop2 = wiring.attachMission(missionDir);

		// Идемпотентен: тот же инстанс (нет двойного wiring)
		expect(loop2).toBe(loop1);
		expect(wiring.getMissionLoop()).toBe(loop1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-6: shutdown() после attachMission → getMissionLoop() возвращает null.
// Зафиксировано: shutdown() abort-ит loop + очищает stored handle → null.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-6: shutdown() очищает missionLoop", () => {
	it("TC-6: после attachMission → shutdown() → getMissionLoop() === null", async () => {
		const { baseDir, missionDir } = await makeTempMission("shutdown-mission");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });
		// НЕ кладём в liveWirings — shutdown вызывается явно в тесте

		const loop = wiring.attachMission(missionDir);
		expect(wiring.getMissionLoop()).toBe(loop);

		await wiring.shutdown();

		// handle очищен → getMissionLoop() null (не aborted-инстанс)
		expect(wiring.getMissionLoop()).toBeNull();
	});

	it("TC-6: shutdown() идемпотентен — повторный вызов не бросает", async () => {
		const { baseDir, missionDir } = await makeTempMission("shutdown-idempotent");
		liveTempDirs.push(baseDir);

		const mockRunAgent = vi.fn().mockResolvedValue({
			response: "<promise>COMPLETE</promise>",
			costTokens: 10,
			costUsd: 0.01,
		});
		const fan = makeMockFan();
		const wiring = wireMission(fan, { runAgent: mockRunAgent });

		wiring.attachMission(missionDir);
		await wiring.shutdown();
		await expect(wiring.shutdown()).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-7: Default-фабрика — session_start hook с mock ctx (cwd=tempdir где есть
// миссия) → attachMission вызывается (getMissionLoop не null).
// Миссия инициализирована реальным initMission в <tempdir>/docs/missions/<slug>.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-7: session_start с активной миссией в cwd", () => {
	it("TC-7: session_start (cwd с миссией) → getMissionLoop() не null (attachMission вызван)", async () => {
		const { baseDir, missionDir } = await makeTempMission("autostart-mission");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);
		expect(handle).toBeDefined();
		expect(typeof handle.getMissionLoop).toBe("function");

		// mock ctx для session_start: cwd=tempdir с миссией, hasUI=true
		// cwd продублирован в event-payload и в ctx (ambiguity-решение №2)
		const sessionCtx = {
			cwd: baseDir,
			hasUI: true,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, sessionCtx);

		// attachMission вызван → missionLoop создан и сохранён
		const loop = handle.getMissionLoop();
		expect(loop).not.toBeNull();
		expect(typeof loop.status).toBe("function");

		// status() работает (читает MISSION.md → "active")
		const status = await loop.status();
		expect(status).toBe("active");
	});

	it("TC-7: найденная миссия — тот же каталог, что initMission создал (missionDir совпадает)", async () => {
		const { baseDir, missionDir } = await makeTempMission("autostart-path");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);

		// missionLoop создан для найденного missionDir — status() читает именно его
		const loop = handle.getMissionLoop();
		expect(loop).not.toBeNull();
		// Если status() возвращает "active" — значит MISSION.md найден в missionDir
		const status = await loop.status();
		expect(status).toBe("active");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-8: session_start с cwd БЕЗ миссии → getMissionLoop() null (не падает,
// не создаёт миссию автоматически).
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-8: session_start без миссии в cwd", () => {
	it("TC-8: session_start (cwd без docs/missions) → getMissionLoop() null, не бросает", async () => {
		const emptyDir = makeEmptyTempDir();
		liveTempDirs.push(emptyDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// session_start с cwd без миссии — НЕ должен бросать
		await expect(
			fan._emit(
				"session_start",
				{ type: "session_start", cwd: emptyDir },
				{ cwd: emptyDir, hasUI: true, ui: {} },
			),
		).resolves.toBeUndefined();

		// Нет миссии → attachMission не вызван → getMissionLoop() null
		expect(handle.getMissionLoop()).toBeNull();
	});

	it("TC-8: session_start без миссии не создаёт файлов миссии автоматически", async () => {
		const emptyDir = makeEmptyTempDir();
		liveTempDirs.push(emptyDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: emptyDir },
			{ cwd: emptyDir, hasUI: true, ui: {} },
		);

		// Никакой миссии не должно быть создано автоматически
		expect(handle.getMissionLoop()).toBeNull();
		// Страховка: repeat emit тоже не падает
		await expect(
			fan._emit(
				"session_start",
				{ type: "session_start", cwd: emptyDir },
				{ cwd: emptyDir, hasUI: true, ui: {} },
			),
		).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-9 (lifecycle): session_shutdown hook вызывает shutdown → getMissionLoop() null.
// Сценарий: factory(fan) → session_start (attach) → session_shutdown (shutdown) → null.
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-9: lifecycle через хуки factory", () => {
	it("TC-9: session_shutdown хук вызывает shutdown — getMissionLoop() → null", async () => {
		const { baseDir } = await makeTempMission("lifecycle-mission");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		// НЕ кладём в liveWirings — shutdown через session_shutdown hook

		// session_start → attach (миссия найдена)
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		// session_shutdown → shutdown
		await fan._emit("session_shutdown", { type: "session_shutdown" });

		// handle очищен
		expect(handle.getMissionLoop()).toBeNull();
	});

	it("TC-9: session_shutdown без предшествующего session_start — не бросает (no-op)", async () => {
		const fan = makeMockFan();
		factory(fan);

		// shutdown без attach — идемпотентен, не бросает
		await expect(
			fan._emit("session_shutdown", { type: "session_shutdown" }),
		).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────────
// TC-10 (lazy-attach 0.6.0): session_start не аттачил loop (миссии не было или
// статус терминальный для session_start) — /mission:status|start лениво аттачат
// контур без рестарта fan. Скан — реальный findAttachableMission, FSM — реальный
// writeMissionStatus, attach — реальный wiring.attachMission (тот же мост ТИКЕТ-14).
// ────────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-10: lazy-attach в запущенной сессии", () => {
	it("TC-10a: /mission:status — миссия появилась после session_start → lazy-attach + статус", async () => {
		const emptyDir = makeEmptyTempDir();
		liveTempDirs.push(emptyDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// session_start: миссии ещё нет → loop не аттачен.
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: emptyDir },
			{ cwd: emptyDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).toBeNull();

		// Миссия "появляется" в cwd (например, fan mission init в другом терминале).
		const missionDir = await initMission("lazy-status", { baseDir: join(emptyDir, "docs", "missions") });
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] lazy step\n", "utf8");

		// /mission:status лениво аттачит loop (read-only) и показывает статус.
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

		expect(handle.getMissionLoop()).not.toBeNull();
		const text = statusCalls.map((c) => c.join(" ")).join("\n");
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/active/);
		expect(text).toMatch(/iteration/i);
	});

	it("TC-10b: /mission:start — миссия aborted на момент session_start → FSM-переход + attach + tick", async () => {
		const { baseDir, missionDir } = await makeTempMission("lazy-start");
		liveTempDirs.push(baseDir);
		// Миссия остановлена ДО старта fan (например, /mission:stop в прошлой сессии).
		await writeMissionStatus(missionDir, "aborted");

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// session_start: aborted не не-терминальный → НЕ аттачится (прежнее поведение).
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).toBeNull();

		// /mission:start → scan → aborted → writeMissionStatus(active) → attach → tick.
		// tick внутри ждёт дефолтный runAgent (mock fan без agent_end) — проверяем
		// побочные эффекты асинхронно, затем осаживаем через shutdown.
		const startCmd = fan._commands.get("mission:start");
		expect(startCmd).toBeDefined();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const tickPromise = startCmd.handler("");
		try {
			for (let i = 0; i < 200 && handle.getMissionLoop() === null; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(handle.getMissionLoop()).not.toBeNull();
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("active");
		} finally {
			logSpy.mockRestore();
		}

		// Осадить контур: shutdown() settle-ит waiter дефолтного runAgent (FAILED-тег)
		// и abort-ит loop → незавершённый tick разворачивается, guarded глотает ошибку.
		await handle.shutdown();
		await tickPromise;
		expect(handle.getMissionLoop()).toBeNull();
	});

	it("TC-10c: /mission:start без миссий в cwd → 'No mission found', loop не создаётся", async () => {
		const emptyDir = makeEmptyTempDir();
		liveTempDirs.push(emptyDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: emptyDir },
			{ cwd: emptyDir, hasUI: true, ui: {} },
		);

		const startCmd = fan._commands.get("mission:start");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let startCalls;
		try {
			await startCmd.handler("");
			startCalls = [...logSpy.mock.calls]; // снять ДО mockRestore (он чистит mock.calls)
		} finally {
			logSpy.mockRestore();
		}

		expect(handle.getMissionLoop()).toBeNull();
		const text = startCalls.map((c) => c.join(" ")).join("\n");
		expect(text).toContain("No mission found");
		expect(text).toContain(emptyDir);
		expect(text).toContain("fan mission init");
	});

	it("TC-10d: findAttachableMission — пустой cwd → null; aborted находит; completed находит (0.6.1)", async () => {
		expect(typeof findAttachableMission).toBe("function");

		const emptyDir = makeEmptyTempDir();
		liveTempDirs.push(emptyDir);
		expect(await findAttachableMission(emptyDir)).toBeNull();

		const { baseDir, missionDir } = await makeTempMission("scan-mission");
		liveTempDirs.push(baseDir);

		// active — найдена (дефолтный accept)
		let found = await findAttachableMission(baseDir);
		expect(found).not.toBeNull();
		expect(found.missionDir).toBe(missionDir);
		expect(found.status).toBe("active");

		// aborted — тоже найдена (lazy-attach: start/resume сами делают переход)
		await writeMissionStatus(missionDir, "aborted");
		found = await findAttachableMission(baseDir);
		expect(found).not.toBeNull();
		expect(found.status).toBe("aborted");

		// completed — дефолтный accept (0.6.1) НАХОДИТ: скан видит ЛЮБУЮ миссию,
		// политика переходов/attach — на уровне обработчиков команд
		await writeMissionStatus(missionDir, "active");
		await writeMissionStatus(missionDir, "completed");
		found = await findAttachableMission(baseDir);
		expect(found).not.toBeNull();
		expect(found.status).toBe("completed");

		// фильтр session_start (не-терминальные) — completed не проходит
		const nonTerminal = (s) => ["active", "paused", "awaiting_decision"].includes(s);
		expect(await findAttachableMission(baseDir, nonTerminal)).toBeNull();
	});

	it("TC-10e: session_start на completed-миссии → НЕ аттачится (регрессия TC-10b); status — read-only attach", async () => {
		const { baseDir, missionDir } = await makeTempMission("completed-start");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "completed");

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// session_start: completed — терминальный для auto-attach → loop НЕ создан.
		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).toBeNull();

		// /mission:status: lazy-attach read-only для completed → реальный статус показан.
		const statusCmd = fan._commands.get("mission:status");
		expect(statusCmd).toBeDefined();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let statusCalls;
		try {
			await statusCmd.handler("");
			statusCalls = [...logSpy.mock.calls];
		} finally {
			logSpy.mockRestore();
		}

		expect(handle.getMissionLoop()).not.toBeNull();
		const text = statusCalls.map((c) => c.join(" ")).join("\n");
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/completed/);

		// read-only: статус миссии не изменился.
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("completed");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-11: батчинг вывода slash-команд (0.6.2) — обёртка registerCommand собирает
// строки output() в буфер и делает ОДИН ctx.ui.notify (TUI showStatus заменяет
// предыдущий статус, построчный notify потерял бы все строки, кроме последней).
// Без UI — fallback построчно в console.log (прежнее поведение, TC-10 зелёные).
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-11: батчинг вывода в ctx.ui.notify", () => {
	it("TC-11a: handler с cmdCtx.ui.notify → ОДИН notify со склеенным текстом, console.log НЕ вызван", async () => {
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// Команда без миссии: /mission:stop без аттача выводит ровно 1 строку,
		// /mission:status — "No active mission". Берём stop (детерминированно).
		const stopCmd = fan._commands.get("mission:stop");
		expect(stopCmd).toBeDefined();

		const notify = vi.fn();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let logCalls;
		try {
			await stopCmd.handler("", { ui: { notify } });
			logCalls = [...logSpy.mock.calls]; // снять ДО mockRestore (он чистит mock.calls)
		} finally {
			logSpy.mockRestore();
		}

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("No active mission to stop — nothing attached.", "info");
		expect(logCalls).toHaveLength(0);
	});

	it("TC-11b: многострочный вывод склеивается в один notify (батчинг, не построчно)", async () => {
		const { baseDir, missionDir } = await makeTempMission("notify-batch");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "completed");

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// session_start: completed — терминальный для auto-attach → НЕ аттачится.
		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, { cwd: baseDir });

		// /mission:start на completed → 1 строка-подсказка (без attach). Для
		// многострочного кейса используем status: lazy-attach read-only + 4 строки.
		const statusCmd = fan._commands.get("mission:status");
		const notify = vi.fn();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let logCalls;
		try {
			await statusCmd.handler("", { ui: { notify } });
			logCalls = [...logSpy.mock.calls];
		} finally {
			logSpy.mockRestore();
		}

		expect(notify).toHaveBeenCalledTimes(1);
		const [text, type] = notify.mock.calls[0];
		expect(type).toBe("info");
		// 4 строки статуса склеены переводами строк в ОДНО сообщение.
		expect(text.split("\n").length).toBeGreaterThanOrEqual(3);
		expect(text).toMatch(/status/i);
		expect(text).toMatch(/completed/);
		expect(logCalls).toHaveLength(0);
	});

	it("TC-11c: строка 'Error: ...' в выводе → notify с типом 'error'", async () => {
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		// /mission:steer без аргумента — детерминированная usage-ошибка,
		// не требует миссии: 'Error: usage /mission:steer "<message>"'.
		const steerCmd = fan._commands.get("mission:steer");
		expect(steerCmd).toBeDefined();

		const notify = vi.fn();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let logCalls;
		try {
			await steerCmd.handler("", { ui: { notify } });
			logCalls = [...logSpy.mock.calls];
		} finally {
			logSpy.mockRestore();
		}

		expect(notify).toHaveBeenCalledTimes(1);
		const [text, type] = notify.mock.calls[0];
		expect(type).toBe("error");
		expect(text).toContain("Error: usage /mission:steer");
		expect(logCalls).toHaveLength(0);
	});

	it("TC-11d: без cmdCtx (fallback) — построчный console.log, notify не вызывается", async () => {
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		const stopCmd = fan._commands.get("mission:stop");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let logCalls;
		try {
			await stopCmd.handler("");
			logCalls = [...logSpy.mock.calls]; // снять ДО mockRestore (он чистит mock.calls)
		} finally {
			logSpy.mockRestore();
		}

		expect(logCalls).toEqual([["No active mission to stop — nothing attached."]]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F12: F-MISSION-DUTY — completed-миссия с RECURRING.md дежурит после рестарта
// ────────────────────────────────────────────────────────────────────────────

describe("F-MISSION-INDEX / TC-F12: session_start аттачит completed-миссии на дежурство", () => {
	it("TC-F12a: active → аттачится как раньше", async () => {
		const { baseDir, missionDir } = await makeTempMission("duty-active");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, { cwd: baseDir, ui: {} });

		expect(handle.getMissionLoop()).not.toBeNull();
		const status = await handle.getMissionLoop().status();
		expect(status).toBe("active");
	});

	it("TC-F12b: completed + RECURRING-пункт → loop аттачен (duty)", async () => {
		const { baseDir, missionDir } = await makeTempMission("duty-completed");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "completed");
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n\n- [ ] Check inbox (interval: 30m)\n",
			"utf8",
		);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, { cwd: baseDir, ui: {} });

		expect(handle.getMissionLoop()).not.toBeNull();
		const status = await handle.getMissionLoop().status();
		expect(status).toBe("completed");
	});

	it("TC-F12c: completed БЕЗ RECURRING-пунктов → НЕ аттачится", async () => {
		const { baseDir, missionDir } = await makeTempMission("duty-completed-no-recur");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "completed");

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, { cwd: baseDir, ui: {} });

		expect(handle.getMissionLoop()).toBeNull();
	});

	it("TC-F12d: приоритет — не-терминальная миссия выше completed-duty", async () => {
		const { baseDir, missionDir } = await makeTempMission("duty-active-priority");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "completed");
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n\n- [ ] Check inbox (interval: 30m)\n",
			"utf8",
		);

		// Вторая миссия — active, должна быть выбрана первой
		const activeDir = await initMission("duty-real-active", { baseDir: join(baseDir, "docs", "missions") });
		writeFileSync(join(activeDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] active step\n", "utf8");

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit("session_start", { type: "session_start", cwd: baseDir }, { cwd: baseDir, ui: {} });

		const loop = handle.getMissionLoop();
		expect(loop).not.toBeNull();
		const status = await loop.status();
		expect(status).toBe("active");
	});
});
