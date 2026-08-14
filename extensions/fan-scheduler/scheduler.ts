// F-13: Расширение fan-scheduler — тики I4 (heartbeat) миссионного контура.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3 (таблица I4)
//
// Контракт: startScheduler(ctx) → { stop() }. На каждом тике проверяется
// getStatus(); если миссия "active" — actions.sendMessage(tickPrompt, "followUp")
// с подстановкой плейсхолдеров {missionDir}/{date}. cronExpression (опционально)
// побеждает intervalMs; невалидный cron → явная ошибка при старте.

export type MissionStatus = "active" | "paused" | "completed" | "aborted" | "failed" | "budget_exhausted";

// Только "steer" | "followUp": fan.sendUserMessage поддерживает лишь эти два
// режима deliverAs ("nextTurn" исключён — планировщик всегда шлёт "followUp").
export type StreamingBehavior = "steer" | "followUp";

export interface SchedulerActions {
	sendMessage(text: string, streamingBehavior: StreamingBehavior): void | Promise<void>;
}

export interface SchedulerCtx {
	actions: SchedulerActions;
	getStatus: () => Promise<MissionStatus> | MissionStatus;
	getMissionDir?: () => string;
	tickPrompt?: string;
	intervalMs?: number;
	cronExpression?: string;
}

export interface SchedulerHandle {
	stop: () => void;
}

export const DEFAULT_INTERVAL_MS = 300_000; // 5 минут

export const DEFAULT_TICK_PROMPT =
	"Тик контура миссии. Прочитай STATE.md, ROADMAP.md и BACKLOG.md в {missionDir}, " +
	"проверь git log. Реши: ITERATE / GENERATE / IDLE. Текущая дата: {date}.";

// ─── Рендер шаблона тика ────────────────────────────────────────────────────

export interface TickPromptVars {
	missionDir?: string;
	date?: string;
}

/**
 * Подстановка {missionDir}/{date} в шаблон. Неизвестные плейсхолдеры
 * остаются как есть; undefined-значения заменяются пустой строкой.
 */
export function renderTickPrompt(template: string, vars: TickPromptVars): string {
	return template
		.replaceAll("{missionDir}", vars.missionDir ?? "")
		.replaceAll("{date}", vars.date ?? new Date().toISOString());
}

// ─── Cron-утилиты (вынесены в cron-parser.ts) ────────────────────────────────
import { nextCronDelayMs, parseCronExpression } from "./cron-parser.js";

export { parseCronExpression } from "./cron-parser.js";

// ─── Планировщик ────────────────────────────────────────────────────────────

/**
 * Запуск планировщика тиков I4. Возвращает handle с идемпотентным stop().
 * Повторный вызов startScheduler создаёт независимый handle (restart-safe).
 */
export function startScheduler(ctx: SchedulerCtx): SchedulerHandle {
	const intervalMs = ctx.intervalMs ?? DEFAULT_INTERVAL_MS;
	const template = ctx.tickPrompt ?? DEFAULT_TICK_PROMPT;

	let stopped = false;
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const tickHandler = async (): Promise<void> => {
		const status = await ctx.getStatus();
		if (stopped) {
			return;
		}
		if (status !== "active") {
			return; // paused / терминальные статусы → тик не доставляется
		}
		const text = renderTickPrompt(template, {
			missionDir: ctx.getMissionDir ? ctx.getMissionDir() : "",
			date: new Date().toISOString(),
		});
		await ctx.actions.sendMessage(text, "followUp");
	};

	if (ctx.cronExpression !== undefined) {
		// cron побеждает intervalMs; невалидное выражение → явная ошибка.
		const parsed = parseCronExpression(ctx.cronExpression);
		const scheduleNext = (): void => {
			if (stopped) {
				return;
			}
			const delayMs = nextCronDelayMs(parsed, new Date());
			timeoutId = setTimeout(() => {
				void tickHandler()
					.then(() => {
						scheduleNext();
					})
					.catch((err: unknown) => {
						console.error("[fan-scheduler] tickHandler error:", err);
						scheduleNext();
					});
			}, delayMs);
		};
		scheduleNext();
	} else {
		intervalId = setInterval(() => {
			void tickHandler().catch((err: unknown) => {
				console.error("[fan-scheduler] tickHandler error:", err);
			});
		}, intervalMs);
	}

	return {
		stop(): void {
			if (stopped) {
				return; // идемпотентно
			}
			stopped = true;
			if (intervalId !== undefined) {
				clearInterval(intervalId);
				intervalId = undefined;
			}
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
		},
	};
}
