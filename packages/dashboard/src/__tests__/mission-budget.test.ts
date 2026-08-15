/**
 * F-41: Dashboard <mission-budget> — RED-phase tests.
 *
 * Component under test:
 *   packages/dashboard/src/components/mission/mission-budget.ts
 *
 * Contract under test:
 *   - REST: GET /api/missions/:id/budget → { mission_id, budget_total,
 *     budget_usd, allocated, consumed, peak, by_branch: Record<string,
 *     { allocated, consumed, cost_usd }> }
 *   - WS:   system-wide mission_event fan-out (consumed via window CustomEvent
 *           "fan:mission-event", dispatched by dashboard-app from FanWsClient).
 *
 * Reference: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-41
 *
 * Mocking strategy:
 *   - REST → vi.stubGlobal("fetch", mockFetch) (matches existing api-client.test.ts)
 *   - WS   → window.dispatchEvent(new CustomEvent("fan:mission-event", { detail }))
 *
 * NOTE: These tests MUST FAIL until mission-budget.ts is fully implemented.
 */

import type { WsMissionEvent } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Import component under test (registers <mission-budget> custom element).
// In RED phase this import throws MODULE_NOT_FOUND → vitest reports test as
// failed, which is exactly the expected red signal.
// ---------------------------------------------------------------------------
import "../components/mission/mission-budget.js";

// ---------------------------------------------------------------------------
// Types (mirror the F-47 budget API response shape)
// ---------------------------------------------------------------------------

interface BudgetBranch {
	allocated: number;
	consumed: number;
	cost_usd: number;
}

interface MissionBudgetData {
	mission_id: string;
	budget_total: number;
	budget_usd: number;
	allocated: number;
	consumed: number;
	peak: number;
	by_branch: Record<string, BudgetBranch>;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** TC-F41-1 fixture: 3 branches, total budget $10.00. */
const BUDGET_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 8.0,
	consumed: 3.45,
	peak: 4.0,
	by_branch: {
		"L1/node-1": { allocated: 3.0, consumed: 0.45, cost_usd: 0.45 },
		"L1/node-2": { allocated: 3.0, consumed: 0.3, cost_usd: 0.3 },
		"L1/node-3": { allocated: 2.0, consumed: 0.12, cost_usd: 0.12 },
	},
};

/** TC-F41-2 fixture: branch with 85% consumption (≥80% → warning/yellow). */
const WARNING_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 10.0,
	consumed: 8.5,
	peak: 8.5,
	by_branch: {
		"L1/node-1": { allocated: 5.0, consumed: 4.25, cost_usd: 4.25 }, // 85% → warning
		"L1/node-2": { allocated: 5.0, consumed: 1.0, cost_usd: 1.0 }, // 20% → normal
	},
};

/** Fixture: branch with 97% consumption (≥95% → critical/red). */
const CRITICAL_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 10.0,
	consumed: 9.7,
	peak: 9.7,
	by_branch: {
		"L1/node-1": { allocated: 5.0, consumed: 4.85, cost_usd: 4.85 }, // 97% → critical
		"L1/node-2": { allocated: 5.0, consumed: 1.0, cost_usd: 1.0 },
	},
};

/** Fixture: consumed > allocated → over-budget branch. */
const OVER_BUDGET_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 5.0,
	consumed: 6.5,
	peak: 6.5,
	by_branch: {
		"L1/node-1": { allocated: 3.0, consumed: 4.5, cost_usd: 4.5 }, // 150% → over
		"L1/node-2": { allocated: 2.0, consumed: 2.0, cost_usd: 2.0 }, // 100% → normal
	},
};

/** Fixture: empty by_branch (no branches). */
const EMPTY_BRANCHES_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 0,
	consumed: 0,
	peak: 0,
	by_branch: {},
};

/** Fixture: budget_total = 0 → division by zero guard. */
const ZERO_BUDGET_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 0,
	budget_usd: 0,
	allocated: 0,
	consumed: 0,
	peak: 0,
	by_branch: {
		"L1/node-1": { allocated: 0, consumed: 0, cost_usd: 0 },
	},
};

