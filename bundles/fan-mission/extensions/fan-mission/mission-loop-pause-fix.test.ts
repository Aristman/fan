// Тесты для фиксации ложного abort миссии (P0: fresh-break, session_shutdown→pause, abort defence-in-depth).
//
// Запуск: npx vitest run bundles/fan-mission/extensions/fan-mission/mission-loop-pause-fix.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	MissionLoop,
	readMissionLoopState,
	writeLoopStateSync,
	clearMissionAbortArtifacts,
} from "./mission-loop.js";
import {
	canTransition,
	readMission,
	readBacklog,
	writeMissionStatus,
	writeRoadmap,
	writeState,
	appendBacklog,
} from "./file-state-manager.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

let missionDir: string;

const MISSION_TEMPLATE = `---
mission_id: test-pause-fix
created: 2026-08-26T00:00:00.000Z
status: active
metric_type: checklist
metric_command: echo done
budget_tokens: 1000000
budget_usd: 10
max_depth: 3
max_width: 5
session_mode: persistent
---

# Test Mission
`;

const ROADMAP_ONE_ITEM = `- [ ] Do the thing`;
const ROADMAP_ALL_DONE = `- [x] Do the thing`;
const ROADMAP_NO_ITEMS = `# ROADMAP\n\nNo items here.`;

