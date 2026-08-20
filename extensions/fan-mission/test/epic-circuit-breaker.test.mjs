// F-48.5 circuit breaker (mission-loop.ts): consecutive FAILED EPIC delegations.
//
// Семантика (MAX_DELEGATION_FAILURES = 2 по умолчанию, deps.maxDelegationFailures):
//   • FAILED-ответ делегирования → итерация FAILED (пункт остаётся в ROADMAP),
//     loopState.delegationFailure = { item, count } — БЕЗ локального исполнения;
//   • count >= maxFailures на ТОМ ЖЕ пункте → принудительное локальное
//     исполнение (executor.runIteration), сброс счётчика, warn через deps.notify;
//   • COMPLETE-делегирование → счётчик сброшен (delegationFailure undefined);
//   • FAILED на другом пункте → счётчик начинается с 1;
//   • null-fallback (нет подписчика/таймаут/невалидный JSON) → локальное
//     исполнение как раньше; счётчик НЕ трогается (fallback ≠ отказ делегирования).
//
// Счётчик персистится в .mission-loop.json (переживает ротацию/рестарт).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readState } from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState } from "../mission-loop.js";

// ─── Mock factories (тот же контракт, что epic-delegation.test.mjs) ─────────

function makeMockExecutor(results = [{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			const r = results[Math.min(idx, results.length - 1)];
			idx++;
			return { ...r };
		},
	};
}

