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
//     и session_shutdown (shutdown; в середине fresh-ротации (rotatingGuard,
//     ralph-loop S5) — лёгкая очистка БЕЗ detach/abort, §4.2 дизайна
//     docs/research/ralph-loop-mission-mode.md). ralph-loop (S5): deps loop'а
//     включают sessionRotator (rotate() → rotatingGuard + fan.newSession с
//     parentSession из opts.getSessionFile); session_start после attach
//     снимает .mission-loop.json.resumeAfterRotation и планирует
//     setTimeout(loop.tick, 0) — автопродолжение после ротации. Slash-команды start/resume/status
//     поддерживают lazy-attach: если loop не аттачен в session_start,
//     они находят миссию через findAttachableMission(cwd) и аттачат её
//     в запущенной сессии (без рестарта fan). ВОЗВРАЩАЕТ wiring-handle
//     (разумное отклонение от `: void` — единственный способ наблюдать
//     session_start через getMissionLoop()).

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import type { KeyId } from "@seaagents/fan-tui";
import { createOperatorDecisionPrompter, type OperatorDecisionUI } from "./decision-dialog.js";
import { createDefaultRunAgent } from "./default-run-agent.js";
import { readMission, readRecurring, writeMissionStatus } from "./file-state-manager.js";
import { createGitAdapter } from "./git-adapter.js";
import { promoteAcceptedIdeas } from "./idea-promoter.js";
import {
	clearMissionAbortArtifacts,
	type LoopState,
	MissionLoop,
	type MissionSessionRotator,
	readMissionLoopState,
	setDrainSignal,
	writeLoopStateSync,
} from "./mission-loop.js";
import { registerMissionWidget, type MissionStatusSnapshot } from "./mission-widget.js";
import { createSessionExecutor, type RunAgent } from "./session-executor.js";
import {
	registerMissionSlashCommands,
	type SlashCtx,
	TERMINAL_STATUSES,
} from "./slash-commands.js";
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
	/** F-48.5: таймаут ожидания ответа EPIC-делегирования (мс; default 30 мин). */
	delegationTimeoutMs?: number;
	/** ralph-loop (S5): provider текущего session-файла — parentSession для
	 * линковки итерационных сессий при fresh-ротации (§4.5). */
	getSessionFile?: () => string | undefined;
	/** ralph-loop incident fix: operator notification channel (обычно
	 * ctx.ui.notify из session_start) — degradation-алерты из MissionLoop. */
	notify?: (msg: string) => void;
}