/** Fixture: branch allocated = 0 → per-branch division by zero guard. */
const ZERO_ALLOCATED_FIXTURE: MissionBudgetData = {
	mission_id: "auth-refactor",
	budget_total: 10.0,
	budget_usd: 10.0,
	allocated: 0,
	consumed: 0,
	peak: 0,
	by_branch: {
		"L1/node-1": { allocated: 0, consumed: 0.5, cost_usd: 0.5 },
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a fresh <mission-budget> element and wait for Lit's first render. */
async function mount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
	const el = document.createElement("mission-budget");
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
// TC-F41-1: Render bar chart from API fixture (by_branch)
// ============================================================================

describe("TC-F41-1: render bars by branch", () => {
	it("renders a bar element for each branch with data-branch attribute", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Each branch must have a data-branch attribute for DOM querying.
		const branchEls = el.querySelectorAll<HTMLElement>("[data-branch]");
		expect(branchEls.length).toBe(3);

		const branchNames = Array.from(branchEls).map((e) => e.getAttribute("data-branch"));
		expect(branchNames).toContain("L1/node-1");
		expect(branchNames).toContain("L1/node-2");
		expect(branchNames).toContain("L1/node-3");
	});

	it("renders branch labels (node IDs) as text", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		expect(text).toContain("L1/node-1");
		expect(text).toContain("L1/node-2");
		expect(text).toContain("L1/node-3");
	});

	it("renders cost values ($0.45, $0.30, $0.12) for each branch", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		// At least one form of cost rendering should be present per branch.
		const hasCost045 = text.includes("0.45") || text.includes("$0.45");
		const hasCost030 = text.includes("0.30") || text.includes("$0.30") || text.includes("0.3");
		const hasCost012 = text.includes("0.12") || text.includes("$0.12");
		expect(hasCost045).toBe(true);
		expect(hasCost030).toBe(true);
		expect(hasCost012).toBe(true);
	});

	it("issues GET /api/missions/:id/budget with the mission-id attribute", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		await trackMount({ "mission-id": "auth-refactor" });

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(String(url)).toContain("/api/missions/auth-refactor/budget");
		expect(init?.method ?? "GET").toBe("GET");
	});

	it("renders a summary bar showing total consumed vs budget_total", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		// Summary should show consumed (3.45) and total (10.00 or 10.0).
		const hasConsumed = text.includes("3.45") || text.includes("$3.45");
		const hasTotal = text.includes("10.00") || text.includes("10.0") || text.includes("$10");
		expect(hasConsumed).toBe(true);
		expect(hasTotal).toBe(true);
	});
});

// ============================================================================
// TC-F41-2: Threshold colors (80% → warning/yellow, 95% → critical/red)
// ============================================================================

