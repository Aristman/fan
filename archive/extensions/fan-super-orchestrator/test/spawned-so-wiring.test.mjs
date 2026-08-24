// F-5: Spawned SO init в session_start (recursive wiring) — RED-фаза TDD.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §Этап 5, F-5
// Спека: docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-5
//
// Тесты проверяют recursive wiring в session_start hook:
//   • TC-F5-1: FAN_NODE_ROLE=super-orchestrator → circuit создан с recursive wiring
//     (handleDelegateRecursive зарегистрирован, role profile загружен)
//   • TC-F5-2: Delegate handler для recursive SO работает через api.events
//     (emit mission_delegate → recursive handler вызван, НЕ depth2-integration)
//   • TC-F5-3: Role profile загружается через loadRoleCatalog при FAN_NODE_ROLE_PROFILE
//   • TC-F5-4: Worker role (FAN_NODE_ROLE=worker) НЕ инициализирует recursive wiring
//     (back-compat guard — может trivially PASS)
//   • TC-F5-5: Abort propagation — shutdown пишет abort event в journal
//
// RED-фаза: тесты должны FAIL, т.к. текущий код (index.ts session_start hook):
//   • НЕ проверяет FAN_NODE_ROLE env var
//   • НЕ вызывает loadRoleCatalog
//   • НЕ регистрирует handleDelegateRecursive
//   • НЕ пишет abort event в journal при shutdown
//   • wiring return value не содержит recursive-specific API (getRoleProfile, isRecursive)
//
// Ожидаемые результаты:
//   TC-F5-1: FAIL — wiring.isRecursive не существует (extension не проверяет FAN_NODE_ROLE)
//   TC-F5-2: FAIL — depth2-integration вызван (recursive handler не реализован)
//   TC-F5-3: FAIL — wiring.getRoleProfile не существует (loadRoleCatalog не вызывается)
//   TC-F5-4: PASS (trivially) — recursive wiring не существует вообще, worker не использует её
//   TC-F5-5: FAIL — journal не содержит abort event (shutdown не пишет в journal)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mock EventBus (pattern-matching из entry-point.test.mjs) ───────────────

function makeMockEventBus() {
	const listeners = new Map();
	const emitCalls = [];
	return {
		_listeners: listeners,
		_emitCalls: emitCalls,
		emit(channel, data) {
			emitCalls.push({ channel, data });
			const handlers = listeners.get(channel) ?? [];
			for (const h of [...handlers]) {
				h(data);
			}
		},
		on(channel, handler) {
			if (!listeners.has(channel)) listeners.set(channel, []);
			listeners.get(channel).push(handler);
			return () => {
				const arr = listeners.get(channel) ?? [];
				const i = arr.indexOf(handler);
				if (i >= 0) arr.splice(i, 1);
			};
		},
		listenerCount(channel) {
			return (listeners.get(channel) ?? []).length;
		},
		findEmit(channelOrPattern) {
			return emitCalls.find(
				(c) => c.channel === channelOrPattern || c.channel.includes(channelOrPattern),
			);
		},
		findAllEmits(channelOrPattern) {
			return emitCalls.filter(
				(c) => c.channel === channelOrPattern || c.channel.includes(channelOrPattern),
			);
		},
	};
}

// ─── Mock fan API (pattern-matching из entry-point.test.mjs) ────────────────

function makeMockFan(eventBus) {
	const hooks = new Map();
	return {
		_hooks: hooks,
		on(event, handler) {
			hooks.set(event, handler);
		},
		events: eventBus,
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		sendUserMessage: vi.fn(),
		async _emitHook(event, ...args) {
			const handler = hooks.get(event);
			if (handler) await handler(...args);
		},
	};
}

// ─── Mock depth2-integration (pattern-matching из entry-point.test.mjs) ─────

function makeMockDepth2(opts = {}) {
	const runCalls = [];
	const abortCalls = [];
	const createCalls = [];
	const runResult = opts.runResult ?? {
		reports: [
			{
				nodeId: "L1/node-1",
				report: {
					status: "completed",
					correlationId: "test/L1/node-1",
					result: { text: "Mock result text" },
					usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
				},
			},
		],
		budget: {
			allocated: { tokens: 0, usd: 0 },
			consumed: { tokens: 150, usd: 0.01 },
			byBranch: {},
		},
		journalEntries: 3,
		durationMs: 500,
	};

	return {
		_runCalls: runCalls,
		_abortCalls: abortCalls,
		_createCalls: createCalls,
		create(opts2) {
			createCalls.push(opts2);
			return {
				async run(runOpts) {
					runCalls.push({ opts: opts2, runOpts });
					return runResult;
				},
				async abort() {
					abortCalls.push(Date.now());
				},
			};
		},
	};
}

// ─── Setup: temp dirs with mission structure ────────────────────────────────

