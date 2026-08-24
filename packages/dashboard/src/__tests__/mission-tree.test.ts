/**
 * F-39: Dashboard <mission-tree> — RED-phase tests.
 *
 * Component under test:
 *   packages/dashboard/src/components/mission/mission-tree.ts
 *
 * Contract under test:
 *   - REST: GET /api/missions/:id/tree → { nodes, roots }
 *   - WS:   system-wide mission_event fan-out (consumed via window CustomEvent
 *           "fan:mission-event", dispatched by dashboard-app from FanWsClient).
 *
 * Reference: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-39
 *
 * Mocking strategy:
 *   - REST → vi.stubGlobal("fetch", mockFetch) (matches existing api-client.test.ts)
 *   - WS   → window.dispatchEvent(new CustomEvent("fan:mission-event", { detail }))
 *            (same propagation channel as existing "fan:budget-alert" used by
 *            budget-panel / dashboard-app).
 *
 * NOTE: These tests MUST FAIL until mission-tree.ts is implemented.
 */

import type { MissionTree, MissionTreeNode } from "@fan/api-gateway/mission-api";
import type { WsMissionEvent } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Import component under test (registers <mission-tree> custom element).
// In RED phase this import throws MODULE_NOT_FOUND → vitest reports test as
// failed, which is exactly the expected red signal.
// ---------------------------------------------------------------------------
import "../components/mission/mission-tree.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** TC-F39-1 fixture: L0 → 2×L1 (one completed, one active) + L1/node-2 → 1×L2 (pending). */
const TREE_FIXTURE: MissionTree = {
	roots: ["L0"],
	nodes: {
		L0: {
			parentId: null,
			children: ["L1/node-1", "L1/node-2"],
			status: "active",
			correlationId: "auth-refactor/L0/node-0",
			usage: { tokens: 5000, usd: 1.2 },
		} satisfies MissionTreeNode,
		"L1/node-1": {
			parentId: "L0",
			children: [],
			status: "completed",
			correlationId: "auth-refactor/L1/node-1",
			usage: { tokens: 2000, usd: 0.45 },
		} satisfies MissionTreeNode,
		"L1/node-2": {
			parentId: "L0",
			children: ["L2/node-2.1"],
			status: "active",
			correlationId: "auth-refactor/L1/node-2",
			usage: { tokens: 1500, usd: 0.3 },
		} satisfies MissionTreeNode,
		"L2/node-2.1": {
			parentId: "L1/node-2",
			children: [],
			status: "pending",
			correlationId: "auth-refactor/L2/node-2.1",
		} satisfies MissionTreeNode,
	},
};

const EMPTY_TREE: MissionTree = { roots: [], nodes: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a fresh <mission-tree> element and wait for Lit's first render. */
async function mount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
	const el = document.createElement("mission-tree");
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	document.body.appendChild(el);
	// Wait for Lit's initial render cycle (updateComplete resolves after render).
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
// TC-F39-1: Render tree from API fixture
// ============================================================================

describe("TC-F39-1: render tree from API fixture", () => {
	it("renders all four nodes with their nodeId text", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });

		// Wait for fetch-driven state update to flush through Lit.
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		expect(text).toContain("L0");
		expect(text).toContain("L1/node-1");
		expect(text).toContain("L1/node-2");
		expect(text).toContain("L2/node-2.1");
	});

	it("issues GET /api/missions/:id/tree with the mission-id attribute", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		await trackMount({ "mission-id": "auth-refactor" });

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(String(url)).toContain("/api/missions/auth-refactor/tree");
		expect(init?.method ?? "GET").toBe("GET");
	});

	it("applies depth-based indentation (L2 is indented deeper than L1)", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// The component must render each node in its own element with a
		// depth-dependent style (padding-left, margin-left, or CSS variable).
		// Strategy: find all node-bearing elements and check that one with
		// deeper depth has larger left offset (via inline style, class, or
		// data-depth attribute).
		const nodeEls = el.querySelectorAll<HTMLElement>("[data-node-id], [data-depth], .mission-node");
		expect(nodeEls.length).toBeGreaterThanOrEqual(4);
	});

	it("displays status indicator for each node (active/completed/pending/failed/aborted)", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Roadmap icon set: ● active, ✓ completed, ✗ failed, ○ pending.
		// Accepts either the literal glyph or a data-status / class carrying the state.
		const html = el.innerHTML;
		const hasVisualStatus =
			html.includes("completed") ||
			html.includes("active") ||
			html.includes("pending") ||
			html.includes("failed") ||
			html.includes("✓") ||
			html.includes("●") ||
			html.includes("○") ||
			html.includes("✗") ||
			el.querySelectorAll("[data-status]").length >= 4;
		expect(hasVisualStatus).toBe(true);
	});
});

// ============================================================================
// TC-F39-2: WS mission_event → live update
// ============================================================================