describe("TC-F41-2: threshold color changes", () => {
	it("marks branch at 85% consumption as warning (≥80%)", async () => {
		mockFetchJson(200, WARNING_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// L1/node-1: 4.25 / 5.0 = 85% → warning.
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-1']");
		expect(branchEl).not.toBeNull();

		// The component must signal the warning state via data-over, class, or
		// data-threshold attribute.
		const html = branchEl!.outerHTML;
		const isWarning =
			html.includes("warning") ||
			html.includes("yellow") ||
			html.includes("amber") ||
			branchEl!.getAttribute("data-threshold") === "warning" ||
			branchEl!.classList.toString().includes("warning") ||
			branchEl!.classList.toString().includes("yellow") ||
			branchEl!.classList.toString().includes("amber");
		expect(isWarning).toBe(true);
	});

	it("marks branch at 97% consumption as critical (≥95%)", async () => {
		mockFetchJson(200, CRITICAL_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// L1/node-1: 4.85 / 5.0 = 97% → critical.
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-1']");
		expect(branchEl).not.toBeNull();

		const html = branchEl!.outerHTML;
		const isCritical =
			html.includes("critical") ||
			html.includes("red") ||
			html.includes("danger") ||
			branchEl!.getAttribute("data-threshold") === "critical" ||
			branchEl!.classList.toString().includes("critical") ||
			branchEl!.classList.toString().includes("red") ||
			branchEl!.classList.toString().includes("danger");
		expect(isCritical).toBe(true);
	});

	it("does NOT mark branch at 20% consumption as warning", async () => {
		mockFetchJson(200, WARNING_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// L1/node-2: 1.0 / 5.0 = 20% → normal (no warning class).
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-2']");
		expect(branchEl).not.toBeNull();

		const html = branchEl!.outerHTML;
		const isWarning =
			html.includes("warning") ||
			html.includes("yellow") ||
			html.includes("amber") ||
			branchEl!.getAttribute("data-threshold") === "warning";
		expect(isWarning).toBe(false);
	});
});

// ============================================================================
// Consumed > allocated → over-budget highlight
// ============================================================================

describe("consumed > allocated → over-budget highlight", () => {
	it("marks a branch as over-budget when consumed exceeds allocated", async () => {
		mockFetchJson(200, OVER_BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// L1/node-1: consumed 4.5 > allocated 3.0 → over.
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-1']");
		expect(branchEl).not.toBeNull();

		// The component must signal over-budget via data-over="true", class, or
		// data-threshold="over".
		const html = branchEl!.outerHTML;
		const isOver =
			branchEl!.getAttribute("data-over") === "true" ||
			html.includes("over") ||
			html.includes("exceed") ||
			html.includes("danger") ||
			html.includes("red") ||
			branchEl!.getAttribute("data-threshold") === "over" ||
			branchEl!.classList.toString().includes("over") ||
			branchEl!.classList.toString().includes("danger") ||
			branchEl!.classList.toString().includes("red");
		expect(isOver).toBe(true);
	});

	it("does NOT mark a branch at exactly 100% as over-budget", async () => {
		mockFetchJson(200, OVER_BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// L1/node-2: consumed 2.0 == allocated 2.0 → exactly 100%, not over.
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-2']");
		expect(branchEl).not.toBeNull();

		const isOver =
			branchEl!.getAttribute("data-over") === "true" || branchEl!.getAttribute("data-threshold") === "over";
		expect(isOver).toBe(false);
	});
});

// ============================================================================
// TC-F41-3: WS mission_event → live update
// ============================================================================

describe("TC-F41-3: WS mission_event → live bar update", { timeout: 15_000 }, () => {
	it("updates consumed value when a 'complete' WS event arrives", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: initial consumed for L1/node-2 is 0.30.
		expect(el.textContent).toContain("L1/node-2");

		// Simulate WS event: L1/node-2 completed with extra cost.
		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L1/node-2",
			entry: {
				event: "complete",
				nodeId: "L1/node-2",
				consumed: 1.5,
				cost_usd: 0.15,
				usage: { costUsd: 0.15 },
			},
		});

		// Wait up to 5s for the component to reflect the updated value.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
			const text = el.textContent ?? "";
			// The consumed for L1/node-2 should now be different from 0.30.
			if (text.includes("1.5") || text.includes("1.50") || text.includes("$1.5")) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const text = el.textContent ?? "";
		const updated = text.includes("1.5") || text.includes("1.50") || text.includes("$1.5") || text.includes("$1.50");
		expect(updated).toBe(true);
	});

	it("ignores mission_event for a different missionId", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const snapshot = el.innerHTML;

		dispatchMissionEvent({
			missionId: "other-mission",
			event: "complete",
			nodeId: "L1/node-1",
			entry: { consumed: 999 },
		});

		await new Promise((r) => setTimeout(r, 200));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// The DOM should not have changed for a foreign mission event.
		expect(el.innerHTML).toBe(snapshot);
	});
});

// ============================================================================
// Empty / 404 / error states
// ============================================================================

describe("empty / 404 / error states", () => {
	it("renders empty state when by_branch is empty", async () => {
		mockFetchJson(200, EMPTY_BRANCHES_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = (el.textContent ?? "").toLowerCase();
		const hasPlaceholder =
			text.includes("no ") ||
			text.includes("empty") ||
			text.includes("no data") ||
			text.includes("нет ") ||
			text.includes("пуст") ||
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

	it("does not render any bar elements while in error state", async () => {
		mockFetchJson(404, { error: "Not found" });
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the component must surface some error indication.
		const text = (el.textContent ?? "").toLowerCase();
		const hasErrorIndicator =
			text.includes("not found") ||
			text.includes("error") ||
			text.includes("fail") ||
			el.querySelector("[data-state='not-found']") !== null ||
			el.querySelector("[data-state='error']") !== null;
		expect(hasErrorIndicator).toBe(true);

		// No branch bars should appear in the error view.
		expect(el.querySelectorAll("[data-branch]").length).toBe(0);
	});

	it("shows a loading indicator while fetch is in flight", async () => {
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
			json: () => Promise.resolve(BUDGET_FIXTURE),
			text: () => Promise.resolve(JSON.stringify(BUDGET_FIXTURE)),
		} as unknown as Response);

		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
	});
});

// ============================================================================
// mission-id attribute change → reload
// ============================================================================

describe("mission-id attribute change", () => {
	it("reloads budget when mission-id is changed at runtime", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Second call: different mission.
		const secondFixture = { ...BUDGET_FIXTURE, mission_id: "other-mission" };
		mockFetchJson(200, secondFixture);

		el.setAttribute("mission-id", "other-mission");
		await new Promise((r) => setTimeout(r, 50));
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
		const lastUrl = String(mockFetch.mock.calls.at(-1)![0]);
		expect(lastUrl).toContain("/api/missions/other-mission/budget");
	});
});

// ============================================================================
// WS unsubscribe on disconnectedCallback
// ============================================================================

describe("WS unsubscribe on disconnect", () => {
	it("stops reacting to mission_event after being removed from the DOM", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await mount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Pre-condition: the component must have actually rendered bars.
		expect(el.textContent).toContain("L1/node-1");

		// Detach (disconnectedCallback must run and remove the window listener).
		await unmount(el);

		const snapshot = el.innerHTML;

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L1/node-1",
			entry: { consumed: 999 },
		});

		await new Promise((r) => setTimeout(r, 100));
		// The detached element should not have mutated.
		expect(el.innerHTML).toBe(snapshot);
	});
});