let baseDir;
let missionDir;

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "fan-so-f5-"));
	missionDir = join(baseDir, "docs", "missions", "test-mission");
	mkdirSync(missionDir, { recursive: true });
	// Очищаем env vars между тестами
	delete process.env.FAN_NODE_ROLE;
	delete process.env.FAN_NODE_ROLE_PROFILE;
	delete process.env.FAN_ORCHESTRATOR_DEPTH;
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	delete process.env.FAN_NODE_ROLE;
	delete process.env.FAN_NODE_ROLE_PROFILE;
	delete process.env.FAN_ORCHESTRATOR_DEPTH;
});

function writeMissionMd(status, extra = {}) {
	const budgetTokens = extra.budgetTokens ?? 100000;
	const budgetUsd = extra.budgetUsd ?? 10;
	writeFileSync(
		join(missionDir, "MISSION.md"),
		`---\nstatus: ${status}\nbudget_tokens: ${budgetTokens}\nbudget_usd: ${budgetUsd}\ntitle: Test Mission\n---\n\nTest mission body.\n`,
		"utf8",
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS: F-5 — Spawned SO wiring (RED phase)
// ═══════════════════════════════════════════════════════════════════════════

describe("F-5: Spawned SO init в session_start (recursive wiring)", () => {
	// ─── TC-F5-1: Spawned SO init создаёт circuit при FAN_NODE_ROLE=super-orchestrator ─
	describe("TC-F5-1: Spawned SO init создаёт recursive circuit при FAN_NODE_ROLE=super-orchestrator", () => {
		it("session_start при FAN_NODE_ROLE=super-orchestrator инициализирует recursive wiring (isRecursive + circuit)", async () => {
			// Условие: mock api с FAN_NODE_ROLE = "super-orchestrator"
			process.env.FAN_NODE_ROLE = "super-orchestrator";
			const eventBus = makeMockEventBus();
			const fan = makeMockFan(eventBus);
			writeMissionMd("active");

			const mod = await import("../index.js");
			const wiring = mod.default(fan);

			// Шаги: вызвать session_start handler
			await fan._emitHook("session_start", { cwd: baseDir }, { cwd: baseDir });

			// Ожидаемый результат: circuit создан с missionDir (existing behavior)
			expect(wiring.getActiveMissionDir()).toBe(missionDir);

			// RED: recursive wiring инициализирована — wiring экспонирует isRecursive()
			// F-5 должен добавить проверку FAN_NODE_ROLE и recursive init.
			// Текущий код НЕ проверяет FAN_NODE_ROLE → isRecursive не существует.
			expect(typeof wiring.isRecursive).toBe("function");
			expect(wiring.isRecursive()).toBe(true);
		});
	});

	// ─── TC-F5-2: Spawned SO register delegate handler через api.events ─────
	describe("TC-F5-2: Spawned SO delegate handler использует recursive path (не depth2-integration)", () => {
		it("при FAN_NODE_ROLE=super-orchestrator mission_delegate обрабатывается recursive handler (НЕ depth2)", async () => {
			// Условие: FAN_NODE_ROLE=super-orchestrator, DI mock depth2 для отслеживания
			process.env.FAN_NODE_ROLE = "super-orchestrator";
			const eventBus = makeMockEventBus();
			const fan = makeMockFan(eventBus);
			writeMissionMd("active");

			// DI mock depth2: если recursive wiring работает, createDepth2 НЕ вызывается
			const mockDepth2 = makeMockDepth2();
			const mod = await import("../index.js");
			mod.default(fan, { createDepth2: mockDepth2.create });

			// Init: session_start
			await fan._emitHook("session_start", { cwd: baseDir }, { cwd: baseDir });

			// Шаги: emit test event mission_delegate через mock api.events
			const correlationId = `test-f5-recursive-${Date.now()}`;
			const replyEvent = `mission_delegate_result:${correlationId}`;

			eventBus.emit("mission_delegate", {
				missionDir,
				correlationId,
				packages: [{ task: "Recursive delegation task" }],
				replyEvent,
			});

			// Ждём async handler
			await new Promise((r) => setTimeout(r, 150));

			// Ожидаемый результат: recursive handler НЕ использует depth2-integration.
			// F-5 должен зарегистрировать handleDelegateRecursive, который
			// делегирует через HTTP (не через createDepth2/spawnNode).
			// Текущий код: handleDelegate ВСЕГДА вызывает createDepth2 → runCalls > 0.
			expect(mockDepth2._runCalls.length).toBe(0);
		});
	});

	// ─── TC-F5-3: Spawned SO init загружает role profile ────────────────────
	describe("TC-F5-3: Spawned SO init загружает role profile через loadRoleCatalog", () => {
		it("при FAN_NODE_ROLE=super-orchestrator + FAN_NODE_ROLE_PROFILE=pm role profile загружен и доступен", async () => {
			// Условие: FAN_NODE_ROLE=super-orchestrator, FAN_NODE_ROLE_PROFILE=pm
			process.env.FAN_NODE_ROLE = "super-orchestrator";
			process.env.FAN_NODE_ROLE_PROFILE = "pm";
			const eventBus = makeMockEventBus();
			const fan = makeMockFan(eventBus);
			writeMissionMd("active");

			const mod = await import("../index.js");
			const wiring = mod.default(fan);

			// Шаги: вызвать session_start handler
			await fan._emitHook("session_start", { cwd: baseDir }, { cwd: baseDir });

			// Ожидаемый результат: loadRoleCatalog вызван, profile "pm" доступен.
			// F-5 должен вызвать loadRoleCatalog в session_start и экспонировать
			// getRoleProfile() через wiring.
			// Текущий код: НЕ вызывает loadRoleCatalog → getRoleProfile не существует.
			expect(typeof wiring.getRoleProfile).toBe("function");

			const profile = wiring.getRoleProfile();
			expect(profile).toBeDefined();
			expect(profile.id).toBe("pm");
		});
	});

	// ─── TC-F5-4: Worker role НЕ инициализирует recursive wiring ────────────
	describe("TC-F5-4: Worker role (FAN_NODE_ROLE=worker) НЕ инициализирует recursive wiring", () => {
		it("при FAN_NODE_ROLE=worker recursive wiring НЕ инициализирована (existing flow сохранён)", async () => {
			// Условие: FAN_NODE_ROLE = "worker"
			process.env.FAN_NODE_ROLE = "worker";
			const eventBus = makeMockEventBus();
			const fan = makeMockFan(eventBus);
			writeMissionMd("active");

			const mockDepth2 = makeMockDepth2();
			const mod = await import("../index.js");
			mod.default(fan, { createDepth2: mockDepth2.create });

			// Шаги: вызвать session_start handler
			await fan._emitHook("session_start", { cwd: baseDir }, { cwd: baseDir });

			// Ожидаемый результат: existing flow (circuit создан, delegate handler работает)
			// Circuit создан (existing behavior — back-compat)
			// Примечание: getActiveMissionDir может быть null если mission не найдена,
			// но с writeMissionMd("active") — должна найтись.
			const activeMission = fan._hooks.has("session_start");
			expect(activeMission).toBe(true);

			// Recursive wiring НЕ инициализирована для worker.
			// Если isRecursive существует (F-5 реализован), он должен вернуть false.
			// Если не существует (текущий код) — это тоже OK (нет recursive = worker safe).
			const mod2 = await import("../index.js");
			const wiring2 = mod2.default(fan);

			// Создаём отдельный fan для проверки wiring
			const eventBus2 = makeMockEventBus();
			const fan2 = makeMockFan(eventBus2);
			const wiring = mod2.default(fan2);

			// Worker: session_start с другим cwd (без миссии) — circuit не создан
			const emptyDir = mkdtempSync(join(tmpdir(), "fan-so-f5-empty-"));
			try {
				await fan2._emitHook("session_start", { cwd: emptyDir }, { cwd: emptyDir });

				// RED: Если F-5 реализован, wiring для worker НЕ должен иметь recursive API.
				// Текущий код: wiring НЕ имеет recursive API (нет isRecursive) → PASS.
				// Это back-compat guard: если кто-то добавит recursive wiring для worker,
				// этот тест должен упасть.
				if (typeof wiring.isRecursive === "function") {
					expect(wiring.isRecursive()).toBe(false);
				}

				// Дополнительная проверка: delegate handler для worker НЕ должен
				// регистрироваться как recursive. Проверяем через eventBus.
				// (Для worker без миссии — handler не регистрируется вообще.)
				expect(eventBus2.listenerCount("mission_delegate")).toBe(0);
			} finally {
				rmSync(emptyDir, { recursive: true, force: true });
			}
		});
	});

	// ─── TC-F5-5: Spawned SO abort propagation (kill-switch recursive) ──────
	describe("TC-F5-5: Spawned SO abort propagation — shutdown пишет abort event в journal", () => {
		it("после session_start + shutdown journal содержит abort event (graceful shutdown recursive SO)", async () => {
			// Условие: FAN_NODE_ROLE=super-orchestrator, spawned SO работает
			process.env.FAN_NODE_ROLE = "super-orchestrator";
			const eventBus = makeMockEventBus();
			const fan = makeMockFan(eventBus);
			writeMissionMd("active");

			const mod = await import("../index.js");
			const wiring = mod.default(fan);

			// session_start: circuit создан
			await fan._emitHook("session_start", { cwd: baseDir }, { cwd: baseDir });
			expect(wiring.getActiveMissionDir()).toBe(missionDir);

			// Journal создан (existing behavior)
			const journalPath = join(missionDir, "tree-journal.jsonl");
			expect(existsSync(journalPath)).toBe(true);

			// Шаги: вызвать shutdown (имитация SIGTERM parent)
			await wiring.shutdown();

			// Ожидаемый результат: journal содержит abort event.
			// F-5 должен писать abort event в journal при shutdown recursive SO.
			// Текущий код: shutdown НЕ пишет в journal → abort event отсутствует.
			const content = readFileSync(journalPath, "utf8");
			const lines = content.split("\n").filter((l) => l.trim() !== "");
			const entries = lines.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			}).filter(Boolean);

			const abortEntry = entries.find((e) => e.event === "abort");
			expect(abortEntry).toBeDefined();
			expect(abortEntry.nodeId).toBeDefined();
		});
	});
});
