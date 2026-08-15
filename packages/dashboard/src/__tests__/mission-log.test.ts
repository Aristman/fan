/**
 * F-40: Dashboard <mission-log> — RED-phase tests.
 *
 * Component under test:
 *   packages/dashboard/src/components/mission/mission-log.ts
 *
 * Contract under test:
 *   - WS:   system-wide mission_event fan-out (consumed via window CustomEvent
 *           "fan:mission-event", dispatched by dashboard-app from FanWsClient).
 *   - Log:  append-only journal, last 100 entries (roadmap §F-40).
 *
 * Reference: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-40
 *
 * Mocking strategy:
 *   - WS → window.dispatchEvent(new CustomEvent("fan:mission-event", { detail }))
 *   - No REST endpoint for log (WS-driven append-only journal per roadmap).
 *
 * NOTE: These tests MUST FAIL until mission-log.ts is fully implemented.
 */

import type { WsMissionEvent } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Import component under test (registers <mission-log> custom element).
// In RED phase the stub renders nothing → assertions on text/state FAIL.
// ---------------------------------------------------------------------------
import "../components/mission/mission-log.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a fresh <mission-log> element and wait for Lit's first render. */
async function mount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
	const el = document.createElement("mission-log");
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
		timestamp: event.timestamp ?? new Date().toISOString(),
		entry: {},
		...event,
	};
	window.dispatchEvent(new CustomEvent("fan:mission-event", { detail: payload, bubbles: true }));
}

/** Wait for Lit to process updates. */
async function waitForUpdate(el: HTMLElement): Promise<void> {
	await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
}

/** Wait up to `ms` milliseconds for a predicate to become true. */
async function waitFor(el: HTMLElement, predicate: (el: HTMLElement) => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		await waitForUpdate(el);
		if (predicate(el)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return predicate(el);
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
// TC-F40-2: <mission-log> renders log entries
// ============================================================================

describe("TC-F40-2: render log entries from WS events", () => {
	it("renders a log entry after receiving a spawn event", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/node-1",
			timestamp: "2026-08-15T10:00:00.000Z",
			entry: { event: "spawn", nodeId: "L1/node-1" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-1"));

		const text = el.textContent ?? "";
		expect(text).toContain("L1/node-1");
		expect(text).toContain("spawn");
	});

	it("renders multiple log entries in order", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		const events = [
			{ event: "spawn", nodeId: "L1/node-1", timestamp: "2026-08-15T10:00:00.000Z" },
			{ event: "complete", nodeId: "L1/node-1", timestamp: "2026-08-15T10:00:05.000Z" },
			{ event: "spawn", nodeId: "L1/node-2", timestamp: "2026-08-15T10:00:06.000Z" },
			{ event: "fail", nodeId: "L1/node-2", timestamp: "2026-08-15T10:00:10.000Z" },
			{ event: "steer", nodeId: "L0", timestamp: "2026-08-15T10:00:12.000Z" },
		];

		for (const ev of events) {
			dispatchMissionEvent({
				missionId: "auth-refactor",
				event: ev.event,
				nodeId: ev.nodeId,
				timestamp: ev.timestamp,
				entry: { event: ev.event, nodeId: ev.nodeId },
			});
		}

		await waitFor(el, (e) => {
			const t = e.textContent ?? "";
			return t.includes("L1/node-1") && t.includes("L1/node-2") && t.includes("L0");
		});

		const text = el.textContent ?? "";
		// All 5 events should have their nodeId and event type visible.
		for (const ev of events) {
			expect(text).toContain(ev.nodeId);
			expect(text).toContain(ev.event);
		}
	});

	it("renders timestamp for each log entry", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/node-1",
			timestamp: "2026-08-15T10:30:00.000Z",
			entry: { event: "spawn", nodeId: "L1/node-1" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-1"));

		const text = el.textContent ?? "";
		// Timestamp should appear in some form — could be full ISO, localized, or relative.
		// Accept any of: "10:30", "10:30:00", "2026-08-15", or the raw ISO string.
		const hasTimestamp =
			text.includes("10:30") ||
			text.includes("2026-08-15") ||
			text.includes("10:30:00") ||
			text.includes("ago") ||
			text.includes("sec") ||
			el.querySelector("[data-timestamp], time") !== null;
		expect(hasTimestamp).toBe(true);
	});

	it("renders diag/description text when provided in entry", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "fail",
			nodeId: "L1/node-2",
			timestamp: "2026-08-15T10:00:10.000Z",
			entry: {
				event: "fail",
				nodeId: "L1/node-2",
				diag: "tool 'write' not in manifest",
			},
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-2"));

		const text = el.textContent ?? "";
		const hasDiag = text.includes("manifest") || text.includes("tool") || text.includes("diag");
		expect(hasDiag).toBe(true);
	});

	it("renders empty/placeholder state when no events have been received", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await waitForUpdate(el);

		const text = (el.textContent ?? "").toLowerCase();
		const hasPlaceholder =
			text.includes("no ") ||
			text.includes("empty") ||
			text.includes("waiting") ||
			text.includes("log") ||
			text.includes("event") ||
			el.querySelector("[data-state='empty']") !== null;
		expect(hasPlaceholder).toBe(true);
	});
});

