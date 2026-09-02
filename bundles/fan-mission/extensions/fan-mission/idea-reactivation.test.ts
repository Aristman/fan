// Tests for IDEA reactivation of completed missions.
//
// Run: npx vitest run bundles/fan-mission/extensions/fan-mission/idea-reactivation.test.ts

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendBacklog,
	hasUncheckedRoadmapItems,
	readBacklog,
	readMission,
	readRoadmap,
	writeMissionStatus,
	writeRoadmap,
} from "./file-state-manager.js";
import { promoteAcceptedIdeas } from "./idea-promoter.js";
import { MissionLoop, readMissionLoopState, writeLoopStateSync } from "./mission-loop.js";
import {
	BOOTSTRAP_PLANNING_GUIDANCE,
	buildExecutionPrompt,
	IDEA_PLANNING_GUIDANCE,
	ITEM_SIZE_GUIDANCE,
	PLANNING_ITEM_TEXT,
	RECUR_GUIDANCE,
} from "./prompt-builder.js";
import { registerMissionSlashCommands, type SlashCommandRegister, type SlashCtx } from "./slash-commands.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

let missionDir: string;
const tmpRoot = join(tmpdir(), "fan-mission-idea-reactivate-test");

const MISSION_TEMPLATE = `---
mission_id: test-idea-reactivate
created: 2026-08-27T00:00:00.000Z
status: completed
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

const BACKLOG_HEADER =
	"| id | date | idea | source | fit | value | risk | cost | score | status |\n" +
	"|-----|------|------|--------|-----|-------|------|------|-------|--------|\n";

function createMissionDir(opts?: { roadmap?: string; backlog?: string }): string {
	const dir = join(tmpRoot, `mission-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "MISSION.md"), MISSION_TEMPLATE, "utf8");
	writeFileSync(join(dir, "ROADMAP.md"), opts?.roadmap ?? "- [x] Done thing\n", "utf8");
	writeFileSync(join(dir, "STATE.md"), "## Сделано\n\n## Блокеры\n\n## Следующие шаги\n", "utf8");
	writeFileSync(join(dir, "BACKLOG.md"), opts?.backlog ?? BACKLOG_HEADER, "utf8");
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
		executor: { runIteration: vi.fn().mockResolvedValue(result) },
		git: {
			commit: vi.fn().mockResolvedValue({ hash: "abc123" }),
			log: vi.fn().mockResolvedValue([]),
			status: vi.fn().mockResolvedValue({ clean: true }),
		},
		clock: { now: () => new Date("2026-08-27T12:00:00.000Z") },
		lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
	};
}

// ─── Slash-command test helpers (mocked DI per SlashCtx) ────────────────────

type SlashHandler = (args: string, ctx: SlashCtx) => Promise<void>;

type MockMissionLoopHandle = {
	tick: ReturnType<typeof vi.fn>;
	status: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	resolveDecision: ReturnType<typeof vi.fn>;
	completeMission: ReturnType<typeof vi.fn>;
};

function createMockMissionLoop(statusValue = "completed"): MockMissionLoopHandle {
	return {
		tick: vi.fn().mockResolvedValue({ status: statusValue }),
		status: vi.fn().mockResolvedValue(statusValue),
		abort: vi.fn().mockResolvedValue(undefined),
		resolveDecision: vi.fn().mockResolvedValue(undefined),
		completeMission: vi.fn().mockResolvedValue(undefined),
	};
}

function createSlashCtx(overrides?: Partial<SlashCtx>): { ctx: SlashCtx; outputLines: string[] } {
	const outputLines: string[] = [];
	const ctx: SlashCtx = {
		actions: {
			sendMessage: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockResolvedValue(undefined),
			setDrainAfterCurrentTurn: vi.fn(),
			resume: vi.fn(),
		},
		output: (line: string) => {
			outputLines.push(line);
		},
		...overrides,
	};
	return { ctx, outputLines };
}

function registerSlashHandlers(registrationCtx: SlashCtx): Map<string, SlashHandler> {
	const handlers = new Map<string, SlashHandler>();
	const register: SlashCommandRegister = (name, def) => {
		handlers.set(name, def.handler);
	};
	registerMissionSlashCommands(register, registrationCtx);
	return handlers;
}

/** Give detached setTimeout(…, 0) ticks a chance to run. */
function flushDetachedTicks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

const IDEA_ENTRY = {
	id: "idea-100",
	date: "2026-08-27T12:00:00.000Z",
	idea: "Reactivation idea from operator",
	source: "operator",
	fit: 0,
	value: 0,
	risk: 0,
	cost: 0,
	score: 0,
	status: "IDEA",
};

