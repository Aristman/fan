/**
 * F-47: Mission API endpoints + WS-producer mission_event — RED-phase tests
 *
 * Feature: REST GET /api/missions/:id/status, /tree, /budget
 *          WS-producer mission_event (broadcast on journal write)
 * Source: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-47
 *         docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.2
 *
 * TC coverage:
 *   - TC-F47-1  Endpoints return journal data (status, tree, budget)
 *   - TC-F47-2  WS-producer sends mission_event on journal write (onJournalWrite hook)
 *   - TC-F47-3  404 for nonexistent slug (all 3 endpoints)
 *   - Auth      Without token → 401
 *   - Structure Response shapes: tree (nodes/roots), budget (by_branch/allocated/consumed),
 *               status (status/iteration/budget)
 *   - Routing   Multiple missions — :id routes correctly
 *   - Edge      Mission without tree-journal → tree empty, not 500
 *
 * Red expectation: endpoints do not exist yet (return 404 from global notFound handler).
 * WS-producer does not exist. All assertions below should FAIL.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// ── vi.hoisted mocks ────────────────────────────────────────────────────────
const { mockClientToken, mockRandomBytes } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
	mockRandomBytes: vi.fn().mockReturnValue({
		toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
	}),
}));

// ── Standard mock objects (same pattern as other test files) ────────────────
const mockModelManager = {
	getAllModelSettings: vi.fn().mockResolvedValue([]),
	setModelSetting: vi.fn().mockResolvedValue(undefined),
	getModelSetting: vi.fn().mockReturnValue(null),
	getBudgetStatus: vi.fn().mockResolvedValue([]),
	configureBudget: vi.fn().mockResolvedValue(undefined),
	getRoutingRules: vi.fn().mockResolvedValue([]),
};

const mockSessionAdapter = {
	listSessions: vi.fn().mockResolvedValue([]),
	getSession: vi.fn().mockResolvedValue(null),
	createSession: vi.fn().mockResolvedValue({ id: "s1", title: "Test" }),
	deleteSession: vi.fn().mockResolvedValue(false),
	sendMessage: vi.fn().mockResolvedValue(true),
	subscribeToSession: vi.fn().mockReturnValue(() => {}),
	getAvailableModels: vi.fn().mockResolvedValue([]),
	bindSessionExtensions: vi.fn().mockResolvedValue(undefined),
	whenReady: vi.fn().mockResolvedValue(undefined),
	listAnalyticsReports: vi.fn().mockResolvedValue([]),
	readAnalyticsReport: vi.fn().mockResolvedValue(null),
	abortSession: vi.fn().mockResolvedValue(true),
	drainSession: vi.fn().mockResolvedValue(true),
	getActiveSessionId: vi.fn().mockReturnValue("test-session"),
	getActiveModelManager: vi.fn().mockReturnValue(undefined),
	onSessionChange: vi.fn(),
};

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
	}),
}));

vi.mock("node:crypto", () => ({
	randomBytes: mockRandomBytes,
}));

// Default: bypass token auth for happy-path tests
process.env.FAN_NO_AUTH = "1";

import type { ModelManager } from "@fan/model-manager";
import { createApp } from "../http-server.js";
import { getMissionBudget, getMissionStatus, getMissionTree, isValidMissionSlug } from "../mission-api.js";

/** Type helper — Hono's Response.json() returns unknown in test types */
function json<T>(res: Response): Promise<T> {
	return res.json() as Promise<T>;
}

type App = Awaited<ReturnType<typeof createApp>>;

// ============================================================================
// Fixture helpers
// ============================================================================

/** MISSION.md frontmatter + body (matches fan-mission format) */
const SAMPLE_MISSION_MD = `---
mission_id: test-slug
created: "2026-08-10T10:00:00Z"
status: active
metric_type: command
metric_command: "echo ok"
budget_tokens: 100000
budget_usd: 10.0
max_depth: 3
max_width: 4
iteration: 5
---

# Test Mission

This is a test mission for F-47 fixtures.
`;

