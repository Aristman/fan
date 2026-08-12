// F-11: Slash-команды /mission:* — DI-регистрация и маршрутизация I0–I3.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-11
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2 (I0–I3), §3.2.4, §6.3
//
// Этап 0: без зависимости от TUI/fan.registerCommand — регистрация через
// DI-колбэк `register` (в проде это тонкая обёртка над fan.registerCommand),
// вся маршрутизация тестируется на моках (test/slash-commands.test.mjs).

import { readMission, writeMissionStatus } from "./file-state-manager.js";
import type { MissionLoop } from "./mission-loop.js";
import { readMissionLoopState } from "./mission-loop.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MissionStatusSnapshot {
	status: string;
	iteration: number;
	budgetUsed: { tokens: number; usd: number };
	currentStep: string;
}

export interface SlashCtxActions {
	sendMessage(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): void | Promise<void>;
	abort(): void | Promise<void>;
	setDrainAfterCurrentTurn(value: boolean): void;
	resume(): void;
}

export interface SlashCtx {
	actions: SlashCtxActions;
	missionLoop?: MissionLoop | null;
	output: (line: string) => void;
	missionDir?: string;
	getStatusSnapshot?: () => Promise<MissionStatusSnapshot>;
}

export interface SlashCommandDef {
	description: string;
	handler: (args: string, ctx: SlashCtx) => Promise<void>;
}

export type SlashCommandRegister = (name: string, cmd: SlashCommandDef) => void;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Trim whitespace and strip one pair of matching outer quotes ("..." or '...'). */
function parseQuotedArg(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/** Run a handler body; on failure print an error line via output instead of throwing. */
function guarded(output: (line: string) => void, body: () => Promise<void>): Promise<void> {
	return body().catch((err: unknown) => {
		output(`Error: ${err instanceof Error ? err.message : String(err)}`);
	});
}

/** Mission-loop step names by journal lastStep (0 = idle / no tick yet). */
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

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Зарегистрировать 7 slash-команд /mission:* (спека §6.3).
 *
 * Маршрутизация по уровням прерываний (§3.2.2):
 *   /mission:stop   — I0 abort (actions.abort + missionLoop.abort + status=aborted)
 *   /mission:pause  — I1 drain (setDrainAfterCurrentTurn(true) + status=paused)
 *   /mission:steer  — I2 steer (sendMessage(..., { streamingBehavior: "steer" }))
 *   /mission:decide — I3 followUp (sendMessage(..., { streamingBehavior: "followUp" }))
 *   /mission:start|resume|status — управляющие команды.
 */
export function registerMissionSlashCommands(register: SlashCommandRegister, registrationCtx: SlashCtx): void {
	register("mission:start", {
		description: "Start the mission loop (runs one tick)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				if (!ctx.missionLoop) return; // no-op without an attached loop
				await ctx.missionLoop.tick();
			}),
	});

	register("mission:stop", {
		description: "Stop the mission immediately (I0 abort)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				await ctx.actions.abort();
				if (ctx.missionLoop) await ctx.missionLoop.abort();
				if (ctx.missionDir) await writeMissionStatus(ctx.missionDir, "aborted");
			}),
	});

	register("mission:pause", {
		description: "Pause the mission after the current turn (I1 drain)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				ctx.actions.setDrainAfterCurrentTurn(true);
				if (ctx.missionDir) await writeMissionStatus(ctx.missionDir, "paused");
			}),
	});

	register("mission:resume", {
		description: "Resume the mission after pause",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				ctx.actions.resume();
				ctx.actions.setDrainAfterCurrentTurn(false);
				if (ctx.missionDir) await writeMissionStatus(ctx.missionDir, "active");
			}),
	});

	register("mission:status", {
		description: "Show mission status, iteration, budget usage and current step",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				if (ctx.getStatusSnapshot) {
					const snap = await ctx.getStatusSnapshot();
					ctx.output(`Status:    ${snap.status}`);
					ctx.output(`Iteration: ${snap.iteration}`);
					ctx.output(`Budget:    ${snap.budgetUsed.tokens} tokens / $${snap.budgetUsed.usd.toFixed(2)} used`);
					ctx.output(`Step:      ${snap.currentStep}`);
					return;
				}

				let status = "unknown";
				let iteration = 0;
				let budgetUsed = { tokens: 0, usd: 0 };
				let currentStep = "—";

				if (ctx.missionLoop) {
					try {
						status = String(await ctx.missionLoop.status());
					} catch {
						status = "unknown";
					}
				} else if (!ctx.missionDir) {
					ctx.output("No active mission (mission loop is not attached)");
					return;
				}

				if (ctx.missionDir) {
					try {
						const loopState = await readMissionLoopState(ctx.missionDir);
						iteration = loopState.currentIteration;
						budgetUsed = loopState.budgetUsed;
						currentStep = STEP_NAMES[loopState.lastStep] ?? "—";
					} catch {
						// keep defaults — loop state file may not exist yet
					}
					if (!ctx.missionLoop) {
						try {
							const mission = await readMission(ctx.missionDir);
							status = String(mission.frontmatter.status ?? "unknown");
						} catch {
							// keep defaults
						}
					}
				}

				ctx.output(`Status:    ${status}`);
				ctx.output(`Iteration: ${iteration}`);
				ctx.output(`Budget:    ${budgetUsed.tokens} tokens / $${budgetUsed.usd.toFixed(2)} used`);
				ctx.output(`Step:      ${currentStep}`);
			}),
	});

	register("mission:steer", {
		description: 'Inject a steering message into the running loop (I2): /mission:steer "<msg>"',
		handler: (args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				const message = parseQuotedArg(args);
				if (!message) {
					ctx.output('Error: usage /mission:steer "<message>"');
					return;
				}
				await ctx.actions.sendMessage(message, { streamingBehavior: "steer" });
			}),
	});

	register("mission:decide", {
		description: 'Answer a DECIDE interruption (I3 followUp): /mission:decide "<answer>"',
		handler: (args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				const answer = parseQuotedArg(args);
				if (!answer) {
					ctx.output('Error: usage /mission:decide "<answer>"');
					return;
				}
				await ctx.actions.sendMessage(answer, { streamingBehavior: "followUp" });
			}),
	});
}
