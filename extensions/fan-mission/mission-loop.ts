// F-09: Mission loop — deterministic 7-step external cycle for the FAN super-orchestrator.
// Each tick() executes: wake → read → decide → iterate → verify → commit → backlog.
// Stateless recovery via `.mission-loop.json` (survives process crashes between ticks).
//
// Deep-fix (P0-1..P2-9): per-step journal, abort signal, atomic step 6,
// budget_usd enforcement, STATE.md auto-archiving, file-lock, CRLF preservation.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_DELEGATION_TIMEOUT_MS,
	type EpicEventBus,
	type EpicRunAgent,
	isEpicItem,
	runEpicDelegation,
} from "./epic-delegation.js";
import {
	ARCHIVE_KEEP_COUNT,
	appendDecision,
	appendRecurringItems,
	archiveOldDoneItems,
	type BacklogEntry,
	canTransition,
	checkStateFileSize,
	extractGoal,
	InvalidTransitionError,
	isRecurringDue,
	isRecurringItem,
	MAX_STATE_BYTES,
	type MissionState,
	markRecurringRun,
	parseAllUnchecked,
	readBacklog,
	readMission,
	readRecurring,
	readRecurringState,
	readRoadmap,
	readState,
	updateBacklogEntry,
	writeMissionStatus,
	writeRecurringState,
	writeRoadmap,
	writeState,
} from "./file-state-manager.js";
import { type PromiseParseResult, parsePromise } from "./promise-parser.js";
import { buildExecutionPrompt, PLANNING_ITEM_TEXT } from "./prompt-builder.js";
import type { VerificationLadder, VerificationLadderResult } from "./verification-ladder.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MissionStatus =
	| "active"
	| "paused"
	| "completed"
	| "aborted"
	| "failed"
	| "budget_exhausted"
	| "awaiting_decision"
	| "busy";

export interface IterationResult {
	status: "COMPLETE" | "BLOCKED" | "DECIDE" | "FAILED";
	reason?: string;
	question?: string;
	commitMessage?: string;
	costTokens?: number;
	costUsd?: number;
	/** F-17: raw LLM response — parsed via parsePromise() for promise tags (DECIDE). */
	response?: string;
}

export interface MissionExecutor {
	runIteration(opts: {
		missionDir: string;
		prompt: string;
		cwd: string;
		/** F-15: pending operator steer message(s) for this iteration. */
		steer?: string;
	}): Promise<IterationResult>;
}

export interface MissionGit {
	commit(opts: { cwd: string; message: string; files: string[] }): Promise<{ hash: string }>;
	log(opts: { cwd: string; maxCount?: number }): Promise<Array<{ hash: string; subject: string; date: string }>>;
	status(opts: { cwd: string }): Promise<{ clean: boolean }>;
}

export interface MissionClock {
	now(): Date | Promise<Date>;
}

export interface MissionLock {
	acquire(): Promise<boolean>;
	release(): Promise<void>;
}

export interface MissionLoopDeps {
	executor: MissionExecutor;
	git: MissionGit;
	clock: MissionClock;
	lock?: MissionLock;
	/** ralph-loop (S3): session rotator for `session_mode: fresh`. Absent →
	 * fresh mode degrades to persistent with a one-time warn. */
	sessionRotator?: MissionSessionRotator;
	/** ralph-loop incident fix: optional operator notification channel for
	 * visible degradation alerts (rotation cancelled/failed, rotator missing).
	 * Without it the persistent fallback was invisible outside console logs. */
	notify?: (msg: string) => void;
}

/**
 * ralph-loop (S3): DI session rotator. Called by tick() AFTER the tick fully
 * finalised (writeLoopStateSync lastStep=7, interrupted=false) and released the
 * lock, when fresh-mode work remains (LoopState.resumeAfterRotation).
 * `{cancelled: true}` → the loop clears the flag, warns and falls back to
 * persistent mode for the rest of the process.
 */
export interface MissionSessionRotator {
	rotate(): Promise<{ cancelled: boolean }>;
}

/** Phase B (F-19): DI idea generator hook — called after each completed iteration. */
export interface MissionIdeaGenerator {
	generate(missionDir: string): Promise<{ added: number; skippedDuplicates: number }>;
}

/** Phase B (F-20): DI idea scorer hook — scores unscored BACKLOG ideas (status "IDEA"). */
export interface MissionIdeaScorer {
	scoreIdea(
		missionDir: string,
		idea: { id: string; idea: string; source: string },
	): Promise<{ id: string; score: number; status: "ROADMAP" | "DECIDE" | "REJECTED" }>;
}

/** Phase B (F-21): DI metrics collector hook — records each iteration outcome. */
export interface MissionMetricsHook {
	onIterationEnd(missionDir: string, record: Record<string, unknown>): Promise<void>;
}

/** F-22: DI idea promoter hook — moves ROADMAP ideas from BACKLOG to ROADMAP.md. */
export interface MissionIdeaPromoter {
	promote(missionDir: string): Promise<{ promoted: string[] }>;
}

/** F-18: escalation payload for promise-tag routing (I3 level). */
export interface EscalationPayload {
	tag: string | null;
	reason?: string;
	iteration: number;
}

export interface TickSteps {
	wake: boolean;
	read: boolean;
	decide: boolean;
	iterate: boolean;
	verify: boolean;
	commit: boolean;
	backlog: boolean;
}

export interface TickResult {
	iteration: number;
	steps: TickSteps;
	status: MissionStatus;
	interrupted?: boolean;
	item?: string;
	/** 0.8.0: number of roadmap items executed during this tick. */
	itemsExecuted?: number;
}

export interface LoopState {
	currentIteration: number;
	lastStep: number;
	interrupted: boolean;
	budgetUsed: { tokens: number; usd: number };
	// P0-1: persisted iteration result for recovery after step 4
	iterationResult?: IterationResult;
	// P0-1: roadmap item being processed (survives crash)
	pendingItem?: string;
	pendingItemIndex?: number;
	// P0-1: whether step 6 commit was completed
	committed?: boolean;
	// P0-2: abort signal persisted by abort()
	abortedByOperator?: boolean;
	// P1-1: which item the step 5 budget increment was persisted for (prevents double-count on recovery)
	budgetCountedFor?: string | null;
	// F-17: pending DECIDE question (survives restarts, consumed by resolveDecision)
	pendingDecision?: { question: string; date: string };
	// F-17: operator answer to a DECIDE question (consumed by the next tick)
	pendingOperatorAnswer?: string;
	// F-22: idea id associated with a pending DECIDE (so resolveDecision can
	// update the BACKLOG entry to ROADMAP on accept, enabling promoter pickup)
	pendingDecisionIdeaId?: string;
	// F-22: number of ideas promoted in the last tick (for observability)
	lastPromotedCount?: number;
	// 0.7.2: consecutive empty planning iterations (backlog #32 cap)
	emptyPlanningStreak?: number;
	// ralph-loop (S3): fresh-mode rotation request — set only after a fully
	// persisted finalise (lastStep=7, interrupted=false); consumed by the
	// session_start wiring (S5) which resets it and auto-continues the loop.
	resumeAfterRotation?: boolean;
}

// ─── Loop state persistence (.mission-loop.json) ────────────────────────────

const LOOP_STATE_FILE = ".mission-loop.json";
const ABORT_SIGNAL_FILE = ".mission-abort-signal";

function defaultLoopState(): LoopState {
	return {
		currentIteration: 0,
		lastStep: 0,
		interrupted: false,
		budgetUsed: { tokens: 0, usd: 0 },
	};
}

export async function readMissionLoopState(missionDir: string): Promise<LoopState> {
	const filePath = join(missionDir, LOOP_STATE_FILE);
	if (!existsSync(filePath)) {
		return defaultLoopState();
	}
	const raw = readFileSync(filePath, "utf8");
	return { ...defaultLoopState(), ...JSON.parse(raw) };
}

export function writeLoopStateSync(missionDir: string, state: LoopState): void {
	const filePath = join(missionDir, LOOP_STATE_FILE);
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	const content = JSON.stringify(state, null, 2);
	try {
		writeFileSync(tmpPath, content, "utf8");
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath);
			}
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}

// ─── F-15: drain & steer signals (file-based, shared loop state) ────────────

const DRAIN_SIGNAL_FILE = ".mission-drain-flag";
const STEER_QUEUE_FILE = ".mission-steer-queue.json";

/**
 * F-15: set/clear the drain signal for a mission dir.
 * When set, the next MissionLoop.tick() finishes without starting a new
 * iteration and pauses the mission (MISSION.md status → "paused").
 */
export function setDrainSignal(missionDir: string, value: boolean): void {
	const signalPath = join(missionDir, DRAIN_SIGNAL_FILE);
	if (value) {
		writeFileSync(signalPath, JSON.stringify({ drainAfterCurrentTurn: true, ts: Date.now() }), "utf8");
		return;
	}
	try {
		if (existsSync(signalPath)) unlinkSync(signalPath);
	} catch {
		// best-effort
	}
}

function readDrainSignal(missionDir: string): boolean {
	return existsSync(join(missionDir, DRAIN_SIGNAL_FILE));
}

/**
 * F-15: append a steer message to the mission's steer queue.
 * The queue is consumed by the next MissionLoop.tick() (step 4) and passed
 * to executor.runIteration as opts.steer (and appended to the prompt).
 */
