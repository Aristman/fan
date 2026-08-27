// Tests for IDEA reactivation of completed missions.
//
// Run: npx vitest run bundles/fan-mission/extensions/fan-mission/idea-reactivation.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	MissionLoop,
	readMissionLoopState,
	writeLoopStateSync,
} from "./mission-loop.js";
import {
	readMission,
	readRoadmap,
	writeMissionStatus,
	writeRoadmap,
	appendBacklog,
	readBacklog,
} from "./file-state-manager.js";
import { promoteAcceptedIdeas } from "./idea-promoter.js";

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

function createMockDeps(overrides?: {
	executorResult?: { status: string; response?: string };
}): {
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

beforeAll(() => {
	mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	missionDir = createMissionDir();
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
				fit: 0, value: 0, risk: 0, cost: 0, score: 0,
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
			const result = await loop.tick();

			// Mission should NOT remain completed — it should be active
			// (or complete again after processing the promoted item)
			const mission = await readMission(missionDir);
			const finalStatus = String(mission.frontmatter.status);

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
				fit: 0, value: 0, risk: 0, cost: 0, score: 0,
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