export interface MissionWiring {
	/** Создаёт (или возвращает уже созданный для того же dir) MissionLoop. */
	attachMission(missionDir: string): MissionLoop;
	/** Текущий MissionLoop либо null (ленивый: создаётся в attachMission). */
	getMissionLoop(): MissionLoop | null;
	/** ralph-loop (S5): true, пока fresh-ротация сессии в полёте (guard §4.2 —
	 * session_shutdown в это время НЕ должен делать detach/abort). */
	isRotating(): boolean;
	/** ralph-loop (S5): сброс rotation-guard (идемпотентен). */
	clearRotationGuard(): void;
	/** abort активного loop + очистка handle. Идемпотентен. */
	shutdown(): Promise<void>;
	/** Осадить waiter дефолтного runAgent БЕЗ abort loop (для graceful pause). */
	settleWaiter(reason?: string): void;
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

export function wireMission(fan: ExtensionAPI, opts?: MissionWireOptions): MissionWiring {
	// Дефолтный runAgent создаётся только при отсутствии DI-варианта (не нужно
	// подписываться на agent_end в тестах с mock runAgent).
	const defaultHandle = opts?.runAgent ? null : createDefaultRunAgent(fan, { timeoutMs: opts?.runAgentTimeoutMs });
	const runAgent: RunAgent = defaultHandle ? defaultHandle.runAgent : (opts?.runAgent as RunAgent);

	let loop: MissionLoop | null = null;
	let attachedDir: string | null = null;

	// ralph-loop (S5): guard против деструктивного abort в session_shutdown во
	// время fresh-ротации (§4.2, КРИТИЧНО — иначе abort() пишет статус aborted
	// и миссия умирает на первой же ротации). Ставится rotator'ом ДО
	// fan.newSession; снимается guard-веткой session_shutdown (success, teardown
	// внутри newSession) либо finally rotator'а (cancelled/throw — teardown не
	// выполнялся). Scope — экземпляр wireMission (фабрики пересоздаются на
	// каждую сессию: guard старой сессии не протекает в новую).
	let rotatingGuard = false;

	// ralph-loop (S5): DI-rotator для MissionLoop (S3-контракт). rotate()
	// вызывается loop'ом ПОСЛЕ release lock'а при session_mode=fresh и
	// resumeAfterRotation на диске. {cancelled:true}/throw → loop сам снимает
	// флаг и деградирует в persistent; при успехе флаг НЕ снимается — это зона
	// session_start новой сессии (maybeResumeAfterRotation).
	const sessionRotator: MissionSessionRotator = {
		async rotate() {
			// Fail-safe: хост без биндинга newSession (старый runner, тестовый
			// mock) → cancelled, loop деградирует в persistent (как loader default).
			if (typeof fan.newSession !== "function") {
				return { cancelled: true };
			}
			rotatingGuard = true;
			try {
				// ralph-loop incident fix: defensive result + диагностика. Хост может
				// резолвить undefined (unbound/failed binding) — тогда ротация считается
				// cancelled (loop деградирует в persistent с видимым notify), а не падает
				// с TypeError на outcome.cancelled. Исключение логируем и пробрасываем —
				// loop сам ловит и деградирует.
				const result = await fan.newSession({ parentSession: opts?.getSessionFile?.() });
				if (result == null) {
					console.error("[fan-mission] fan.newSession resolved to", result, "— treating rotation as cancelled");
					return { cancelled: true };
				}
				return result;
			} catch (err) {
				console.error("[fan-mission] fan.newSession threw during session rotation:", err);
				throw err;
			} finally {
				rotatingGuard = false; // идемпотентно с guard-веткой session_shutdown
			}
		},
	};

	const isRotating = (): boolean => rotatingGuard;

	const clearRotationGuard = (): void => {
		rotatingGuard = false;
	};

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
				// ralph-loop (S5): fresh-режим ротирует сессию через fan.newSession.
				sessionRotator,
				// ralph-loop incident fix: operator-visible degradation alerts.
				notify: opts?.notify,
			},
			// F-48.5: EPIC delegation — тот же runAgent (декомпозиция) + EventBus
			// мост mission_delegate → super-orchestrator (fan.events).
			runAgent,
			eventBus: fan.events,
			// F-22: промоушн BACKLOG→ROADMAP (идеи со статусом ROADMAP/PROMOTED).
			ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
			...(opts?.delegationTimeoutMs !== undefined ? { delegationTimeoutMs: opts.delegationTimeoutMs } : {}),
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

	const settleWaiter = (reason = "mission pause"): void => {
		defaultHandle?.settle(reason);
	};

	return { attachMission, getMissionLoop, isRotating, clearRotationGuard, shutdown, settleWaiter };
}

// ─── Скан миссий (session_start + lazy-attach) ──────────────────────────────

/**
 * Ищет первую миссию в <cwd>/docs/missions/*, чей статус проходит `accept`.
 * Возвращает { missionDir, status } либо null (миссий нет / каталог отсутствует).
 * Никаких файлов не создаёт.
 *
 * - session_start: accept = не-терминальные статусы (active/paused/awaiting_decision);
 * - lazy-attach (/mission:start|resume|status): дефолтный accept — ЛЮБОЙ статус,
 *   включая completed (скан находит любую миссию; политика переходов/attach —
 *   на уровне обработчиков команд).
 */
export async function findAttachableMission(
	cwd: string,
	accept: (status: string, missionDir: string) => boolean = () => true,
): Promise<{ missionDir: string; status: string } | null> {
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
			const status = String(mission.frontmatter.status);
			if (accept(status, missionDir)) {
				return { missionDir, status };
			}
		} catch {
			// каталог без валидного MISSION.md — пропускаем
		}
	}
	return null;
}

// ─── Extension factory ──────────────────────────────────────────────────────