beforeAll(() => {
	mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	missionDir = createMissionDir();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("IDEA reactivation of completed missions", () => {
	describe("tick() on completed mission with IDEA entries", () => {
		it("should reactivate completed mission when BACKLOG has IDEA entries and fall into main loop", async () => {
			// Add an IDEA entry to BACKLOG.md
			const ideaEntry = {
				id: "idea-001",
				date: "2026-08-27T12:00:00.000Z",
				idea: "Test idea from operator",
				source: "operator",
				fit: 0,
				value: 0,
				risk: 0,
				cost: 0,
				score: 0,
				status: "IDEA",
			};
			await appendBacklog(missionDir, ideaEntry);

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
				ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
			});

			// Tick on completed mission with IDEA should:
			// 1. Reactivate to active
			// 2. Promote IDEA → ROADMAP (direct path, no scorer)
			// 3. Process new unchecked ROADMAP items
			await loop.tick();

			// Mission should NOT remain completed — it should be active
			// (or complete again after processing the promoted item)

			// The IDEA should have been promoted (status changed from IDEA)
			const backlog = await readBacklog(missionDir);
			const ideaEntryAfter = backlog.find((e) => e.id === "idea-001");
			expect(ideaEntryAfter?.status).not.toBe("IDEA");

			// ROADMAP should have the promoted idea as unchecked item
			const roadmapRaw = await readRoadmap(missionDir);
			expect(roadmapRaw).toContain("Test idea from operator");
		});

		it("should stay in recur-phase when completed mission has no IDEA entries", async () => {
			// No IDEA entries in BACKLOG.md
			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
			});

			const result = await loop.tick();

			// Should complete normally (no IDEA to reactivate)
			expect(result.status).toBe("completed");

			// Status should still be completed
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("completed");
		});

		it("should promote operator IDEA directly to ROADMAP without scorer", async () => {
			// Add IDEA entry
			const ideaEntry = {
				id: "idea-002",
				date: "2026-08-27T12:00:00.000Z",
				idea: "Another operator idea",
				source: "operator",
				fit: 0,
				value: 0,
				risk: 0,
				cost: 0,
				score: 0,
				status: "IDEA",
			};
			await appendBacklog(missionDir, ideaEntry);

			const deps = createMockDeps();
			const loop = new MissionLoop({
				missionDir,
				deps,
				ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
			});

			await loop.tick();

			// IDEA entry should now have status ROADMAP (promoted) or PROMOTED
			const backlog = await readBacklog(missionDir);
			const entry = backlog.find((e) => e.id === "idea-002");
			expect(entry?.status).toBe("PROMOTED");
		});
	});

	describe("FSM: completed → active", () => {
		it("should allow transition from completed to active", async () => {
			// already verified in existing tests, but explicit here
			await writeMissionStatus(missionDir, "completed");
			await writeMissionStatus(missionDir, "active");
			const mission = await readMission(missionDir);
			expect(String(mission.frontmatter.status)).toBe("active");
		});
	});
});

