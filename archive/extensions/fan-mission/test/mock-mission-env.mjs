// F-15: MockMissionEnvironment — refactor-target helper для интеграционных тестов.
//
// Контракт (см. карточку F-15 + roadmap.md):
//
//   createMockMissionEnvironment(opts?) -> {
//     missionLoop: MissionLoop
//     scheduler: SchedulerHandle | null       // если opts.withScheduler = true
//     webhook:   WebhookServerHandle | null   // если opts.withWebhook = true
//     actions:   MockMissionActions           // DI: sendMessage / abort / drain / resume
//     executor:  MockExecutorHandle           // доступ к calls[] для assertions
//     cleanup(): Promise<void>                // idempotent teardown
//   }
//
// Хелпер инкапсулирует:
//   - in-memory DI-контекст (mock executor, mock git, mock clock, mock lock)
//   - in-memory actions (sendMessage / abort / setDrainAfterCurrentTurn / resume)
//   - временный missionDir на диске (через initMission)
//   - опциональный scheduler (setInterval/cron → actions.sendMessage)
//   - опциональный webhook-сервер (HTTP → actions.sendMessage)
//
// Green-фаза (F-15): модули связаны в сквозной контур:
//   - webhook/scheduler → actions.sendMessage
//   - actions.sendMessage(steer) → steer-очередь → следующий MissionLoop.tick()
//   - actions.sendMessage(followUp) → MissionLoop.tick() (scheduler I4)
//   - actions.setDrainAfterCurrentTurn → drain-флаг → MissionLoop.tick() →
//     статус paused без новой итерации

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";
import {
	MissionLoop,
	readMissionLoopState,
	appendSteerMessage,
	setDrainSignal,
} from "../mission-loop.js";

import { startScheduler } from "../../fan-scheduler/scheduler.js";
import { startWebhookServer } from "../../fan-webhook/webhook-server.js";

// ─── Types (re-exported для удобства) ────────────────────────────────────────

/**
 * In-memory mock executor: записи вызовов + очередь iteration-результатов.
 */
export function createMockExecutor(initialResults = [{ status: "COMPLETE", commitMessage: "iter: tick" }]) {
	const calls = [];
	const steerMessages = []; // история steer, которые executor «получил» (для assertions)
	let idx = 0;

	const executor = {
		calls,
		steerMessages,
		async runIteration(opts) {
			calls.push({
				missionDir: opts.missionDir,
				prompt: opts.prompt,
				cwd: opts.cwd,
				// steer (если executor контракт поддерживает) — приходит через opts.steer
				steer: opts.steer ?? null,
			});
			// Сохраняем steer в историю (если пришёл)
			if (opts.steer) {
				steerMessages.push(opts.steer);
			}
			const result = initialResults[Math.min(idx, initialResults.length - 1)];
			idx++;
			return { ...result };
		},
	};

	return executor;
}

/**
 * In-memory mock git: лог коммитов.
 */
export function createMockGit() {
	const commits = [];
	return {
		commits,
		async commit({ cwd, message, files }) {
			const hash = `hash-${commits.length + 1}-${Date.now().toString(36)}`;
			commits.push({ cwd, message, files, hash });
			return { hash };
		},
		async log({ cwd, maxCount = 10 }) {
			return commits.slice(-maxCount).map((c) => ({
				hash: c.hash,
				subject: c.message,
				date: new Date().toISOString(),
			}));
		},
		async status({ cwd }) {
			return { clean: true };
		},
	};
}

/**
 * In-memory mock clock: каждый вызов +1 минута от базы 2026-08-10T10:00:00Z.
 */
export function createMockClock() {
	let n = 0;
	const base = new Date("2026-08-10T10:00:00Z");
	return {
		async now() {
			return new Date(base.getTime() + n * 60_000);
		},
	};
}

/**
 * In-memory mock lock: первый acquire = true, повторный до release = false.
 */
export function createMockLock() {
	let held = false;
	return {
		held: () => held,
		async acquire() {
			if (held) return false;
			held = true;
			return true;
		},
		async release() {
			held = false;
		},
	};
}

/**
 * In-memory actions: логирует sendMessage/abort/drain/resume.
 */
