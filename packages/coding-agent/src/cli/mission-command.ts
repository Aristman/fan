// F-10: CLI `fan mission <subcommand>` — init + lifecycle subcommands.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-10
// Спека:   docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.2, §6.1
//
// Команда условна: требует расширение `fan-mission`. Файловое хранилище
// (F-08) подключается динамически из `extensions/fan-mission/file-state-manager.ts`,
// чтобы не ломать rootDir сборки coding-agent и не падать, когда расширение
// отсутствует (в этом случае бросается MissionExtensionMissingError).
//
// Субкоманды: init, start, stop, status, pause, resume.
// start/stop/pause/resume — проверки + FSM-переходы через file-state-manager;
// реальный executor подключается на этапе 1 через F-09 (сейчас start — no-op).

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MISSION_FILES = ["MISSION.md", "ROADMAP.md", "STATE.md", "BACKLOG.md", "DECISIONS.md"] as const;

const SUBCOMMANDS = ["init", "start", "stop", "status", "pause", "resume"] as const;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class MissionAlreadyExistsError extends Error {
	constructor(slug: string, missionDir: string) {
		super(`Mission "${slug}" already exists at ${missionDir}`);
		this.name = "MissionAlreadyExistsError";
	}
}

export class MissionNotInitializedError extends Error {
	constructor(dir: string) {
		super(`No mission initialized in ${dir}. Run "fan mission init <slug>" first.`);
		this.name = "MissionNotInitializedError";
	}
}

export class MissionExtensionMissingError extends Error {
	constructor(detail?: string) {
		super(detail ? `${detail} — extension "fan-mission" is not loaded` : 'Extension "fan-mission" is not loaded');
		this.name = "MissionExtensionMissingError";
	}
}

export class InvalidTransitionError extends Error {
	readonly from: string;
	readonly to: string;
	constructor(from: string, to: string) {
		super(`Invalid status transition: ${from} → ${to}`);
		this.name = "InvalidTransitionError";
		this.from = from;
		this.to = to;
	}
}

// ─── Context ────────────────────────────────────────────────────────────────

export interface MissionContext {
	/** DI: проверка загрузки расширения (по умолчанию fan-mission считается встроенным). */
	isExtensionLoaded?: (name: string) => boolean;
	/** Базовый каталог миссий (по умолчанию `docs/missions`). */
	baseDir?: string;
}

// ─── file-state-manager (F-08) dynamic loader ───────────────────────────────

interface FileStateManagerModule {
	MISSION_FILES: readonly string[];
	validateSlug(slug: string): void;
	initMission(slug: string, opts?: { baseDir?: string; template?: string }): Promise<string>;
	readMission(missionDir: string): Promise<{ frontmatter: Record<string, unknown>; body: string }>;
	readState(missionDir: string): Promise<{ done: string[]; blockers: string[]; nextSteps: string[] }>;
	writeMissionStatus(missionDir: string, newStatus: string): Promise<void>;
	canTransition(from: string, to: string): boolean;
	InvalidTransitionError: typeof InvalidTransitionError;
}

let fsmCache: FileStateManagerModule | undefined;

