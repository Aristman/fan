/**
 * F-40: Dashboard <mission-status> — RED-phase tests.
 *
 * Component under test:
 *   packages/dashboard/src/components/mission/mission-status.ts
 *
 * Contract under test:
 *   - REST: GET /api/missions/:id/status → { mission_id, status, iteration,
 *     budget_total, consumed, budget_usd, ... }
 *   - WS:   system-wide mission_event fan-out (consumed via window CustomEvent
 *           "fan:mission-event", dispatched by dashboard-app from FanWsClient).
 *
 * Reference: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-40
 *
 * Mocking strategy:
 *   - REST → vi.stubGlobal("fetch", mockFetch) (matches existing api-client.test.ts)
 *   - WS   → window.dispatchEvent(new CustomEvent("fan:mission-event", { detail }))
 *
 * NOTE: These tests MUST FAIL until mission-status.ts is fully implemented.
 */

import type { WsMissionEvent } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Import component under test (registers <mission-status> custom element).
// In RED phase the stub renders nothing → assertions on text/state FAIL.
// ---------------------------------------------------------------------------
import "../components/mission/mission-status.js";

// ---------------------------------------------------------------------------
// Types (local — mirror the F-47 status API response shape)
// ---------------------------------------------------------------------------

interface MissionStatusData {
	mission_id: string;
	status: string;
	iteration: number;
	budget_total: number;
	consumed: number;
	budget_usd: number;
	active_nodes?: number;
	stage?: string;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** TC-F40-1 fixture: active mission, 5th iteration, $3.45 / $10.00. */
const STATUS_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "active",
	iteration: 5,
	budget_total: 10.0,
	consumed: 3.45,
	budget_usd: 10.0,
	active_nodes: 2,
	stage: "execution",
};

/** Paused mission fixture. */
const PAUSED_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "paused",
	iteration: 3,
	budget_total: 10.0,
	consumed: 1.2,
	budget_usd: 10.0,
};

/** Completed mission fixture. */
const COMPLETED_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "completed",
	iteration: 12,
	budget_total: 10.0,
	consumed: 8.9,
	budget_usd: 10.0,
};

/** Failed mission fixture. */
const FAILED_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "failed",
	iteration: 7,
	budget_total: 10.0,
	consumed: 5.5,
	budget_usd: 10.0,
};

/** Awaiting-decision mission fixture. */
const AWAITING_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "awaiting_decision",
	iteration: 4,
	budget_total: 10.0,
	consumed: 2.0,
	budget_usd: 10.0,
};

/** Aborted mission fixture. */
const ABORTED_FIXTURE: MissionStatusData = {
	mission_id: "auth-refactor",
	status: "aborted",
	iteration: 9,
	budget_total: 10.0,
	consumed: 7.0,
	budget_usd: 10.0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a fresh <mission-status> element and wait for Lit's first render. */
async function mount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
	const el = document.createElement("mission-status");
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	document.body.appendChild(el);
	await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
	return el;
}

/** Unmount element and wait one microtask so disconnectedCallback can run. */
async function unmount(el: HTMLElement): Promise<void> {
	el.remove();
	await new Promise((r) => setTimeout(r, 0));
}

/** Simulate the dashboard-app WS fan-out: dispatch a system-wide mission_event. */
function dispatchMissionEvent(
	event: Partial<WsMissionEvent> & { missionId: string; event: string; nodeId: string },
): void {
	const payload: WsMissionEvent = {
		type: "mission_event",
		timestamp: new Date().toISOString(),
		entry: {},
		...event,
	};
	window.dispatchEvent(new CustomEvent("fan:mission-event", { detail: payload, bubbles: true }));
}

/** Configure mockFetch to resolve once with a JSON body + status. */
function mockFetchJson(status: number, body: unknown): void {
	mockFetch.mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 404 ? "Not Found" : status === 500 ? "Internal Server Error" : "OK",
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let mountedEls: HTMLElement[] = [];

beforeEach(() => {
	mockFetch.mockReset();
	mountedEls = [];
});

afterEach(async () => {
	for (const el of mountedEls) await unmount(el);
	mountedEls = [];
	vi.restoreAllMocks();
});

async function trackMount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
	const el = await mount(attrs);
	mountedEls.push(el);
	return el;
}

