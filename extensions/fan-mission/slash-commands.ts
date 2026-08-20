// F-11: Slash-команды /mission:* — DI-регистрация и маршрутизация I0–I3.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-11
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.2 (I0–I3), §3.2.4, §6.3
//
// Этап 0: без зависимости от TUI/fan.registerCommand — регистрация через
// DI-колбэк `register` (в проде это тонкая обёртка над fan.registerCommand),
// вся маршрутизация тестируется на моках (test/slash-commands.test.mjs).

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { formatIdeaEntry, formatIdeaId, maxIdeaNumber } from "./backlog-format.js";
import {
	appendBacklog,
	canTransition,
	hasUncheckedRoadmapItems,
	initMission,
	readBacklog,
	readMission,
	readRoadmap,
	writeMissionStatus,
	writeRoadmap,
} from "./file-state-manager.js";
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
	// --- Lazy-attach (0.6.0): подхват контура в запущенной сессии. ---
	// Заполняются при регистрации (index.ts); без них команды сохраняют
	// прежнее поведение (start — no-op, status — "No active mission").
	/** cwd сессии — для скана миссий и сообщения "No mission found in <cwd>". */
	cwd?: string;
	/** Скан <cwd>/docs/missions: первая миссия с ЛЮБЫМ статусом (включая completed). */
	findAttachableMission?: () => Promise<{ missionDir: string; status: string } | null>;
	/** Аттач контура: создаёт MissionLoop и обновляет ctx.missionLoop/missionDir. */
	attach?: (missionDir: string) => MissionLoop;
	/** FSM-переход статуса миссии (обёртка writeMissionStatus). */
	writeStatus?: (missionDir: string, status: string) => Promise<void>;
	// --- /mission:init (0.7.0): диалоги в интерактивном режиме. ---
	// Заполняется обёрткой fan.registerCommand (index.ts) из ctx.ui; без него
	// (RPC/headless, тесты) /mission:init работает без диалогов.
	/** Dialog UI: input() запрашивает строку у оператора (undefined = отмена). */
	ui?: {
		input?(title: string, placeholder?: string): Promise<string | undefined>;
	};
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

// ─── Lazy-attach (0.6.0) ────────────────────────────────────────────────────
// Контур аттачился только в session_start; если миссию остановили (aborted)
// или она стала active после старта сессии (через CLI), запущенная сессия
// оставалась без контура. /mission:start|resume|status лениво находят миссию
// (ctx.findAttachableMission) и аттачат её (ctx.attach) без рестарта fan.
// stop/pause/steer/decide по-прежнему требуют аттаченный loop.

/** Терминальные статусы FSM: tick/stop по ним — no-op, нужен явный фидбек. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "budget_exhausted"]);

/** Подсказка для completed-миссии: добавить пункты в ROADMAP или создать новую. */
function completedMissionHint(slug: string): string {
	return `Mission ${slug} is completed. Add new unchecked items to ROADMAP.md and run /mission:start, or create a new mission: fan mission init <new-slug>.`;
}

/** Разрешить функцию записи статуса: DI-override либо реальный writeMissionStatus. */
function resolveWriteStatus(ctx: SlashCtx): (missionDir: string, status: string) => Promise<void> {
	return ctx.writeStatus ?? writeMissionStatus;
}

/** Сообщение "миссия не найдена" с подсказкой init (используется в start/resume). */
function outputNoMissionFound(ctx: SlashCtx): void {
	const where = ctx.cwd ?? "current directory";
	ctx.output(`No mission found in ${where} — run \`fan mission init <slug>\` first`);
}

/**
 * Lazy-attach для /mission:start. Нашёл миссию → при необходимости FSM-переход
 * в active (completed → отказ или реактивация при unchecked-пунктах;
 * невозможный переход → отказ) → attach.
 * Возвращает true, если loop аттачен и можно тикать.
 */
async function lazyAttachForStart(ctx: SlashCtx): Promise<boolean> {
	if (!ctx.findAttachableMission || !ctx.attach) {
		return false; // DI не предоставлен — прежнее поведение (no-op)
	}
	const found = await ctx.findAttachableMission();
	if (!found) {
		outputNoMissionFound(ctx);
		return false;
	}
	if (found.status === "completed") {
		const hasUnchecked = await hasUncheckedRoadmapItems(found.missionDir);
		if (hasUnchecked) {
			await resolveWriteStatus(ctx)(found.missionDir, "active");
			ctx.attach(found.missionDir);
			ctx.output("Mission reactivated — new unchecked items found.");
			return true;
		}
		ctx.output(completedMissionHint(basename(found.missionDir)));
		return false;
	}
	if (found.status !== "active") {
		if (!canTransition(found.status, "active")) {
			ctx.output(`Cannot start mission in status "${found.status}" (FSM forbids transition to active)`);
			return false;
		}
		await resolveWriteStatus(ctx)(found.missionDir, "active");
	}
	ctx.attach(found.missionDir);
	return true;
}

