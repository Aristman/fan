/**
 * F-1.12 regression tests: SessionManager.listAll() cwd propagation through the
 * session adapter (main.ts) into API-facing SessionSummary objects.
 *
 * Contract: sessions with a cwd in the JSONL header expose it verbatim; legacy
 * sessions without a header cwd (SessionInfo.cwd === "") are normalized to
 * `undefined` so API responses omit the field — never "" or null. Cwd-less
 * sessions never match a project filter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAllMock } = vi.hoisted(() => ({
	listAllMock: vi.fn(),
}));

vi.mock("../src/core/session-manager.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/core/session-manager.js")>();
	// The adapter only uses the static SessionManager.listAll — replace it with a
	// stub instead of extending the class (its constructor is private).
	return { ...orig, SessionManager: { ...orig.SessionManager, listAll: listAllMock } };
});

import { createSessionAdapter } from "../src/main.js";

function sessionInfo(id: string, cwd: string, modified: string) {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd,
		name: id,
		parentSessionPath: undefined,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

// Minimal runtime stub — listSessions() never touches the runtime.
const fakeRuntime = {
	session: { sessionId: "active", sessionFile: null },
};

describe("session adapter cwd propagation (F-1.12)", () => {
	beforeEach(() => {
		listAllMock.mockReset();
	});

	// TC-F-1.12-1 (adapter level): cwd from listAll is present in every listed
	// session; legacy empty cwd ("") is normalized to undefined (field omitted).
	it("listSessions propagates cwd from listAll and omits it for legacy sessions (TC-F-1.12-1)", async () => {
		listAllMock.mockResolvedValue([
			sessionInfo("s-a", "/data/repos/a", "2026-01-02T00:00:00Z"),
			sessionInfo("s-b", "/data/repos/b", "2026-01-01T00:00:00Z"),
			sessionInfo("s-legacy", "", "2025-12-31T00:00:00Z"),
		]);
		const adapter = createSessionAdapter(fakeRuntime as never);
		const sessions = await adapter.listSessions();
		expect(sessions).toHaveLength(3);
		const byId = new Map(sessions.map((s) => [s.id, s]));
		expect(byId.get("s-a")?.cwd).toBe("/data/repos/a");
		expect(byId.get("s-b")?.cwd).toBe("/data/repos/b");
		expect(byId.get("s-legacy")?.cwd).toBeUndefined();
	});

	// TC-F-1.12-2 (adapter level): the project filter is applied after listAll
	// (in-memory); filtered results keep cwd; cwd-less sessions are excluded.
	it("listSessions(projectPath) filters after listAll and keeps cwd (TC-F-1.12-2)", async () => {
		listAllMock.mockResolvedValue([
			sessionInfo("s-a1", "/data/repos/a", "2026-01-03T00:00:00Z"),
			sessionInfo("s-a2", "/data/repos/a/", "2026-01-02T00:00:00Z"),
			sessionInfo("s-b", "/data/repos/b", "2026-01-01T00:00:00Z"),
			sessionInfo("s-legacy", "", "2025-12-31T00:00:00Z"),
		]);
		const adapter = createSessionAdapter(fakeRuntime as never);
		const sessions = await adapter.listSessions("/data/repos/a");
		expect(sessions).toHaveLength(2);
		for (const s of sessions) {
			expect(s.cwd).toBeDefined();
			expect(s.cwd?.replace(/\/$/, "")).toBe("/data/repos/a");
		}
	});
});