export default function missionExtension(fan: ExtensionAPI): MissionWiring {
	// ralph-loop (S5): текущий session-файл, захваченный в session_start
	// (ctx.sessionManager.getSessionFile()) — parentSession для линковки
	// итерационных сессий при fresh-ротации.
	let currentSessionFile: string | undefined;
	// ralph-loop incident fix: operator notify-канал (ctx.ui.notify), захваченный
	// в session_start. Без UI (RPC/headless/тесты) остаётся undefined — loop
	// всё равно пишет console.warn.
	let operatorNotify: ((msg: string) => void) | undefined;
	// F-MISSION-DIALOG: operator UI (ExtensionUIContext с select/input/notify),
	// захваченный в session_start. Без полного UI (RPC/headless/тесты) —
	// undefined: prompter деградирует в headlessNotify (warning без диалога).
	let operatorUi: OperatorDecisionUI | undefined;
	// F-MISSION-DIALOG: опросник решений миссии (awaiting_decision → диалог).
	// Anti-spam по pendingDecision.date — внутри prompter'а (один диалог на вопрос).
	const decisionPrompter = createOperatorDecisionPrompter({
		headlessNotify: (msg) => operatorNotify?.(msg),
	});
	// Detached-вызов: диалог не блокирует tick/session_start; сбой диалога
	// не должен ронять контур (миссия остаётся awaiting_decision, fallback —
	// /mission:decide).
	const promptOperatorDecision = (targetLoop: MissionLoop, missionDir: string): void => {
		void decisionPrompter.maybePrompt(targetLoop, missionDir, operatorUi).catch((err) => {
			console.error("[fan-mission] decision dialog failed:", err);
		});
	};
	const wiring = wireMission(fan, {
		getSessionFile: () => currentSessionFile,
		notify: (msg) => operatorNotify?.(msg),
	});

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
		// Дефолтный вывод вне обёртки registerCommand (прямые вызовы из тестов,
		// служебные пути). В TUI обёртка ниже батчит строки в ctx.ui.notify.
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

	// Lazy-attach (0.6.0): /mission:start|resume|status подхватывают контур
	// в запущенной сессии, если session_start его не аттачил (миссию остановили
	// или активировали через CLI после старта fan). Скан берёт ЛЮБОЙ статус
	// (включая completed — чтобы команды могли дать явный фидбек вместо
	// "No mission found"); FSM-переход в active делают сами команды. ТИКЕТ-14 мост
	// (scheduler → tick) и виджет f9 подхватываются автоматически: они читают
	// loop из wiring/slashCtx через замыкания, обновлённые в attach().
	slashCtx.findAttachableMission = () => findAttachableMission(slashCtx.cwd ?? process.cwd());
	slashCtx.attach = attach;
	slashCtx.writeStatus = writeMissionStatus;

	// ТИКЕТ-14: auto-tick мост — fan-scheduler эмитит "mission_tick" в
	// fan.events, handler вызывает loop.tick() программно (без LLM-промпта).
	// Guard для mock fan без events (тесты): подписка просто не создаётся.
	const bridge = createMissionTickHandler({
		getLoop: () => wiring.getMissionLoop(),
		getMissionDir: () => slashCtx.missionDir,
		// F-MISSION-DIALOG (точка 1): тик завершился в awaiting_decision →
		// показать операторный диалог (detached — тикер не блокируется).
		onTickResult: (result) => {
			if (result.status !== "awaiting_decision") {
				return;
			}
			const currentLoop = wiring.getMissionLoop();
			const missionDir = slashCtx.missionDir;
			if (!currentLoop || !missionDir) {
				return;
			}
			promptOperatorDecision(currentLoop, missionDir);
		},
	});
	const unsubTick = fan.events?.on ? fan.events.on("mission_tick", bridge.handler) : undefined;

	// (detach удалён — мёртвый код, нигде не вызывался)

	// Снимок статуса для виджета (читает ТЕКУЩИЙ loop из handle).
	const getStatusSnapshot = async (): Promise<MissionStatusSnapshot> => {
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
		// 1.2: терминальный статус → фактический шаг цикла неактуален («done»).
		// awaiting_decision НЕ терминальный (FSM: ждёт решения оператора —
		// resolveDecision/completeMission/abort) — показываем фактический шаг.
		if (TERMINAL_STATUSES.has(status)) {
			currentStep = "done";
		}
		// 1.2: лимиты — из frontmatter MISSION.md (L0: поля информационные,
		// без enforcement). Расход остаётся честным из loop-state: usd реально
		// 0, пока провайдер не отдаёт cost — конвертацию токены→USD не выдумываем.
		let budgetTokens = 0;
		let budgetUsd = 0;
		try {
			const mission = await readMission(missionDir);
			budgetTokens = Number(mission.frontmatter.budget_tokens) || 0;
			budgetUsd = Number(mission.frontmatter.budget_usd) || 0;
		} catch {
			// MISSION.md не читается — нули (прежнее поведение)
		}
		return {
			status,
			iteration,
			budgetUsed,
			budgetTokens,
			budgetUsd,
			currentStep,
		};
	};

	// 1. Slash-команды /mission:* — DI через fan.registerCommand. Handler
	//    всегда получает общий slashCtx (fan передаёт ExtensionCommandContext,
	//    который не содержит SlashCtx-полей).
	registerMissionSlashCommands((name, def) => {
		fan.registerCommand(name, {
			description: def.description,
			handler: async (args, cmdCtx) => {
				// Батчинг вывода (0.6.2): output() собирает строки в буфер, после
				// handler — ОДИН ctx.ui.notify. TUI showStatus ЗАМЕНЯЕТ предыдущий
				// status-текст, поэтому построчный notify потерял бы всё, кроме
				// последней строки (/mission:status выводит 4 строки).
				// output мутируется в slashCtx (НЕ копия): команды читают
				// missionLoop/missionDir, обновляемые attach() внутри handler.
				const lines: string[] = [];
				const prevOutput = slashCtx.output;
				slashCtx.output = (line) => {
					lines.push(line);
				};
				// 0.7.0: /mission:init использует ctx.ui.input для диалогов
				// Goal/Scope/Constraints — прокидываем UI команды в slashCtx
				// (RPC/headless: ui отсутствует → команда работает без диалогов).
				const prevUi = slashCtx.ui;
				slashCtx.ui = cmdCtx?.ui;
				try {
					await def.handler(args, slashCtx);
				} finally {
					slashCtx.output = prevOutput;
					slashCtx.ui = prevUi;
				}
				if (lines.length === 0) {
					return;
				}
				const notify = cmdCtx?.ui?.notify;
				if (typeof notify === "function") {
					const type = lines.some((line) => line.startsWith("Error:")) ? "error" : "info";
					notify.call(cmdCtx.ui, lines.join("\n"), type);
				} else {
					// Fallback без UI (тесты, RPC): построчно в консоль.
					for (const line of lines) {
						console.log(line);
					}
				}
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

	// ralph-loop (S5): автопродолжение после fresh-ротации. Новая сессия
	// пересоздаёт фабрику и аттачит миссию; если на диске стоит
	// resumeAfterRotation — сбросить флаг ДО tick (иначе он протечёт в
	// maybeRotateSession нового tick'а и вызовет лишнюю ротацию) и запланировать
	// tick на следующий macrotask (§4.2). Plan-B без автопродолжения: scheduler
	// перезапускается на session_start и пришлёт mission_tick ≤60с.
	const maybeResumeAfterRotation = async (missionDir: string, attachedLoop: MissionLoop): Promise<void> => {
		let loopState: LoopState;
		try {
			loopState = await readMissionLoopState(missionDir);
		} catch {
			return; // state нечитаем — Plan-B (scheduler mission_tick) продолжит контур
		}
		if (loopState.resumeAfterRotation !== true) {
			return;
		}
		try {
			loopState.resumeAfterRotation = false;
			writeLoopStateSync(missionDir, loopState);
		} catch {
			// best-effort — флаг останется на диске, худшее: лишняя ротация
		}
		// Наблюдаемость (§4.5): имя итерационной сессии в /resume и dashboard.
		try {
			if (typeof fan.setSessionName === "function") {
				fan.setSessionName(`mission/${basename(missionDir)}/iter-${loopState.currentIteration + 1}`);
			}
		} catch {
			// best-effort
		}
		setTimeout(() => {
			void attachedLoop.tick();
		}, 0);
	};

	// 3. Хуки жизненного цикла.
	fan.on("session_start", async (event, ctx) => {
		try {
			lastUiCtx = ctx as unknown as typeof lastUiCtx;
			// ralph-loop incident fix: канал degradation-алертов для MissionLoop.
			operatorNotify = typeof ctx?.ui?.notify === "function" ? (msg) => ctx.ui.notify(msg, "warning") : undefined;
			// F-MISSION-DIALOG: UI для диалога решений — только если есть select+input
			// (partial UI как {} в тестах/RPC → undefined → headless-ветка prompter'а).
			operatorUi =
				typeof ctx?.ui?.select === "function" && typeof ctx?.ui?.input === "function"
					? (ctx.ui as OperatorDecisionUI)
					: undefined;
			const cwd = ctx?.cwd ?? (event as unknown as { cwd?: string }).cwd;
			if (!cwd) {
				return;
			}
			slashCtx.cwd = cwd; // для lazy-attach: скан и диагностика "No mission found in <cwd>"
			// ralph-loop (S5): текущий session-файл — parentSession для ротации.
			try {
				currentSessionFile = ctx?.sessionManager?.getSessionFile?.() ?? undefined;
			} catch {
				currentSessionFile = undefined;
			}
			// F-MISSION-DUTY: сначала не-терминальные; если их нет —
			// completed-миссия с parseable recurring-пунктами аттачится как duty.
			let found = await findAttachableMission(cwd, (status) => NON_TERMINAL_STATUSES.has(status));
			if (!found) {
				found = await findAttachableMission(
					cwd,
					(status, missionDir) => status === "completed" && readRecurring(missionDir).length > 0,
				);
			}
			if (found) {
				const attachedLoop = attach(found.missionDir);
				// Явное/неявное восстановление: сбросить протухший abort-сигнал,
				// иначе первый тик сгорит с результатом 'aborted'.
				await clearMissionAbortArtifacts(found.missionDir);
				// Paused by session_shutdown → auto-resume: переводим в active
				// перед первым тиком, чтобы tick() не вернул no-op (P1-2).
				// Также сбрасываем interrupted (pause() мог его поставить),
				// чтобы tick не пытался recovery-путь вместо нормального.
				if (found.status === "paused") {
					try {
						await writeMissionStatus(found.missionDir, "active");
						const ls = await readMissionLoopState(found.missionDir);
						if (ls.interrupted) {
							ls.interrupted = false;
							writeLoopStateSync(found.missionDir, ls);
						}
					} catch {
						// FSM-переход запрещён или IO error — best-effort
					}
				}
				await maybeResumeAfterRotation(found.missionDir, attachedLoop);
				// F-MISSION-DIALOG (точка 2): recovery — миссия застряла в
				// awaiting_decision до рестарта/ротации → показать диалог сразу.
				// Anti-spam внутри prompter'а: повторный session_start с тем же
				// pendingDecision.date даст только notify.
				if (found.status === "awaiting_decision") {
					promptOperatorDecision(attachedLoop, found.missionDir);
				}
			}
		} catch (err) {
			console.warn("[fan-mission] session_start hook failed:", err);
		}
	});

	fan.on("session_shutdown", async () => {
		// ralph-loop (S5, КРИТИЧНО): session_shutdown в середине fresh-ротации —
		// это teardown СТАРОЙ сессии внутри fan.newSession, а НЕ остановка
		// миссии. Лёгкая очистка (unsubTick, bridge.dispose) БЕЗ detach/abort —
		// иначе abort() пишет abort-сигнал и статус aborted, и миссия умирает на
		// первой же ротации (§4.2). Новая сессия пересоздаст фабрику и подписки.
		if (wiring.isRotating()) {
			if (typeof unsubTick === "function") {
				unsubTick();
			}
			bridge.dispose();
			wiring.clearRotationGuard();
			return;
		}
		// Не-rotating shutdown (закрытие/переключение сессии оператором):
		// graceful pause — миссия остаётся resumable (paused), а не aborted.
		// Отписываем tick-мост, очищаем bridge, осаждаем waiter,
		// ставим миссию на паузу, сбрасываем loop/slashCtx —
		// но НЕ пишем abort-signal и НЕ вызываем shutdown() (abort()).
		if (typeof unsubTick === "function") {
			unsubTick();
		}
		bridge.dispose();
		wiring.settleWaiter("session shutdown — graceful pause");
		const current = wiring.getMissionLoop();
		if (current) {
			await current.pause();
		}
		slashCtx.missionLoop = null;
		slashCtx.missionDir = undefined;
	});

	return wiring;
}