/** tree-journal.jsonl entries (5 entries: L0 root + 2×L1 spawn + 1 complete + 1 L2 spawn) */
function sampleJournalLines(): string[] {
	return [
		JSON.stringify({
			timestamp: "2026-08-10T10:01:00Z",
			event: "spawn",
			nodeId: "L0",
			correlationId: "test-slug/L0/root",
			depth: 0,
		}),
		JSON.stringify({
			timestamp: "2026-08-10T10:02:00Z",
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "L0",
			correlationId: "test-slug/L1/node-1",
			depth: 1,
		}),
		JSON.stringify({
			timestamp: "2026-08-10T10:03:00Z",
			event: "complete",
			nodeId: "L1/node-1",
			parentId: "L0",
			correlationId: "test-slug/L1/node-1",
			depth: 1,
			usage: { tokens: 15000, usd: 0.45 },
		}),
		JSON.stringify({
			timestamp: "2026-08-10T10:04:00Z",
			event: "spawn",
			nodeId: "L1/node-2",
			parentId: "L0",
			correlationId: "test-slug/L1/node-2",
			depth: 1,
		}),
		JSON.stringify({
			timestamp: "2026-08-10T10:05:00Z",
			event: "spawn",
			nodeId: "L2/node-1.1",
			parentId: "L1/node-1",
			correlationId: "test-slug/L2/node-1.1",
			depth: 2,
		}),
	];
}

/** mission-budget.json (matches F-31 format) */
const SAMPLE_BUDGET = {
	mission_id: "test-slug",
	budget_total: 100000,
	budget_usd: 10.0,
	allocated: 60000,
	consumed: 25000,
	peak: 30000,
	by_branch: {
		"L1/node-1": { allocated: 26666, consumed: 15000, cost_usd: 0.45 },
		"L1/node-2": { allocated: 26666, consumed: 10000, cost_usd: 0.3 },
	},
};

/** Create a temp mission directory with all fixture files. Returns the temp root (parent of <slug>/). */
function createMissionFixture(
	slug: string,
	opts?: { skipJournal?: boolean; skipBudget?: boolean; skipMission?: boolean },
): string {
	const root = mkdtempSync(join(tmpdir(), "fan-mission-test-"));
	const missionDir = join(root, slug);
	mkdirSync(missionDir, { recursive: true });

	if (!opts?.skipMission) {
		writeFileSync(join(missionDir, "MISSION.md"), SAMPLE_MISSION_MD);
	}
	if (!opts?.skipJournal) {
		writeFileSync(join(missionDir, "tree-journal.jsonl"), `${sampleJournalLines().join("\n")}\n`);
	}
	if (!opts?.skipBudget) {
		writeFileSync(join(missionDir, "mission-budget.json"), JSON.stringify(SAMPLE_BUDGET));
	}
	return root;
}

/** Create a second fixture with different slug for multi-mission routing tests. */
function createSecondMissionFixture(slug: string): string {
	const root = mkdtempSync(join(tmpdir(), "fan-mission-test2-"));
	const missionDir = join(root, slug);
	mkdirSync(missionDir, { recursive: true });

	const missionMd = SAMPLE_MISSION_MD.replace("test-slug", slug).replace("status: active", "status: completed");
	writeFileSync(join(missionDir, "MISSION.md"), missionMd);

	const journalLines = [
		JSON.stringify({
			timestamp: "2026-08-10T12:00:00Z",
			event: "spawn",
			nodeId: "L0",
			correlationId: `${slug}/L0/root`,
			depth: 0,
		}),
		JSON.stringify({
			timestamp: "2026-08-10T12:01:00Z",
			event: "complete",
			nodeId: "L0",
			correlationId: `${slug}/L0/root`,
			depth: 0,
			usage: { tokens: 5000, usd: 0.1 },
		}),
	];
	writeFileSync(join(missionDir, "tree-journal.jsonl"), `${journalLines.join("\n")}\n`);

	const budget = { ...SAMPLE_BUDGET, mission_id: slug, consumed: 5000, by_branch: {} };
	writeFileSync(join(missionDir, "mission-budget.json"), JSON.stringify(budget));
	return root;
}

// ============================================================================
// REST Endpoint Tests
// ============================================================================

