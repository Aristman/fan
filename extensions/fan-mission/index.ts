// F-MISSION-INDEX: Расширение fan-mission — entry-point (wiring).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-11/§F-12
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2 (I0–I3), §3.2.4, §6.3, §6.4
//
// Контракт:
//   export wireMission(fan, opts?) — тестируемый wiring:
//     { attachMission(missionDir), getMissionLoop(), shutdown() }.
//     attachMission создаёт MissionLoop с production-deps (executor из
//     opts.runAgent ?? дефолт, git = createGitAdapter(), clock = { now })
//     и идемпотентен для того же missionDir.
//     Дефолтный runAgent (без opts.runAgent) — createDefaultRunAgent из
//     ./default-run-agent.js: prompt → sendUserMessage(followUp) → ожидание
//     agent_end → последний assistant-текст + Σ usage (single-flight,
//     timeout = opts.runAgentTimeoutMs ?? 30 мин). shutdown() осаживает
//     активный waiter дефолтного runAgent FAILED-тегом ДО abort loop.
//   export default missionExtension(fan) — фабрика расширения: регистрирует
//     7 slash-команд /mission:* (DI через fan.registerCommand), виджет
//     (f9, uiEvents = fan.events), хуки session_start (скан
//     <cwd>/docs/missions/*/MISSION.md → attach первого не-терминального)
//     и session_shutdown (shutdown). ВОЗВРАЩАЕТ wiring-handle (разумное
//     отклонение от `: void` — единственный способ наблюдать session_start
//     через getMissionLoop()).

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import type { KeyId } from "@seaagents/fan-tui";

import { createDefaultRunAgent } from "./default-run-agent.js";
import { readMission } from "./file-state-manager.js";
import { createGitAdapter } from "./git-adapter.js";
import { MissionLoop, readMissionLoopState, setDrainSignal } from "./mission-loop.js";
import { registerMissionWidget } from "./mission-widget.js";
import { createSessionExecutor, type RunAgent } from "./session-executor.js";
import { registerMissionSlashCommands, type SlashCtx } from "./slash-commands.js";
import { createMissionTickHandler } from "./tick-bridge.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Не-терминальные статусы: миссия в таком статусе аттачится в session_start. */
const NON_TERMINAL_STATUSES = new Set(["active", "paused", "awaiting_decision"]);

