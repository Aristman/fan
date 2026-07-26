/**
 * F-5.8 regression test: SessionAdapter.sendMessage (main.ts) logs a clear
 * error when the target session does not exist on disk, instead of failing
 * silently.
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

// Minimal runtime stub — sendMessage only needs the active session id.
const fakeRuntime = {
	session: { sessionId: "active", sessionFile: null },
};

describe("session adapter sendMessage logging (F-5.8)", () => {
	beforeEach(() => {
		listAllMock.mockReset();
	});

	it("logs an error when the target session is not found on disk", async () => {
		listAllMock.mockResolvedValue([]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const adapter = createSessionAdapter(fakeRuntime as never);
		const result = await adapter.sendMessage("missing-sess", "hello");

		expect(result).toBe(false);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("[session-adapter] sendMessage: session missing-sess not found on disk");

		errorSpy.mockRestore();
	});
});