// ============================================================================
// Division by zero guards (budget_total=0, allocated=0)
// ============================================================================

describe("division by zero guards", () => {
	it("does not produce NaN when budget_total is 0", async () => {
		mockFetchJson(200, ZERO_BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// The rendered text should never contain "NaN" or "Infinity".
		const text = el.textContent ?? "";
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("Infinity");

		// The component should still render (not crash).
		expect(el.children.length).toBeGreaterThan(0);
	});

	it("does not produce NaN when a branch has allocated=0", async () => {
		mockFetchJson(200, ZERO_ALLOCATED_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		const text = el.textContent ?? "";
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("Infinity");

		// The branch should still render.
		const branchEl = el.querySelector<HTMLElement>("[data-branch='L1/node-1']");
		// Branch may or may not render depending on design — but no NaN crash.
		if (branchEl) {
			expect(branchEl.innerHTML).not.toContain("NaN");
		}
	});
});

// ============================================================================
// Accessibility / rendering sanity
// ============================================================================

describe("rendering sanity", () => {
	it("does not use shadow DOM (Tailwind penetration requirement)", async () => {
		mockFetchJson(200, BUDGET_FIXTURE);
		const el = await trackMount({ "mission-id": "auth-refactor" });
		// createRenderRoot() { return this; } → shadowRoot must be null.
		expect(el.shadowRoot).toBeNull();
	});

	it("is registered as a custom element named 'mission-budget'", () => {
		const ctor = customElements.get("mission-budget");
		expect(ctor).toBeDefined();
	});

	it("renders empty state when mission-id is not provided", async () => {
		const el = await trackMount({});
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

		// Should not have made any fetch call.
		expect(mockFetch).not.toHaveBeenCalled();

		// The component MUST show a meaningful empty-state indicator.
		const text = (el.textContent ?? "").toLowerCase();
		const hasPlaceholder =
			text.includes("no ") ||
			text.includes("empty") ||
			text.includes("select") ||
			text.includes("mission") ||
			el.querySelector("[data-state='empty']") !== null;
		expect(hasPlaceholder).toBe(true);
	});
});