describe("/mission:start on a completed mission (slash-command DI mocks)", () => {
	it("reactivates completed mission with IDEA in backlog: status → active, attach called, tick scheduled", async () => {
		await appendBacklog(missionDir, IDEA_ENTRY);

		// Stale abort artifacts — reactivation must clear them.
		writeFileSync(join(missionDir, ".mission-abort-signal"), "abort", "utf8");
		writeLoopStateSync(missionDir, {
			currentIteration: 3,
			lastStep: 4,
			interrupted: true,
			budgetUsed: { tokens: 100, usd: 1 },
			abortedByOperator: true,
		});

		const mockLoop = createMockMissionLoop();
		const { ctx, outputLines } = createSlashCtx({
			missionLoop: null,
			findAttachableMission: vi.fn().mockResolvedValue({ missionDir, status: "completed" }),
		});
		const attach = vi.fn((dir: string): MissionLoop => {
			ctx.missionLoop = mockLoop as unknown as MissionLoop;
			ctx.missionDir = dir;
			return mockLoop as unknown as MissionLoop;
		});
		ctx.attach = attach;

		const handlers = registerSlashHandlers(ctx);
		const start = handlers.get("mission:start");
		expect(start).toBeDefined();
		await start?.("", ctx);
		await flushDetachedTicks();

		// MISSION.md flipped to active (real writeMissionStatus, FSM allows completed → active)
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");

		// Loop attached exactly once for the found mission
		expect(attach).toHaveBeenCalledTimes(1);
		expect(attach).toHaveBeenCalledWith(missionDir);

		// Tick scheduled: direct handler tick + detached lazy-attach tick
		expect(mockLoop.tick.mock.calls.length).toBeGreaterThanOrEqual(2);

		// Abort artifacts cleared by clearMissionAbortArtifacts
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.abortedByOperator).toBe(false);
		expect(loopState.interrupted).toBe(false);

		// Operator feedback
		expect(outputLines.some((line) => line.includes("Mission reactivated"))).toBe(true);
	});

	it("reactivates completed mission with unchecked ROADMAP items (no IDEA in backlog)", async () => {
		await writeRoadmap(missionDir, "- [x] Done thing\n- [ ] Fresh unchecked work\n");

		const mockLoop = createMockMissionLoop();
		const { ctx, outputLines } = createSlashCtx({
			missionLoop: null,
			findAttachableMission: vi.fn().mockResolvedValue({ missionDir, status: "completed" }),
		});
		const attach = vi.fn((dir: string): MissionLoop => {
			ctx.missionLoop = mockLoop as unknown as MissionLoop;
			ctx.missionDir = dir;
			return mockLoop as unknown as MissionLoop;
		});
		ctx.attach = attach;

		const handlers = registerSlashHandlers(ctx);
		await handlers.get("mission:start")?.("", ctx);
		await flushDetachedTicks();

		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
		expect(attach).toHaveBeenCalledTimes(1);
		expect(outputLines.some((line) => line.includes("Mission reactivated"))).toBe(true);
	});

	it("keeps completed status and prints hint when ROADMAP is fully done and backlog has no IDEA", async () => {
		// default fixture: ROADMAP `- [x] Done thing`, header-only BACKLOG
		const mockLoop = createMockMissionLoop();
		const { ctx, outputLines } = createSlashCtx({
			missionLoop: null,
			findAttachableMission: vi.fn().mockResolvedValue({ missionDir, status: "completed" }),
		});
		const attach = vi.fn((dir: string): MissionLoop => {
			ctx.missionLoop = mockLoop as unknown as MissionLoop;
			ctx.missionDir = dir;
			return mockLoop as unknown as MissionLoop;
		});
		ctx.attach = attach;

		const handlers = registerSlashHandlers(ctx);
		await handlers.get("mission:start")?.("", ctx);
		await flushDetachedTicks();

		// No reactivation: status unchanged, loop not attached, no tick
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("completed");
		expect(attach).not.toHaveBeenCalled();
		expect(mockLoop.tick).not.toHaveBeenCalled();

		// Hint: add unchecked ROADMAP items or create a new mission
		const joined = outputLines.join("\n");
		expect(joined).toContain("is completed");
		expect(joined).toContain("ROADMAP.md");
	});

	it("tick-handler: attached loop reporting completed + IDEA → writeStatus(active) and tick() once", async () => {
		await appendBacklog(missionDir, IDEA_ENTRY);

		const mockLoop = createMockMissionLoop("completed");
		const { ctx, outputLines } = createSlashCtx({
			missionLoop: mockLoop as unknown as MissionLoop,
			missionDir,
		});

		const handlers = registerSlashHandlers(ctx);
		await handlers.get("mission:start")?.("", ctx);

		// Exactly one tick (no lazy-attach detached tick on this path)
		expect(mockLoop.tick).toHaveBeenCalledTimes(1);

		// Status written active via real writeMissionStatus
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
		expect(outputLines.some((line) => line.includes("Mission reactivated"))).toBe(true);
	});

	it("tick-handler: attached loop reporting completed + nothing pending → tick skipped with hint", async () => {
		const mockLoop = createMockMissionLoop("completed");
		const { ctx, outputLines } = createSlashCtx({
			missionLoop: mockLoop as unknown as MissionLoop,
			missionDir,
		});

		const handlers = registerSlashHandlers(ctx);
		await handlers.get("mission:start")?.("", ctx);

		expect(mockLoop.tick).not.toHaveBeenCalled();
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("completed");
		const joined = outputLines.join("\n");
		expect(joined).toContain("tick skipped");
		expect(joined).toContain("is completed");
	});
});

describe("reactivation condition helpers (hasUncheckedRoadmapItems / readBacklog)", () => {
	it("produces the combinations lazyAttachForStart relies on", async () => {
		// default fixture: ROADMAP all checked, BACKLOG header-only
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(false);
		expect((await readBacklog(missionDir)).some((e) => e.status === "IDEA")).toBe(false);

		// unchecked item appears → true regardless of backlog
		await writeRoadmap(missionDir, "- [x] Done thing\n- [ ] Fresh work\n");
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(true);

		// back to all checked + IDEA entry → only the backlog condition holds
		await writeRoadmap(missionDir, "- [x] Done thing\n");
		await appendBacklog(missionDir, IDEA_ENTRY);
		expect(await hasUncheckedRoadmapItems(missionDir)).toBe(false);
		expect((await readBacklog(missionDir)).some((e) => e.status === "IDEA")).toBe(true);
	});
});