async function loadFileStateManager(): Promise<FileStateManagerModule> {
	if (fsmCache) return fsmCache;

	const here = new URL(".", import.meta.url);
	const candidates: string[] = [];
	if (process.env.FAN_MISSION_DIR) {
		// P-4: try .js first, then .ts fallback for dev with tsx-loader.
		candidates.push(resolve(process.env.FAN_MISSION_DIR, "file-state-manager.js"));
		candidates.push(resolve(process.env.FAN_MISSION_DIR, "file-state-manager.ts"));
	}
	for (const ext of ["js", "ts"]) {
		// Монорепо: <root>/packages/coding-agent/src/cli → <root>/extensions/fan-mission
		candidates.push(fileURLToPath(new URL(`../../../../extensions/fan-mission/file-state-manager.${ext}`, here)));
		// Запуск из корня монорепо (например, из собранного бандла другой глубины).
		candidates.push(resolve("extensions", "fan-mission", `file-state-manager.${ext}`));
	}

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const mod = (await import(pathToFileURL(candidate).href)) as FileStateManagerModule;
			fsmCache = mod;
			return mod;
		} catch (err) {
			// Log and continue to next candidate
			console.error(
				`[mission] Failed to load file-state-manager from ${candidate}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	throw new MissionExtensionMissingError("file-state-manager module not found");
}

// ─── Mission directory resolution ───────────────────────────────────────────

function resolveMissionDir(missionDir: string | undefined, baseDir: string | undefined): string {
	if (missionDir) return resolve(missionDir);
	const base = resolve(baseDir ?? join("docs", "missions"));
	if (existsSync(join(base, "MISSION.md"))) return base;
	if (existsSync(base)) {
		let entries: string[] = [];
		try {
			entries = readdirSync(base, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			entries = [];
		}
		for (const name of entries) {
			const candidate = join(base, name);
			if (existsSync(join(candidate, "MISSION.md"))) {
				// P-8: log auto-detected mission slug to stderr.
				console.error(`[mission] auto-detected mission: ${name}`);
				return candidate;
			}
		}
	}
	return base;
}

async function requireMissionDir(missionDir: string | undefined, ctx: MissionContext | undefined): Promise<string> {
	const dir = resolveMissionDir(missionDir, ctx?.baseDir);
	if (!existsSync(join(dir, "MISSION.md"))) {
		throw new MissionNotInitializedError(dir);
	}
	return dir;
}

async function readStatus(fsm: FileStateManagerModule, missionDir: string): Promise<string> {
	const { frontmatter } = await fsm.readMission(missionDir);
	return String(frontmatter.status ?? "active");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function listMissionSubcommands(): string[] {
	return [...SUBCOMMANDS];
}

/**
 * Создать миссию: `<baseDir>/<slug>/` с 5 файлами-шаблонами.
 * Делегирует создание и валидацию slug в file-state-manager (F-08).
 */
export async function missionInit(slug: string, opts?: { baseDir?: string; template?: string }): Promise<string> {
	const fsm = await loadFileStateManager();
	fsm.validateSlug(slug);
	const baseDir = opts?.baseDir ?? join("docs", "missions");
	const missionDir = resolve(baseDir, slug);
	if (existsSync(missionDir)) {
		throw new MissionAlreadyExistsError(slug, missionDir);
	}
	return fsm.initMission(slug, { baseDir, template: opts?.template });
}

/**
 * Запустить миссию. Заглушка: реальный executor подключается через F-09
 * (этап 1). Сейчас — проверка наличия миссии и статуса active.
 * P-5: использует FSM-переходы; для aborted/failed/budget_exhausted
 * предлагает resume.
 */
export async function missionStart(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "active") {
		const { frontmatter } = await fsm.readMission(dir);
		console.log(`Mission ${frontmatter.mission_id} is active at ${dir}`);
		console.log("(executor not attached yet — mission-loop integration lands with F-09)");
		return;
	}
	// Check if FSM allows transitioning to active (aborted, failed, budget_exhausted do).
	if (fsm.canTransition(status, "active")) {
		throw new InvalidTransitionError(status, "active");
	}
	throw new InvalidTransitionError(status, "active");
}

/** Остановить миссию (FSM: active/paused → aborted). */
export async function missionStop(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "completed" || status === "aborted") {
		console.log(`Mission already ${status} at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "aborted")) {
		throw new InvalidTransitionError(status, "aborted");
	}
	await fsm.writeMissionStatus(dir, "aborted");
	console.log(`Mission stopped (aborted) at ${dir}`);
}

/** Показать состояние миссии: frontmatter + сводка STATE.md. */
export async function missionStatus(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const { frontmatter } = await fsm.readMission(dir);
	console.log(`Mission:  ${frontmatter.mission_id}`);
	console.log(`Dir:      ${dir}`);
	console.log(`Status:   ${frontmatter.status}`);
	console.log(`Created:  ${frontmatter.created}`);
	console.log(`Metric:   ${frontmatter.metric_type} (${frontmatter.metric_command})`);
	console.log(`Budget:   ${frontmatter.budget_tokens} tokens / $${frontmatter.budget_usd}`);
	const state = await fsm.readState(dir).catch(() => undefined);
	if (state) {
		console.log(
			`Done:     ${state.done.length} item(s); blockers: ${state.blockers.length}; next: ${state.nextSteps.length}`,
		);
	}
}