/**
 * Lazy-attach для /mission:resume: аттачит только paused-миссию
 * (переход paused → active); прочие статусы/отсутствие миссии — сообщение.
 * Возвращает true, если loop аттачен.
 */
async function lazyAttachForResume(ctx: SlashCtx): Promise<boolean> {
	if (!ctx.findAttachableMission || !ctx.attach) {
		return false;
	}
	const found = await ctx.findAttachableMission();
	if (!found) {
		outputNoMissionFound(ctx);
		return false;
	}
	if (found.status !== "paused") {
		ctx.output(`Mission is not paused (status: ${found.status}) — nothing to resume`);
		return false;
	}
	await resolveWriteStatus(ctx)(found.missionDir, "active");
	ctx.attach(found.missionDir);
	ctx.output("Mission resumed — loop attached");
	return true;
}

/**
 * Lazy-attach для /mission:status (read-only, безопасно): аттачит первую
 * найденную миссию ЛЮБОГО статуса (включая completed), чтобы показать её
 * реальный статус. Ничего не найдено → без аттача, команда выведет
 * "No active mission".
 */
async function lazyAttachForStatus(ctx: SlashCtx): Promise<void> {
	if (!ctx.findAttachableMission || !ctx.attach) {
		return;
	}
	const found = await ctx.findAttachableMission();
	if (!found) {
		return;
	}
	ctx.attach(found.missionDir);
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

// ─── Idea command (shared by `/idea <text>` and `/mission idea <text>`) ─────

/**
 * Append an operator-sourced idea to the first mission's BACKLOG.md.
 * If the mission is not active (and the FSM allows), reactivate it so the
 * scorer/promoter can pick the idea up on the next tick.
 */
async function handleIdeaCommand(rawArgs: string, ctx: SlashCtx): Promise<void> {
	const ideaText = rawArgs.trim();
	if (!ideaText) {
		ctx.output("Error: usage /idea <text> or /mission idea <text>");
		return;
	}

	const finder = ctx.findAttachableMission;
	if (!finder) {
		ctx.output("Error: lazy-attach not available — cannot locate a mission");
		return;
	}

	const found = await finder();
	if (!found) {
		outputNoMissionFound(ctx);
		return;
	}

	const missionDir = found.missionDir;
	let entries: BacklogEntry[] = [];
	try {
		entries = await readBacklog(missionDir);
	} catch {
		entries = [];
	}

	const id = formatIdeaId(maxIdeaNumber(entries) + 1);
	const entry = formatIdeaEntry({
		id,
		date: new Date().toISOString(),
		idea: ideaText,
		source: "operator",
	});
	await appendBacklog(missionDir, entry);

	const mission = await readMission(missionDir);
	const currentStatus = String(mission.frontmatter.status);
	if (currentStatus !== "active" && canTransition(currentStatus, "active")) {
		await resolveWriteStatus(ctx)(missionDir, "active");
		ctx.output("Idea recorded — mission reactivated, it will be scored on the next tick.");
		return;
	}

	ctx.output("Idea recorded.");
}

// ─── Epic command (shared by `/epic <text>` and `/mission epic <text>`) ─────

/**
 * Append an operator-sourced EPIC item (`- [ ] [EPIC] <text>`) to the first
 * mission's ROADMAP.md. The [EPIC] marker triggers sub-orchestrator
 * decomposition on the next tick. If the mission is not active (and the FSM
 * allows), reactivate it so the epic is picked up.
 */
async function handleEpicCommand(rawArgs: string, ctx: SlashCtx): Promise<void> {
	const epicText = rawArgs.trim();
	if (!epicText) {
		ctx.output("Error: usage /epic <text> or /mission epic <text>");
		return;
	}

	const finder = ctx.findAttachableMission;
	if (!finder) {
		ctx.output("Error: lazy-attach not available — cannot locate a mission");
		return;
	}

	const found = await finder();
	if (!found) {
		outputNoMissionFound(ctx);
		return;
	}

	const missionDir = found.missionDir;
	const item = `- [ ] [EPIC] ${epicText}`;
	let raw = "";
	try {
		raw = await readRoadmap(missionDir);
	} catch {
		raw = "";
	}
	const content = raw && !raw.endsWith("\n") ? `${raw}\n${item}\n` : `${raw}${item}\n`;
	await writeRoadmap(missionDir, content);

	const mission = await readMission(missionDir);
	const currentStatus = String(mission.frontmatter.status);
	if (currentStatus !== "active" && canTransition(currentStatus, "active")) {
		await resolveWriteStatus(ctx)(missionDir, "active");
		ctx.output("EPIC added to ROADMAP — mission reactivated, it will be decomposed on the next tick.");
		return;
	}

	ctx.output("EPIC added to ROADMAP.");
}

// ─── `/mission` subcommand dispatcher ───────────────────────────────────────

/** Print a dim-style help list for the `/mission` dispatcher. */
function outputMissionHelp(ctx: SlashCtx, defs: ReadonlyMap<string, SlashCommandDef>, unknownSub?: string): void {
	const dim = "\x1b[2m";
	const reset = "\x1b[0m";
	const lines: string[] = [];
	if (unknownSub) {
		lines.push(`${dim}Unknown subcommand: ${unknownSub}${reset}`);
	}
	lines.push(`${dim}Usage: /mission <subcommand> [args]${reset}`);
	lines.push(`${dim}Subcommands:${reset}`);
	for (const [name, def] of defs) {
		lines.push(`${dim}  /mission ${name.padEnd(8)} — ${def.description}${reset}`);
	}
	ctx.output(lines.join("\n"));
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Зарегистрировать slash-команды миссии:
 *   - классические `/mission:*` (сохраняются как алиасы),
 *   - `/idea <text>` — запись идеи оператора,
 *   - `/epic <text>` — EPIC-пункт в ROADMAP (декомпозиция на следующем тике),
 *   - `/mission <subcommand>` — диспетчер через пробел.
 *
 * Маршрутизация по уровням прерываний (§3.2.2):
 *   /mission:stop   — I0 abort (actions.abort + missionLoop.abort + status=aborted)
 *   /mission:pause  — I1 drain (setDrainAfterCurrentTurn(true) + status=paused)
 *   /mission:steer  — I2 steer (sendMessage(..., { streamingBehavior: "steer" }))
 *   /mission:decide — I3 followUp (sendMessage(..., { streamingBehavior: "followUp" }))
 *   /mission:start|resume|status — управляющие команды.
 *   /mission:complete — завершение из awaiting_decision (дежурство продолжается).
 *   /mission:init   — создание миссии (описание позиционально или диалогами).
 */
export function registerMissionSlashCommands(register: SlashCommandRegister, registrationCtx: SlashCtx): void {
	// Collect subcommand definitions so the bare `/mission` dispatcher can
	// route to them and render a help list without duplicating handlers.
	const subcommandDefs = new Map<string, SlashCommandDef>();

	const wrappedRegister = (name: string, def: SlashCommandDef): void => {
		register(name, def);
		const shortName = name.replace(/^mission:/, "");
		if (name !== "mission") {
			subcommandDefs.set(shortName, def);
		}
	};

	wrappedRegister("mission:start", {
		description: "Start the mission loop (runs one tick)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				// Lazy-attach: loop не аттачен — найти миссию и аттачить (сообщения внутри).
				// Если lazyAttachForStart отработал — он уже вывел сообщение и (при
				// реактивации) перевёл статус в active; терминальный чек ниже не нужен.
				let justLazyAttached = false;
				if (!ctx.missionLoop) {
					if (!(await lazyAttachForStart(ctx))) {
						return;
					}
					justLazyAttached = true;
				}
				// Терминальный статус → tick в mission-loop — silent no-op:
				// явный фидбек вместо молчания (completed — с подсказкой ROADMAP/init
				// или реактивация при unchecked-пунктах).
				// Пропускаем для только что аттаченного через lazyAttachForStart —
				// он уже обработал реактивацию/подсказку.
				if (ctx.missionLoop && !justLazyAttached) {
					let status: string | null = null;
					try {
						status = String(await ctx.missionLoop.status());
					} catch {
						status = null; // статус не прочитался — tick разберётся сам
					}
					if (status && TERMINAL_STATUSES.has(status)) {
						if (status === "completed" && ctx.missionDir) {
							const hasUnchecked = await hasUncheckedRoadmapItems(ctx.missionDir);
							if (hasUnchecked) {
								const ws = resolveWriteStatus(ctx);
								await ws(ctx.missionDir, "active");
								ctx.output("Mission reactivated — new unchecked items found.");
								await ctx.missionLoop.tick();
								return;
							}
						}
						ctx.output(`Mission is ${status} — tick skipped.`);
						if (status === "completed") {
							ctx.output(completedMissionHint(ctx.missionDir ? basename(ctx.missionDir) : "<slug>"));
						}
						return;
					}
				}
				await ctx.missionLoop?.tick();
			}),
	});

	wrappedRegister("mission:stop", {
		description: "Stop the mission immediately (I0 abort)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				// Терминальный статус → FSM-переход в aborted невозможен: явный
				// фидбек вместо InvalidTransitionError или молчания.
				if (ctx.missionDir) {
					let current: string | null = null;
					try {
						const mission = await readMission(ctx.missionDir);
						current = String(mission.frontmatter.status);
					} catch {
						current = null; // MISSION.md не прочитался — обычный путь
					}
					if (current && TERMINAL_STATUSES.has(current)) {
						ctx.output(`Mission already ${current}.`);
						return;
					}
				}
				await ctx.actions.abort();
				if (ctx.missionLoop) await ctx.missionLoop.abort();
				if (ctx.missionDir) {
					await writeMissionStatus(ctx.missionDir, "aborted");
					ctx.output("Mission stopped (status: aborted).");
				} else {
					ctx.output("No active mission to stop — nothing attached.");
				}
			}),
	});

	wrappedRegister("mission:pause", {
		description: "Pause the mission after the current turn (I1 drain)",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				ctx.actions.setDrainAfterCurrentTurn(true);
				if (ctx.missionDir) await writeMissionStatus(ctx.missionDir, "paused");
			}),
	});

	wrappedRegister("mission:resume", {
		description: "Resume the mission after pause",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				// Lazy-attach: loop не аттачен — аттачить только paused-миссию.
				if (!ctx.missionLoop && !(await lazyAttachForResume(ctx))) {
					return;
				}
				ctx.actions.resume();
				ctx.actions.setDrainAfterCurrentTurn(false);
				if (ctx.missionDir) await resolveWriteStatus(ctx)(ctx.missionDir, "active");
			}),
	});

	wrappedRegister("mission:status", {
		description: "Show mission status, iteration, budget usage and current step",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				// Lazy-attach (read-only, безопасно): loop не аттачен — попробовать
				// найти и аттачить миссию любого статуса (включая completed),
				// чтобы показать её реальный статус.
				if (!ctx.missionLoop) {
					await lazyAttachForStatus(ctx);
				}

				if (ctx.getStatusSnapshot && ctx.missionLoop) {
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

	wrappedRegister("mission:steer", {
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

	wrappedRegister("mission:decide", {
		description: 'Answer a DECIDE interruption (I3 followUp): /mission:decide "<answer>"',
		handler: (args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				const answer = parseQuotedArg(args);
				if (!answer) {
					ctx.output('Error: usage /mission:decide "<answer>"');
					return;
				}
				// F-22: use resolveDecision for proper F-17 state transition
				// (awaiting_decision → active, records answer in DECISIONS.md,
				// updates BACKLOG DECIDE→ROADMAP on accept for promoter pickup).
				if (ctx.missionLoop) {
					try {
						await ctx.missionLoop.resolveDecision(answer);
						ctx.output("Decision recorded — mission resumed.");
					} catch (err) {
						ctx.output(`Error: ${err instanceof Error ? err.message : String(err)}`);
					}
				} else {
					await ctx.actions.sendMessage(answer, { streamingBehavior: "followUp" });
				}
			}),
	});

	// gmail-watch incident: прямой выход из карусели awaiting_decision →
	// planning → awaiting_decision. Оператор завершает миссию с вопроса;
	// дежурство по RECURRING.md продолжается через scheduler tick.
	wrappedRegister("mission:complete", {
		description: "Mark mission as completed (from awaiting_decision) — continue recurring duty only",
		handler: (_args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				if (!ctx.missionLoop) {
					ctx.output("Error: no mission attached. Use /mission:start or /mission:status first.");
					return;
				}
				try {
					await ctx.missionLoop.completeMission("operator via /mission:complete");
					ctx.output("Mission marked as completed — recurring duty (RECURRING.md) continues.");
				} catch (err) {
					ctx.output(`Error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}),
	});

	// 0.7.0: /mission:init <slug> [description] — создать миссию, не выходя из
	// сессии. Описание опционально: без него и при наличии ctx.ui.input Goal
	// запрашивается диалогами (Goal обязателен, Scope/Constraints — нет);
	// без UI (RPC/headless) миссия создаётся без описания (пустой Goal), как
	// раньше. Существующая миссия → ошибка через output.
	wrappedRegister("mission:init", {
		description: "Initialize a new mission: /mission:init <slug> [description]",
		handler: (args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				const trimmed = args.trim();
				if (!trimmed) {
					ctx.output("Error: usage /mission:init <slug> [description]");
					return;
				}

				// slug = первый токен (возможен в кавычках), description = остаток.
				let slug: string;
				let description = "";
				const firstChar = trimmed[0];
				if (firstChar === '"' || firstChar === "'") {
					const closing = trimmed.indexOf(firstChar, 1);
					if (closing > 0) {
						slug = trimmed.slice(1, closing);
						description = trimmed.slice(closing + 1).trim();
					} else {
						slug = trimmed.slice(1); // незакрытая кавычка — весь остаток это slug
					}
				} else {
					const spaceIdx = trimmed.search(/\s/);
					if (spaceIdx === -1) {
						slug = trimmed;
					} else {
						slug = trimmed.slice(0, spaceIdx);
						description = trimmed.slice(spaceIdx + 1).trim();
					}
				}
				description = parseQuotedArg(description);

				if (!slug) {
					ctx.output("Error: usage /mission:init <slug> [description]");
					return;
				}

				// Интерактивные диалоги (только TUI; RPC/headless — без них).
				if (!description && typeof ctx.ui?.input === "function") {
					const input = ctx.ui.input.bind(ctx.ui);
					const goal = await input("Mission Goal", "What should this mission achieve?");
					if (!goal || !goal.trim()) {
						ctx.output("Mission init cancelled — Goal is required.");
						return;
					}
					const parts = [goal.trim()];
					const scope = await input("Mission Scope (optional)", "Leave empty to skip");
					if (scope?.trim()) parts.push(`Scope: ${scope.trim()}`);
					const constraints = await input("Mission Constraints (optional)", "Leave empty to skip");
					if (constraints?.trim()) parts.push(`Constraints: ${constraints.trim()}`);
					description = parts.join("\n\n");
				}

				const baseDir = join(ctx.cwd ?? process.cwd(), "docs", "missions");
				const missionDir = join(baseDir, slug);
				if (existsSync(join(missionDir, "MISSION.md"))) {
					// MissionAlreadyExistsError (аналог CLI missionInit)
					throw new Error(`Mission "${slug}" already exists at ${missionDir}`);
				}
				const dir = await initMission(slug, { baseDir, ...(description ? { description } : {}) });
				ctx.output(`Mission ${slug} initialized at ${dir}. Start with /mission:start.`);
			}),
	});

	// Part 2: /idea <text> — append an operator idea to BACKLOG.md and
	// reactivate the mission when possible.
	wrappedRegister("idea", {
		description: "Record an idea in the mission backlog: /idea <text>",
		handler: (args, ctx = registrationCtx) => guarded(ctx.output, () => handleIdeaCommand(args, ctx)),
	});

	// Part 3: /epic <text> — append an [EPIC] item to ROADMAP.md and
	// reactivate the mission when possible.
	wrappedRegister("epic", {
		description: "Add an EPIC item to the mission roadmap: /epic <text>",
		handler: (args, ctx = registrationCtx) => guarded(ctx.output, () => handleEpicCommand(args, ctx)),
	});

	// Part 1: /mission <subcommand> — space-separated dispatcher; bare `/mission`
	// prints a dim help list. Old `/mission:*` commands remain as aliases.
	register("mission", {
		description: "Mission commands: init, start, stop, pause, resume, status, steer, decide, complete, idea, epic",
		handler: (args, ctx = registrationCtx) =>
			guarded(ctx.output, async () => {
				const trimmed = args.trim();
				if (!trimmed) {
					outputMissionHelp(ctx, subcommandDefs);
					return;
				}
				const spaceIdx = trimmed.search(/\s/);
				const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
				const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trimStart();
				const def = subcommandDefs.get(sub);
				if (!def) {
					outputMissionHelp(ctx, subcommandDefs, sub);
					return;
				}
				await def.handler(rest, ctx);
			}),
	});
}
