// F-13: Расширение fan-scheduler — entry-point (wiring).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека (I4): docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3
//
// Контракт:
//   export default schedulerExtension(fan) — фабрика расширения: регистрирует
//     session_start (захват ctx.cwd, старт планировщика; ошибки глотаются +
//     console.warn) и session_shutdown (стоп) через fan.on(...). Дефолтный
//     getStatus/getMissionDir — самодостаточный детектор активной миссии
//     (readMissionStatus/findActiveMission): нет не-терминальной миссии в
//     <cwd>/docs/missions/ → "completed" → холостые тики не отправляются.
//   export wireScheduler(fan, opts?) — тестируемый wiring: { start, stop }.
//     start() → startScheduler (actions.sendMessage → fan.sendUserMessage с
//     deliverAs), идемпотентен. stop() идемпотентен, безопасен без start().
//     opts.onTick — опциональный программный мост (ТИКЕТ-14): пробрасывается
//     в actions.onTick и приоритетнее sendMessage.
//   ТИКЕТ-14 (auto-tick мост): в проде фабрика при наличии fan.events эмитит
//     событие "mission_tick" ({ missionDir, ts, tickId }) — его слушает
//     fan-mission и вызывает loop.tick() программно, без LLM-промпта.
//     Fallback (fan без events, например mock в тестах) — старый путь:
//     tick-промпт через fan.sendUserMessage. Feature-detection обязателен.

import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { MissionStatus, SchedulerHandle, TickPayload } from "./scheduler.js";
import { hasRecurringItems, startScheduler } from "./scheduler.js";

export type { TickPayload } from "./scheduler.js";

export interface SchedulerWireOptions {
	intervalMs?: number;
	cronExpression?: string;
	tickPrompt?: string;
	getStatus?: () => MissionStatus | Promise<MissionStatus>;
	getMissionDir?: () => string;
	/** ТИКЕТ-14: программный мост тика (приоритетнее sendMessage). */
	onTick?: (payload: TickPayload) => void | Promise<void>;
}

export interface SchedulerWiring {
	/** Запускает планировщик и возвращает handle. Идемпотентен. */
	start: () => SchedulerHandle | null;
	/** Останавливает планировщик. Идемпотентен; безопасен без start(). */
	stop: () => void;
}

// ─── Детектор активной миссии (самодостаточный, без импорта fan-mission) ────

/** Не-терминальные статусы миссии: при них планировщик может тикать. */
const NON_TERMINAL = new Set(["active", "paused", "awaiting_decision"]);

/** Читает status из frontmatter MISSION.md (между --- маркерами). */
export function readMissionStatus(missionDir: string): string | null {
	try {
		const text = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) return null;
		const line = fm[1].split(/\r?\n/).find((l) => /^status\s*:/.test(l));
		if (!line) return null;
		return line.replace(/^status\s*:\s*/, "").trim();
	} catch {
		return null;
	}
}

/**
 * Находит миссию для тиков в <cwd>/docs/missions/: первую не-терминальную;
 * если такой нет — (R3) первую completed с непустым RECURRING.md (дежурство).
 * Completed без recurring-пунктов не возвращается → тиков нет, как раньше.
 */
export function findActiveMission(cwd: string): { dir: string; status: string } | null {
	const root = join(cwd, "docs", "missions");
	if (!existsSync(root)) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	let completedOnDuty: { dir: string; status: string } | null = null;
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		const status = readMissionStatus(dir);
		if (!status) continue;
		if (NON_TERMINAL.has(status)) return { dir, status };
		// R3: completed-миссия с recurring-пунктами остаётся на дежурстве.
		if (status === "completed" && !completedOnDuty && hasRecurringItems(dir)) {
			completedOnDuty = { dir, status };
		}
	}
	return completedOnDuty;
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

export function wireScheduler(fan: ExtensionAPI, opts?: SchedulerWireOptions): SchedulerWiring {
	let handle: SchedulerHandle | null = null;

	const start = (): SchedulerHandle | null => {
		if (handle) {
			return handle; // идемпотентно
		}
		handle = startScheduler({
			actions: {
				sendMessage: (text, behavior) => fan.sendUserMessage(text, { deliverAs: behavior }),
				...(opts?.onTick ? { onTick: opts.onTick } : {}),
			},
			getStatus: opts?.getStatus ?? (() => "active"),
			getMissionDir: opts?.getMissionDir,
			tickPrompt: opts?.tickPrompt,
			intervalMs: opts?.intervalMs,
			cronExpression: opts?.cronExpression,
		});
		return handle;
	};

	const stop = (): void => {
		const current = handle;
		handle = null;
		if (current) {
			current.stop();
		}
	};

	return { start, stop };
}

export default function schedulerExtension(fan: ExtensionAPI): void {
	// cwd захватывается из ctx session_start (до него миссий не ищем → тиков нет).
	let cwdRef: string | null = null;

	// ТИКЕТ-14: feature-detection EventBus — mock fan без events (тесты) идёт
	// legacy-путём (sendUserMessage), прод — эмитит mission_tick для fan-mission.
	const canBridge = typeof fan.events?.emit === "function";

	const wiring = wireScheduler(fan, {
		...(canBridge
			? {
					onTick: (p) => {
						fan.events.emit("mission_tick", { missionDir: p.missionDir, ts: Date.now(), tickId: randomUUID() });
					},
				}
			: {}),
		getStatus: () => {
			if (!cwdRef) return "completed";
			const m = findActiveMission(cwdRef);
			if (!m) return "completed"; // нет миссии → не тикать
			return m.status as MissionStatus; // active → тикать; paused/awaiting → scheduler сам пропустит
		},
		getMissionDir: () => {
			if (!cwdRef) return "";
			return findActiveMission(cwdRef)?.dir ?? "";
		},
	});

	fan.on("session_start", (_event, ctx) => {
		try {
			cwdRef = ctx?.cwd ?? null;
			wiring.start();
		} catch (err) {
			console.warn("[fan-scheduler] failed to start scheduler:", err);
		}
	});

	fan.on("session_shutdown", () => {
		wiring.stop();
	});
}