export function createMockActions(overrides = {}) {
	const sendCalls = [];
	const abortCalls = [];
	const drainCalls = [];
	const resumeCalls = [];
	return {
		sendCalls,
		abortCalls,
		drainCalls,
		resumeCalls,
		async sendMessage(text, opts) {
			sendCalls.push({ text, opts });
			if (overrides.sendMessageImpl) {
				return overrides.sendMessageImpl(text, opts);
			}
		},
		async abort() {
			abortCalls.push(Date.now());
			if (overrides.abortImpl) return overrides.abortImpl();
		},
		setDrainAfterCurrentTurn(value) {
			drainCalls.push(value);
			if (overrides.setDrainAfterCurrentTurnImpl) {
				return overrides.setDrainAfterCurrentTurnImpl(value);
			}
		},
		resume() {
			resumeCalls.push(Date.now());
			if (overrides.resumeImpl) return overrides.resumeImpl();
		},
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Создать полный мок-окружение для интеграционных тестов.
 *
 * @param opts
 *   - slug?: string           — slug для initMission (default: "integration-test")
 *   - baseDir?: string        — родительский каталог (default: tmpdir())
 *   - executorResults?: []    — массив IterationResult для executor
 *   - withScheduler?: boolean — запустить ли scheduler
 *   - schedulerIntervalMs?: number — период (default: 1000 для тестов)
 *   - withWebhook?: boolean   — запустить ли webhook-сервер (ephemeral port)
 *   - initialSteer?: string   — добавить steer в очередь executor
 */
export async function createMockMissionEnvironment(opts = {}) {
	const slug = opts.slug ?? "integration-test";
	const baseDir = opts.baseDir ?? mkdtempSync(join(tmpdir(), "fan-f15-"));
	const executorResults = opts.executorResults ?? [
		{ status: "COMPLETE", commitMessage: "iter: 1" },
		{ status: "COMPLETE", commitMessage: "iter: 2" },
		{ status: "COMPLETE", commitMessage: "iter: 3" },
	];

	// 1. Mission dir на диске через initMission (file-state-manager)
	const missionDir = await initMission(slug, { baseDir });

	// F-15 Green: фикстура ROADMAP с 3 пунктами — иначе миссия завершится после
	// первой итерации (дефолтный шаблон содержит 1 пункт) и сквозные сценарии
	// scheduler→loop (3+ тика) невозможны.
	writeFileSync(
		join(missionDir, "ROADMAP.md"),
		"# Roadmap\n\n- [ ] item a\n- [ ] item b\n- [ ] item c\n",
		"utf8",
	);

	// 2. Mock DI deps для MissionLoop
	const executor = createMockExecutor(executorResults);
	const git = createMockGit();
	const clock = createMockClock();
	const lock = createMockLock();

	// 3. MissionLoop
	const missionLoop = new MissionLoop({
		missionDir,
		deps: { executor, git, clock, lock },
	});

	// 4. Mock actions, связанные с контуром (F-15 Green):
	//   - steer    → очередь steer-сообщений (.mission-steer-queue.json) →
	//                потребляется следующим missionLoop.tick() (step 4)
	//   - followUp → missionLoop.tick() (scheduler I4 → loop)
	//   - drain    → drain-флаг (.mission-drain-flag) → loop ставит статус paused
	const actions = createMockActions({
		sendMessageImpl: async (text, sendOpts) => {
			const behavior = sendOpts?.streamingBehavior;
			if (behavior === "steer") {
				appendSteerMessage(missionDir, text);
				return;
			}
			if (behavior === "followUp") {
				await missionLoop.tick();
			}
		},
		setDrainAfterCurrentTurnImpl: (value) => {
			setDrainSignal(missionDir, Boolean(value));
		},
	});

	// 5. Scheduler (опционально)
	let schedulerHandle = null;
	if (opts.withScheduler === true) {
		const intervalMs = opts.schedulerIntervalMs ?? 1000;
		schedulerHandle = startScheduler({
			actions: {
				sendMessage: (text, streamingBehavior) =>
					actions.sendMessage(text, { streamingBehavior }),
			},
			getStatus: async () => {
				try {
					return await missionLoop.status();
				} catch {
					return "failed";
				}
			},
			getMissionDir: () => missionDir,
			intervalMs,
			tickPrompt:
				opts.tickPrompt ?? "Тик контура: {missionDir}, дата: {date}. Дёрни missionLoop.tick().",
		});
	}

	// 6. Webhook (опционально, ephemeral port)
	let webhookHandle = null;
	if (opts.withWebhook === true) {
		webhookHandle = await startWebhookServer({
			actions: {
				sendMessage: (text, streamingBehavior) =>
					actions.sendMessage(text, { streamingBehavior }),
			},
			port: 0, // ephemeral
		});
	}

	// 7. cleanup: idempotent teardown
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		if (schedulerHandle) {
			schedulerHandle.stop();
		}
		if (webhookHandle) {
			await webhookHandle.stop();
		}
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// ignore — tmp dir может быть уже удалён
		}
	};

	return {
		missionDir,
		missionLoop,
		scheduler: schedulerHandle,
		webhook: webhookHandle,
		actions,
		executor,
		git,
		clock,
		lock,
		cleanup,
		// Помощник: прочитать loopState с диска (для assertions)
		readLoopState: () => readMissionLoopState(missionDir),
	};
}

// ─── Stand-alone helpers (для будущих тестов) ────────────────────────────────

/** Свежий tmp-каталог для теста (cleaned вручную через rmSync). */
export function freshBaseDir(prefix = "fan-f15-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Recursive safe-cleanup каталога. */
export function safeCleanup(dir) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}