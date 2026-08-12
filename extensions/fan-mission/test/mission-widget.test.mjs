// F-12: TUI-виджет статуса миссии — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-12
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4, §6.4 (UI)
//
// Контракт API (по карточке F-12 + по образцу fan-orchestrator extension.js:
//
//   registerMissionWidget(args): void
//
//     args: {
//       registerShortcut: (key, def) => void       — DI: в проде обёртка над fan.registerShortcut,
//                                                   в тестах мок собирает handler.
//       ui: {
//         render(lines: string[]): void            — UI-сторона: функция рендера,
//                                                   принимает массив строк (любого формата).
//         toggle(key: 'M'): void                   — UI-сторона: контроллер,
//                                                   переключает видимость виджета.
//       },
//       missionLoop: MissionLoop                   — активный цикл миссии (status()/snapshot).
//       missionDir?: string                        — путь к каталогу миссии (опционально).
//       uiEvents: UIEventEmitter                   — event emitter (on/emit/off) —
//                                                   подписка на mission_iteration_end и др.
//       getStatusSnapshot?: () => Promise<MissionStatusSnapshot>
//                                                  — поставщик снимка статуса
//                                                   (snapshot → данные рендера).
//     }
//
// Поведение (TC-F12-1..3 + критерии приёмки):
//   - При активной миссии + Alt+M → render(lines) содержит
//       «Статус: ● активна │ Итерация: N │ Расход: $X.XX / $Y.YY»
//     (поля могут быть в одной строке или на нескольких —
//      контракт покрывает оба варианта через contains-ассерты).
//   - При отсутствии активной миссии → render([]) (auto-hide).
//   - Событие `mission_iteration_end` → render обновляется (счётчик итерации++,
//     расход обновляется).
//   - Alt+M переключает видимость; toggle-состояние персистится внутри модуля.
//
// Этап 0: skip реальный fan.registerShortcut — только DI-контракт (как slash-commands).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля, который ещё не существует → ERR_MODULE_NOT_FOUND.
//
// Используем dynamic import в beforeAll, чтобы каждая it()-проверка получала
// свою собственную ошибку (vitest отчитывается по N it-блокам, а не как
// одиночный failed-suite с "no tests").
// ────────────────────────────────────────────────────────────────────────────

let registerMissionWidget;

async function importMissionWidget() {
	if (!registerMissionWidget) {
		const mod = await import("../mission-widget.js");
		registerMissionWidget = mod.registerMissionWidget;
	}
	return registerMissionWidget;
}

// ────────────────────────────────────────────────────────────────────────────
// DI-хелперы
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory UIEventEmitter с логированием подписок.
 * API: on(name, handler) / off(name, handler) / emit(name, payload).
 * Поведение `emit` — синхронный вызов handler'ов (без Promise).
 */