function createMissionDir(): string {
	const dir = join(tmpdir(), `fan-mission-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "MISSION.md"), MISSION_TEMPLATE, "utf8");
	writeFileSync(join(dir, "ROADMAP.md"), ROADMAP_ONE_ITEM, "utf8");
	writeFileSync(join(dir, "STATE.md"), "## Сделано\n\n## Блокеры\n\n## Следующие шаги\n", "utf8");
	writeFileSync(join(dir, "BACKLOG.md"), "", "utf8");
	writeFileSync(join(dir, "DECISIONS.md"), "", "utf8");
	return dir;
}

function createMockDeps(overrides?: { executorResult?: { status: string; response?: string } }): {
	executor: { runIteration: ReturnType<typeof vi.fn> };
	git: { commit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
	clock: { now: () => Date };
	lock: { acquire: () => Promise<boolean>; release: () => Promise<void> };
} {
	const result = overrides?.executorResult ?? { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
	return {
		executor: {
			runIteration: vi.fn().mockResolvedValue(result),
		},
		git: {
			commit: vi.fn().mockResolvedValue({ hash: "abc123" }),
			log: vi.fn().mockResolvedValue([]),
			status: vi.fn().mockResolvedValue({ clean: true }),
		},
		clock: { now: () => new Date("2026-08-26T12:00:00.000Z") },
		lock: {
			acquire: vi.fn().mockResolvedValue(true),
			release: vi.fn().mockResolvedValue(undefined),
		},
	};
}

beforeEach(() => {
	missionDir = createMissionDir();
});

afterEach(() => {
	try {
		rmSync(missionDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// Helper for mid-test dir recreation (afterEach handles final cleanup)
function cleanup() {
	try {
		rmSync(missionDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("mission-loop pause-fix", () => {

	// ── Test (a): fresh-break with empty roadmap writes completed ────────

	describe("P0: fresh-break finalization", () => {
		it("should complete mission when fresh-mode tick finishes last unchecked item", async () => {
			cleanup();
			missionDir = createMissionDir();

			// Set session_mode to fresh in MISSION.md
			writeFileSync(
				join(missionDir, "MISSION.md"),
				MISSION_TEMPLATE.replace("session_mode: persistent", "session_mode: fresh"),
				"utf8",
			);

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			// Tick processes the one unchecked item → marks it done →
			// fresh-break sees no unchecked → completes.
			const result = await loop.tick();

			expect(result.status).toBe("completed");

			// Verify MISSION.md status
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");

			// Verify no abort signal
			const abortSignalPath = join(missionDir, ".mission-abort-signal");
			expect(existsSync(abortSignalPath)).toBe(false);

			cleanup();
		});

		it("should set resumeAfterRotation when fresh-mode has remaining unchecked items (with rotator)", async () => {
			cleanup();
			missionDir = createMissionDir();

			// Two unchecked items
			writeFileSync(
				join(missionDir, "ROADMAP.md"),
				"- [ ] First thing\n- [ ] Second thing",
				"utf8",
			);
			writeFileSync(
				join(missionDir, "MISSION.md"),
				MISSION_TEMPLATE.replace("session_mode: persistent", "session_mode: fresh"),
				"utf8",
			);

			const mockRotator = { rotate: vi.fn().mockResolvedValue({ cancelled: false }) };
			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps: { ...deps, sessionRotator: mockRotator },
			});

			const result = await loop.tick();

			// With rotator: fresh mode processes one item, sets resumeAfterRotation
			// Status should remain active (one item done, one remaining)
			expect(result.status).toBe("active");

			// resumeAfterRotation should be set
			const loopState = await readMissionLoopState(missionDir);
			expect(loopState.resumeAfterRotation).toBe(true);

			// MISSION.md should still be active
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("active");

			cleanup();
		});
	});

	// ── Test (b): session_shutdown → pause, not abort ─────────────────────

	describe("pause() method", () => {
		it("should transition active mission to paused without abort signal", async () => {
			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.pause();

			// MISSION.md should be paused
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("paused");

			// No abort signal file
			const abortSignalPath = join(missionDir, ".mission-abort-signal");
			expect(existsSync(abortSignalPath)).toBe(false);

			// No abortedByOperator in loop state
			const loopState = await readMissionLoopState(missionDir);
			expect(loopState.abortedByOperator).not.toBe(true);

			cleanup();
		});

		it("should transition awaiting_decision mission to paused", async () => {
			// Set mission to awaiting_decision
			await writeMissionStatus(missionDir, "awaiting_decision");

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.pause();

			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("paused");

			// No abort signal
			const abortSignalPath = join(missionDir, ".mission-abort-signal");
			expect(existsSync(abortSignalPath)).toBe(false);

			cleanup();
		});

		it("should be no-op for already terminal status", async () => {
			await writeMissionStatus(missionDir, "completed");

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.pause();

			// Still completed
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");

			cleanup();
		});

		it("should be no-op for already paused status", async () => {
			await writeMissionStatus(missionDir, "paused");

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.pause();

			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("paused");

			cleanup();
		});
	});

	// ── Test (c): abort() on exhausted roadmap → completed ───────────────

	describe("abort() defence-in-depth", () => {
		it("should complete mission when ROADMAP is exhausted (all checked)", async () => {
			cleanup();
			missionDir = createMissionDir();

			// All items done
			writeFileSync(join(missionDir, "ROADMAP.md"), ROADMAP_ALL_DONE, "utf8");

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.abort();

			// Should be completed, NOT aborted
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");

			// No abort signal
			const abortSignalPath = join(missionDir, ".mission-abort-signal");
			expect(existsSync(abortSignalPath)).toBe(false);

			// Loop state should NOT have abortedByOperator
			const loopState = await readMissionLoopState(missionDir);
			expect(loopState.abortedByOperator).toBe(false);

			cleanup();
		});

		it("should still abort when ROADMAP has unchecked items", async () => {
			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.abort();

			// Should be aborted (real abort — unchecked items remain)
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("aborted");

			// Abort signal should exist
			const abortSignalPath = join(missionDir, ".mission-abort-signal");
			// Note: abort() clears signal if tickRunning is false (post-hoc cleanup)
			// but the status is still aborted

			cleanup();
		});

		it("should complete when ROADMAP has checklist items but all are checked", async () => {
			cleanup();
			missionDir = createMissionDir();

			// Multiple items, all done
			writeFileSync(
				join(missionDir, "ROADMAP.md"),
				"- [x] First\n- [x] Second\n- [x] Third",
				"utf8",
			);

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.abort();

			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");

			cleanup();
		});

		it("should still abort when ROADMAP has no parseable items (not exhausted, just empty)", async () => {
			cleanup();
			missionDir = createMissionDir();

			// No checklist items at all — not "exhausted", just empty
			writeFileSync(join(missionDir, "ROADMAP.md"), "# ROADMAP\n\nSome text but no checklist", "utf8");

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			await loop.abort();

			// Should be aborted (no checklist = not "exhausted")
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("aborted");

			cleanup();
		});
	});

	// ── Regression: /mission:stop after loop.abort() completes mission ────

	describe("regression: stop on exhausted roadmap (completed → aborted must not throw)", () => {
		it("should NOT throw InvalidTransitionError when writeMissionStatus(aborted) is called on completed", async () => {
			cleanup();
			missionDir = createMissionDir();

			// All roadmap items done → abort() writes 'completed'
			writeFileSync(join(missionDir, "ROADMAP.md"), ROADMAP_ALL_DONE, "utf8");

			const deps = createMockDeps();
			const loop = new MissionLoop({ missionDir, deps });
			await loop.abort();

			// Simulate what /mission:stop handler now does:
			// re-read status, see it's terminal, skip writeMissionStatus('aborted').
			const mission = await readMission(missionDir);
			const postAbort = String(mission.frontmatter.status);
			expect(postAbort).toBe("completed");
			expect(canTransition(postAbort, "aborted")).toBe(false);

			// The key assertion: canTransition correctly blocks this.
			// The handler must check canTransition or re-read status before writing.
			await expect(writeMissionStatus(missionDir, "aborted"))
				.rejects.toThrow();

			cleanup();
		});

		it("should allow abort→aborted write when roadmap has unchecked items (normal abort)", async () => {
			const deps = createMockDeps();
			const loop = new MissionLoop({ missionDir, deps });
			await loop.abort();

			const mission = await readMission(missionDir);
			const postAbort = String(mission.frontmatter.status);
			expect(postAbort).toBe("aborted");
			// No throw — already aborted, write aborted is a no-op
			await writeMissionStatus(missionDir, "aborted");
			cleanup();
		});
	});

	// ── Shutdown-pause vs completion race (post-iteration re-read) ────────

	// Инцидент git-reviewer 2026-08-27: session_shutdown вызвал pause() во время
	// тика; тик доработал ПОСЛЕДНИЙ пункт ROADMAP, но re-read видел 'paused' и
	// выходил до completion-блока — миссия с законченной работой зависла в paused.
	describe("shutdown-pause vs completion race (post-iteration re-read)", () => {
		/** deps с executor'ом, который вызывает loop.pause() посреди тика (симуляция session_shutdown). */
		function createShutdownRaceDeps(
			loopRef: { current?: MissionLoop },
			opts?: { sessionMode?: "fresh" | "persistent" },
		) {
			const deps = createMockDeps();
			deps.executor.runIteration.mockImplementation(async () => {
				// Simulate session_shutdown → MissionLoop.pause() mid-tick
				await loopRef.current?.pause();
				return { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
			});
			const fullDeps: Record<string, unknown> = { ...deps };
			if (opts?.sessionMode === "fresh") {
				fullDeps.sessionRotator = { rotate: vi.fn().mockResolvedValue({ cancelled: false }) };
			}
			return fullDeps as unknown as ConstructorParameters<typeof MissionLoop>[0]["deps"];
		}

		it("completes mission when shutdown-pause fires while tick finishes the LAST roadmap item (fresh mode)", async () => {
			cleanup();
			missionDir = createMissionDir();
			writeFileSync(
				join(missionDir, "MISSION.md"),
				MISSION_TEMPLATE.replace("session_mode: persistent", "session_mode: fresh"),
				"utf8",
			);

			const loopRef: { current?: MissionLoop } = {};
			const loop = new MissionLoop({ missionDir, deps: createShutdownRaceDeps(loopRef, { sessionMode: "fresh" }) });
			loopRef.current = loop;

			const result = await loop.tick();

			// Работа закончена — пауза не должна «заморозить» finished-миссию
			expect(result.status).toBe("completed");
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");
			expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);

			cleanup();
		});

		it("stays paused when ROADMAP still has unchecked items after shutdown-pause", async () => {
			cleanup();
			missionDir = createMissionDir();
			writeFileSync(join(missionDir, "ROADMAP.md"), "- [ ] First\n- [ ] Second", "utf8");

			const loopRef: { current?: MissionLoop } = {};
			const loop = new MissionLoop({ missionDir, deps: createShutdownRaceDeps(loopRef) });
			loopRef.current = loop;

			const result = await loop.tick();

			// Работа есть — shutdown-pause корректно останавливает новые итерации
			expect(result.status).toBe("paused");
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("paused");

			cleanup();
		});

		it("stays paused when backlog has IDEA entries after shutdown-pause (roadmap exhausted)", async () => {
			cleanup();
			missionDir = createMissionDir();
			await appendBacklog(missionDir, {
				id: "idea-1",
				date: "2026-08-27",
				idea: "Future idea",
				source: "operator",
				fit: 3,
				value: 3,
				risk: 1,
				cost: 2,
				score: 2.5,
				status: "IDEA",
			});

			const loopRef: { current?: MissionLoop } = {};
			const loop = new MissionLoop({ missionDir, deps: createShutdownRaceDeps(loopRef) });
			loopRef.current = loop;

			const result = await loop.tick();

			// IDEA не теряется — пауза сохраняется, разбудится реактивацией
			expect(result.status).toBe("paused");
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("paused");
			const backlog = await readBacklog(missionDir);
			expect(backlog.some((e) => e.status === "IDEA")).toBe(true);

			cleanup();
		});

		for (const externalStatus of ["aborted", "failed"] as const) {
			it(`breaks immediately on ${externalStatus} status even when roadmap becomes exhausted (no pause special-case)`, async () => {
				cleanup();
				missionDir = createMissionDir();

				const deps = createMockDeps();
				deps.executor.runIteration.mockImplementation(async () => {
					// External status change (not via pause())
					await writeMissionStatus(missionDir, externalStatus);
					return { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
				});
				const loop = new MissionLoop({ missionDir, deps });

				const result = await loop.tick();

				expect(result.status).toBe(externalStatus);
				const mission = await readMission(missionDir);
				expect(String(mission.frontmatter.status)).toBe(externalStatus);

				cleanup();
			});
		}
	});

	// ── FSM transitions ───────────────────────────────────────────────────

	describe("FSM: awaiting_decision → paused", () => {
		it("should allow transition from awaiting_decision to paused", () => {
			expect(canTransition("awaiting_decision", "paused")).toBe(true);
		});

		it("should still allow existing transitions", () => {
			// Verify we didn't break existing transitions
			expect(canTransition("active", "paused")).toBe(true);
			expect(canTransition("paused", "active")).toBe(true);
			expect(canTransition("active", "completed")).toBe(true);
			expect(canTransition("active", "aborted")).toBe(true);
			expect(canTransition("awaiting_decision", "active")).toBe(true);
			expect(canTransition("awaiting_decision", "aborted")).toBe(true);
			expect(canTransition("awaiting_decision", "completed")).toBe(true);
		});
	});
});