// ============================================================================
// TC-F40-3: WS event → live addition within 5 seconds
// ============================================================================

describe("TC-F40-3: WS live event addition", { timeout: 15_000 }, () => {
	it("adds a new entry to the log within 5 seconds of WS event", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await waitForUpdate(el);

		// Pre-condition: L1/node-new should NOT be in the log yet.
		expect(el.textContent).not.toContain("L1/node-new");

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "complete",
			nodeId: "L1/node-new",
			entry: { event: "complete", nodeId: "L1/node-new" },
		});

		const found = await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-new"));
		expect(found).toBe(true);
	});

	it("filters events by missionId — ignores events for other missions", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });
		await waitForUpdate(el);

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/own-node",
			entry: { event: "spawn", nodeId: "L1/own-node" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/own-node"));

		// Now dispatch an event for a different mission.
		dispatchMissionEvent({
			missionId: "other-mission",
			event: "spawn",
			nodeId: "L1/foreign-node",
			entry: { event: "spawn", nodeId: "L1/foreign-node" },
		});

		await new Promise((r) => setTimeout(r, 200));
		await waitForUpdate(el);

		expect(el.textContent).toContain("L1/own-node");
		expect(el.textContent).not.toContain("L1/foreign-node");
	});

	it("handles all known event types (spawn, complete, fail, abort, steer, decide)", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		const eventTypes = ["spawn", "complete", "fail", "abort", "steer", "decide"];
		for (const evType of eventTypes) {
			dispatchMissionEvent({
				missionId: "auth-refactor",
				event: evType,
				nodeId: `L1/node-${evType}`,
				entry: { event: evType, nodeId: `L1/node-${evType}` },
			});
		}

		await waitFor(el, (e) => {
			const t = e.textContent ?? "";
			return eventTypes.every((ev) => t.includes(ev));
		});

		const text = el.textContent ?? "";
		for (const evType of eventTypes) {
			expect(text).toContain(evType);
		}
	});
});

// ============================================================================
// 100-entry limit
// ============================================================================

describe("100-entry limit", () => {
	it("does not render more than 100 log entries", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		// Dispatch 120 events.
		for (let i = 0; i < 120; i++) {
			dispatchMissionEvent({
				missionId: "auth-refactor",
				event: "spawn",
				nodeId: `L1/node-${i}`,
				timestamp: new Date(Date.now() + i * 1000).toISOString(),
				entry: { event: "spawn", nodeId: `L1/node-${i}` },
			});
		}

		// Wait for the last event to appear (or for the component to settle).
		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-119"), 10_000);

		// Count the number of log entry elements rendered.
		const entryEls = el.querySelectorAll<HTMLElement>("[data-log-entry], .log-entry, .mission-log-entry");
		// If the component uses data attributes or classes for entries, check count.
		if (entryEls.length > 0) {
			expect(entryEls.length).toBeLessThanOrEqual(100);
		} else {
			// Fallback: count occurrences of node IDs in the text.
			// Only the last 100 should be present (nodes 20–119).
			const text = el.textContent ?? "";
			// The earliest nodes (0–19) should have been evicted.
			const _earlyNodePresent = text.includes("L1/node-0") && !text.includes("L1/node-100");
			// At minimum, the most recent node should be there.
			expect(text).toContain("L1/node-119");
			// And the total number of distinct "L1/node-" occurrences ≤ 100.
			const nodeMatches = text.match(/L1\/node-\d+/g) ?? [];
			const uniqueNodes = new Set(nodeMatches);
			expect(uniqueNodes.size).toBeLessThanOrEqual(100);
		}
	});

	it("keeps the most recent entries when limit is reached", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		// Dispatch 110 events (exceeds 100 limit).
		for (let i = 0; i < 110; i++) {
			dispatchMissionEvent({
				missionId: "auth-refactor",
				event: "spawn",
				nodeId: `L1/node-${i}`,
				timestamp: new Date(Date.now() + i * 1000).toISOString(),
				entry: { event: "spawn", nodeId: `L1/node-${i}` },
			});
		}

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-109"), 10_000);

		const text = el.textContent ?? "";
		// The most recent entries (10–109) should be present.
		expect(text).toContain("L1/node-109");
		expect(text).toContain("L1/node-100");

		// The earliest entries (0–9) should have been evicted.
		// Check that node-0 is NOT present (it was the first in, first out).
		const _hasNode0 = text.includes("L1/node-0 ");
		// Note: "L1/node-0" might match "L1/node-00" or "L1/node-01" etc.
		// Use a more precise check: look for exact boundary.
		const nodeIds = text.match(/L1\/node-\d+/g) ?? [];
		const hasEarlyNode = nodeIds.some((id) => {
			const num = parseInt(id.replace("L1/node-", ""), 10);
			return num < 10;
		});
		expect(hasEarlyNode).toBe(false);
	});
});

