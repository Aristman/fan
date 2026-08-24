// F-12: TUI-виджет статуса миссии (Green-фаза).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-12.
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4, §6.4 (UI).
//
// Контракт:
//   registerMissionWidget(args): void
//
// DI-стиль по образцу fan-orchestrator task widget.

import { readMission } from "./file-state-manager.js";
import type { MissionLoop } from "./mission-loop.js";
import { readMissionLoopState } from "./mission-loop.js";

/** Снимок статуса миссии. */
export interface MissionStatusSnapshot {
	status: string;
	iteration: number;
	budgetUsed: { tokens: number; usd: number };
	budgetTokens: number;
	budgetUsd: number;
	currentStep: string;
}

/** UI-фасад. */
export interface MissionWidgetUI {
	render(lines: string[]): void;
	toggle(key: string): void;
}

/** События миссии. */
export interface MissionWidgetEvents {
	on(name: string, handler: (payload: unknown) => void): void;
	off(name: string, handler: (payload: unknown) => void): void;
}

/** Определение шортката, передаваемое в registerShortcut. */
export interface ShortcutDefinition {
	description: string;
	handler: (ui: MissionWidgetUI) => Promise<void> | void;
}

/** Сборка DI-аргументов. */
export interface MissionWidgetArgs {
	registerShortcut: (key: string, def: ShortcutDefinition) => void;
	ui: MissionWidgetUI;
	missionLoop?: MissionLoop | null;
	missionDir?: string;
	uiEvents: MissionWidgetEvents;
	getStatusSnapshot?: () => Promise<MissionStatusSnapshot>;
}

function statusLabelRu(status: string): string {
	switch (status) {
		case "active":
			return "активна";
		case "paused":
			return "пауза";
		case "completed":
			return "завершена";
		case "aborted":
			return "aborted";
		case "failed":
			return "failed";
		case "budget_exhausted":
			return "budget exhausted";
		default:
			return status;
	}
}

/** Компактный формат токенов: 1234 → «1.2k», 1_500_000 → «1.5M». */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Сборка render-линии на основе снимка. */
function renderLines(snapshot: MissionStatusSnapshot, iterationOverride?: number): string[] {
	const statusEmoji = snapshot.status === "active" ? "●" : "○";
	const statusLabel = statusLabelRu(snapshot.status);
	const budgetUsed = `$${snapshot.budgetUsed.usd.toFixed(2)}`;
	const budgetTotal = `$${snapshot.budgetUsd.toFixed(2)}`;
	// 1.2: расход честный — usd реально 0 (провайдер не отдаёт cost, конвертацию
	// токены→USD не выдумываем); токены показываем рядом компактно. Лимиты —
	// из frontmatter MISSION.md (budget_tokens / budget_usd).
	const tokens = `${formatTokens(snapshot.budgetUsed.tokens)} / ${formatTokens(snapshot.budgetTokens)} tok`;
	const iter = iterationOverride ?? snapshot.iteration;
	return [
		`Статус: ${statusEmoji} ${statusLabel} │ Итерация: ${iter} │ Расход: ${budgetUsed} / ${budgetTotal} (${tokens}) │ Этап: ${snapshot.currentStep}`,
	];
}

/** Получить снимок из всех доступных источников. */
async function fetchSnapshot(args: MissionWidgetArgs): Promise<MissionStatusSnapshot | null> {
	try {
		if (args.getStatusSnapshot) {
			return await args.getStatusSnapshot();
		}
	} catch {
		return null;
	}
	if (args.missionLoop) {
		try {
			const status = await args.missionLoop.status();
			let iter = 0;
			let budgetUsed = { tokens: 0, usd: 0 };
			let currentStep = "";
			// 1.2: лимиты — из frontmatter MISSION.md (тем же readMission),
			// как и в основном пути getStatusSnapshot (fan-mission/index.ts).
			let budgetTokens = 0;
			let budgetUsd = 0;
			try {
				if (args.missionDir) {
					const ls = await readMissionLoopState(args.missionDir);
					iter = ls.currentIteration;
					budgetUsed = ls.budgetUsed ?? { tokens: 0, usd: 0 };
				}
				const mission = await readMission(args.missionDir ?? ".");
				currentStep = (mission.body?.[0] ?? "").toString().slice(0, 40);
				budgetTokens = Number(mission.frontmatter.budget_tokens) || 0;
				budgetUsd = Number(mission.frontmatter.budget_usd) || 0;
			} catch {
				/* допустимо — клиент не успевает */
			}
			return {
				status,
				iteration: iter,
				budgetUsed,
				budgetTokens,
				budgetUsd,
				currentStep,
			};
		} catch {
			return null;
		}
	}
	return null;
}

interface RenderOptions {
	visible: boolean;
	iterationOverride?: number;
}

/** Виджет: render с учётом visible и payload-iteration. Терминальные статусы
 * (completed/aborted/failed) тоже рендерятся строкой статуса — иначе F9 на
 * завершённой миссии показывал пустой виджет (молчание). */
async function renderWidget(args: MissionWidgetArgs, opts: RenderOptions): Promise<void> {
	const snapshot = await fetchSnapshot(args);
	if (!snapshot) {
		await args.ui.render([]);
		return;
	}
	if (!opts.visible) {
		await args.ui.render([]);
		return;
	}
	const lines = renderLines(snapshot, opts.iterationOverride);
	await args.ui.render(lines);
}

/**
 * Регистрирует виджет миссии: подписывается на `mission_iteration_end` и шорткат `f9`.
 */
export function registerMissionWidget(args: MissionWidgetArgs): void {
	// По умолчанию виджет выключен при запуске; включается шорткатом f9
	let visible = false;

	const onIterationEnd = async (payload: unknown) => {
		try {
			const iterOverride =
				payload && typeof payload === "object" && "iteration" in payload
					? Number((payload as { iteration?: unknown }).iteration)
					: undefined;
			await renderWidget(args, {
				visible,
				iterationOverride: Number.isFinite(iterOverride) ? iterOverride : undefined,
			});
		} catch {
			/* не падаем */
		}
	};

	try {
		args.uiEvents.on("mission_iteration_end", onIterationEnd);
	} catch {
		/* uiEvents без on — не критично */
	}

	const shortcutHandler = async (ui: MissionWidgetUI) => {
		// Сначала toggle, затем render на новом состоянии (согласно спеке)
		visible = !visible;
		await renderWidget(args, { visible });
		ui.toggle("M");
	};

	try {
		args.registerShortcut("f9", {
			description: "Toggle mission status widget (виджет миссии)",
			handler: shortcutHandler,
		});
	} catch {
		/* не критично */
	}
}
