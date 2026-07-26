// Tests for <session-sidebar> tree grouping by cwd (F-2.7)
import type { SessionSummary } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FanApiClient } from "../api/client.js";
import "../components/session-sidebar.js";
import { NO_PROJECT_LABEL, type SessionSidebar } from "../components/session-sidebar.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
	return {
		title: `Session ${overrides.id}`,
		createdAt: "2026-07-25T10:00:00.000Z",
		updatedAt: "2026-07-25T10:00:00.000Z",
		messageCount: 1,
		...overrides,
	};
}

interface ListCall {
	options?: { project?: string };
}

/** Minimal FanApiClient stub — only what session-sidebar touches. */
function mockClient(sessions: SessionSummary[], calls: ListCall[] = []): FanApiClient {
	return {
		listSessions: async (options?: { project?: string }) => {
			calls.push({ options });
			return { sessions };
		},
		createSession: async () => makeSession({ id: "new" }),
		deleteSession: async () => ({ success: true }),
	} as unknown as FanApiClient;
}

async function flush(el: SessionSidebar): Promise<void> {
	// Wait for the async loadSessions() promise chain + Lit re-render
	await new Promise((r) => setTimeout(r, 0));
	await el.updateComplete;
}

const THREE_SESSIONS: SessionSummary[] = [
	makeSession({ id: "s1", cwd: "/a", title: "Alpha 1", updatedAt: "2026-07-25T12:00:00.000Z" }),
	makeSession({ id: "s2", cwd: "/a", title: "Alpha 2", updatedAt: "2026-07-25T11:00:00.000Z" }),
	makeSession({ id: "s3", cwd: "/b", title: "Beta 1", updatedAt: "2026-07-25T10:00:00.000Z" }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-sidebar tree grouping (F-2.7)", () => {
	let el: SessionSidebar;
	let calls: ListCall[];

	function createEl(sessions: SessionSummary[]): void {
		calls = [];
		el = document.createElement("session-sidebar") as SessionSidebar;
		el.apiClient = mockClient(sessions, calls);
		document.body.appendChild(el);
	}

	afterEach(() => {
		el.remove();
	});

	// TC-F-2.7-1: sessions are grouped by cwd with correct counters
	it("groups 3 sessions (2×/a, 1×/b) into two groups with counters", async () => {
		createEl(THREE_SESSIONS);
		await flush(el);

		const groups = el.querySelectorAll<HTMLElement>(".tree-group");
		expect(groups.length).toBe(2);

		const keys = Array.from(groups).map((g) => g.dataset.groupKey);
		expect(keys).toEqual(["/a", "/b"]);

		const counts = Array.from(el.querySelectorAll<HTMLElement>(".tree-group-count")).map((c) =>
			c.textContent?.trim(),
		);
		expect(counts).toEqual(["2", "1"]);

		// Sessions are nested inside their groups
		const groupA = groups[0];
		const groupB = groups[1];
		expect(groupA.querySelectorAll(".tree-item").length).toBe(2);
		expect(groupB.querySelectorAll(".tree-item").length).toBe(1);
		expect(groupA.textContent).toContain("Alpha 1");
		expect(groupA.textContent).toContain("Alpha 2");
		expect(groupB.textContent).toContain("Beta 1");
	});

	// TC-F-2.7-2: toggle collapses/expands a group and flips the ▼/▶ icon
	it("collapses and expands a group on toggle, switching ▼/▶", async () => {
		createEl(THREE_SESSIONS);
		await flush(el);

		const groupA = el.querySelector<HTMLElement>('.tree-group[data-group-key="/a"]')!;
		const header = groupA.querySelector<HTMLButtonElement>(".tree-group-header")!;
		const icon = () => groupA.querySelector<HTMLElement>(".toggle-icon")!.textContent;

		// Expanded by default
		expect(icon()).toBe("▼");
		expect(groupA.querySelector(".tree-items")).not.toBeNull();
		expect(header.getAttribute("aria-expanded")).toBe("true");

		// Collapse
		header.click();
		await el.updateComplete;
		expect(icon()).toBe("▶");
		expect(groupA.querySelector(".tree-items")).toBeNull();
		expect(header.getAttribute("aria-expanded")).toBe("false");

		// Expand again
		header.click();
		await el.updateComplete;
		expect(icon()).toBe("▼");
		expect(groupA.querySelectorAll(".tree-item").length).toBe(2);

		// Group /b stays expanded — toggles are independent
		const groupB = el.querySelector<HTMLElement>('.tree-group[data-group-key="/b"]')!;
		expect(groupB.querySelector(".tree-items")).not.toBeNull();
	});

	// Legacy sessions without cwd land in the "Без проекта" group (rendered last)
	it("puts cwd-less legacy sessions into the dedicated no-project group, rendered last", async () => {
		createEl([
			makeSession({ id: "s1", cwd: "/a", updatedAt: "2026-07-25T12:00:00.000Z" }),
			makeSession({ id: "legacy", title: "Old session", updatedAt: "2026-07-25T13:00:00.000Z" }),
		]);
		await flush(el);

		const groups = Array.from(el.querySelectorAll<HTMLElement>(".tree-group"));
		expect(groups.length).toBe(2);

		const legacyGroup = groups[groups.length - 1];
		expect(legacyGroup.querySelector(".tree-group-label")!.textContent).toContain(NO_PROJECT_LABEL);
		expect(legacyGroup.querySelector(".tree-group-count")!.textContent?.trim()).toBe("1");
		expect(legacyGroup.textContent).toContain("Old session");
	});

	// Regression: clicking a session still dispatches fan:session-selected
	it("dispatches fan:session-selected with the session id on click (regression)", async () => {
		createEl(THREE_SESSIONS);
		await flush(el);

		const events: CustomEvent[] = [];
		el.addEventListener("fan:session-selected", (e) => events.push(e as CustomEvent));

		const item = el.querySelector<HTMLButtonElement>('.tree-group[data-group-key="/b"] .tree-item')!;
		item.click();

		expect(events.length).toBe(1);
		expect(events[0].detail).toEqual({ sessionId: "s3" });
		expect(events[0].bubbles).toBe(true);
		expect(events[0].composed).toBe(true);
	});

	// Status colour coding: 🟢 active / 🔵 completed / 🟡 draft(error)
	it("renders status dots: active (selected), completed (messages), error (draft)", async () => {
		createEl([
			makeSession({ id: "act", cwd: "/a", messageCount: 3 }),
			makeSession({ id: "done", cwd: "/a", messageCount: 5 }),
			makeSession({ id: "draft", cwd: "/a", messageCount: 0 }),
		]);
		el.activeSessionId = "act";
		await flush(el);

		const dotOf = (title: string) => {
			const items = Array.from(el.querySelectorAll(".tree-item")) as HTMLElement[];
			const item = items.find((i) => i.textContent?.includes(title))!;
			return item.querySelector<HTMLElement>(".status-dot")!;
		};

		expect(dotOf("Session act").classList.contains("status-active")).toBe(true);
		expect(dotOf("Session done").classList.contains("status-completed")).toBe(true);
		expect(dotOf("Session draft").classList.contains("status-error")).toBe(true);
	});

	// F-2.7 + F-2.8: fan:project-changed re-scopes the list via listSessions({ project })
	it("reloads sessions scoped to the project on fan:project-changed", async () => {
		createEl(THREE_SESSIONS);
		await flush(el);
		expect(calls[0].options).toBeUndefined();

		const projectSessions = [makeSession({ id: "s1", cwd: "/a" }), makeSession({ id: "s2", cwd: "/a" })];
		el.apiClient = mockClient(projectSessions, calls);

		window.dispatchEvent(new CustomEvent("fan:project-changed", { detail: { path: "/a" } }));
		await flush(el);

		expect(calls[calls.length - 1].options).toEqual({ project: "/a" });
		// Single group remains (all sessions share the project cwd)
		expect(el.querySelectorAll(".tree-group").length).toBe(1);
		expect(el.querySelectorAll(".tree-item").length).toBe(2);

		// Back to "all projects" → unscoped request
		window.dispatchEvent(new CustomEvent("fan:project-changed", { detail: { path: null } }));
		await flush(el);
		expect(calls[calls.length - 1].options).toBeUndefined();
	});

	// Search filter still applies before grouping
	it("applies the search filter before grouping", async () => {
		createEl(THREE_SESSIONS);
		await flush(el);

		const input = el.querySelector<HTMLInputElement>('input[type="text"]')!;
		input.value = "beta";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;

		expect(el.querySelectorAll(".tree-group").length).toBe(1);
		expect(el.querySelectorAll(".tree-item").length).toBe(1);
		expect(el.textContent).toContain("Beta 1");
	});
});