/** Названия шагов цикла по STATE.md lastStep (0 = idle / ещё не было tick). */
const STEP_NAMES: Record<number, string> = {
	0: "idle",
	1: "wake",
	2: "read",
	3: "decide",
	4: "iterate",
	5: "verify",
	6: "commit",
	7: "backlog",
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MissionWireOptions {
	/** DI: runAgent для session-executor (в тестах — mock, без реального LLM). */
	runAgent?: RunAgent;
	/** Дефолтный deliverAs для actions.sendMessage (по умолчанию "steer"). */
	streamingBehavior?: "steer" | "followUp";
	/** Таймаут дефолтного runAgent (мс; по умолчанию 1_800_000 = 30 мин). */
	runAgentTimeoutMs?: number;
}

export interface MissionWiring {
	/** Создаёт (или возвращает уже созданный для того же dir) MissionLoop. */
	attachMission(missionDir: string): MissionLoop;
	/** Текущий MissionLoop либо null (ленивый: создаётся в attachMission). */
	getMissionLoop(): MissionLoop | null;
	/** abort активного loop + очистка handle. Идемпотентен. */
	shutdown(): Promise<void>;
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

export function wireMission(fan: ExtensionAPI, opts?: MissionWireOptions): MissionWiring {
	// Дефолтный runAgent создаётся только при отсутствии DI-варианта (не нужно
	// подписываться на agent_end в тестах с mock runAgent).
	const defaultHandle = opts?.runAgent ? null : createDefaultRunAgent(fan, { timeoutMs: opts?.runAgentTimeoutMs });
	const runAgent: RunAgent = defaultHandle ? defaultHandle.runAgent : (opts?.runAgent as RunAgent);

	let loop: MissionLoop | null = null;
	let attachedDir: string | null = null;

	const attachMission = (missionDir: string): MissionLoop => {
		if (loop && attachedDir === missionDir) {
			return loop; // идемпотентен для того же dir — без двойного wiring
		}
		if (loop) {
			void loop.abort(); // смена миссии: глушим предыдущий контур
		}
		loop = new MissionLoop({
			missionDir,
			deps: {
				executor: createSessionExecutor({ runAgent }),
				git: createGitAdapter(),
				clock: { now: () => new Date() },
			},
		});
		attachedDir = missionDir;
		return loop;
	};

	const getMissionLoop = (): MissionLoop | null => loop;

	const shutdown = async (): Promise<void> => {
		// Осадить waiter дефолтного runAgent ДО abort loop: mission-loop при
		// abort получит FAILED-тег вместо зависшего/пустого результата.
		defaultHandle?.settle("mission shutdown");
		const current = loop;
		loop = null;
		attachedDir = null;
		if (current) {
			await current.abort();
		}
	};

	return { attachMission, getMissionLoop, shutdown };
}

// ─── session_start scan ─────────────────────────────────────────────────────

/**
 * Ищет первую миссию не-терминального статуса в <cwd>/docs/missions/*.
 * Возвращает missionDir либо null (миссии нет / каталог отсутствует).
 * Никаких файлов не создаёт.
 */
async function findActiveMissionDir(cwd: string): Promise<string | null> {
	const missionsRoot = join(cwd, "docs", "missions");
	if (!existsSync(missionsRoot)) {
		return null;
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(missionsRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const missionDir = join(missionsRoot, entry.name);
		try {
			const mission = await readMission(missionDir);
			if (NON_TERMINAL_STATUSES.has(String(mission.frontmatter.status))) {
				return missionDir;
			}
		} catch {
			// каталог без валидного MISSION.md — пропускаем
		}
	}
	return null;
}

// ─── Extension factory ──────────────────────────────────────────────────────

export default function missionExtension(fan: ExtensionAPI): MissionWiring {
	const wiring = wireMission(fan);

	// Общий ctx slash-команд: МУТИРУЕТСЯ в attach/shutdown, чтобы команды
	// всегда видели актуальный loop и missionDir.
	const slashCtx: SlashCtx = {
		actions: {
			sendMessage: (text, options) => {
				fan.sendUserMessage(text, {
					deliverAs: options?.streamingBehavior ?? "steer",
				});
			},
			// I0 abort: гасит активный loop (если есть).
			abort: () => {
				const current = wiring.getMissionLoop();
				if (current) {
					void current.abort();
				}
			},
			// I1 drain: файловый сигнал (mission-loop.ts setDrainSignal) —
			// контур подхватит его на границе текущего тёрна.
			setDrainAfterCurrentTurn: (value) => {
				if (slashCtx.missionDir) {
					setDrainSignal(slashCtx.missionDir, value);
				}
			},
			// resume: снять drain-сигнал (статус в MISSION.md пишет сама команда).
			resume: () => {
				if (slashCtx.missionDir) {
					setDrainSignal(slashCtx.missionDir, false);
				}
			},
		},
		// TODO: вывод в TUI-командную область; console.log — минимальный fallback.
		output: (line) => {
			console.log(line);
		},
	};

	const attach = (missionDir: string): MissionLoop => {
		const loop = wiring.attachMission(missionDir);
		slashCtx.missionLoop = loop;
		slashCtx.missionDir = missionDir;
		return loop;
	};

	// ТИКЕТ-14: auto-tick мост — fan-scheduler эмитит "mission_tick" в
	// fan.events, handler вызывает loop.tick() программно (без LLM-промпта).
	// Guard для mock fan без events (тесты): подписка просто не создаётся.
	const bridge = createMissionTickHandler({
		getLoop: () => wiring.getMissionLoop(),
		getMissionDir: () => slashCtx.missionDir,
	});
	const unsubTick = fan.events?.on ? fan.events.on("mission_tick", bridge.handler) : undefined;

	const detach = async (): Promise<void> => {
		if (typeof unsubTick === "function") {
			unsubTick();
		}
		bridge.dispose();
		await wiring.shutdown();
		slashCtx.missionLoop = null;
		slashCtx.missionDir = undefined;
	};

	// Снимок статуса для виджета (читает ТЕКУЩИЙ loop из handle).
	const getStatusSnapshot = async () => {
		const loop = wiring.getMissionLoop();
		const missionDir = slashCtx.missionDir;
		if (!loop || !missionDir) {
			throw new Error("No active mission");
		}
		const status = await loop.status();
		let iteration = 0;
		let budgetUsed = { tokens: 0, usd: 0 };
		let currentStep = STEP_NAMES[0] ?? "idle";
		try {
			const loopState = await readMissionLoopState(missionDir);
			iteration = loopState.currentIteration;
			budgetUsed = loopState.budgetUsed ?? budgetUsed;
			currentStep = STEP_NAMES[loopState.lastStep] ?? currentStep;
		} catch {
			// STATE.md может ещё отсутствовать — оставляем дефолты
		}
		return {
			status,
			iteration,
			budgetUsed,
			budgetTokens: 0,
			budgetUsd: 0,
			currentStep,
		};
	};

	// 1. Slash-команды /mission:* — DI через fan.registerCommand. Handler
	//    всегда получает общий slashCtx (fan передаёт ExtensionCommandContext,
	//    который не содержит SlashCtx-полей).
	registerMissionSlashCommands((name, def) => {
		fan.registerCommand(name, {
			description: def.description,
			handler: async (args) => {
				await def.handler(args, slashCtx);
			},
		});
	}, slashCtx);

	// 2. Виджет (f9). ctx.ui захватывается в shortcut-handler и session_start
	//    (последний wins), чтобы widgetUi.render мог вызвать ctx.ui.setWidget.
	let lastUiCtx: { ui: { setWidget(key: string, content: string[] | undefined, options?: unknown): void } } | null =
		null;
	const widgetUi = {
		render: (lines: string[]): void => {
			if (!lastUiCtx) return;
			lastUiCtx.ui.setWidget("mission", lines.length > 0 ? lines : undefined);
		},
		toggle: (_key: string): void => {},
	};
	registerMissionWidget({
		registerShortcut: (key, def) => {
			fan.registerShortcut(key as KeyId, {
				description: def.description,
				handler: async (ctx) => {
					lastUiCtx = ctx as unknown as typeof lastUiCtx;
					await def.handler(widgetUi);
				},
			});
		},
		ui: widgetUi,
		uiEvents: {
			// EventBus не имеет off — подписка живёт весь срок сессии.
			on: (name, handler) => {
				fan.events.on(name, handler);
			},
			off: (_name, _handler) => {},
		},
		getStatusSnapshot,
	});

	// 3. Хуки жизненного цикла.
	fan.on("session_start", async (event, ctx) => {
		try {
			lastUiCtx = ctx as unknown as typeof lastUiCtx;
			const cwd = ctx?.cwd ?? (event as unknown as { cwd?: string }).cwd;
			if (!cwd) {
				return;
			}
			const missionDir = await findActiveMissionDir(cwd);
			if (missionDir) {
				attach(missionDir);
			}
		} catch (err) {
			console.warn("[fan-mission] session_start hook failed:", err);
		}
	});

	fan.on("session_shutdown", async () => {
		await detach();
	});

	return wiring;
}