function makeMockUIEventEmitter() {
	const handlers = new Map(); // name → handler[]
	const calls = { on: [], off: [], emit: [] };
	const emitter = {
		calls,
		on(name, handler) {
			calls.on.push({ name, handler });
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		off(name, handler) {
			calls.off.push({ name, handler });
			const list = handlers.get(name) ?? [];
			const idx = list.indexOf(handler);
			if (idx >= 0) list.splice(idx, 1);
			handlers.set(name, list);
		},
		emit(name, payload) {
			calls.emit.push({ name, payload });
			const list = handlers.get(name) ?? [];
			for (const h of list) {
				h(payload);
			}
		},
		// тестовый хелпер: вызвать handler напрямую (без записи в calls.emit)
		__fire(name, payload) {
			const list = handlers.get(name) ?? [];
			for (const h of list) h(payload);
		},
		// тестовый хелпер: сколько handler'ов на событии
		__listenerCount(name) {
			return (handlers.get(name) ?? []).length;
		},
	};
	return emitter;
}

/**
 * Mock UI controller: render + toggle. Логирует все вызовы.
 */
function makeMockUI() {
	const calls = { render: [], toggle: [] };
	const ui = {
		calls,
		render(lines) {
			calls.render.push([...lines]);
		},
		toggle(key) {
			calls.toggle.push(key);
		},
	};
	return ui;
}

/**
 * DI: registerShortcut — собирает все зарегистрированные шорткаты.
 */
function makeMockRegisterShortcut() {
	const shortcuts = new Map();
	const register = (key, def) => {
		shortcuts.set(key, { description: def.description, handler: def.handler });
	};
	return { register, shortcuts };
}

/**
 * MissionLoop mock с методами status/tick/abort и _calls.
 */
function makeMockMissionLoop(overrides = {}) {
	const calls = { tick: [], abort: [], status: [] };
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
 * Default snapshot для активной миссии (5-я итерация, $3.45 / $10.00).
 */
function makeSnapshot(overrides = {}) {
	return {
		status: "active",
		iteration: 5,
		budgetUsed: { tokens: 1200, usd: 3.45 },
		budgetTokens: 5000,
		budgetUsd: 10.0,
		currentStep: "iterate",
		...overrides,
	};
}

/**
 * Полный набор DI-зависимостей для виджета.
 */
function makeWidgetCtx(overrides = {}) {
	const registerShortcut = makeMockRegisterShortcut();
	const ui = makeMockUI();
	const uiEvents = makeMockUIEventEmitter();
	const missionLoop = makeMockMissionLoop();
	const getStatusSnapshot = vi.fn(async () => makeSnapshot());

	const args = {
		registerShortcut: registerShortcut.register,
		ui,
		missionLoop,
		uiEvents,
		getStatusSnapshot,
		...overrides,
	};
	// accessors for tests
	args._registerShortcut = registerShortcut;
	args._ui = ui;
	args._uiEvents = uiEvents;
	args._missionLoop = missionLoop;
	return args;
}

/**
 * Временный корневой каталог для миссии (нужен для missionDir в некоторых TC).
 */
function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f12-red-"));
}

/**
 * Render all lines concatenated — для contains-ассертов.
 */
function flatten(lines) {
	return (lines ?? []).join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Module structure (smoke tests)
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-module: registerMissionWidget API contract", () => {
	beforeEach(async () => {
		await importMissionWidget();
	});

	it("TC-F12-module: registerMissionWidget экспортируется как функция", () => {
		expect(typeof registerMissionWidget).toBe("function");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F12-1: виджет отображается при активной миссии (Alt+M toggles)
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-1: виджет отображается при активной миссии", () => {
	let ctx;
	let widgetCtx;

	beforeEach(async () => {
		await importMissionWidget();
		widgetCtx = makeWidgetCtx();
		registerMissionWidget(widgetCtx);
		ctx = widgetCtx;
	});

	it("TC-F12-1: зарегистрирован шорткат 'alt+m'", () => {
		expect(ctx._registerShortcut.shortcuts.has("alt+m")).toBe(true);
	});

	it("TC-F12-1: описание шортката 'alt+m' содержит 'toggle' / 'widget' / 'миссия'", () => {
		const def = ctx._registerShortcut.shortcuts.get("alt+m");
		expect(def.description).toBeTruthy();
		expect(def.description).toMatch(/toggle|widget|виджет|миссия|status/i);
	});

	it("TC-F12-1: handler шортката 'alt+m' — функция", () => {
		const def = ctx._registerShortcut.shortcuts.get("alt+m");
		expect(typeof def.handler).toBe("function");
	});

	it("TC-F12-1: подписка на uiEvents.on('mission_iteration_end', ...) выполнена", () => {
		const subs = ctx._uiEvents.calls.on.filter((c) => c.name === "mission_iteration_end");
		expect(subs.length).toBeGreaterThanOrEqual(1);
	});

	it("TC-F12-1: при активной миссии render вызван хотя бы один раз (после Alt+M)", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // вызов Alt+M handler с UI
		expect(ctx._ui.calls.render.length).toBeGreaterThan(0);
	});

	it("TC-F12-1: render содержит 'Статус:' с активной иконкой '●'", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // 1st: render(empty), toggle→visible
		await handler(ctx.ui); // 2nd: render(data), toggle→hidden
		const text = flatten(ctx._ui.calls.render.at(-1));
		expect(text).toMatch(/статус:/i);
		expect(text).toMatch(/●/);
	});

	it("TC-F12-1: render содержит 'Итерация: 5' (5-я итерация из snapshot)", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // 1st: render(empty), toggle→visible
		await handler(ctx.ui); // 2nd: render(data), toggle→hidden
		const text = flatten(ctx._ui.calls.render.at(-1));
		expect(text).toMatch(/итерация:\s*5/i);
	});

	it("TC-F12-1: render содержит 'Расход: $3.45 / $10.00'", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // 1st: render(empty), toggle→visible
		await handler(ctx.ui); // 2nd: render(data), toggle→hidden
		const text = flatten(ctx._ui.calls.render.at(-1));
		expect(text).toMatch(/расход:/i);
		expect(text).toMatch(/3\.45/);
		expect(text).toMatch(/10\.00/);
		// обе суммы (использовано / всего) присутствуют с разделителем
		expect(text).toMatch(/3\.45.*10\.00|10\.00.*3\.45/s);
	});

	it("TC-F12-1: render содержит объединённую compact-строку со всеми полями (одна из строк)", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // 1st: render(empty), toggle→visible
		await handler(ctx.ui); // 2nd: render(data), toggle→hidden
		const lines = ctx._ui.calls.render.at(-1);
		// Контракт: ≤ 4 строк (compact, не task-list)
		expect(lines.length).toBeLessThanOrEqual(4);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F12-2: виджет авто-скрывается при отсутствии активной миссии
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-2: виджет авто-скрыт при отсутствии активной миссии", () => {
	let baseDir;
	let ctx;
	let widgetCtx;

	beforeEach(async () => {
		await importMissionWidget();
	});

	afterEach(() => {
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
	});

	function setupNoActive(overrides = {}) {
		// Snapshot показывает paused/aborted/completed → нет активной миссии
		widgetCtx = makeWidgetCtx({
			getStatusSnapshot: vi.fn(async () =>
				makeSnapshot({ status: "completed", iteration: 7 }),
			),
			...overrides,
		});
		registerMissionWidget(widgetCtx);
		ctx = widgetCtx;
	}

	it("TC-F12-2: Alt+M при статус 'completed' → render([]) (auto-hide)", async () => {
		setupNoActive({ getStatusSnapshot: vi.fn(async () => makeSnapshot({ status: "completed" })) });
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui);
		expect(ctx._ui.calls.render.length).toBeGreaterThan(0);
		const last = ctx._ui.calls.render.at(-1);
		expect(last).toEqual([]);
	});

	it("TC-F12-2: Alt+M при статус 'aborted' → render([]) (auto-hide)", async () => {
		setupNoActive({ getStatusSnapshot: vi.fn(async () => makeSnapshot({ status: "aborted" })) });
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui);
		const last = ctx._ui.calls.render.at(-1);
		expect(last).toEqual([]);
	});

	it("TC-F12-2: render не содержит '● активна' при paused/aborted/completed", async () => {
		setupNoActive({ getStatusSnapshot: vi.fn(async () => makeSnapshot({ status: "paused" })) });
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui);
		const text = flatten(ctx._ui.calls.render.at(-1));
		expect(text).not.toMatch(/●\s*активна/i);
	});

	it("TC-F12-2: если нет ни missionLoop, ни getStatusSnapshot → render([]) без падения", async () => {
		const ui = makeMockUI();
		const uiEvents = makeMockUIEventEmitter();
		const registerShortcut = makeMockRegisterShortcut();
		// Ни missionLoop, ни getStatusSnapshot — авто-худ.
		registerMissionWidget({
			registerShortcut: registerShortcut.register,
			ui,
			uiEvents,
			missionLoop: null,
		});
		expect(() => {
			// Поиск handler возможен только если зарегистрирован
			const def = registerShortcut.shortcuts.get("alt+m");
			if (def) def.handler(ui);
		}).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F12-3: виджет обновляется в реальном времени (mission_iteration_end)
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-3: виджет обновляется по событиям миссии", () => {
	let ctx;
	let widgetCtx;

	beforeEach(async () => {
		await importMissionWidget();
		widgetCtx = makeWidgetCtx();
		registerMissionWidget(widgetCtx);
		ctx = widgetCtx;
	});

	it("TC-F12-3: emit('mission_iteration_end', payload) → render вызван с обновлённой итерацией", async () => {
		// Alt+M → toggle visible (visible=true → visible=false → hidden)
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui); // visible=false
		await handler(ctx.ui); // visible=true (widget visible)

		// Snapshot меняется на iteration=6
		let snapshotIter = 5;
		widgetCtx.getStatusSnapshot = vi.fn(async () => makeSnapshot({ iteration: snapshotIter }));

		// Эмитим событие → render должен пересоздать
		ctx._uiEvents.__fire("mission_iteration_end", { iteration: 6 });
		// Allow promise microtasks to flush
		await new Promise((r) => setImmediate(r));

		// Должно быть минимум 3 вызова render (initial + on event)
		expect(ctx._ui.calls.render.length).toBeGreaterThanOrEqual(3);
		const lastText = flatten(ctx._ui.calls.render.at(-1));
		expect(lastText).toMatch(/итерация:\s*6/i);
	});

	it("TC-F12-3: НЕ mission_iteration_end (другое событие) → render НЕ вызван", async () => {
		const beforeCount = ctx._ui.calls.render.length;
		ctx._uiEvents.__fire("user_typed", { text: "hi" });
		await new Promise((r) => setImmediate(r));
		expect(ctx._ui.calls.render.length).toBe(beforeCount);
	});

	it("TC-F12-3: подписка на mission_iteration_end зарегистрирована ровно один раз", () => {
		const subs = ctx._uiEvents.calls.on.filter((c) => c.name === "mission_iteration_end");
		expect(subs.length).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Alt+M toggle: переключение видимости и ui.toggle('M')
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-toggle: Alt+M toggle (ui.toggle)", () => {
	let ctx;
	let widgetCtx;

	beforeEach(async () => {
		await importMissionWidget();
		widgetCtx = makeWidgetCtx();
		registerMissionWidget(widgetCtx);
		ctx = widgetCtx;
	});

	it("TC-F12-toggle: handler 'alt+m' вызывает ui.toggle('M')", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui);
		expect(ctx._ui.calls.toggle.length).toBeGreaterThanOrEqual(1);
		expect(ctx._ui.calls.toggle.at(-1)).toBe("M");
	});

	it("TC-F12-toggle: Alt+M дважды → ui.toggle вызван дважды", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(ctx.ui);
		await handler(ctx.ui);
		expect(ctx._ui.calls.toggle.length).toBeGreaterThanOrEqual(2);
	});

	it("TC-F12-toggle: toggle state переключается между visible/hidden (snapshot)", async () => {
		let snapshotIter = 5;
		widgetCtx.getStatusSnapshot = vi.fn(async () => makeSnapshot({ iteration: snapshotIter }));

		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;

		// First call: widget hidden by default → render пуст
		await handler(ctx.ui);
		expect(ctx._ui.calls.render.at(-1)).toEqual([]);

		// Second call: toggle ON → render с данными
		await handler(ctx.ui);
		const text = flatten(ctx._ui.calls.render.at(-1));
		expect(text).toMatch(/статус:/i);
	});

	it("TC-F12-toggle: после toggle off render снова пустой", async () => {
		const handler = ctx._registerShortcut.shortcuts.get("alt+m").handler;
		// 1) visible=true → visible=false (hidden)
		await handler(ctx.ui);
		// 2) visible=false → visible=true (visible)
		await handler(ctx.ui);
		// 3) visible=true → visible=false (hidden)
		await handler(ctx.ui);
		const lastText = flatten(ctx._ui.calls.render.at(-1));
		// либо render пустой, либо содержит явный hide-маркер
		const isEmpty = ctx._ui.calls.render.at(-1).length === 0;
		const hasHideMarker = /скрыт|hidden|hide/i.test(lastText);
		expect(isEmpty || hasHideMarker).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Persist toggle state между вызовами и между событиями
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-persist: persist toggle state", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		await importMissionWidget();
	});

	afterEach(() => {
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F12-persist: после Alt+M=off, событие mission_iteration_end → render (виджет скрыт)", async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("widget-mission", { baseDir });
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] step\n", "utf8");

		const widgetCtx = makeWidgetCtx({ missionDir });
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(widgetCtx.ui); // 1st click → HIDDEN (toggle from visible)
		await handler(widgetCtx.ui); // 2nd click → VISIBLE (toggle back)
		await handler(widgetCtx.ui); // 3rd click → HIDDEN

		// emit → render НЕ должен содержать активную итерацию (widget off)
		widgetCtx._uiEvents.__fire("mission_iteration_end", { iteration: 6 });
		await new Promise((r) => setImmediate(r));

		const lastText = flatten(widgetCtx._ui.calls.render.at(-1));
		const isEmpty = widgetCtx._ui.calls.render.at(-1).length === 0;
		const hasHideMarker = /скрыт|hidden|hide/i.test(lastText);
		expect(isEmpty || hasHideMarker).toBe(true);
	});

	it("TC-F12-persist: toggle state сохраняется внутри виджета между событиями", async () => {
		const widgetCtx = makeWidgetCtx();
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;

		// After 1 call: toggle to hidden
		await handler(widgetCtx.ui);
		const initialStateIsHidden =
			widgetCtx._ui.calls.render.at(-1).length === 0
			|| /скрыт|hidden|hide/i.test(flatten(widgetCtx._ui.calls.render.at(-1)));

		// Emit event
		widgetCtx._uiEvents.__fire("mission_iteration_end", { iteration: 6 });
		await new Promise((r) => setImmediate(r));

		// State должен сохраниться — если был hidden, остался hidden
		const stateAfterEmitIsHidden =
			widgetCtx._ui.calls.render.at(-1).length === 0
			|| /скрыт|hidden|hide/i.test(flatten(widgetCtx._ui.calls.render.at(-1)));
		expect(stateAfterEmitIsHidden).toBe(initialStateIsHidden);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("F-12 / TC-F12-edge: edge cases", () => {
	let baseDir;

	beforeEach(async () => {
		await importMissionWidget();
	});

	afterEach(() => {
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F12-edge: getStatusSnapshot throws → render([]), no crash", async () => {
		const widgetCtx = makeWidgetCtx({
			getStatusSnapshot: vi.fn(async () => {
				throw new Error("disk read failed");
			}),
		});
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await expect(handler(widgetCtx.ui)).resolves.not.toThrow();
		// Render либо пустой, либо без crash
		expect(widgetCtx._ui.calls.render.length).toBeGreaterThan(0);
	});

	it("TC-F12-edge: paused статус → render содержит 'пауза' (или 'paused')", async () => {
		const widgetCtx = makeWidgetCtx({
			getStatusSnapshot: vi.fn(async () => makeSnapshot({ status: "paused", iteration: 3 })),
		});
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(widgetCtx.ui);
		await handler(widgetCtx.ui); // toggle on
		const text = flatten(widgetCtx._ui.calls.render.at(-1));
		expect(text).toMatch(/пауза|paused/i);
	});

	it("TC-F12-edge: budget_exhausted статус → render содержит 'budget'/'exhausted'", async () => {
		const widgetCtx = makeWidgetCtx({
			getStatusSnapshot: vi.fn(async () =>
				makeSnapshot({ status: "budget_exhausted", iteration: 9 }),
			),
		});
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(widgetCtx.ui);
		await handler(widgetCtx.ui);
		const text = flatten(widgetCtx._ui.calls.render.at(-1));
		// Контракт покрывает оба варианта (ru/en)
		expect(text).toMatch(/budget|exhausted|расход/i);
	});

	it("TC-F12-edge: без missionDir → render использует snapshot (no disk read)", async () => {
		const widgetCtx = makeWidgetCtx({ missionDir: undefined });
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(widgetCtx.ui);
		await handler(widgetCtx.ui);

		// getStatusSnapshot вызван хотя бы раз
		expect(widgetCtx.getStatusSnapshot).toHaveBeenCalled();
	});

	it("TC-F12-edge: uiEvents без метода off → виджет всё равно работает (no-op)", async () => {
		const uiEvents = {
			on(name, handler) {
				// no off impl
			},
		};
		const ui = makeMockUI();
		const registerShortcut = makeMockRegisterShortcut();
		const missionLoop = makeMockMissionLoop();

		expect(() =>
			registerMissionWidget({
				registerShortcut: registerShortcut.register,
				ui,
				uiEvents,
				missionLoop,
				getStatusSnapshot: vi.fn(async () => makeSnapshot()),
			}),
		).not.toThrow();
	});

	it("TC-F12-edge: USD форматируется с 2 знаками после запятой ($3.45, $10.00)", async () => {
		const widgetCtx = makeWidgetCtx({
			getStatusSnapshot: vi.fn(async () =>
				makeSnapshot({ budgetUsed: { tokens: 1200, usd: 3.45 }, budgetUsd: 10.0 }),
			),
		});
		registerMissionWidget(widgetCtx);

		const handler = widgetCtx._registerShortcut.shortcuts.get("alt+m").handler;
		await handler(widgetCtx.ui);
		await handler(widgetCtx.ui);
		const text = flatten(widgetCtx._ui.calls.render.at(-1));
		expect(text).toMatch(/\$3\.45/);
		expect(text).toMatch(/\$10\.00/);
	});

});