describe("prompt-builder: size-heuristic guidance for promoted ideas (F-22)", () => {
	const EMPTY_STATE = { done: [], blockers: [], nextSteps: [] };

	function ideaOpts(itemText: string, roadmapRaw: string, index: number) {
		return { missionDir, itemText, index, roadmapRaw, state: EMPTY_STATE };
	}

	it("(a) item with (idea:id) → prompt contains IDEA_PLANNING_GUIDANCE", async () => {
		const roadmap = "- [x] Done thing\n- [ ] Add export button (idea:idea-100)\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Add export button (idea:idea-100)", roadmap, 1));
		expect(prompt).toContain(IDEA_PLANNING_GUIDANCE);
	});

	it("(b) regular item → neither idea guidance nor bootstrap guidance", async () => {
		const roadmap = "- [x] Done thing\n- [ ] Plain small task\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Plain small task", roadmap, 1));
		expect(prompt).not.toContain(IDEA_PLANNING_GUIDANCE);
		expect(prompt).not.toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	it("(c) bootstrap item → bootstrap guidance present, idea guidance absent", async () => {
		// isPlanningIteration requires a non-empty `## Goal` section in MISSION.md
		writeFileSync(join(missionDir, "MISSION.md"), `${MISSION_TEMPLATE}\n## Goal\nBuild the thing\n`, "utf8");
		const roadmap = "- [ ] Bootstrap mission: decompose the goal\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Bootstrap mission: decompose the goal", roadmap, 0));
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
		expect(prompt).not.toContain(IDEA_PLANNING_GUIDANCE);
	});

	it("(d) [EPIC] item with (idea:id) → idea guidance NOT added (own delegation path)", async () => {
		const item = "[EPIC] Big multi-module feature (idea:idea-200)";
		const roadmap = `- [x] Done thing\n- [ ] ${item}\n`;
		const prompt = await buildExecutionPrompt(ideaOpts(item, roadmap, 1));
		expect(prompt).not.toContain(IDEA_PLANNING_GUIDANCE);
		expect(prompt).not.toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	// ── Anti-long-steps: ITEM_SIZE_GUIDANCE wiring (Task B) ──────────────────

	it("(e) regular item → prompt contains ITEM_SIZE_GUIDANCE", async () => {
		const roadmap = "- [x] Done thing\n- [ ] Plain small task\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Plain small task", roadmap, 1));
		expect(prompt).toContain(ITEM_SIZE_GUIDANCE);
	});

	it("(f) planning item → no ITEM_SIZE_GUIDANCE (own bootstrap guidance)", async () => {
		// isPlanningIteration requires a non-empty `## Goal` section in MISSION.md
		writeFileSync(join(missionDir, "MISSION.md"), `${MISSION_TEMPLATE}\n## Goal\nBuild the thing\n`, "utf8");
		const roadmap = `- [ ] ${PLANNING_ITEM_TEXT}\n`;
		const prompt = await buildExecutionPrompt(ideaOpts(PLANNING_ITEM_TEXT, roadmap, 0));
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
		expect(prompt).not.toContain(ITEM_SIZE_GUIDANCE);
	});

	it("(g) (idea:id) item → F-22 guidance instead of ITEM_SIZE_GUIDANCE", async () => {
		const roadmap = "- [x] Done thing\n- [ ] Add export button (idea:idea-100)\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Add export button (idea:idea-100)", roadmap, 1));
		expect(prompt).toContain(IDEA_PLANNING_GUIDANCE);
		expect(prompt).not.toContain(ITEM_SIZE_GUIDANCE);
	});

	it("(h) [EPIC] item → no ITEM_SIZE_GUIDANCE (own delegation path)", async () => {
		const item = "[EPIC] Big multi-module feature";
		const roadmap = `- [x] Done thing\n- [ ] ${item}\n`;
		const prompt = await buildExecutionPrompt(ideaOpts(item, roadmap, 1));
		expect(prompt).not.toContain(ITEM_SIZE_GUIDANCE);
	});

	it("(i) recurring item → no ITEM_SIZE_GUIDANCE (tick semantics)", async () => {
		const item = "Watch the loop (recur)";
		const roadmap = `- [x] Done thing\n- [ ] ${item}\n`;
		const prompt = await buildExecutionPrompt(ideaOpts(item, roadmap, 1));
		expect(prompt).toContain(RECUR_GUIDANCE);
		expect(prompt).not.toContain(ITEM_SIZE_GUIDANCE);
	});

	it("(j) bootstrap item → prompt contains the ~20–30 minutes sizing phrase", async () => {
		writeFileSync(join(missionDir, "MISSION.md"), `${MISSION_TEMPLATE}\n## Goal\nBuild the thing\n`, "utf8");
		const roadmap = "- [ ] Bootstrap mission: decompose the goal\n";
		const prompt = await buildExecutionPrompt(ideaOpts("Bootstrap mission: decompose the goal", roadmap, 0));
		expect(prompt).toContain("~20–30 minutes");
	});
});
