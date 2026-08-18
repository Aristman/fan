// F-13: Расширение fan-scheduler — тики I4 (heartbeat) миссионного контура.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3 (таблица I4)
//
// Контракт: startScheduler(ctx) → { stop() }. На каждом тике проверяется
// getStatus(); если миссия "active" — actions.sendMessage(tickPrompt, "followUp")
// с подстановкой плейсхолдеров {missionDir}/{date}. cronExpression (опционально)
// побеждает intervalMs; невалидный cron → явная ошибка при старте.
//
// R3 (0.3.0): миссия "completed" тоже тикается, если в её каталоге есть
// непустой RECURRING.md (дежурство; loop сам решает, что подоспело — no-op
// тик без LLM-вызовов). Per-mission `tick_interval_ms` из frontmatter
// MISSION.md (≥1000) троттлит тики этой миссии (in-memory lastTickTs;
// cron-конфиг не троттлится). Базовый интервал: 60_000 мс.

export type MissionStatus =
	| "active"
	| "paused"
	| "awaiting_decision"
	| "completed"
	| "aborted"
	| "failed"
	| "budget_exhausted";

// Только "steer" | "followUp": fan.sendUserMessage поддерживает лишь эти два
// режима deliverAs ("nextTurn" исключён — планировщик всегда шлёт "followUp").
export type StreamingBehavior = "steer" | "followUp";

/** Пейлоад тика для программного моста (ТИКЕТ-14: EventBus вместо LLM-промпта). */
export interface TickPayload {
	missionDir: string;
	date: string;
	prompt: string;
}

export interface SchedulerActions {
	sendMessage(text: string, streamingBehavior: StreamingBehavior): void | Promise<void>;
	/**
	 * Опциональный программный мост (ТИКЕТ-14): если задан — вызывается вместо
	 * sendMessage (LLM-промпт не отправляется). sendMessage остаётся обязательным.
	 */
	onTick?(payload: TickPayload): void | Promise<void>;
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

export const DEFAULT_INTERVAL_MS = 60_000; // 60 секунд — дешёвый polling;
// LLM-вызовов на no-op тике нет (mission-loop сам решает, что подоспело).

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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nextCronDelayMs, parseCronExpression } from "./cron-parser.js";

export { parseCronExpression } from "./cron-parser.js";

// ─── R3: дежурство completed-миссий + per-mission интервал ──────────────────

/** Пункт RECURRING.md: незакрытый checkbox `- [ ] ...` / `* [ ] ...`. */
const RECURRING_ITEM_RE = /^[-*] \[ \] .+$/m;

/**
 * R3: есть ли в каталоге миссии непустой RECURRING.md (хотя бы один
 * unchecked-пункт). Файл отсутствует/нечитаем/без пунктов → false.
 * Дешёвая проверка (только чтение файла) — loop сам решает, что подоспело.
 */
export function hasRecurringItems(missionDir: string): boolean {
	if (!missionDir) return false;
	try {
		const text = readFileSync(join(missionDir, "RECURRING.md"), "utf8");
		return RECURRING_ITEM_RE.test(text);
	} catch {
		return false;
	}
}

/**
 * R3: per-mission интервал тиков из frontmatter MISSION.md
 * (`tick_interval_ms: <number>`). Валидное положительное число ≥ 1000 →
 * интервал в мс; поле отсутствует/невалидно → null (базовый интервал).
 */
export function readTickIntervalMs(missionDir: string): number | null {
	if (!missionDir) return null;
	try {
		const text = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) return null;
		const line = fm[1].split(/\r?\n/).find((l) => /^tick_interval_ms\s*:/.test(l));
		if (!line) return null;
		const raw = line.replace(/^tick_interval_ms\s*:\s*/, "").trim();
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 1000) return null;
		return n;
	} catch {
		return null;
	}
}

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

	// R3: per-mission lastTickTs — троттлинг по tick_interval_ms из MISSION.md.
	const lastTickByMission = new Map<string, number>();

	const tickHandler = async (): Promise<void> => {
		const status = await ctx.getStatus();
		if (stopped) {
			return;
		}
		const missionDir = ctx.getMissionDir ? ctx.getMissionDir() : "";
		if (status === "completed") {
			// R3 (дежурство): completed-миссия тикается только при непустом
			// RECURRING.md (есть unchecked-пункты). Дальше loop решает, что
			// подоспело; no-op тик дешёвый — без LLM-вызовов. Completed без
			// recurring → пропуск, как раньше.
			if (!hasRecurringItems(missionDir)) {
				return;
			}
		} else if (status !== "active") {
			return; // paused / awaiting_decision / терминальные → тик не доставляется
		}
		// R3: per-mission tick_interval_ms из frontmatter MISSION.md. Только для
		// interval-режима — cron-конфиг обгоняет интервал и не троттлится.
		if (ctx.cronExpression === undefined) {
			const minIntervalMs = readTickIntervalMs(missionDir);
			if (minIntervalMs !== null) {
				const now = Date.now();
				const last = lastTickByMission.get(missionDir) ?? 0;
				if (now - last < minIntervalMs) {
					return;
				}
				lastTickByMission.set(missionDir, now);
			}
		}
		const date = new Date().toISOString();
		const text = renderTickPrompt(template, { missionDir, date });
		if (ctx.actions.onTick) {
			// ТИКЕТ-14: программный мост (EventBus) приоритетнее LLM-промпта.
			await ctx.actions.onTick({ missionDir, date, prompt: text });
		} else {
			await ctx.actions.sendMessage(text, "followUp");
		}
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