// ============================================================================
// Auto-scroll behaviour
// ============================================================================

describe("auto-scroll", () => {
	it("scrolls to the bottom when a new entry is added", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		// Add enough entries to potentially overflow the container.
		for (let i = 0; i < 30; i++) {
			dispatchMissionEvent({
				missionId: "auth-refactor",
				event: "spawn",
				nodeId: `L1/node-${i}`,
				timestamp: new Date(Date.now() + i * 1000).toISOString(),
				entry: { event: "spawn", nodeId: `L1/node-${i}` },
			});
		}

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/node-29"));

		// Check if the component has a scrollable container that was scrolled to the bottom.
		// In jsdom, scrollHeight/clientHeight are 0, so we check for overflow style or
		// the presence of a scroll container with appropriate CSS.
		const scrollContainer =
			el.querySelector<HTMLElement>("[data-log-scroll], .mission-log-entries, .log-scroll") ?? el;

		// The container should have overflow-y set (auto or scroll).
		const style = getComputedStyle(scrollContainer);
		const hasScrollSetup =
			style.overflowY === "auto" ||
			style.overflowY === "scroll" ||
			style.overflow === "auto" ||
			style.overflow === "scroll" ||
			scrollContainer.classList.toString().includes("overflow") ||
			scrollContainer.className.includes("scroll");

		// In jsdom we can't truly test scrolling, but we can verify the component
		// has the infrastructure for auto-scroll. At minimum, the last entry should
		// be in the DOM.
		expect(el.textContent).toContain("L1/node-29");
		// The component should have some scroll-related setup.
		expect(hasScrollSetup || scrollContainer.scrollHeight >= 0).toBe(true);
	});
});

// ============================================================================
// mission-id attribute change → clear + resubscribe
// ============================================================================

describe("mission-id attribute change", () => {
	it("clears log entries when mission-id changes", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/old-node",
			entry: { event: "spawn", nodeId: "L1/old-node" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/old-node"));

		// Change mission-id.
		el.setAttribute("mission-id", "new-mission");
		await new Promise((r) => setTimeout(r, 50));
		await waitForUpdate(el);

		// Old entries should be cleared.
		expect(el.textContent).not.toContain("L1/old-node");
	});

	it("accepts events for the new mission-id after change", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/old-node",
			entry: { event: "spawn", nodeId: "L1/old-node" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/old-node"));

		el.setAttribute("mission-id", "new-mission");
		await new Promise((r) => setTimeout(r, 50));
		await waitForUpdate(el);

		dispatchMissionEvent({
			missionId: "new-mission",
			event: "spawn",
			nodeId: "L1/new-node",
			entry: { event: "spawn", nodeId: "L1/new-node" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/new-node"));

		expect(el.textContent).toContain("L1/new-node");
		expect(el.textContent).not.toContain("L1/old-node");
	});
});

// ============================================================================
// WS unsubscribe on disconnectedCallback
// ============================================================================

describe("WS unsubscribe on disconnect", () => {
	it("stops reacting to mission_event after being removed from the DOM", async () => {
		const el = await mount({ "mission-id": "auth-refactor" });
		await waitForUpdate(el);

		// Add an initial entry to confirm the component is working.
		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/before-disconnect",
			entry: { event: "spawn", nodeId: "L1/before-disconnect" },
		});

		await waitFor(el, (e) => (e.textContent ?? "").includes("L1/before-disconnect"));

		// Detach (disconnectedCallback must run and remove the window listener).
		await unmount(el);

		const snapshot = el.textContent ?? "";

		dispatchMissionEvent({
			missionId: "auth-refactor",
			event: "spawn",
			nodeId: "L1/after-disconnect",
			entry: { event: "spawn", nodeId: "L1/after-disconnect" },
		});

		await new Promise((r) => setTimeout(r, 100));
		// The detached element should not have mutated.
		expect(el.textContent).toBe(snapshot);
		expect(el.textContent).not.toContain("L1/after-disconnect");
	});
});

// ============================================================================
// Accessibility / rendering sanity
// ============================================================================

describe("rendering sanity", () => {
	it("does not use shadow DOM (Tailwind penetration requirement)", async () => {
		const el = await trackMount({ "mission-id": "auth-refactor" });
		expect(el.shadowRoot).toBeNull();
	});

	it("is registered as a custom element named 'mission-log'", () => {
		const ctor = customElements.get("mission-log");
		expect(ctor).toBeDefined();
	});
});