// ============================================================================
// TC-F40-1: <mission-status> renders status, iteration, budget
// ============================================================================

describe("TC-F40-1: render status, iteration, and budget", () => {
	it("renders the status text 'active' for an active mission", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		// Must show the status word (active) or a visual indicator for it.
		const hasStatus =
			text.toLowerCase().includes("active") ||
			el.querySelector("[data-status='active']") !== null ||
			text.includes("●");
		expect(hasStatus).toBe(true);
	});

	it("renders the iteration number (5)", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		// Iteration number should appear somewhere in the rendered output.
		expect(text).toMatch(/\b5\b/);
	});

	it("renders budget progress (consumed $3.45 / total $10.00)", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		// At minimum, the consumed amount should be visible.
		const hasConsumed = text.includes("3.45") || text.includes("$3.45") || text.includes("34.5");
		expect(hasConsumed).toBe(true);

		// The total budget should also be visible.
		const hasTotal = text.includes("10.00") || text.includes("10.0") || text.includes("$10");
		expect(hasTotal).toBe(true);
	});

	it("issues GET /api/missions/:id/status with the mission-id attribute", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		await trackMount({ "mission-id": "auth-refactor" });

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(String(url)).toContain("/api/missions/auth-refactor/status");
		expect(init?.method ?? "GET").toBe("GET");
	});

	it("renders status badge for each known status value", async () => {
		for (const [statusKey, fixture] of [
			["active", STATUS_FIXTURE],
			["paused", PAUSED_FIXTURE],
			["completed", COMPLETED_FIXTURE],
			["failed", FAILED_FIXTURE],
			["awaiting_decision", AWAITING_FIXTURE],
			["aborted", ABORTED_FIXTURE],
		] as const) {
			mockFetch.mockReset();
			mockFetchJson(200, fixture);
			const el = await trackMount({ "mission-id": "auth-refactor" });
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

			const text = (el.textContent ?? "").toLowerCase();
			const hasStatus = text.includes(statusKey) || el.querySelector(`[data-status='${statusKey}']`) !== null;
			expect(hasStatus, `status '${statusKey}' should be visible`).toBe(true);

			await unmount(el);
			mountedEls.pop();
		}
	});
});

// ============================================================================
// TC-F40-1b: WS live status update
// ============================================================================

describe("TC-F40-1b: WS mission_event → live status update", { timeout: 15_000 }, () => {
	it("updates status when WS event carries a status change", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: initial status should be "active".
		expect(
			(el.textContent ?? "").toLowerCase().includes("active") || el.querySelector("[data-status='active']") !== null,
		).toBe(true);

		// Simulate WS event indicating mission is now completed.
		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L0",
			entry: {
				event: "complete",
				nodeId: "L0",
				status: "completed",
				missionStatus: "completed",
				iteration: 5,
			},
		});

		// Wait up to 5s for the component to reflect the status change.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
			const text = (el.textContent ?? "").toLowerCase();
			if (text.includes("completed") || el.querySelector("[data-status='completed']")) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const text = (el.textContent ?? "").toLowerCase();
		const updated = text.includes("completed") || el.querySelector("[data-status='completed']") !== null;
		expect(updated).toBe(true);
	});

	it("ignores mission_event for a different missionId", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		dispatchMissionEvent({
			missionId: "other-mission",
			event: "complete",
			nodeId: "L0",
			entry: { missionStatus: "failed" },
		});

		await new Promise((r) => setTimeout(r, 200));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Status should still be "active", NOT "failed".
		const text = (el.textContent ?? "").toLowerCase();
		expect(text).not.toContain("failed");
	});

	it("updates budget consumed when WS event carries usage data", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Simulate WS event with updated budget info.
		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L1/node-1",
			entry: {
				event: "complete",
				nodeId: "L1/node-1",
				consumed: 5.0,
			},
		});

		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
			if ((el.textContent ?? "").includes("5.0") || (el.textContent ?? "").includes("5.00")) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const text = el.textContent ?? "";
		const updated = text.includes("5.0") || text.includes("5.00");
		expect(updated).toBe(true);
	});
});

