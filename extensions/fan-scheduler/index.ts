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

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { MissionStatus, SchedulerHandle } from "./scheduler.js";
import { startScheduler } from "./scheduler.js";

export interface SchedulerWireOptions {
	intervalMs?: number;
	cronExpression?: string;
	tickPrompt?: string;
	getStatus?: () => MissionStatus | Promise<MissionStatus>;
	getMissionDir?: () => string;
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

/** Находит первую не-терминальную миссию в <cwd>/docs/missions/. */
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
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		const status = readMissionStatus(dir);
		if (status && NON_TERMINAL.has(status)) return { dir, status };
	}
	return null;
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

	const wiring = wireScheduler(fan, {
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