export function appendSteerMessage(missionDir: string, text: string): void {
	const queuePath = join(missionDir, STEER_QUEUE_FILE);
	const queue = readSteerQueue(missionDir);
	queue.push(text);
	const tmpPath = `${queuePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(queue, null, 2), "utf8");
		renameSync(tmpPath, queuePath);
	} catch (err) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}

function readSteerQueue(missionDir: string): string[] {
	const queuePath = join(missionDir, STEER_QUEUE_FILE);
	if (!existsSync(queuePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(queuePath, "utf8"));
		if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		// corrupted queue — treat as empty
	}
	return [];
}

/**
 * F-15: read and clear the steer queue (consumed by MissionLoop step 4).
 */
export function consumeSteerQueue(missionDir: string): string[] {
	const queue = readSteerQueue(missionDir);
	if (queue.length > 0) {
		try {
			unlinkSync(join(missionDir, STEER_QUEUE_FILE));
		} catch {
			// best-effort
		}
	}
	return queue;
}

// ─── Abort signal (lock-free) ───────────────────────────────────────────────

function writeAbortSignal(missionDir: string): void {
	const signalPath = join(missionDir, ABORT_SIGNAL_FILE);
	writeFileSync(signalPath, JSON.stringify({ abortedByOperator: true, ts: Date.now() }), "utf8");
}

function readAbortSignal(missionDir: string): boolean {
	const signalPath = join(missionDir, ABORT_SIGNAL_FILE);
	return existsSync(signalPath);
}

function clearAbortSignal(missionDir: string): void {
	const signalPath = join(missionDir, ABORT_SIGNAL_FILE);
	try {
		if (existsSync(signalPath)) unlinkSync(signalPath);
	} catch {
		// best-effort
	}
}

// ─── ROADMAP helpers ────────────────────────────────────────────────────────

function markRoadmapDone(raw: string, lineIndex: number, itemText?: string): string {
	// 0.7.3: recurring items are NEVER marked [x] — they stay unchecked
	// so the mission loop keeps executing them every tick (watch-loop semantics).
	if (itemText !== undefined && isRecurringItem(itemText)) {
		return raw;
	}
	const lines = raw.split("\n");
	const uncheckedTextAt = (i: number): string | null => {
		if (i < 0 || i >= lines.length) return null;
		const m = /^[-*] \[ \] (.+)$/.exec(lines[i].trim());
		return m ? m[1] : null;
	};
	let target = -1;
	const textAtIndex = uncheckedTextAt(lineIndex);
	if (textAtIndex !== null && (itemText === undefined || textAtIndex === itemText)) {
		target = lineIndex;
	} else if (itemText !== undefined) {
		// 0.7.0: the executor may have edited ROADMAP.md during the iteration
		// (bootstrap planning appends items) — lines can shift, so fall back
		// to locating the item by its text.
		for (let i = 0; i < lines.length; i++) {
			if (uncheckedTextAt(i) === itemText) {
				target = i;
				break;
			}
		}
	}
	if (target >= 0) {
		// Replace only the checkbox state, preserving the original list marker
		// (`-` or `*` — both are valid markdown).
		lines[target] = lines[target].replace("[ ] ", "[x] ");
	}
	return lines.join("\n");
}

function isRoadmapItemChecked(raw: string, lineIndex: number): boolean {
	const lines = raw.split("\n");
	if (lineIndex < 0 || lineIndex >= lines.length) return false;
	return /^[-*] \[x\] /.test(lines[lineIndex].trim());
}

/**
 * True if the ROADMAP contains at least one checklist item (checked or not).
 * Used to distinguish "all items done" from "no parseable checklist at all"
 * — the latter must NOT be treated as mission completion.
 */
function hasAnyChecklistItem(raw: string): boolean {
	for (const line of raw.split("\n")) {
		if (/^[-*] \[[x ]\] /.test(line.trim())) return true;
	}
	return false;
}

// ─── File lock (P1-6) ───────────────────────────────────────────────────────

const LOCK_FILE = ".mission-loop.lock";

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a file-based inter-process lock for the mission directory.
 * Lock file `.mission-loop.lock` stores {pid, timestamp}.
 *
 * Acquire semantics:
 *   - File exists AND process is alive AND timestamp < 60 s → deny (busy)
 *   - File exists but process is dead OR timestamp ≥ 60 s → take over (stale)
 *   - File doesn't exist → acquire
 *
 * Release: delete the lock file.
 */
export function createFileLock(missionDir: string): MissionLock {
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	const stopHeartbeat = (): void => {
		if (heartbeatInterval !== null) {
			clearInterval(heartbeatInterval);
			heartbeatInterval = null;
		}
	};

	const startHeartbeat = (): void => {
		stopHeartbeat();
		const lockPath = join(missionDir, LOCK_FILE);
		heartbeatInterval = setInterval(() => {
			try {
				writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
			} catch {
				// best-effort: if write fails, stale-takeover will kick in
			}
		}, 30_000);
		// Don't keep the process alive just for the heartbeat
		if (
			typeof heartbeatInterval === "object" &&
			heartbeatInterval !== null &&
			typeof heartbeatInterval.unref === "function"
		) {
			heartbeatInterval.unref();
		}
	};

	return {
		async acquire(): Promise<boolean> {
			const lockPath = join(missionDir, LOCK_FILE);
			if (existsSync(lockPath)) {
				try {
					const data = JSON.parse(readFileSync(lockPath, "utf8"));
					const pid = data.pid as number;
					const ts = data.timestamp as number;
					const age = Date.now() - ts;
					if (isProcessAlive(pid) && age < 60_000) {
						return false; // busy
					}
					// stale lock — take over
				} catch {
					// corrupted lock file — take over
				}
			}
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
			startHeartbeat();
			return true;
		},
		async release(): Promise<void> {
			stopHeartbeat();
			const lockPath = join(missionDir, LOCK_FILE);
			try {
				if (existsSync(lockPath)) unlinkSync(lockPath);
			} catch {
				// best-effort
			}
		},
	};
}

// ─── MissionLoop ────────────────────────────────────────────────────────────

/** 0.7.2: infra-error patterns — these are runner noise, not mission blockers. */
const INFRA_ERROR_PATTERNS: RegExp[] = [/^runAgent already in flight/, /^Lock is busy/, /^runAgent timeout/];

/** Check if an error message matches infra-error patterns (runner noise). */
export function isInfraError(message: string): boolean {
	return INFRA_ERROR_PATTERNS.some((p) => p.test(message));
}

export class MissionLoop {
	private missionDir: string;
	private deps: MissionLoopDeps;
	private lock: MissionLock;
	// F-15: optional DI drain flag (checked in addition to the file signal)
	private drainFlag?: () => boolean;
	// F-17: DECIDE wait timeout (default 1 hour) and its pending timer
	private decideTimeoutMs: number;
	private decideTimer?: ReturnType<typeof setTimeout>;
	// F-18: verification ladder injected for step 5 (verify) of COMPLETE iterations
	private verificationLadder?: VerificationLadder;
	// F-18: escalation callback (I3) for promise-tag routing (no tag / BLOCKED)
	private onEscalate?: (level: string, payload: EscalationPayload) => void;
	// Phase B (F-19/F-20/F-21): optional DI hooks — without injection the loop
	// behaves exactly as before (backward compat).
	private ideaGenerator?: MissionIdeaGenerator;
	private ideaScorer?: MissionIdeaScorer;
	private metricsCollector?: MissionMetricsHook;
	private ideaPromoter?: MissionIdeaPromoter;
	// F-48.5: EPIC delegation deps (runAgent декомпозиции + EventBus мост).
	// Без инъекции [EPIC]-пункты исполняются локально (как обычные).
	private epicRunAgent?: EpicRunAgent;
	private epicEventBus?: EpicEventBus;
	private delegationTimeoutMs: number;
	// F-48.5: cleanup pending-делегирования (отписка reply при abort/shutdown).
	private pendingDelegationCleanup?: (() => void) | null;
	// 0.7.2: in-memory reentrancy guard (defence-in-depth with file lock)
	private tickRunning = false;
	// ralph-loop (S3): session mode resolved once per tick from MISSION.md
	// frontmatter (immutable after init). 'fresh' requires an injected
	// sessionRotator; without it the mode degrades to persistent.
	private sessionMode: "fresh" | "persistent" = "persistent";
	// ralph-loop (S3): after a cancelled rotation the mission runs persistent
	// for the rest of the process (rotation is not retried).
	private rotationFallbackPersistent = false;
	private rotatorMissingWarned = false;

	constructor(opts: {
		missionDir: string;
		deps: MissionLoopDeps;
		drainFlag?: () => boolean;
		decideTimeoutMs?: number;
		verificationLadder?: VerificationLadder;
		onEscalate?: (level: string, payload: EscalationPayload) => void;
		ideaGenerator?: MissionIdeaGenerator;
		ideaScorer?: MissionIdeaScorer;
		metricsCollector?: MissionMetricsHook;
		/** F-22: DI idea promoter (BACKLOG→ROADMAP promotion after scoring). */
		ideaPromoter?: MissionIdeaPromoter;
		/** F-48.5: runAgent декомпозиции [EPIC]-пунктов (делегирование). */
		runAgent?: EpicRunAgent;
		/** F-48.5: EventBus для моста mission_delegate (делегирование). */
		eventBus?: EpicEventBus;
		/** F-48.5: таймаут ожидания ответа делегирования (default 30 мин). */
		delegationTimeoutMs?: number;
	}) {
		this.missionDir = opts.missionDir;
		this.deps = opts.deps;
		this.drainFlag = opts.drainFlag;
		this.decideTimeoutMs = opts.decideTimeoutMs ?? 3_600_000;
		this.verificationLadder = opts.verificationLadder;
		this.onEscalate = opts.onEscalate;
		this.ideaGenerator = opts.ideaGenerator;
		this.ideaScorer = opts.ideaScorer;
		this.metricsCollector = opts.metricsCollector;
		this.ideaPromoter = opts.ideaPromoter;
		// F-48.5: EPIC delegation wiring (оба deps обязательны для делегирования)
		this.epicRunAgent = opts.runAgent;
		this.epicEventBus = opts.eventBus;
		this.delegationTimeoutMs = opts.delegationTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
		// P1-6: use provided lock or default file-lock
		this.lock = opts.deps.lock ?? createFileLock(opts.missionDir);
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * 0.7.2: check if a tick is currently running (in-memory reentrancy guard).
	 * Used by tick-bridge to skip ticks while the loop is busy.
	 */
	isTickRunning(): boolean {
		return this.tickRunning;
	}

	async tick(): Promise<TickResult> {
		let result: TickResult;
		try {
			result = await this._tickInner();
		} catch (err) {
			// ralph-loop incident fix: even when the tick died, still attempt
			// rotation — resumeAfterRotation may be persisted on disk from a
			// previous iteration, and a fresh session is the recovery path for
			// a wedged persistent session (e.g. bloated STATE.md killing every
			// tick in the same session). maybeRotateSession never throws
			// (rotator errors are caught inside). The tick error is rethrown.
			await this.maybeRotateSession();
			throw err;
		}
		// ralph-loop (S3): session rotation happens AFTER the tick fully
		// finalised and the lock was released (finally inside _tickInner).
		await this.maybeRotateSession();
		return result;
	}

	/**
	 * ralph-loop (S3): resolve the session mode once per tick from MISSION.md
	 * frontmatter (`session_mode`). 'fresh' requires an injected sessionRotator;
	 * without it (or after a cancelled rotation) the mode degrades to
	 * persistent — with a one-time warn for the missing rotator.
	 */
	private resolveSessionMode(rawMode: unknown): "fresh" | "persistent" {
		if (String(rawMode) !== "fresh") return "persistent";
		if (this.rotationFallbackPersistent) return "persistent";
		if (!this.deps.sessionRotator) {
			if (!this.rotatorMissingWarned) {
				this.rotatorMissingWarned = true;
				console.warn(
					`[fan-mission] session_mode: fresh but no sessionRotator injected — degrading to persistent (missionDir: ${this.missionDir})`,
				);
				this.notifyOperator(
					"⚠️ session_mode: fresh but no sessionRotator injected — mission degrades to persistent mode",
				);
			}
			return "persistent";
		}
		return "fresh";
	}

	/**
	 * ralph-loop incident fix: best-effort operator notification. Never throws —
	 * a broken notify channel must not kill the tick or the rotation path.
	 */
	private notifyOperator(msg: string): void {
		try {
			this.deps.notify?.(msg);
		} catch {
			// best-effort — console.warn already emitted by the caller
		}
	}

	/**
	 * ralph-loop (S3): post-tick session rotation. Runs after _tickInner()'s
	 * finally (lock released): if the tick requested a rotation
	 * (LoopState.resumeAfterRotation persisted on disk), ask the injected
	 * rotator to switch the session. `{cancelled: true}` (or a rotator error)
	 * → clear the flag, warn, and run persistent for the rest of the process.
	 */
	private async maybeRotateSession(): Promise<void> {
		if (this.sessionMode !== "fresh") return;
		const rotator = this.deps.sessionRotator;
		if (!rotator) return;
		let loopState: LoopState;
		try {
			loopState = await readMissionLoopState(this.missionDir);
		} catch {
			return; // state unreadable — nothing to rotate on
		}
		if (!loopState.resumeAfterRotation) return;
		let cancelled = false;
		try {
			const outcome = await rotator.rotate();
			cancelled = outcome.cancelled === true;
		} catch (err) {
			cancelled = true;
			console.warn("[fan-mission] session rotation failed — falling back to persistent mode:", err);
		}
		if (cancelled) {
			this.rotationFallbackPersistent = true;
			this.sessionMode = "persistent";
			try {
				loopState.resumeAfterRotation = false;
				writeLoopStateSync(this.missionDir, loopState);
			} catch {
				// best-effort — the flag stays on disk; next tick's rotation is
				// skipped anyway due to rotationFallbackPersistent.
			}
			console.warn("[fan-mission] session rotation cancelled — mission continues in persistent mode");
			this.notifyOperator("⚠️ session rotation cancelled — mission continues in persistent mode");
		}
	}

	private async _tickInner(): Promise<TickResult> {
		// 0.7.2: in-memory reentrancy guard — if a tick is already running,
		// return immediately without side effects (no journal, no STATE, no throw).
		if (this.tickRunning) {
			const loopState = await readMissionLoopState(this.missionDir);
			return {
				iteration: loopState.currentIteration,
				steps: {
					wake: false,
					read: false,
					decide: false,
					iterate: false,
					verify: false,
					commit: false,
					backlog: false,
				},
				status: "busy" as MissionStatus,
			};
		}
		this.tickRunning = true;

		const acquired = await this.lock.acquire();
		if (!acquired) {
			this.tickRunning = false;
			throw new Error("Lock is busy — concurrent tick not allowed");
		}

		const steps: TickSteps = {
			wake: false,
			read: false,
			decide: false,
			iterate: false,
			verify: false,
			commit: false,
			backlog: false,
		};
		let resultStatus: MissionStatus = "active";
		let currentIteration = 0;
		let currentItem: string | undefined;
		let lastCompletedStep = 0;
		let loopState = defaultLoopState();

		try {
			// ── Step 1: Wake ───────────────────────────────────────────────
			steps.wake = true;
			loopState = await readMissionLoopState(this.missionDir);
			currentIteration = loopState.currentIteration;

			// P0-2: respect abort signal from previous run
			if (loopState.abortedByOperator) {
				loopState.abortedByOperator = false;
				loopState.interrupted = false;
				loopState.iterationResult = undefined;
				loopState.pendingItem = undefined;
				loopState.committed = false;
				writeLoopStateSync(this.missionDir, loopState);
				clearAbortSignal(this.missionDir);
				return { iteration: currentIteration, steps, status: "aborted" };
			}

			const mission = await readMission(this.missionDir);
			const missionStatus = String(mission.frontmatter.status) as MissionStatus;
			const budgetTokens = Number(mission.frontmatter.budget_tokens) || 0;
			const budgetUsd = Number(mission.frontmatter.budget_usd) || 0;

			// ralph-loop (S3): session mode — resolved once per tick (frontmatter
			// is immutable after init). Resolved here, before the completed
			// early-return, so recur-phase rotation works in дежурство too.
			this.sessionMode = this.resolveSessionMode(mission.frontmatter.session_mode);

			// Terminal statuses → no-op (except completed → recur-only дежурство)
			if (missionStatus === "aborted" || missionStatus === "failed" || missionStatus === "budget_exhausted") {
				return { iteration: currentIteration, steps, status: missionStatus };
			}

			// R2: completed → recur-only phase (дежурство).
			// Skip one-shot/planning, execute only due recurring items.
			if (missionStatus === "completed") {
				let missionState: MissionState;
				try {
					missionState = await readState(this.missionDir);
				} catch {
					missionState = { done: [], blockers: [], nextSteps: [] };
				}
				const roadmapRaw = await readRoadmap(this.missionDir);
				const recurResult = await this.runRecurPhase(
					loopState,
					steps,
					currentIteration,
					budgetTokens,
					budgetUsd,
					roadmapRaw,
					missionState,
					"completed",
					0,
				);
				return recurResult;
			}

			// P1-2: Paused mission → no-op (resume only via explicit external action)
			if (missionStatus === "paused") {
				return { iteration: currentIteration, steps, status: "paused" };
			}

			// F-17: DECIDE interruption — loop is blocked until the operator answers
			// via resolveDecision() (or the decide timeout aborts the mission).
			if (missionStatus === "awaiting_decision") {
				return { iteration: currentIteration, steps, status: "awaiting_decision" };
			}

			// F-15: drain — current turn boundary reached: do NOT start a new
			// iteration, record the pause in STATE.md and set MISSION.md → paused.
			if (this.isDrainRequested()) {
				return await this.drainTick(steps, currentIteration);
			}

			resultStatus = missionStatus as MissionStatus;
			// Save original recovery info BEFORE journalStep overwrites lastStep
			const recoveredLastStep = loopState.lastStep;
			const recoveredInterrupted = loopState.interrupted;
			lastCompletedStep = 1;
			this.journalStep(loopState, 1);

			// ── Step 2: Read ───────────────────────────────────────────────
			steps.read = true;

			// P1-5: preflight STATE.md size — archive if over limit.
			// ralph-loop incident fix: readState no longer throws StateFileTooLarge
			// (it truncates + warns), but the preflight still keeps STATE.md small
			// proactively so prompts and git history stay compact.
			let stateSize = checkStateFileSize(this.missionDir);
			if (stateSize >= MAX_STATE_BYTES) {
				const archived = await archiveOldDoneItems(this.missionDir, ARCHIVE_KEEP_COUNT);
				if (!archived) {
					resultStatus = "failed";
					await writeMissionStatus(this.missionDir, "failed");
					this.journalStep(loopState, 7);
					loopState.interrupted = false;
					writeLoopStateSync(this.missionDir, loopState);
					return {
						iteration: currentIteration,
						steps,
						status: "failed",
						item: "STATE.md overflow — archiving impossible",
					};
				}
				stateSize = checkStateFileSize(this.missionDir);
			}

			// Validate STATE.md exists and parse it (may throw for schema issues).
			// The parsed state is reused in step 4 to build the execution prompt.
			// (readState truncates oversized files instead of throwing — see
			// file-state-manager.ts readState.)
			const missionState = await readState(this.missionDir);

			let roadmapRaw = await readRoadmap(this.missionDir);
			await this.deps.git.log({ cwd: this.missionDir });

			lastCompletedStep = 2;
			this.journalStep(loopState, 2);

			// ── 0.9.0: Continuous execution loop ──────────────────────────
			// Execute roadmap items continuously until a stop condition:
			// - All one-shots done → completed/yield
			// - Mission status changed (paused/aborted/terminal) → yield
			// - Early exit (BLOCKED/DECIDE/FAILED/budget/abort) → return
			// After the loop: recur-phase (RECURRING.md) runs.
			let itemsExecuted = 0;
			let recoveryAttempted = false;

			// R2: legacy migration — (recur) items in ROADMAP → RECURRING.md
			{
				const allUncheckedForMigration = parseAllUnchecked(roadmapRaw);
				const legacyRecurs = allUncheckedForMigration.filter((i) => isRecurringItem(i.text));
				if (legacyRecurs.length > 0) {
					await this.migrateLegacyRecurring(legacyRecurs, roadmapRaw);
					roadmapRaw = await readRoadmap(this.missionDir);
				}
			}

			while (true) {
				// ── Step 3: Decide ─────────────────────────────────────────────
				steps.decide = true;
				// R2: one-shot pass takes ALL unchecked ROADMAP (no recur filter).
				// Legacy (recur) items were migrated above; remaining unchecked = one-shots.
				const allUnchecked = parseAllUnchecked(roadmapRaw);
				let nextItem: { index: number; text: string } | null = allUnchecked[0] ?? null;

				// All items done → completed/planning
				if (!nextItem) {
					// Guard against false completion: a ROADMAP without ANY parseable
					// checklist items (checked or unchecked) is suspicious — the mission
					// never had work items, so "all done" is a fabrication. Fail loudly
					// instead of silently completing with zero work done.
					if (!hasAnyChecklistItem(roadmapRaw)) {
						if (canTransition(resultStatus, "failed")) {
							resultStatus = "failed";
							await writeMissionStatus(this.missionDir, "failed");
						}
						this.journalStep(loopState, 3);
						loopState.interrupted = false;
						loopState.iterationResult = undefined;
						loopState.pendingItem = undefined;
						loopState.committed = false;
						writeLoopStateSync(this.missionDir, loopState);
						return {
							iteration: currentIteration,
							steps,
							status: resultStatus,
							item: "ROADMAP contains no parseable checklist items",
							itemsExecuted,
						};
					}
					// 0.7.0 bootstrap planning: a valid ROADMAP (has checked items) with
					// no unchecked items left AND a non-empty mission Goal → the mission
					// still has work to decompose. Do NOT complete: run a planning
					// iteration on a synthetic item — the executor must decompose the
					// Goal into unchecked ROADMAP items (prompt-builder adds guidance).
					// Empty Goal → completed as before (nothing left to plan).
					if (!extractGoal(mission.body)) {
						if (canTransition(resultStatus, "completed")) {
							resultStatus = "completed";
							await writeMissionStatus(this.missionDir, "completed");
						}
						this.journalStep(loopState, 3);
						loopState.interrupted = false;
						loopState.iterationResult = undefined;
						loopState.pendingItem = undefined;
						loopState.committed = false;
						writeLoopStateSync(this.missionDir, loopState);
						// R2: break to recur-phase (дежурство) instead of returning
						break;
					}
					// Synthetic planning item: index -1 marks it as not present in the
					// ROADMAP (markRoadmapDone/prompt marking are no-ops for it).
					nextItem = { index: -1, text: PLANNING_ITEM_TEXT };
				}

				// Recovery: determine resume point (use ORIGINAL values from disk)
				// P0 fix: recovery triggers by PRESENCE of saved iterationResult in journal
				// (which is persisted at step 5 together with budgetCountedFor), NOT solely
				// by the interrupted flag. After SIGKILL, interrupted=false but the journal
				// may still have the saved result from step 5.
				//
				// - lastStep >= 4 with saved iterationResult + pendingItem → resume from step 5+
				//   (executor skipped, budget already counted via budgetCountedFor)
				// - interrupted=true with lastStep > 0 → in-process crash, resume from lastStep+1
				// - 0.8.0: lastStep 1..6 with interrupted=false → SIGKILL (no catch handler);
				//   resumeFromStep=0 → falls through to fresh executor call (redo).
				// - Otherwise → fresh iteration (no recovery needed)
				// 0.8.0: recovery only on first pass of the continuous loop.
				// SIGKILL/budget invariants are preserved per-item (budgetCountedFor prevents
				// double-counting the recovered item); the continuous loop then proceeds to the
				// next unchecked roadmap item.
				let resumeFromStep = 0;
				if (!recoveryAttempted) {
					recoveryAttempted = true;
					if (recoveredLastStep >= 4 && loopState.iterationResult && loopState.pendingItem) {
						resumeFromStep = recoveredLastStep + 1;
					} else if (recoveredInterrupted && recoveredLastStep > 0) {
						resumeFromStep = recoveredLastStep + 1;
					}
				}

				// Increment iteration only for fresh starts (not recovery past step 1)
				if (resumeFromStep <= 1) {
					currentIteration++;
					loopState.currentIteration = currentIteration;
				}

				currentItem = nextItem.text;
				lastCompletedStep = 3;
				this.journalStep(loopState, 3);

				// Recovery: skip past commit → just finish backlog
				if (resumeFromStep > 6) {
					steps.backlog = true;
					const now = await this.deps.clock.now();
					await this.appendBacklogEntry(loopState, now, currentIteration, {
						text: nextItem.text,
						isSuccess: true,
						isBlockOrFail: false,
						costUsd: 0,
						iterStatus: loopState.iterationResult?.status,
					});
					loopState.interrupted = false;
					loopState.iterationResult = undefined;
					loopState.pendingItem = undefined;
					loopState.pendingItemIndex = undefined;
					loopState.committed = false;
					loopState.budgetCountedFor = null;
					this.journalStep(loopState, 7);
					writeLoopStateSync(this.missionDir, loopState);
					return { iteration: currentIteration, steps, status: resultStatus, item: currentItem };
				}

				// ── Step 4: Iterate ────────────────────────────────────────────
				let iterResult: IterationResult;

				if (resumeFromStep >= 4 && loopState.iterationResult && loopState.pendingItem === nextItem.text) {
					// P0-1: Recovery with saved result — skip executor
					iterResult = loopState.iterationResult;
					steps.iterate = false;

					// Note: loopState.committed is always false here — step 6 clears
					// committed before advancing lastStep to 6. If the full tick completed,
					// pendingItem is also cleared, so we never enter this branch.
				} else {
					// P1-4 + P2-7: Budget preflight BEFORE executor
					steps.iterate = true;

					// P2 fix: budget=0 / missing = unlimited (no limit).
					// Only check preflight when budget > 0 (explicit limit set).
					const tokensRemaining = budgetTokens - loopState.budgetUsed.tokens;
					const usdRemaining = budgetUsd - loopState.budgetUsed.usd;
					const tokensPreflightFail = budgetTokens > 0 && tokensRemaining <= 0;
					const usdPreflightFail = budgetUsd > 0 && usdRemaining <= 0;
					if (tokensPreflightFail || usdPreflightFail) {
						resultStatus = "budget_exhausted";
						await writeMissionStatus(this.missionDir, "budget_exhausted");
						return this.finishTickNoIterate(loopState, steps, currentIteration, resultStatus, currentItem);
					}

					// P0-2: abort check before expensive work
					if (this.isAborted()) {
						return this.abortTick(loopState, steps, currentIteration, currentItem);
					}

					// F-15: consume pending steer messages (webhook / scheduler / operator)
					const steerMessages = consumeSteerQueue(this.missionDir);
					let steer = steerMessages.length > 0 ? steerMessages.join("\n") : undefined;
					// F-17: consume pending operator answer to a DECIDE question
					if (loopState.pendingOperatorAnswer !== undefined) {
						const answerLine = `operator_answer: ${loopState.pendingOperatorAnswer}`;
						steer = steer ? `${steer}\n${answerLine}` : answerLine;
						loopState.pendingOperatorAnswer = undefined;
					}
					// Prompt enriched with mission context (MISSION/ROADMAP/STATE/BACKLOG,
					// `<promise>` reporting protocol, guidance and steer) — the executor
					// must not waste the iteration on rediscovering mission files.
					const prompt = await buildExecutionPrompt({
						missionDir: this.missionDir,
						itemText: nextItem.text,
						index: nextItem.index,
						roadmapRaw,
						state: missionState,
						...(steer ? { steer } : {}),
						freshSession: this.sessionMode === "fresh",
					});
					const runLocalIteration = (): Promise<IterationResult> =>
						this.deps.executor.runIteration({
							missionDir: this.missionDir,
							prompt,
							cwd: this.missionDir,
							...(steer ? { steer } : {}),
						});
					// F-48.5: [EPIC]-пункт → delegation path (декомпозиция → EventBus →
					// super-orchestrator). Любая неудача делегирования → безопасный
					// fallback на локальный executor.runIteration.
					if (isEpicItem(nextItem.text) && this.epicRunAgent && this.epicEventBus) {
						let delegated: IterationResult | null = null;
						try {
							delegated = await runEpicDelegation({
								missionDir: this.missionDir,
								itemText: nextItem.text,
								runAgent: this.epicRunAgent,
								eventBus: this.epicEventBus,
								timeoutMs: this.delegationTimeoutMs,
								cwd: this.missionDir,
								...(steer ? { steer } : {}),
								onPendingChange: (cleanup) => {
									this.pendingDelegationCleanup = cleanup;
								},
							});
						} catch {
							delegated = null; // непредвиденная ошибка → локальный fallback
						}
						this.pendingDelegationCleanup = null;
						iterResult = delegated ?? (await runLocalIteration());
					} else {
						iterResult = await runLocalIteration();
					}

					// P0-1: persist result immediately after step 4
					loopState.iterationResult = iterResult;
					loopState.pendingItem = nextItem.text;
					loopState.pendingItemIndex = nextItem.index;
					loopState.committed = false;
					this.journalStep(loopState, 4);
				}

				lastCompletedStep = 4;

				// P0-2: abort check after iteration, before commit
				if (this.isAborted()) {
					return this.abortTick(loopState, steps, currentIteration, currentItem);
				}

				// F-17: DECIDE interruption — parse the promise tag from the raw response.
				// Call-site guard: only strings are parsed (parsePromise(non-string) throws).
				const parsedPromise = typeof iterResult.response === "string" ? parsePromise(iterResult.response) : null;
				if (parsedPromise?.tag === "DECIDE") {
					return await this.decideTick(loopState, steps, currentIteration, currentItem, parsedPromise.reason);
				}

				// F-18: promise-tag routing — COMPLETE/BLOCKED/FAILED tags take priority
				// over iterResult.status; the reason from the tag becomes iterResult.reason.
				if (parsedPromise) {
					iterResult.status = parsedPromise.tag;
					iterResult.reason = parsedPromise.reason;
				} else {
					// No promise tag in the raw response → I3 escalation, then fallback
					// to iterResult.status (backward compat).
					this.escalate("I3", { tag: null, iteration: currentIteration });
				}

				// F-18: BLOCKED (after routing) → I3 escalation with the blocker reason
				// (the blocker itself is recorded in STATE.md by step 6).
				if (iterResult.status === "BLOCKED") {
					this.escalate("I3", { tag: "BLOCKED", reason: iterResult.reason, iteration: currentIteration });
				}

				// ── Step 5: Verify ─────────────────────────────────────────────
				steps.verify = true;
				const costTokens = iterResult.costTokens || 0;
				const costUsd = iterResult.costUsd || 0;

				// P1-1 fix: increment budget BEFORE journal write so that when
				// journal confirms step 5 (budgetCountedFor present), budgetUsed is
				// guaranteed to already include the cost. Crash between increment and
				// journal = no journal → budget lost but not double-counted on recovery.
				const wasBudgetCounted = loopState.budgetCountedFor === nextItem.text;
				if (!wasBudgetCounted) {
					loopState.budgetUsed.tokens += costTokens;
					loopState.budgetUsed.usd += costUsd;
				}
				// else: budget already counted for this item — skip to prevent double-count

				loopState.iterationResult = iterResult;
				loopState.pendingItem = nextItem.text;
				loopState.pendingItemIndex = nextItem.index;
				loopState.committed = false;
				loopState.budgetCountedFor = nextItem.text;
				this.journalStep(loopState, 5);

				// P1-4: check both token and USD limits
				const tokensExceeded = budgetTokens > 0 && loopState.budgetUsed.tokens > budgetTokens;
				const usdExceeded = budgetUsd > 0 && loopState.budgetUsed.usd > budgetUsd;
				const budgetExceededPostHoc = tokensExceeded || usdExceeded;

				let isSuccess = iterResult.status === "COMPLETE";
				let isBlockOrFail = iterResult.status === "BLOCKED" || iterResult.status === "FAILED";

				// F-18: verification ladder — COMPLETE iterations are verified before
				// commit (budget already counted: the work was done). Ladder failure →
				// iteration treated as FAILED: no commit, no roadmap checkbox, diagnosis
				// goes to STATE.md blockers (step 6), loop continues.
				if (isSuccess && this.verificationLadder) {
					const ladderOutcome = await this.runVerificationLadder();
					if (!ladderOutcome.passed) {
						iterResult.status = "FAILED";
						iterResult.reason =
							ladderOutcome.diagnosis ??
							(ladderOutcome.failedStep
								? `Verification failed at step: ${ladderOutcome.failedStep}`
								: "Verification ladder failed");
						// Persist the amended result so a crash before step 6 cannot
						// recover as COMPLETE and commit a failed iteration.
						loopState.iterationResult = iterResult;
						writeLoopStateSync(this.missionDir, loopState);
						isSuccess = false;
						isBlockOrFail = true;
					}
				}

				// P2-7: budget exceeded AFTER successful iteration → commit first, then status
				if (budgetExceededPostHoc && !isSuccess) {
					resultStatus = "budget_exhausted";
				} else if (budgetExceededPostHoc && isSuccess) {
					// Will set budget_exhausted AFTER commit
					resultStatus = "active"; // temporarily — will change after commit
				}

				lastCompletedStep = 5;

				// ── Step 6: Commit ─────────────────────────────────────────────
				steps.commit = true;
				await this.doStep6Commit(
					loopState,
					nextItem,
					roadmapRaw,
					iterResult,
					isSuccess,
					isBlockOrFail,
					budgetExceededPostHoc,
				);

				// P3-d: deduplicated — single branch for budget_exhausted after commit
				if (budgetExceededPostHoc) {
					resultStatus = "budget_exhausted";
					await writeMissionStatus(this.missionDir, "budget_exhausted");
				}

				// P0-1: Clear iteration result INSIDE step 6 (before advancing lastStep)
				// This ensures that if we crash between step 6 and step 7,
				// recovery won't try to re-execute the already-committed item.
				loopState.iterationResult = undefined;
				loopState.pendingItem = undefined;
				loopState.pendingItemIndex = undefined;
				loopState.committed = false;

				this.journalStep(loopState, 6);
				lastCompletedStep = 6;

				// P0-2: abort check after commit
				if (this.isAborted()) {
					return this.abortTick(loopState, steps, currentIteration, currentItem);
				}

				// ── Step 7: Backlog ────────────────────────────────────────────
				steps.backlog = true;
				const now = await this.deps.clock.now();
				// 0.7.2: infra errors (runner noise) are not written to BACKLOG
				const infraSkip = isBlockOrFail && typeof iterResult.reason === "string" && isInfraError(iterResult.reason);
				await this.appendBacklogEntry(loopState, now, currentIteration, {
					text: nextItem.text,
					isSuccess,
					isBlockOrFail,
					costUsd,
					iterStatus: iterResult.status,
					budgetExhausted: budgetExceededPostHoc,
					budgetUsed: loopState.budgetUsed,
					budgetTokens,
					...(infraSkip ? { skipBacklog: true } : {}),
				});

				// ── 0.7.2: Planning cap (backlog #32) ─────────────────────────
				// Planning tick (index -1) that didn't add unchecked items → streak++.
				// Streak >= 2 → enter awaiting_decision instead of infinite loop.
				if (nextItem.index === -1) {
					const freshRoadmapForCap = await readRoadmap(this.missionDir);
					const hasUnchecked = /^[-*] \[ \] /m.test(freshRoadmapForCap);
					if (!hasUnchecked) {
						loopState.emptyPlanningStreak = (loopState.emptyPlanningStreak ?? 0) + 1;
					} else {
						loopState.emptyPlanningStreak = 0;
					}
					writeLoopStateSync(this.missionDir, loopState);
					if (loopState.emptyPlanningStreak >= 2) {
						loopState.emptyPlanningStreak = 0;
						writeLoopStateSync(this.missionDir, loopState);
						await this.enterAwaitingDecision(
							loopState,
							"Planning produced no new roadmap items twice — goal achieved? stop mission?",
						);
						return {
							iteration: currentIteration,
							steps,
							status: "awaiting_decision",
							item: currentItem,
							itemsExecuted,
						};
					}
				} else {
					// Non-planning tick → reset the streak
					if ((loopState.emptyPlanningStreak ?? 0) > 0) {
						loopState.emptyPlanningStreak = 0;
						writeLoopStateSync(this.missionDir, loopState);
					}
				}

				// ── Finalise ───────────────────────────────────────────────────
				loopState.lastStep = 7;
				loopState.interrupted = false;
				loopState.budgetCountedFor = null; // P1-1: reset for next iteration
				writeLoopStateSync(this.missionDir, loopState);
				lastCompletedStep = 7;

				// ── Phase B hooks (F-19/F-20/F-21) ────────────────────────────
				// After the journal write (lastStep=7), so a crash mid-hook recovers
				// cleanly; hook errors never crash the loop (try/catch inside).
				await this.emitIterationMetrics(currentIteration, iterResult, parsedPromise);
				resultStatus = await this.runIdeaHooks(loopState, resultStatus);

				// ── 0.8.0: Continuous loop — continue or break ──────────────
				itemsExecuted++;

				// BLOCKED/FAILED items stay unchecked → break to avoid infinite retry
				if (!isSuccess) {
					break;
				}

				// Re-check mission status (may have changed during execution)
				const freshMission = await readMission(this.missionDir);
				const freshStatus = String(freshMission.frontmatter.status) as MissionStatus;
				if (freshStatus !== "active") {
					resultStatus = freshStatus;
					break;
				}

				// Re-read roadmap for next item
				roadmapRaw = await readRoadmap(this.missionDir);

				// ralph-loop (S3): fresh mode — one iteration per session. If
				// unchecked one-shot work remains, request session rotation +
				// auto-resume. The flag is set only after the finalise above
				// (lastStep=7, interrupted=false persisted), so the next session
				// safely continues from disk.
				if (this.sessionMode === "fresh") {
					if (parseAllUnchecked(roadmapRaw).length > 0) {
						loopState.resumeAfterRotation = true;
						writeLoopStateSync(this.missionDir, loopState);
					}
					break;
				}
			} // end while (true)

			// ── R2: Recur-phase (RECURRING.md) ─────────────────────────────
			// Runs after the one-shot loop: executes due recurring items.
			// Does NOT run step 7 ideas. Budget is still enforced.
			const recurResult = await this.runRecurPhase(
				loopState,
				steps,
				currentIteration,
				budgetTokens,
				budgetUsd,
				roadmapRaw,
				missionState,
				resultStatus,
				itemsExecuted,
				currentItem,
			);
			return recurResult;
		} catch (err) {
			// Record crash marker for recovery, then re-throw
			// Merge with on-disk state to preserve abort signals
			try {
				const crashState = await readMissionLoopState(this.missionDir);
				crashState.currentIteration = currentIteration;
				crashState.lastStep = lastCompletedStep;
				crashState.interrupted = true;
				writeLoopStateSync(this.missionDir, crashState);
			} catch {
				// best-effort
			}
			throw err;
		} finally {
			this.tickRunning = false;
			await this.lock.release();
		}
	}

	async abort(): Promise<void> {
		// F-48.5: прервать pending EPIC-делегирование (отписка от replyEvent,
		// снятие таймаута) — ожидание в tick() разрешится fallback'ом.
		const delegationCleanup = this.pendingDelegationCleanup;
		this.pendingDelegationCleanup = null;
		try {
			delegationCleanup?.();
		} catch {
			// best-effort
		}
		// P0-2: write abort signal file (lock-free, atomic)
		writeAbortSignal(this.missionDir);
		// Also update journal for persistence across restarts
		try {
			const loopState = await readMissionLoopState(this.missionDir);
			loopState.abortedByOperator = true;
			loopState.interrupted = true;
			writeLoopStateSync(this.missionDir, loopState);
		} catch {
			// best-effort
		}
		// Update MISSION.md status
		try {
			await writeMissionStatus(this.missionDir, "aborted");
		} catch {
			// best-effort — abort signal file is the primary mechanism
		}
		// F-17: no pending decide timeout after abort
		this.clearDecideTimer();
	}

	/**
	 * F-17: resolve a DECIDE interruption. Valid only from awaiting_decision.
	 * Records the operator answer in DECISIONS.md (question + answer, ADR format),
	 * clears the decide timeout and transitions back to active. The next tick()
	 * passes the answer to the executor as `operator_answer: <answer>`.
	 */
	async resolveDecision(answer: string): Promise<void> {
		const mission = await readMission(this.missionDir);
		const currentStatus = String(mission.frontmatter.status);
		if (currentStatus !== "awaiting_decision") {
			throw new InvalidTransitionError(currentStatus, "active");
		}

		const loopState = await readMissionLoopState(this.missionDir);
		const question = loopState.pendingDecision?.question ?? "не указан";
		const now = await this.deps.clock.now();

		// ADR-style answer entry (question + operator answer)
		await appendDecision(this.missionDir, {
			id: `ADR-${randomUUID().slice(0, 8)}`,
			date: now.toISOString(),
			status: "accepted",
			context: question,
			decision: answer,
			consequences: "",
		});

		this.clearDecideTimer();

		// F-22: if the DECIDE was about an idea and the operator accepts,
		// update the idea's BACKLOG status from DECIDE to ROADMAP so the
		// promoter picks it up on the next tick.
		// F-22: if the DECIDE was about an idea and the operator accepts,
		// update the idea's BACKLOG status from DECIDE to ROADMAP so the
		// promoter picks it up on the next tick.
		// Note: \b doesn't work with Cyrillic (non-ASCII word chars), so we
		// use (?=[\s,.!?:;]|$) instead to match a word followed by separator/EOL.
		const ideaId = loopState.pendingDecisionIdeaId;
		if (ideaId && /^\s*(accept|yes|да|принять|ок|ok)(?=[\s,.!?:;]|$)/i.test(answer)) {
			try {
				await updateBacklogEntry(this.missionDir, ideaId, { status: "ROADMAP" });
			} catch {
				// best-effort: if the update fails, the idea stays DECIDE in BACKLOG
			}
		}

		loopState.pendingDecision = undefined;
		loopState.pendingDecisionIdeaId = undefined;
		loopState.pendingOperatorAnswer = answer;
		writeLoopStateSync(this.missionDir, loopState);

		await writeMissionStatus(this.missionDir, "active");
	}

	async status(): Promise<MissionStatus> {
		const mission = await readMission(this.missionDir);
		return String(mission.frontmatter.status) as MissionStatus;
	}

	// ── Private helpers ────────────────────────────────────────────────────

	/**
	 * Check if the abort signal file exists (lock-free read).
	 */
	private isAborted(): boolean {
		return readAbortSignal(this.missionDir);
	}

	/**
	 * F-15: drain requested via DI flag or file signal (I1).
	 */
	private isDrainRequested(): boolean {
		return this.drainFlag?.() === true || readDrainSignal(this.missionDir);
	}

	/**
	 * F-15: handle a drain signal — skip iteration, note the pause in STATE.md,
	 * transition MISSION.md to "paused" and clear the signal.
	 */
	private async drainTick(steps: TickSteps, currentIteration: number): Promise<TickResult> {
		setDrainSignal(this.missionDir, false);
		// Record the pause reason in STATE.md (best-effort: keep existing content)
		try {
			const state = await readState(this.missionDir);
			const marker = "Drain requested — mission paused";
			if (!state.blockers.includes(marker)) {
				await writeState(this.missionDir, {
					done: state.done,
					blockers: [...state.blockers, marker],
					nextSteps: state.nextSteps,
				});
			}
		} catch {
			// best-effort — status transition below is the primary effect
		}
		await writeMissionStatus(this.missionDir, "paused");
		return { iteration: currentIteration, steps, status: "paused" };
	}

	/**
	 * F-17: handle a DECIDE promise tag — record the question in DECISIONS.md
	 * (ADR format, pending), transition to awaiting_decision, reset the step-4
	 * journal (next tick after resolve starts a fresh iteration), start the
	 * decide timeout and return without running steps 5–7.
	 */
	private async decideTick(
		loopState: LoopState,
		steps: TickSteps,
		currentIteration: number,
		currentItem: string | undefined,
		rawReason: string | undefined,
	): Promise<TickResult> {
		const question = rawReason && rawReason.trim() !== "" ? rawReason.trim() : "не указан";
		await this.enterAwaitingDecision(loopState, question);
		return { iteration: currentIteration, steps, status: "awaiting_decision", item: currentItem };
	}

	/**
	 * F-17 / Phase B shared transition: record the pending question in
	 * DECISIONS.md (ADR format), move MISSION.md to awaiting_decision, reset
	 * the step-4 journal (the next tick after resolveDecision() runs a fresh
	 * iteration), persist pendingDecision (survives restarts) and start the
	 * decide timeout.
	 *
	 * F-22: optional ideaId — when the DECIDE originates from idea scoring,
	 * the idea id is persisted so resolveDecision() can update the BACKLOG
	 * entry to ROADMAP on accept (enabling promoter pickup on next tick).
	 */
	private async enterAwaitingDecision(loopState: LoopState, question: string, ideaId?: string): Promise<void> {
		const now = await this.deps.clock.now();
		const date = now.toISOString();

		await appendDecision(this.missionDir, {
			id: `ADR-${randomUUID().slice(0, 8)}`,
			date,
			status: "pending",
			context: question,
			decision: "",
			consequences: "",
		});

		await writeMissionStatus(this.missionDir, "awaiting_decision");

		// Reset the step-4 journal so the next tick after resolveDecision() runs
		// a fresh iteration (the DECIDE iteration itself is not committed).
		loopState.iterationResult = undefined;
		loopState.pendingItem = undefined;
		loopState.pendingItemIndex = undefined;
		loopState.committed = false;
		loopState.budgetCountedFor = null;
		loopState.interrupted = false;
		loopState.lastStep = 0;
		// Persist the question so resolveDecision() can record it after a restart.
		loopState.pendingDecision = { question, date };
		// F-22: persist the idea id (if any) for DECIDE→accept→ROADMAP flow.
		loopState.pendingDecisionIdeaId = ideaId;
		writeLoopStateSync(this.missionDir, loopState);

		this.startDecideTimer();
	}

	/**
	 * Phase B (F-21): emit the iteration metrics record after the final
	 * iteration status is known (COMPLETE/BLOCKED/FAILED incl. ladder-fail).
	 * IterationResult carries no tokensIn/tokensOut/durationMs — the loop
	 * passes what it has (costTokens as tokensIn, 0 for the rest). Collector
	 * errors are swallowed — the loop never crashes on metrics.
	 */
	private async emitIterationMetrics(
		iteration: number,
		iterResult: IterationResult,
		parsedPromise: PromiseParseResult | null,
	): Promise<void> {
		if (!this.metricsCollector) return;
		try {
			await this.metricsCollector.onIterationEnd(this.missionDir, {
				iteration,
				tokensIn: iterResult.costTokens ?? 0,
				tokensOut: 0,
				durationMs: 0,
				status: iterResult.status.toLowerCase(),
				promiseTag: parsedPromise?.tag ?? null,
			});
		} catch {
			// A failing collector must not crash the loop.
		}
	}

	/**
	 * Phase B (F-19/F-20) + F-22: idea generation, scoring and promotion after
	 * step 7 (backlog), only when injected.
	 *
	 * Generator errors are swallowed; scorer errors leave the idea unscored
	 * (status "IDEA") and the loop continues. A DECIDE verdict transitions
	 * the mission to awaiting_decision via F-17 (first DECIDE wins).
	 *
	 * F-22: After scoring, the promoter picks up ROADMAP ideas (from both
	 * freshly-scored and previously-scored backlog entries) and adds them
	 * to ROADMAP.md. Promotion only happens on successful iterations
	 * (COMPLETE — not FAILED/BLOCKED). Returns the possibly updated status.
	 */
	private async runIdeaHooks(loopState: LoopState, resultStatus: MissionStatus): Promise<MissionStatus> {
		if (resultStatus !== "active") return resultStatus;

		// Phase B (F-19/F-20): generate + score new ideas.
		if (this.ideaGenerator) {
			let added = 0;
			try {
				const genResult = await this.ideaGenerator.generate(this.missionDir);
				added = genResult?.added ?? 0;
			} catch {
				// generator errors must not crash the loop
			}

			if (added > 0 && this.ideaScorer) {
				// Re-read backlog AFTER generator runs so new entries are visible.
				let backlog: BacklogEntry[];
				try {
					backlog = await readBacklog(this.missionDir);
				} catch {
					backlog = [];
				}

				let decide: { id: string; idea: string; score: number } | null = null;
				for (const entry of backlog) {
					if (entry.status !== "IDEA") continue;
					try {
						const result = await this.ideaScorer.scoreIdea(this.missionDir, {
							id: entry.id,
							idea: entry.idea,
							source: entry.source,
						});
						if (result?.status === "DECIDE" && decide === null) {
							decide = { id: entry.id, idea: entry.idea, score: result.score };
						}
					} catch {
						// Scorer error: the idea stays unscored ("IDEA"); continue.
					}
				}

				if (decide) {
					try {
						// F-22: pass ideaId so resolveDecision can update BACKLOG on accept.
						await this.enterAwaitingDecision(loopState, `${decide.idea} (score: ${decide.score})`, decide.id);
						return "awaiting_decision";
					} catch {
						// A failed transition must not crash the loop.
					}
				}
			}
		}

		// F-22: promote ROADMAP ideas to ROADMAP.md.
		// Runs independently of generate/score so that previously-scored
		// ROADMAP entries (including DECIDE→accept conversions) are picked
		// up even when the generator added nothing this tick.
		if (this.ideaPromoter) {
			try {
				const promoteResult = await this.ideaPromoter.promote(this.missionDir);
				if (promoteResult.promoted.length > 0) {
					loopState.lastPromotedCount = promoteResult.promoted.length;
					writeLoopStateSync(this.missionDir, loopState);
				}
			} catch {
				// Promoter errors must not crash the loop.
			}
		}

		return resultStatus;
	}

	/** F-17: start the decide timeout (aborts the mission on expiry). */
	private startDecideTimer(): void {
		this.clearDecideTimer();
		const timer = setTimeout(() => {
			this.decideTimer = undefined;
			void this.handleDecideTimeout();
		}, this.decideTimeoutMs);
		// Do not keep the Node process alive just for the decide timeout.
		if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
			timer.unref();
		}
		this.decideTimer = timer;
	}

	/** F-17: clear the pending decide timeout (operator answered / aborted). */
	private clearDecideTimer(): void {
		if (this.decideTimer !== undefined) {
			clearTimeout(this.decideTimer);
			this.decideTimer = undefined;
		}
	}

	/**
	 * F-18: invoke the escalation callback (I3) without failing the loop —
	 * callback errors are swallowed.
	 */
	private escalate(level: string, payload: EscalationPayload): void {
		if (!this.onEscalate) return;
		try {
			this.onEscalate(level, payload);
		} catch {
			// A failing escalation callback must not crash the loop.
		}
	}

	/**
	 * F-18: run the injected verification ladder (step 5 verify). Errors thrown
	 * by the ladder are converted to a failed result with the error message as
	 * diagnosis — the loop never crashes on ladder failure.
	 */
	private async runVerificationLadder(): Promise<VerificationLadderResult> {
		try {
			const result = await this.verificationLadder?.run(this.missionDir);
			return {
				passed: result?.passed === true,
				failedStep: result?.failedStep ?? null,
				diagnosis: result?.diagnosis ?? null,
			};
		} catch (err) {
			return {
				passed: false,
				failedStep: null,
				diagnosis: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * F-17: decide timeout fired — add the decide_timeout blocker to STATE.md
	 * and abort the mission. No-op if the status is no longer awaiting_decision.
	 */
	private async handleDecideTimeout(): Promise<void> {
		try {
			const mission = await readMission(this.missionDir);
			if (String(mission.frontmatter.status) !== "awaiting_decision") {
				return; // resolved or otherwise transitioned in the meantime
			}
		} catch {
			return;
		}

		// STATE.md blocker marker (best-effort)
		try {
			const state = await readState(this.missionDir);
			if (!state.blockers.includes("decide_timeout")) {
				await writeState(this.missionDir, {
					done: state.done,
					blockers: [...state.blockers, "decide_timeout"],
					nextSteps: state.nextSteps,
				});
			}
		} catch {
			// best-effort — the abort status below is the primary effect
		}

		try {
			await writeMissionStatus(this.missionDir, "aborted");
		} catch {
			// best-effort
		}
	}

	/**
	 * Write lastStep to journal atomically.
	 */
	private journalStep(state: LoopState, step: number): void {
		state.lastStep = step;
		writeLoopStateSync(this.missionDir, state);
	}

	/**
	 * Finish a tick without running the executor (budget preflight exhausted).
	 * Writes backlog entry and returns.
	 */
	private async finishTickNoIterate(
		loopState: LoopState,
		steps: TickSteps,
		currentIteration: number,
		resultStatus: MissionStatus,
		currentItem: string | undefined,
	): Promise<TickResult> {
		steps.iterate = false;
		steps.verify = false;
		steps.commit = false;
		steps.backlog = true;

		const now = await this.deps.clock.now();
		await this.appendBacklogEntry(loopState, now, currentIteration, {
			text: "Budget exhausted before iteration",
			isSuccess: false,
			isBlockOrFail: false,
			costUsd: 0,
			budgetExhausted: true,
			budgetUsed: loopState.budgetUsed,
		});

		loopState.lastStep = 7;
		loopState.interrupted = false;
		writeLoopStateSync(this.missionDir, loopState);

		return {
			iteration: currentIteration,
			steps,
			status: resultStatus,
			item: currentItem,
		};
	}

	/**
	 * R2: Execute due recurring items from RECURRING.md.
	 * Called after the one-shot while-loop (active tick) or as the sole
	 * work phase for completed missions (дежурство).
	 *
	 * For each due item:
	 * 1. Budget preflight (same as step 4)
	 * 2. executor.runIteration with recurring: true prompt
	 * 3. Budget counting (metrics)
	 * 4. STATE.md update (done/blockers)
	 * 5. Git commit (STATE.md only, ROADMAP untouched)
	 * 6. markRecurringRun + writeRecurringState (AFTER any outcome)
	 *
	 * Does NOT run step 7 ideas (runIdeaHooks).
	 * Returns TickResult with updated status/itemsExecuted.
	 */
	private async runRecurPhase(
		loopState: LoopState,
		steps: TickSteps,
		currentIteration: number,
		budgetTokens: number,
		budgetUsd: number,
		roadmapRaw: string,
		missionState: MissionState,
		initialStatus: MissionStatus,
		itemsExecuted: number,
		previousItem?: string,
	): Promise<TickResult> {
		const recurItems = readRecurring(this.missionDir);
		if (recurItems.length === 0) {
			return {
				iteration: currentIteration,
				steps,
				status: initialStatus,
				item: previousItem,
				itemsExecuted,
			};
		}

		const nowDate = await this.deps.clock.now();
		const nowMs = nowDate instanceof Date ? nowDate.getTime() : new Date(nowDate as unknown as string).getTime();
		let recurState = readRecurringState(this.missionDir);
		let resultStatus = initialStatus;
		let currentItem: string | undefined = previousItem;

		for (const item of recurItems) {
			if (!isRecurringDue(item, recurState, nowMs)) continue;

			// Budget preflight (same logic as step 4)
			const tokensRemaining = budgetTokens - loopState.budgetUsed.tokens;
			const usdRemaining = budgetUsd - loopState.budgetUsed.usd;
			const tokensPreflightFail = budgetTokens > 0 && tokensRemaining <= 0;
			const usdPreflightFail = budgetUsd > 0 && usdRemaining <= 0;
			if (tokensPreflightFail || usdPreflightFail) {
				resultStatus = "budget_exhausted";
				await writeMissionStatus(this.missionDir, "budget_exhausted");
				writeRecurringState(this.missionDir, recurState);
				writeLoopStateSync(this.missionDir, loopState);
				return {
					iteration: currentIteration,
					steps,
					status: resultStatus,
					item: currentItem,
					itemsExecuted,
				};
			}

			// Abort check before expensive work
			if (this.isAborted()) {
				writeRecurringState(this.missionDir, recurState);
				return this.abortTick(loopState, steps, currentIteration, currentItem);
			}

			// Build prompt with recurring flag
			const prompt = await buildExecutionPrompt({
				missionDir: this.missionDir,
				itemText: item.text,
				index: -1, // not in ROADMAP
				roadmapRaw,
				state: missionState,
				recurring: true,
				freshSession: this.sessionMode === "fresh",
			});

			// Execute
			steps.iterate = true;
			let iterResult: IterationResult;
			try {
				iterResult = await this.deps.executor.runIteration({
					missionDir: this.missionDir,
					prompt,
					cwd: this.missionDir,
				});
			} catch {
				// Executor failure → mark as run (interval gates retry), continue
				recurState = markRecurringRun(recurState, item, nowMs);
				writeRecurringState(this.missionDir, recurState);
				writeLoopStateSync(this.missionDir, loopState);
				continue;
			}

			// Budget counting
			const costTokens = iterResult.costTokens || 0;
			const costUsd = iterResult.costUsd || 0;
			loopState.budgetUsed.tokens += costTokens;
			loopState.budgetUsed.usd += costUsd;

			const isSuccess = iterResult.status === "COMPLETE";
			const isBlockOrFail = iterResult.status === "BLOCKED" || iterResult.status === "FAILED";

			// STATE.md update
			try {
				const currentState = await readState(this.missionDir);
				const newDone = [...currentState.done];
				const newBlockers = [...currentState.blockers];
				let newNextSteps = [...currentState.nextSteps];

				if (isSuccess) {
					if (!newDone.includes(item.text)) {
						newDone.push(item.text);
					}
					newNextSteps = [];
				} else if (isBlockOrFail) {
					const reason = iterResult.reason || "Recurring task issue";
					if (!isInfraError(reason)) {
						if (newBlockers.length === 0 || newBlockers[newBlockers.length - 1] !== reason) {
							newBlockers.push(reason);
						}
					}
				}

				await writeState(this.missionDir, {
					done: newDone,
					blockers: newBlockers,
					nextSteps: newNextSteps,
				});

				// Git commit (STATE.md only — ROADMAP not touched)
				await this.deps.git.commit({
					cwd: this.missionDir,
					message: `mission: recurring: ${item.text}`,
					files: ["STATE.md"],
				});
			} catch {
				// best-effort state/commit — markRecurringRun still happens
			}

			// Mark as run AFTER any outcome (interval gates retry)
			recurState = markRecurringRun(recurState, item, nowMs);
			writeRecurringState(this.missionDir, recurState);

			// F1: persist accumulated budget (recur phase mutates loopState.budgetUsed)
			writeLoopStateSync(this.missionDir, loopState);

			itemsExecuted++;
			currentItem = item.text;

			// Check budget post-hoc
			const tokensExceeded = budgetTokens > 0 && loopState.budgetUsed.tokens > budgetTokens;
			const usdExceeded = budgetUsd > 0 && loopState.budgetUsed.usd > budgetUsd;
			if (tokensExceeded || usdExceeded) {
				resultStatus = "budget_exhausted";
				await writeMissionStatus(this.missionDir, "budget_exhausted");
				break;
			}

			// Re-check mission status (may have changed during execution)
			try {
				const freshMission = await readMission(this.missionDir);
				const freshStatus = String(freshMission.frontmatter.status) as MissionStatus;
				if (freshStatus !== "active" && freshStatus !== "completed") {
					resultStatus = freshStatus;
					break;
				}
			} catch {
				// best-effort
			}

			// ralph-loop (S3): fresh mode — one recurring item per session,
			// rotate between due items. markRecurringRun above guarantees the
			// next tick's re-entry skips the item just executed.
			if (this.sessionMode === "fresh") {
				const moreDue = recurItems.some((other) => other !== item && isRecurringDue(other, recurState, nowMs));
				if (moreDue) {
					loopState.resumeAfterRotation = true;
					writeLoopStateSync(this.missionDir, loopState);
				}
				break;
			}
		}

		return {
			iteration: currentIteration,
			steps,
			status: resultStatus,
			item: currentItem,
			itemsExecuted,
		};
	}

	/**
	 * R2: Migrate legacy (recur) items from ROADMAP to RECURRING.md.
	 * For each legacy item:
	 * 1. Extract text without (recur) marker
	 * 2. Add to RECURRING.md with default interval (5m)
	 * 3. Mark [x] in ROADMAP
	 * 4. Single git commit for all migrations
	 */
	private async migrateLegacyRecurring(
		legacyItems: Array<{ index: number; text: string }>,
		roadmapRaw: string,
	): Promise<void> {
		// Extract clean text (remove (recur) marker)
		const itemsToAdd = legacyItems.map((item) => ({
			text: item.text.replace(/\s*\(recur\)\s*/gi, " ").trim(),
			intervalStr: "5m",
		}));

		// Append to RECURRING.md
		appendRecurringItems(this.missionDir, itemsToAdd);

		// Mark [x] in ROADMAP for each legacy item.
		// Can't use markRoadmapDone (it skips recurring items by design).
		// Instead, directly replace [ ] with [x] at the known line indices.
		const lines = roadmapRaw.split("\n");
		for (const item of legacyItems) {
			if (item.index >= 0 && item.index < lines.length) {
				lines[item.index] = lines[item.index].replace("[ ] ", "[x] ");
			}
		}
		const updatedRoadmap = lines.join("\n");
		await writeRoadmap(this.missionDir, updatedRoadmap);

		// Single git commit for the migration
		await this.deps.git.commit({
			cwd: this.missionDir,
			message: "mission: migrate recurring items to RECURRING.md",
			files: ["ROADMAP.md", "RECURRING.md"],
		});
	}

	/**
	 * Handle abort during tick: set journal interrupted, return aborted status,
	 * do NOT commit or write done-entries.
	 * P3-c: degraded-abort — persist abortedByOperator in journal AND update MISSION.md,
	 * so next tick is a no-op even if signal file is lost.
	 */
	private async abortTick(
		loopState: LoopState,
		steps: TickSteps,
		currentIteration: number,
		currentItem: string | undefined,
	): Promise<TickResult> {
		loopState.interrupted = true;
		loopState.abortedByOperator = true; // P3-c: persist for degraded recovery
		writeLoopStateSync(this.missionDir, loopState);
		// P3-c: update MISSION.md status to aborted (idempotent, best-effort)
		try {
			await writeMissionStatus(this.missionDir, "aborted");
		} catch {
			// best-effort — signal file is the primary mechanism
		}
		clearAbortSignal(this.missionDir);
		return {
			iteration: currentIteration,
			steps,
			status: "aborted",
			interrupted: true,
			item: currentItem,
		};
	}

	/**
	 * Step 6: Commit — writeState → writeRoadmap → git.commit → journal.
	 * P0-3: Idempotent — checks for duplicate done-entries and already-checked roadmap.
	 *
	 * 0.7.0: ROADMAP is re-read from disk before marking the item done — the
	 * executor may have edited it during the iteration (bootstrap planning
	 * appends unchecked items; writing the stale step-2 snapshot would erase
	 * those edits). Writes/commit are skipped entirely when nothing changed
	 * (repeated planning iterations on an unchanged roadmap must not fail the
	 * loop on an empty git commit).
	 */
	private async doStep6Commit(
		loopState: LoopState,
		nextItem: { index: number; text: string },
		roadmapRaw: string,
		iterResult: IterationResult,
		isSuccess: boolean,
		isBlockOrFail: boolean,
		budgetExceeded: boolean,
	): Promise<void> {
		const currentState = await readState(this.missionDir);
		const newDone = [...currentState.done];
		const newBlockers = [...currentState.blockers];
		let newNextSteps = [...currentState.nextSteps];
		let shouldGitCommit = false;

		// Check if already committed (recovery scenario)
		const alreadyInDone = currentState.done.includes(nextItem.text);
		const alreadyChecked = isRoadmapItemChecked(roadmapRaw, nextItem.index);
		const wasAlreadyCommitted = loopState.committed === true;

		if (wasAlreadyCommitted || (alreadyInDone && alreadyChecked)) {
			// Already committed during recovery — skip all writes
			return;
		}

		if (isSuccess) {
			// P0-3: dedup — only add if not already present
			if (!alreadyInDone) {
				newDone.push(nextItem.text);
			}
			newNextSteps = [];
			shouldGitCommit = true;
		} else if (isBlockOrFail) {
			const reason = iterResult.reason || "Blocker detected";
			// 0.7.2: infra errors (runner noise) are NOT written to STATE.md blockers
			if (!isInfraError(reason)) {
				// 0.7.2: dedup — don't add identical blocker if it's the last entry
				if (newBlockers.length === 0 || newBlockers[newBlockers.length - 1] !== reason) {
					newBlockers.push(reason);
				}
			}
		} else if (budgetExceeded) {
			newBlockers.push(
				`Budget exhausted: used ${loopState.budgetUsed.tokens} tokens / $${loopState.budgetUsed.usd.toFixed(2)}`,
			);
		}

		const stateChanged =
			JSON.stringify([newDone, newBlockers, newNextSteps]) !==
			JSON.stringify([currentState.done, currentState.blockers, currentState.nextSteps]);

		// 0.7.0: re-read ROADMAP from disk — the executor may have edited it
		// during step 4 (bootstrap planning); the step-2 snapshot is stale.
		let freshRoadmap = roadmapRaw;
		try {
			freshRoadmap = await readRoadmap(this.missionDir);
		} catch {
			freshRoadmap = roadmapRaw; // file vanished mid-tick — use the snapshot
		}
		const updatedRoadmap = shouldGitCommit
			? markRoadmapDone(freshRoadmap, nextItem.index, nextItem.text)
			: freshRoadmap;
		const roadmapChanged = updatedRoadmap !== roadmapRaw;

		// P0-3: order — writeState → writeRoadmap → git.commit → lastStep=6
		if (stateChanged) {
			await writeState(this.missionDir, {
				done: newDone,
				blockers: newBlockers,
				nextSteps: newNextSteps,
			});
		}

		// 0.7.3: git commit happens when:
		// - roadmapChanged (normal items: checkbox marked [x])
		// - OR stateChanged AND item is recurring (recur items: state changes but roadmap doesn't)
		// Planning items (index -1) keep original behavior: no commit if roadmap unchanged.
		const isRecur = isRecurringItem(nextItem.text);
		const shouldCommitNow = shouldGitCommit && (roadmapChanged || (stateChanged && isRecur));

		if (shouldCommitNow) {
			// Write roadmap only if it actually changed (recur items: no-op)
			if (roadmapChanged) {
				await writeRoadmap(this.missionDir, updatedRoadmap);
			}

			const msg = `mission: ${nextItem.text}`;
			const commitFiles = roadmapChanged ? ["STATE.md", "ROADMAP.md"] : ["STATE.md"];
			await this.deps.git.commit({
				cwd: this.missionDir,
				message: msg,
				files: commitFiles,
			});

			loopState.committed = true;
			writeLoopStateSync(this.missionDir, loopState);
		}

		// Persist budget_exhausted status (blocker already written above)
		if (budgetExceeded) {
			await writeMissionStatus(this.missionDir, "budget_exhausted");
		}
	}

	/**
	 * Append a backlog entry (step 7 helper).
	 */
	private async appendBacklogEntry(
		_loopState: LoopState,
		now: Date,
		currentIteration: number,
		opts: {
			text: string;
			isSuccess: boolean;
			isBlockOrFail: boolean;
			costUsd: number;
			iterStatus?: string;
			budgetExhausted?: boolean;
			budgetUsed?: { tokens: number; usd: number };
			budgetTokens?: number;
			/** 0.7.2: if true, skip writing to BACKLOG (infra error) */
			skipBacklog?: boolean;
		},
	): Promise<void> {
		// 0.7.2: infra errors are runner noise — skip BACKLOG entry entirely
		if (opts.skipBacklog) {
			return;
		}

		const { appendBacklog } = await import("./file-state-manager.js");

		let idea: string;
		if (opts.budgetExhausted && !opts.isSuccess) {
			const used = opts.budgetUsed;
			idea = used
				? `Budget exhausted: ${used.tokens} tokens / $${used.usd.toFixed(2)}`
				: `Budget exhausted: ${opts.text}`;
		} else if (opts.isSuccess) {
			idea = `Completed: ${opts.text}`;
		} else {
			idea = `Iteration ${currentIteration}: ${opts.iterStatus ?? opts.text}`;
		}

		await appendBacklog(this.missionDir, {
			id: randomUUID().slice(0, 8),
			date: now.toISOString(),
			idea,
			source: "mission-loop",
			fit: 0,
			value: opts.isSuccess ? 1 : 0,
			risk: opts.isBlockOrFail ? 1 : 0,
			cost: opts.costUsd,
			score: opts.isSuccess ? 1 : 0,
			status: opts.iterStatus ?? (opts.isSuccess ? "COMPLETE" : opts.isBlockOrFail ? "BLOCKED" : "DECIDE"),
		});
	}
}