describe("F-47: Mission API endpoints", () => {
	let fixtureRoot: string;
	let app: App;

	beforeEach(async () => {
		vi.clearAllMocks();
		// Restore default mock return values after clearAllMocks
		mockModelManager.getAllModelSettings.mockResolvedValue([]);
		mockModelManager.getBudgetStatus.mockResolvedValue([]);
		mockModelManager.getRoutingRules.mockResolvedValue([]);
		mockModelManager.getModelSetting.mockReturnValue(null);
		mockSessionAdapter.listSessions.mockResolvedValue([]);
		mockSessionAdapter.getSession.mockResolvedValue(null);
		mockSessionAdapter.createSession.mockResolvedValue({ id: "s1", title: "Test" });
		mockSessionAdapter.deleteSession.mockResolvedValue(false);
		mockSessionAdapter.sendMessage.mockResolvedValue(true);
		mockSessionAdapter.getAvailableModels.mockResolvedValue([]);
		mockSessionAdapter.whenReady.mockResolvedValue(undefined);
		mockSessionAdapter.listAnalyticsReports.mockResolvedValue([]);
		mockSessionAdapter.readAnalyticsReport.mockResolvedValue(null);
		mockSessionAdapter.abortSession.mockResolvedValue(true);
		mockSessionAdapter.drainSession.mockResolvedValue(true);
		mockRandomBytes.mockReturnValue({
			toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
		});

		fixtureRoot = createMissionFixture("test-slug");

		// createApp with missionsDir — the 3rd arg is the options object.
		// Once F-47 is implemented, createApp will accept missionsDir in options
		// and mount /api/missions/:id/* routes.
		app = await createApp(
			mockModelManager as unknown as ModelManager,
			mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
			{ missionsDir: fixtureRoot } as any,
		);
	});

	afterEach(() => {
		if (fixtureRoot && existsSync(fixtureRoot)) {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	// =========================================================================
	// TC-F47-1: Endpoints return journal data
	// =========================================================================
	describe("TC-F47-1: Endpoints return journal data", () => {
		it("GET /api/missions/:id/tree returns tree topology from tree-journal.jsonl", async () => {
			const res = await app.request("/api/missions/test-slug/tree");
			// Red: route doesn't exist → 404 from global notFound → FAILS (expecting 200)
			expect(res.status).toBe(200);
			const data = await json<{ nodes: Record<string, unknown>; roots: string[] }>(res);
			// reconstructTree shape: { nodes: {...}, roots: [...] }
			expect(data).toHaveProperty("nodes");
			expect(data).toHaveProperty("roots");
			// L0 is root
			expect(data.roots).toContain("L0");
			// Nodes include L0, L1/node-1, L1/node-2, L2/node-1.1
			expect(Object.keys(data.nodes).length).toBeGreaterThanOrEqual(4);
		});

		it("GET /api/missions/:id/budget returns mission-budget.json", async () => {
			const res = await app.request("/api/missions/test-slug/budget");
			// Red: route doesn't exist → 404 → FAILS (expecting 200)
			expect(res.status).toBe(200);
			const data = await json<typeof SAMPLE_BUDGET>(res);
			expect(data).toHaveProperty("mission_id", "test-slug");
			expect(data).toHaveProperty("budget_total", 100000);
			expect(data).toHaveProperty("by_branch");
			expect(data).toHaveProperty("allocated");
			expect(data).toHaveProperty("consumed");
			// by_branch has L1/node-1 and L1/node-2
			expect(data.by_branch).toHaveProperty("L1/node-1");
			expect(data.by_branch).toHaveProperty("L1/node-2");
		});

		it("GET /api/missions/:id/status returns mission state from MISSION.md + budget summary", async () => {
			const res = await app.request("/api/missions/test-slug/status");
			// Red: route doesn't exist → 404 → FAILS (expecting 200)
			expect(res.status).toBe(200);
			const data = await json<Record<string, unknown>>(res);
			// Status from MISSION.md frontmatter
			expect(data).toHaveProperty("status", "active");
			expect(data).toHaveProperty("mission_id", "test-slug");
			// Iteration from frontmatter
			expect(data).toHaveProperty("iteration", 5);
			// Budget summary (at minimum: budget_total, consumed)
			expect(data).toHaveProperty("budget_total");
			expect(data).toHaveProperty("consumed");
		});
	});

	// =========================================================================
	// TC-F47-3: 404 for nonexistent slug
	// =========================================================================
	describe("TC-F47-3: 404 for nonexistent slug", () => {
		it("GET /api/missions/nonexistent/tree returns 404", async () => {
			const res = await app.request("/api/missions/nonexistent/tree");
			expect(res.status).toBe(404);
			const data = await json<{ error: string }>(res);
			expect(data.error).toMatch(/not found|nonexistent/i);
		});

		it("GET /api/missions/nonexistent/budget returns 404", async () => {
			const res = await app.request("/api/missions/nonexistent/budget");
			expect(res.status).toBe(404);
			const data = await json<{ error: string }>(res);
			expect(data.error).toMatch(/not found|nonexistent/i);
		});

		it("GET /api/missions/nonexistent/status returns 404", async () => {
			const res = await app.request("/api/missions/nonexistent/status");
			expect(res.status).toBe(404);
			const data = await json<{ error: string }>(res);
			expect(data.error).toMatch(/not found|nonexistent/i);
		});
	});

	// =========================================================================
	// Auth: without token → 401
	// =========================================================================
	describe("Auth: mission endpoints require authentication", () => {
		it("GET /api/missions/:id/tree without token returns 401", async () => {
			const prevAuth = process.env.FAN_NO_AUTH;
			process.env.FAN_NO_AUTH = "0";
			try {
				const authedApp = await createApp(
					mockModelManager as unknown as ModelManager,
					mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
					{ missionsDir: fixtureRoot } as any,
				);
				const res = await authedApp.request("/api/missions/test-slug/tree");
				expect(res.status).toBe(401);
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});

		it("GET /api/missions/:id/budget without token returns 401", async () => {
			const prevAuth = process.env.FAN_NO_AUTH;
			process.env.FAN_NO_AUTH = "0";
			try {
				const authedApp = await createApp(
					mockModelManager as unknown as ModelManager,
					mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
					{ missionsDir: fixtureRoot } as any,
				);
				const res = await authedApp.request("/api/missions/test-slug/budget");
				expect(res.status).toBe(401);
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});

		it("GET /api/missions/:id/status without token returns 401", async () => {
			const prevAuth = process.env.FAN_NO_AUTH;
			process.env.FAN_NO_AUTH = "0";
			try {
				const authedApp = await createApp(
					mockModelManager as unknown as ModelManager,
					mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
					{ missionsDir: fixtureRoot } as any,
				);
				const res = await authedApp.request("/api/missions/test-slug/status");
				expect(res.status).toBe(401);
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});

		it("GET /api/missions/:id/tree with valid token returns 200", async () => {
			const prevAuth = process.env.FAN_NO_AUTH;
			process.env.FAN_NO_AUTH = "0";
			try {
				mockClientToken.update.mockResolvedValue({
					id: "t1",
					name: "Test",
					token: "valid-token",
					createdAt: new Date("2026-01-01"),
					lastUsed: null,
				});
				const authedApp = await createApp(
					mockModelManager as unknown as ModelManager,
					mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
					{ missionsDir: fixtureRoot } as any,
				);
				const res = await authedApp.request("/api/missions/test-slug/tree", {
					headers: { Authorization: "Bearer valid-token" },
				});
				// Red: route doesn't exist → 404 → FAILS (expecting 200)
				expect(res.status).toBe(200);
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});
	});

	// =========================================================================
	// Response structure validation
	// =========================================================================
	describe("Response structure: tree matches reconstructTree shape", () => {
		it("tree response has nodes (Record<nodeId, {parentId, children, status}>) and roots (string[])", async () => {
			const res = await app.request("/api/missions/test-slug/tree");
			expect(res.status).toBe(200);
			const data = await json<{
				nodes: Record<
					string,
					{
						parentId: string | null;
						children: string[];
						status: string;
						correlationId?: string;
						usage?: { tokens?: number; usd?: number };
					}
				>;
				roots: string[];
			}>(res);

			// Roots array contains nodes without parentId
			expect(Array.isArray(data.roots)).toBe(true);

			// Each node has required fields
			for (const [, node] of Object.entries(data.nodes)) {
				expect(node).toHaveProperty("parentId");
				expect(node).toHaveProperty("children");
				expect(node).toHaveProperty("status");
				expect(Array.isArray(node.children)).toBe(true);
			}

			// L1/node-1 was completed with usage
			const node1 = data.nodes["L1/node-1"];
			expect(node1).toBeDefined();
			expect(node1.status).toBe("complete");
			expect(node1.usage).toBeDefined();
			expect(node1.usage!.usd).toBe(0.45);

			// L1/node-1 is child of L0
			const root = data.nodes.L0;
			expect(root).toBeDefined();
			expect(root.children).toContain("L1/node-1");
			expect(root.children).toContain("L1/node-2");

			// L2/node-1.1 is child of L1/node-1
			expect(node1.children).toContain("L2/node-1.1");
		});
	});

	describe("Response structure: budget has by_branch, allocated, consumed", () => {
		it("budget response matches mission-budget.json shape (F-31)", async () => {
			const res = await app.request("/api/missions/test-slug/budget");
			expect(res.status).toBe(200);
			const data = await json<{
				mission_id: string;
				budget_total: number;
				budget_usd: number;
				allocated: number;
				consumed: number;
				peak: number;
				by_branch: Record<string, { allocated: number; consumed: number; cost_usd: number }>;
			}>(res);

			expect(data.mission_id).toBe("test-slug");
			expect(typeof data.budget_total).toBe("number");
			expect(typeof data.budget_usd).toBe("number");
			expect(typeof data.allocated).toBe("number");
			expect(typeof data.consumed).toBe("number");
			expect(typeof data.peak).toBe("number");

			// by_branch is a Record with per-branch breakdowns
			expect(typeof data.by_branch).toBe("object");
			for (const [, branch] of Object.entries(data.by_branch)) {
				expect(branch).toHaveProperty("allocated");
				expect(branch).toHaveProperty("consumed");
				expect(branch).toHaveProperty("cost_usd");
			}
		});
	});

	describe("Response structure: status has status, iteration, budget summary", () => {
		it("status response includes mission state and budget summary", async () => {
			const res = await app.request("/api/missions/test-slug/status");
			expect(res.status).toBe(200);
			const data = await json<{
				mission_id: string;
				status: string;
				iteration: number;
				budget_total: number;
				consumed: number;
				budget_usd: number;
			}>(res);

			// From MISSION.md frontmatter
			expect(data.mission_id).toBe("test-slug");
			expect(data.status).toBe("active");
			expect(data.iteration).toBe(5);

			// Budget summary (from mission-budget.json)
			expect(typeof data.budget_total).toBe("number");
			expect(typeof data.consumed).toBe("number");
			expect(typeof data.budget_usd).toBe("number");
		});
	});

	// =========================================================================
	// Multiple missions: :id routing correct
	// =========================================================================
	describe("Multiple missions: :id routing", () => {
		let secondFixtureRoot: string;
		let multiApp: App;

		beforeEach(async () => {
			secondFixtureRoot = createSecondMissionFixture("other-mission");
			// For multi-mission, we need a parent dir that contains both slugs.
			// Create a combined root with symlinks or use the first fixture root
			// and copy the second mission into it.
			const combinedRoot = mkdtempSync(join(tmpdir(), "fan-mission-combo-"));
			const src1 = join(fixtureRoot, "test-slug");
			const src2 = join(secondFixtureRoot, "other-mission");
			const { cpSync } = await import("node:fs");
			cpSync(src1, join(combinedRoot, "test-slug"), { recursive: true });
			cpSync(src2, join(combinedRoot, "other-mission"), { recursive: true });

			multiApp = await createApp(
				mockModelManager as unknown as ModelManager,
				mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
				{ missionsDir: combinedRoot } as any,
			);
			// Store combinedRoot for cleanup
			(secondFixtureRoot as any) = combinedRoot;
		});

		afterEach(() => {
			const combined = secondFixtureRoot;
			if (combined && existsSync(combined)) {
				rmSync(combined, { recursive: true, force: true });
			}
		});

		it("GET /api/missions/test-slug/status returns test-slug data", async () => {
			const res = await multiApp.request("/api/missions/test-slug/status");
			expect(res.status).toBe(200);
			const data = await json<{ mission_id: string; status: string }>(res);
			expect(data.mission_id).toBe("test-slug");
			expect(data.status).toBe("active");
		});

		it("GET /api/missions/other-mission/status returns other-mission data", async () => {
			const res = await multiApp.request("/api/missions/other-mission/status");
			expect(res.status).toBe(200);
			const data = await json<{ mission_id: string; status: string }>(res);
			expect(data.mission_id).toBe("other-mission");
			expect(data.status).toBe("completed");
		});

		it("GET /api/missions/test-slug/tree returns test-slug tree (not other-mission)", async () => {
			const res = await multiApp.request("/api/missions/test-slug/tree");
			expect(res.status).toBe(200);
			const data = await json<{ nodes: Record<string, unknown>; roots: string[] }>(res);
			// test-slug has 4 nodes (L0, L1/node-1, L1/node-2, L2/node-1.1)
			expect(Object.keys(data.nodes).length).toBeGreaterThanOrEqual(4);
		});

		it("GET /api/missions/other-mission/tree returns other-mission tree (not test-slug)", async () => {
			const res = await multiApp.request("/api/missions/other-mission/tree");
			expect(res.status).toBe(200);
			const data = await json<{ nodes: Record<string, unknown>; roots: string[] }>(res);
			// other-mission has only 1 node (L0)
			expect(Object.keys(data.nodes).length).toBe(1);
			expect(data.nodes).toHaveProperty("L0");
		});
	});

	// =========================================================================
	// Edge: mission without tree-journal → empty tree, not 500
	// =========================================================================
	describe("Edge: mission without tree-journal", () => {
		let emptyFixtureRoot: string;

		beforeEach(async () => {
			emptyFixtureRoot = createMissionFixture("empty-mission", { skipJournal: true });
		});

		afterEach(() => {
			if (emptyFixtureRoot && existsSync(emptyFixtureRoot)) {
				rmSync(emptyFixtureRoot, { recursive: true, force: true });
			}
		});

		it("GET /api/missions/:id/tree returns empty tree (not 500) when tree-journal.jsonl does not exist", async () => {
			const emptyApp = await createApp(
				mockModelManager as unknown as ModelManager,
				mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
				{ missionsDir: emptyFixtureRoot } as any,
			);
			const res = await emptyApp.request("/api/missions/empty-mission/tree");
			// Red: route doesn't exist → 404 → FAILS
			// After implementation: should return 200 with empty tree, NOT 500
			expect(res.status).toBe(200);
			const data = await json<{ nodes: Record<string, unknown>; roots: string[] }>(res);
			expect(data.nodes).toEqual({});
			expect(data.roots).toEqual([]);
		});

		it("GET /api/missions/:id/status still works without tree-journal (reads MISSION.md only)", async () => {
			const emptyApp = await createApp(
				mockModelManager as unknown as ModelManager,
				mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
				{ missionsDir: emptyFixtureRoot } as any,
			);
			const res = await emptyApp.request("/api/missions/empty-mission/status");
			// Red: route doesn't exist → 404 → FAILS
			expect(res.status).toBe(200);
			const data = await json<{ status: string }>(res);
			expect(data.status).toBe("active");
		});
	});

	// =========================================================================
	// Edge: path traversal protection
	// =========================================================================
	describe("Edge: path traversal protection", () => {
		it("GET /api/missions/..%2F..%2Fetc%2Fpasswd/tree returns 400 or 404 (not 500)", async () => {
			const res = await app.request("/api/missions/..%2F..%2Fetc%2Fpasswd/tree");
			expect(res.status).not.toBe(500);
			expect([400, 404]).toContain(res.status);
		});

		it("isValidMissionSlug rejects dot-only slugs ('.', '..', '...')", () => {
			expect(isValidMissionSlug(".")).toBe(false);
			expect(isValidMissionSlug("..")).toBe(false);
			expect(isValidMissionSlug("...")).toBe(false);
			// after percent-decoding
			expect(isValidMissionSlug(decodeURIComponent("%2e%2e"))).toBe(false);
			// valid slugs still pass
			expect(isValidMissionSlug("test-slug")).toBe(true);
			expect(isValidMissionSlug("mission.v2_beta-3")).toBe(true);
		});

		it("getMission*(missionsDir, '..') returns null (no parent directory leak)", () => {
			// fixtureRoot/<test-slug>/ exists; fixtureRoot itself has MISSION.md + budget
			// (simulating sensitive data in the parent directory)
			writeFileSync(join(fixtureRoot, "MISSION.md"), SAMPLE_MISSION_MD);
			writeFileSync(join(fixtureRoot, "mission-budget.json"), JSON.stringify(SAMPLE_BUDGET));
			writeFileSync(join(fixtureRoot, "tree-journal.jsonl"), `${sampleJournalLines().join("\n")}\n`);

			expect(getMissionStatus(fixtureRoot, "..")).toBeNull();
			expect(getMissionTree(fixtureRoot, "..")).toBeNull();
			expect(getMissionBudget(fixtureRoot, "..")).toBeNull();
			expect(getMissionStatus(fixtureRoot, ".")).toBeNull();
			expect(getMissionTree(fixtureRoot, "...")).toBeNull();
			expect(getMissionBudget(fixtureRoot, "...")).toBeNull();
		});

		it("GET /api/missions/%2e%2e/(status|tree|budget) never leaks mission data", async () => {
			for (const endpoint of ["status", "tree", "budget"]) {
				const res = await app.request(`/api/missions/%2e%2e/${endpoint}`);
				expect(res.status).not.toBe(500);
				// WHATWG URL normalization collapses the %2e%2e segment до роутинга
				// (…/budget → /api/budget — чужой, но не-mission роут); если сегмент
				// доходит до mission-хендлера → isValidMissionSlug отклоняет → 400.
				// Ключевой инвариант: тело НЕ содержит данных миссии test-slug.
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.mission_id).toBeUndefined();
				expect(body.nodes).toBeUndefined();
			}
		});
	});
});

// ============================================================================
// WS-producer mission_event Tests
// ============================================================================

describe("F-47: WS-producer mission_event", () => {
	let server: Server;
	let port: number;
	let fixtureRoot: string;

	/** Captured onJournalWrite callbacks from the WS handler options. */
	let journalWriteCallbacks: Array<(entry: Record<string, unknown>) => void>;
	let mockMissionJournal: {
		onJournalWrite: ReturnType<typeof vi.fn>;
	};
	let handler: { close: () => void } | null = null;

	beforeEach(async () => {
		fixtureRoot = createMissionFixture("ws-test-slug");

		journalWriteCallbacks = [];
		mockMissionJournal = {
			onJournalWrite: vi.fn().mockImplementation((cb: (entry: Record<string, unknown>) => void) => {
				journalWriteCallbacks.push(cb);
				return () => {
					const idx = journalWriteCallbacks.indexOf(cb);
					if (idx >= 0) journalWriteCallbacks.splice(idx, 1);
				};
			}),
		};

		// Reset mock adapter for WS tests
		mockSessionAdapter.getActiveSessionId.mockReturnValue("ws-test-session");
		mockSessionAdapter.getActiveModelManager.mockReturnValue(undefined);
		mockSessionAdapter.onSessionChange.mockImplementation(() => {});

		server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		if (handler) {
			handler.close();
			handler = null;
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		if (fixtureRoot && existsSync(fixtureRoot)) {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	/** Open a real WebSocket connection to the test server. */
	async function openWs(sessionId: string): Promise<WebSocket> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/${sessionId}`);
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("WS connection timeout")), 5000);
			ws.once("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.once("error", (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
		return ws;
	}

	/** Wait until at least one onJournalWrite callback has been registered. */
	async function waitForJournalRegistration(): Promise<(entry: Record<string, unknown>) => void> {
		for (let i = 0; i < 50; i++) {
			if (journalWriteCallbacks.length > 0) return journalWriteCallbacks[0];
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error("missionJournal.onJournalWrite was never called by attachWebSocketHandler");
	}

	/** Collect messages received by a WS client. */
	function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
		const messages: Array<Record<string, unknown>> = [];
		ws.on("message", (data: Buffer) => {
			try {
				messages.push(JSON.parse(data.toString()));
			} catch {
				/* ignore malformed */
			}
		});
		return messages;
	}

	/** Wait for async settle. */
	function settle(ms = 200): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// =========================================================================
	// TC-F47-2: WS-producer sends mission_event on journal write
	// =========================================================================
	it("TC-F47-2: WS subscribers receive mission_event when journal entry is written", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockSessionAdapter as any,
			missionJournal: mockMissionJournal,
		} as any);

		const ws = await openWs("ws-test-session");
		const messages = collectMessages(ws);

		const onWrite = await waitForJournalRegistration();

		// Simulate a journal write event (spawn)
		onWrite({
			event: "spawn",
			nodeId: "L1/node-1",
			parentId: "L0",
			correlationId: "ws-test-slug/L1/node-1",
			depth: 1,
			timestamp: "2026-08-10T10:02:00Z",
		});
		await settle();

		// Filter for mission_event messages
		const missionEvents = messages.filter((m) => m.type === "mission_event");
		// Red: no mission_event producer → 0 events → FAILS (expecting 1)
		expect(missionEvents).toHaveLength(1);
		expect(missionEvents[0]).toHaveProperty("missionId", "ws-test-slug");
		expect(missionEvents[0]).toHaveProperty("event", "spawn");
		expect(missionEvents[0]).toHaveProperty("nodeId", "L1/node-1");

		ws.close();
	});

	it("TC-F47-2b: WS mission_event includes entry data in the payload", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockSessionAdapter as any,
			missionJournal: mockMissionJournal,
		} as any);

		const ws = await openWs("ws-test-session-entry");
		const messages = collectMessages(ws);

		const onWrite = await waitForJournalRegistration();

		// Simulate a complete event with usage
		onWrite({
			event: "complete",
			nodeId: "L1/node-2",
			parentId: "L0",
			correlationId: "ws-test-slug/L1/node-2",
			depth: 1,
			usage: { tokens: 20000, usd: 0.6 },
			timestamp: "2026-08-10T10:06:00Z",
		});
		await settle();

		const missionEvents = messages.filter((m) => m.type === "mission_event");
		expect(missionEvents).toHaveLength(1);

		const evt = missionEvents[0];
		// Verify envelope fields
		expect(evt).toHaveProperty("type", "mission_event");
		expect(evt).toHaveProperty("timestamp");
		expect(typeof evt.timestamp).toBe("string");

		// Verify entry/payload
		expect(evt).toHaveProperty("event", "complete");
		expect(evt).toHaveProperty("nodeId", "L1/node-2");

		ws.close();
	});

	it("TC-F47-2c: multiple journal writes produce multiple mission_events", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockSessionAdapter as any,
			missionJournal: mockMissionJournal,
		} as any);

		const ws = await openWs("ws-test-multi");
		const messages = collectMessages(ws);

		const onWrite = await waitForJournalRegistration();

		// Three journal writes
		onWrite({ event: "spawn", nodeId: "L1/node-1", timestamp: "2026-08-10T10:01:00Z" });
		await settle();
		onWrite({ event: "spawn", nodeId: "L1/node-2", timestamp: "2026-08-10T10:02:00Z" });
		await settle();
		onWrite({ event: "complete", nodeId: "L1/node-1", timestamp: "2026-08-10T10:03:00Z" });
		await settle();

		const missionEvents = messages.filter((m) => m.type === "mission_event");
		expect(missionEvents).toHaveLength(3);

		ws.close();
	});

	it("TC-F47-2d: mission_event fans out to all connected WS clients", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockSessionAdapter as any,
			missionJournal: mockMissionJournal,
		} as any);

		const wsA = await openWs("session-A");
		const wsB = await openWs("session-B");
		const messagesA = collectMessages(wsA);
		const messagesB = collectMessages(wsB);

		const onWrite = await waitForJournalRegistration();

		onWrite({ event: "fail", nodeId: "L1/node-3", timestamp: "2026-08-10T10:04:00Z" });
		await settle();

		const eventsA = messagesA.filter((m) => m.type === "mission_event");
		const eventsB = messagesB.filter((m) => m.type === "mission_event");
		expect(eventsA).toHaveLength(1);
		expect(eventsB).toHaveLength(1);

		wsA.close();
		wsB.close();
	});

	it("TC-F47-2e: close() unsubscribes from missionJournal.onJournalWrite", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockSessionAdapter as any,
			missionJournal: mockMissionJournal,
		} as any);

		await waitForJournalRegistration();
		expect(journalWriteCallbacks.length).toBeGreaterThanOrEqual(1);

		handler.close();

		// After close, callback list should be empty (unsubscribe was called)
		expect(journalWriteCallbacks).toHaveLength(0);

		handler = null; // already closed
	});
});