// ============================================================================
// Loading / 404 / error states
// ============================================================================

describe("Loading / error states", () => {
	it("shows a loading indicator while fetch is in flight", async () => {
		// Delay the fetch resolution to catch the loading state.
		let resolveFetch!: (v: Response) => void;
		mockFetch.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);

		const el = await trackMount({ "mission-id": "auth-refactor" });

		// The component should be in a loading state before fetch resolves.
		const loadingEl = el.querySelector("[data-state='loading']");
		const hasLoadingText = (el.textContent ?? "").toLowerCase().includes("loading");
		expect(loadingEl !== null || hasLoadingText).toBe(true);

		// Now resolve the fetch so afterEach cleanup doesn't hang.
		resolveFetch({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(STATUS_FIXTURE),
			text: () => Promise.resolve(JSON.stringify(STATUS_FIXTURE)),
		} as unknown as Response);

		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
	});

	it("renders 'mission not found' on 404", async () => {
		mockFetchJson(404, { error: "Mission 'auth-refactor' not found", code: "NOT_FOUND" });
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = (el.textContent ?? "").toLowerCase();
		const reflects404 =
			text.includes("not found") ||
			text.includes("не найдена") ||
			el.querySelector("[data-state='not-found']") !== null ||
			el.querySelector("[data-state='error']") !== null;
		expect(reflects404).toBe(true);
	});

	it("renders an error state on 500 / network failure", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = (el.textContent ?? "").toLowerCase();
		const reflectsError =
			text.includes("error") ||
			text.includes("fail") ||
			text.includes("ошибка") ||
			el.querySelector("[data-state='error']") !== null;
		expect(reflectsError).toBe(true);
	});

	it("renders empty state when mission-id is not provided", async () => {
		const el = await trackMount({});
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Should not have made any fetch call.
		expect(mockFetch).not.toHaveBeenCalled();

		// The component MUST show a meaningful empty-state indicator.
		// In RED phase the stub renders nothing → this assertion FAILS.
		const text = (el.textContent ?? "").toLowerCase();
		const hasPlaceholder =
			text.includes("no ") ||
			text.includes("empty") ||
			text.includes("select") ||
			text.includes("mission") ||
			el.querySelector("[data-state='empty']") !== null ||
			el.querySelector("[data-state='loading']") !== null;
		expect(hasPlaceholder).toBe(true);
	});
});

// ============================================================================
// Attribute change → reload
// ============================================================================

describe("mission-id attribute change", () => {
	it("reloads status when mission-id is changed at runtime", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Second call: different mission.
		mockFetchJson(200, { ...STATUS_FIXTURE, mission_id: "other-mission", status: "paused" });

		el.setAttribute("mission-id", "other-mission");
		await new Promise((r) => setTimeout(r, 50));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
		const lastUrl = String(mockFetch.mock.calls.at(-1)![0]);
		expect(lastUrl).toContain("/api/missions/other-mission/status");
	});
});

// ============================================================================
// WS unsubscribe on disconnectedCallback
// ============================================================================

describe("WS unsubscribe on disconnect", () => {
	it("stops reacting to mission_event after being removed from the DOM", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await mount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Detach (disconnectedCallback must run and remove the window listener).
		await unmount(el);

		const snapshot = el.textContent ?? "";

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L0",
			entry: { missionStatus: "failed" },
		});

		await new Promise((r) => setTimeout(r, 100));
		// The detached element should not have mutated.
		expect(el.textContent).toBe(snapshot);
	});
});

// ============================================================================
// Accessibility / rendering sanity
// ============================================================================

describe("rendering sanity", () => {
	it("does not use shadow DOM (Tailwind penetration requirement)", async () => {
		mockFetchJson(200, STATUS_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		expect(el.shadowRoot).toBeNull();
	});

	it("is registered as a custom element named 'mission-status'", () => {
		const ctor = customElements.get("mission-status");
		expect(ctor).toBeDefined();
	});
});