function makeMockGit() {
	const commits = [];
	return {
		commits,
		async commit({ message }) {
			const hash = `hash-${commits.length + 1}`;
			commits.push({ hash, message });
			return { hash };
		},
		async log() {
			return commits.map((c) => ({ hash: c.hash, subject: c.message, date: new Date().toISOString() }));
		},
		async status() {
			return { clean: true };
		},
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-20T10:00:00Z");
	return { async now() { return new Date(base.getTime() + n++ * 60_000); } };
}

function makeMockLock() {
	let held = false;
	return {
		async acquire() { if (held) return false; held = true; return true; },
		async release() { held = false; },
	};
}

/** Mock runAgent декомпозиции: всегда валидный JSON из одной подзадачи. */
function makeMockRunAgent() {
	const calls = [];
	const fn = async (prompt, opts) => {
		calls.push({ prompt, opts: opts ?? {} });
		return { response: JSON.stringify([{ task: "Подзадача 1", tokenBudget: 1000 }]), costTokens: 10, costUsd: 0.001 };
	};
	fn.calls = calls;
	return fn;
}

/** Mock EventBus с синхронными handlers и отпиской (контракт EpicEventBus + listenerCount). */
function makeMockEventBus() {
	const listeners = new Map();
	return {
		_listeners: listeners,
		emit(channel, data) {
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
	};
}

/** Подписчик mission_delegate, отвечающий ошибкой делегирования. */
function subscribeWithFailure(eventBus, error = "depth2 spawn failed: all nodes crashed") {
	return eventBus.on("mission_delegate", (payload) => {
		eventBus.emit(payload.replyEvent, { error });
	});
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = mkdtempSync(join(tmpdir(), "fan-epic-breaker-"));
	missionDir = await initMission("test-breaker", { baseDir: join(baseDir, "docs", "missions") });
	// Дефолтный шаблон MISSION.md содержит session_mode: fresh — без инжекта
	// sessionRotator это даёт лишний notify о деградации в persistent, который
	// загрязняет notify-шпион. Для тестов breaker'а переводим в persistent.
	const missionMdPath = join(missionDir, "MISSION.md");
	writeFileSync(
		missionMdPath,
		readFileSync(missionMdPath, "utf8").replace("session_mode: fresh", "session_mode: persistent"),
		"utf8",
	);
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

/** MissionLoop с EPIC-deps + notify-шпионом (deps.notify) и metrics-шпионом. */
function createLoop(opts = {}) {
	const executor = opts.executor ?? makeMockExecutor();
	const runAgent = opts.runAgent ?? makeMockRunAgent();
	const eventBus = opts.eventBus ?? makeMockEventBus();
	const notifyCalls = [];
	const metrics = [];
	const loop = new MissionLoop({
		missionDir,
		deps: {
			executor,
			git: makeMockGit(),
			clock: makeMockClock(),
			lock: makeMockLock(),
			notify: (msg) => notifyCalls.push(msg),
			...(opts.maxDelegationFailures !== undefined
				? { maxDelegationFailures: opts.maxDelegationFailures }
				: {}),
		},
		runAgent,
		eventBus,
		delegationTimeoutMs: 500,
		metricsCollector: {
			async onIterationEnd(_dir, record) {
				metrics.push(record);
			},
		},
	});
	return { loop, executor, runAgent, eventBus, notifyCalls, metrics };
}

function writeRoadmapEpic(itemText) {
	writeFileSync(join(missionDir, "ROADMAP.md"), `# Roadmap\n\n- [ ] ${itemText}\n`, "utf8");
}

const EPIC_ITEM = "[EPIC] Сломанный эпик";

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("F-48.5 circuit breaker: FAILED EPIC delegation → локальный fallback после N неудач", () => {
	// ─── TC-B1: первый FAILED → записан, локального исполнения НЕТ ────────
	it("FAILED один раз → iterResult FAILED записан, delegationFailure={item,count:1}, executor не вызван", async () => {
		writeRoadmapEpic(EPIC_ITEM);
		const eventBus = makeMockEventBus();
		subscribeWithFailure(eventBus);
		const ctx = createLoop({ eventBus });

		const result = await ctx.loop.tick();

		// Локального исполнения НЕТ — только delegation path
		expect(ctx.executor.calls.length).toBe(0);

		// iterResult FAILED записан: metrics (promise-tag routing) + blockers STATE.md
		expect(ctx.metrics.length).toBe(1);
		expect(ctx.metrics[0].status).toBe("failed");
		expect(ctx.metrics[0].promiseTag).toBe("FAILED");
		const state = await readState(missionDir);
		expect(state.done.some((d) => d.includes(EPIC_ITEM))).toBe(false);
		expect(state.blockers.some((b) => b.includes("depth2 spawn failed"))).toBe(true);

		// Счётчик записан и персистится
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: EPIC_ITEM, count: 1 });

		// Пункт остался в ROADMAP (не отмечен), миссия активна
		expect(readFileSync(join(missionDir, "ROADMAP.md"), "utf8")).toContain(`- [ ] ${EPIC_ITEM}`);
		expect(result.status).toBe("active");

		// Оператор НЕ уведомляется на первой неудаче
		expect(ctx.notifyCalls.length).toBe(0);
	});

	// ─── TC-B2: второй FAILED подряд → локальное исполнение + notify ──────
	it("второй FAILED подряд → executor вызван, счётчик сброшен, notify c warning", async () => {
		writeRoadmapEpic(EPIC_ITEM);
		const eventBus = makeMockEventBus();
		subscribeWithFailure(eventBus);
		const ctx = createLoop({ eventBus });

		// Тик 1: FAILED → count 1 (без локального исполнения)
		await ctx.loop.tick();
		expect(ctx.executor.calls.length).toBe(0);
		let loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: EPIC_ITEM, count: 1 });

		// Тик 2: снова FAILED → count 2 >= MAX_DELEGATION_FAILURES → локально
		const result = await ctx.loop.tick();
		expect(ctx.executor.calls.length).toBe(1); // локальная итерация выполнена
		expect(ctx.runAgent.calls.length).toBe(2); // декомпозиция пробовалась оба раза

		// Счётчик сброшен после принудительного локального исполнения
		loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toBeUndefined();

		// Оператор уведомлён ровно один раз (warning про локальное исполнение)
		expect(ctx.notifyCalls.length).toBe(1);
		expect(ctx.notifyCalls[0]).toContain("⚠️");
		expect(ctx.notifyCalls[0]).toContain("executing locally");

		// Локальный результат COMPLETE → пункт закрыт, миссия завершена
		expect(result.status).toBe("completed");
		const state = await readState(missionDir);
		expect(state.done.some((d) => d.includes(EPIC_ITEM))).toBe(true);
	});

	// ─── TC-B3: успешная делегация → счётчик сброшен ──────────────────────
	it("FAILED затем COMPLETE → delegationFailure undefined (успех сбрасывает счётчик)", async () => {
		writeRoadmapEpic(EPIC_ITEM);
		const eventBus = makeMockEventBus();
		let calls = 0;
		eventBus.on("mission_delegate", (payload) => {
			calls++;
			if (calls === 1) {
				eventBus.emit(payload.replyEvent, { error: "transient orchestrator failure" });
			} else {
				eventBus.emit(payload.replyEvent, {
					results: [{ status: "completed", resultText: "Подзадача выполнена" }],
					totalUsage: { tokens: 500, usd: 0.01 },
				});
			}
		});
		const ctx = createLoop({ eventBus });

		// Тик 1: FAILED → count 1
		await ctx.loop.tick();
		let loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: EPIC_ITEM, count: 1 });

		// Тик 2: делегация успешна → пункт закрыт, счётчик сброшен
		await ctx.loop.tick();
		loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toBeUndefined();

		// Локального исполнения не было ни разу (оба тика — delegation path)
		expect(ctx.executor.calls.length).toBe(0);
		expect(ctx.notifyCalls.length).toBe(0);
		const state = await readState(missionDir);
		expect(state.done.some((d) => d.includes(EPIC_ITEM))).toBe(true);
	});

	// ─── TC-B4: FAILED на пункте A, затем пункт B → счётчик с 1 ───────────
	it("FAILED на пункте A, затем пункт B → счётчик начинается с 1 (per-item)", async () => {
		const itemA = "[EPIC] Эпик A";
		const itemB = "[EPIC] Эпик B";
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			`# Roadmap\n\n- [ ] ${itemA}\n- [ ] ${itemB}\n`,
			"utf8",
		);
		const eventBus = makeMockEventBus();
		subscribeWithFailure(eventBus);
		const ctx = createLoop({ eventBus });

		// Тик 1: пункт A FAILED → {item: A, count: 1}
		await ctx.loop.tick();
		let loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: itemA, count: 1 });

		// Пункт A закрывается оператором вручную (FAILED сам по себе пункт не снимает)
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			`# Roadmap\n\n- [x] ${itemA}\n- [ ] ${itemB}\n`,
			"utf8",
		);

		// Тик 2: пункт B FAILED → счётчик НЕ продолжается, а стартует с 1
		await ctx.loop.tick();
		loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: itemB, count: 1 });
		expect(ctx.executor.calls.length).toBe(0); // оба раза — без локального исполнения
	});

	// ─── TC-B5: null-delegation (нет подписчика) → fallback, счётчик не трогается
	it("нет подписчика → локальный fallback как раньше; счётчик НЕ трогается", async () => {
		writeRoadmapEpic(EPIC_ITEM);
		const eventBus = makeMockEventBus();
		subscribeWithFailure(eventBus);
		const ctx = createLoop({ eventBus });

		// Тик 1: FAILED → count 1 (счётчик установлен)
		await ctx.loop.tick();
		let loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: EPIC_ITEM, count: 1 });

		// Снимаем подписчика: следующая делегация → null (listenerCount === 0)
		// Пересоздаём loop на том же missionDir БЕЗ подписчика на том же bus.
		const busNoSubscriber = makeMockEventBus();
		const ctx2 = createLoop({ eventBus: busNoSubscriber });

		const result = await ctx2.loop.tick();

		// Локальный fallback как раньше: executor вызван, пункт закрыт
		expect(ctx2.executor.calls.length).toBe(1);
		expect(result.status).toBe("completed");

		// Счётчик НЕ трогается: fallback ≠ отказ делегирования
		loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toEqual({ item: EPIC_ITEM, count: 1 });
		expect(ctx2.notifyCalls.length).toBe(0);
	});

	it("свежая миссия без подписчика → локальный fallback, счётчик не устанавливается", async () => {
		writeRoadmapEpic(EPIC_ITEM);
		const eventBus = makeMockEventBus(); // без подписчика
		const ctx = createLoop({ eventBus });

		const result = await ctx.loop.tick();

		expect(ctx.executor.calls.length).toBe(1);
		expect(result.status).toBe("completed");
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.delegationFailure).toBeUndefined();
		expect(ctx.notifyCalls.length).toBe(0);
	});
});