/** Поставить миссию на паузу (FSM: active → paused). */
export async function missionPause(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "paused") {
		console.log(`Mission already paused at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "paused")) {
		throw new InvalidTransitionError(status, "paused");
	}
	await fsm.writeMissionStatus(dir, "paused");
	console.log(`Mission paused at ${dir}`);
}

/** Возобновить миссию (FSM: paused/aborted/failed/budget_exhausted → active). */
export async function missionResume(missionDir?: string, ctx?: MissionContext): Promise<void> {
	const fsm = await loadFileStateManager();
	const dir = await requireMissionDir(missionDir, ctx);
	const status = await readStatus(fsm, dir);
	if (status === "active") {
		console.log(`Mission already active at ${dir}`);
		return;
	}
	if (!fsm.canTransition(status, "active")) {
		throw new InvalidTransitionError(status, "active");
	}
	await fsm.writeMissionStatus(dir, "active");
	console.log(`Mission resumed at ${dir}`);
}

// ─── CLI dispatcher ─────────────────────────────────────────────────────────

/**
 * Parse --template flag from args. Supports:
 *   --template <name>
 *   --template=<name>
 * Returns undefined if not present.
 */
function parseTemplateFlag(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--template" && i + 1 < args.length) {
			return args[i + 1];
		}
		if (arg.startsWith("--template=")) {
			return arg.slice("--template=".length);
		}
	}
	return undefined;
}

/**
 * Диспетчер `fan mission <subcommand>`.
 * Возвращает false, если args не относится к команде mission (другие
 * хендлеры продолжают), либо для неизвестной субкоманды.
 */
export async function handleMissionCommand(args: string[], ctx?: MissionContext): Promise<boolean> {
	if (args[0] !== "mission") return false;

	// Условная регистрация: без расширения fan-mission команда не выполняется.
	const isExtensionLoaded = ctx?.isExtensionLoaded ?? (() => true);
	if (!isExtensionLoaded("fan-mission")) {
		console.error('Command "mission" requires the fan-mission extension, which is not loaded.');
		process.exit(1);
		return false;
	}

	const subcommand = args[1];
	try {
		switch (subcommand) {
			case "init": {
				// Extract slug: first non-flag arg after "init", skipping known flags.
				const initArgs = args.slice(2);
				let slug: string | undefined;
				for (let i = 0; i < initArgs.length; i++) {
					const a = initArgs[i];
					if (a === "--template") {
						i++;
						continue;
					} // skip flag + value
					if (a.startsWith("--")) continue; // skip other flags
					slug = a;
					break;
				}
				if (!slug) {
					console.error("Usage: fan mission init <slug> [--template <name>]");
					process.exit(1);
					return false;
				}
				const template = parseTemplateFlag(initArgs);
				const initOpts: { baseDir?: string; template?: string } = {};
				if (ctx?.baseDir) initOpts.baseDir = ctx.baseDir;
				if (template) initOpts.template = template;
				const dir = await missionInit(slug, Object.keys(initOpts).length > 0 ? initOpts : undefined);
				console.log(`Mission initialized: ${dir}`);
				return true;
			}
			case "start":
				await missionStart(undefined, ctx);
				return true;
			case "stop":
				await missionStop(undefined, ctx);
				return true;
			case "status":
				await missionStatus(undefined, ctx);
				return true;
			case "pause":
				await missionPause(undefined, ctx);
				return true;
			case "resume":
				await missionResume(undefined, ctx);
				return true;
			default: {
				console.error(
					`Unknown mission subcommand: ${subcommand ?? "(none)"}. Usage: fan mission <${listMissionSubcommands().join("|")}>`,
				);
				return false;
			}
		}
	} catch (err) {
		const known =
			err instanceof MissionAlreadyExistsError ||
			err instanceof MissionNotInitializedError ||
			err instanceof MissionExtensionMissingError ||
			err instanceof InvalidTransitionError ||
			(err instanceof Error && err.name === "InvalidSlug") ||
			(err instanceof Error && err.name === "InvalidTransitionError");
		if (known) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
			return false;
		}
		throw err;
	}
}