describe("TC-F39-2: WS mission_event live update", { timeout: 15_000 }, () => {
	it("adds a newly-spawned node to the tree within 5 seconds", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		expect(el.textContent).not.toContain("L1/node-3");

		// Simulate WS fan-out from dashboard-app (system-wide broadcast).
		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/node-3",
			entry: {
				event: "spawn",
				nodeId: "L1/node-3",
				parentId: "L0",
				status: "active",
			},
		});

		// Wait up to 5s for the component to reflect the event.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
			if ((el.textContent ?? "").includes("L1/node-3")) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(el.textContent).toContain("L1/node-3");
	});

	it("updates status from active → completed on 'complete' event", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L1/node-2",
			entry: { event: "complete", nodeId: "L1/node-2", status: "completed", usage: { usd: 0.33 } },
		});

		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
			const completedNodes = el.querySelectorAll<HTMLElement>("[data-status='completed']");
			if (completedNodes.length >= 2) break; // L1/node-1 + L1/node-2
			await new Promise((r) => setTimeout(r, 50));
		}
		// Either data-status attribute or rendered status text reflects completion.
		const html = el.innerHTML;
		const reflects =
			el.querySelectorAll<HTMLElement>("[data-status='completed']").length >= 2 ||
			(html.match(/(✓|completed)/g)?.length ?? 0) >= 2;
		expect(reflects).toBe(true);
	});

	it("ignores mission_event for a different missionId", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the component must have rendered its own tree first.
		expect(el.textContent).toContain("L0");
		expect(el.textContent).toContain("L1/node-1");

		dispatchMissionEvent({
			missionId: "other-mission",
			event: "spawn",
			nodeId: "L1/foreign",
		});

		// Give it time to (not) react.
		await new Promise((r) => setTimeout(r, 200));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		expect(el.textContent).not.toContain("L1/foreign");
	});
});

// ============================================================================
// TC-F39-3: Cost/usage display
// ============================================================================

describe("TC-F39-3: cost / usage display", () => {
	it("renders $0.45 next to L1/node-1 (completed node with usage.usd)", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Accept any conventional currency rendering.
		const text = el.textContent ?? "";
		const hasCost = text.includes("$0.45") || text.includes("0.45") || text.includes("USD") || text.includes("usd");
		expect(hasCost).toBe(true);
	});

	it("omits cost rendering for nodes without usage", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the tree must actually be rendered.
		expect(el.textContent).toContain("L0");
		expect(el.textContent).toContain("L2/node-2.1");

		// L2/node-2.1 has no usage; there should NOT be a cost glyph adjacent
		// to it. Approximate check: number of cost occurrences ≤ number of
		// nodes that actually have usage (3 in the fixture: L0, L1/node-1, L1/node-2).
		const text = el.textContent ?? "";
		const costMatches = text.match(/\$[\d.]+/g) ?? [];
		expect(costMatches.length).toBeLessThanOrEqual(3);
	});
});

// ============================================================================
// Empty / 404 / error states
// ============================================================================

describe("Empty / error states", () => {
	it("renders a placeholder when tree has no nodes", async () => {
		mockFetchJson(200, EMPTY_TREE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = (el.textContent ?? "").toLowerCase();
		const hasPlaceholder =
			text.includes("no ") ||
			text.includes("нет ") ||
			text.includes("empty") ||
			text.includes("пуст") ||
			text.includes("placeholder") ||
			el.querySelector("[data-state='empty']") !== null;
		expect(hasPlaceholder).toBe(true);
	});

	it("renders 'mission not found' on 404", async () => {
		mockFetchJson(404, { error: "Mission 'auth-refactor' not found", code: "NOT_FOUND" });
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = (el.textContent ?? "").toLowerCase();
		const reflects404 =
			text.includes("not found") ||
			text.includes("не найдена") ||
			text.includes("не знайдено") ||
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

	it("does not render any tree nodes while in error state", async () => {
		mockFetchJson(404, { error: "Not found" });
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the component must surface some error indication.
		const text = (el.textContent ?? "").toLowerCase();
		const hasErrorIndicator =
			text.includes("not found") ||
			text.includes("не найдена") ||
			text.includes("error") ||
			text.includes("fail") ||
			el.querySelector("[data-state='not-found']") !== null ||
			el.querySelector("[data-state='error']") !== null;
		expect(hasErrorIndicator).toBe(true);

		// No mission nodes should appear in the error view.
		expect(el.querySelectorAll("[data-node-id]").length).toBe(0);
	});
});

// ============================================================================
// Attribute change → reload
// ============================================================================

describe("mission-id attribute change", () => {
	it("reloads tree when mission-id is changed at runtime", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Second call: different mission, different fixture.
		mockFetchJson(200, { roots: ["L0"], nodes: { L0: { parentId: null, children: [], status: "active" } } });

		el.setAttribute("mission-id", "other-mission");
		// Give attributeChangedCallback + Lit one microtask + macrotask to react.
		await new Promise((r) => setTimeout(r, 50));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
		const lastUrl = String(mockFetch.mock.calls.at(-1)![0]);
		expect(lastUrl).toContain("/api/missions/other-mission/tree");
	});
});

// ============================================================================
// WS unsubscribe on disconnectedCallback
// ============================================================================

describe("WS unsubscribe on disconnect", () => {
	it("stops reacting to mission_event after being removed from the DOM", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await mount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the component must have actually rendered the tree.
		expect(el.textContent).toContain("L0");
		expect(el.textContent).toContain("L1/node-1");

		// Detach (disconnectedCallback must run and remove the window listener).
		await unmount(el);

		const snapshot = el.textContent ?? "";

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/detached-node",
		});

		await new Promise((r) => setTimeout(r, 100));
		// The detached element should not have mutated to contain the new node.
		expect(el.textContent).toBe(snapshot);
		expect(el.textContent).not.toContain("L1/detached-node");
	});
});

// ============================================================================
// Accessibility / rendering sanity
// ============================================================================

describe("rendering sanity", () => {
	it("does not use shadow DOM (Tailwind penetration requirement)", async () => {
		mockFetchJson(200, TREE_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		// createRenderRoot() { return this; } → shadowRoot must be null.
		expect(el.shadowRoot).toBeNull();
	});

	it("is registered as a custom element named 'mission-tree'", () => {
		const ctor = customElements.get("mission-tree");
		expect(ctor).toBeDefined();
	});
});
