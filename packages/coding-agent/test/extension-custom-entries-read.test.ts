/**
 * F-48 Red-phase tests: core read-API for custom entries.
 *
 * CONTRACT (drives Green-phase implementation):
 *
 * A new read-API is added to the extension surface so that extensions can
 * READ BACK the custom entries they (or others) appended to the current
 * session — currently only `fan.appendEntry` (write) exists, with no read
 * counterpart.
 *
 *   fan.getCustomEntries<T = unknown>(customType?: string):
 *     Array<{ customType: string; data: T; timestamp?: string }>
 *
 *   - Returns custom entries of the current session, in insertion order.
 *   - When `customType` is provided, returns only entries with that customType.
 *   - Returns `[]` when no custom entries match (never throws).
 *   - Each item carries `customType`, `data`, and `timestamp`.
 *
 * Implementation surface:
 *   1. SessionManager.getCustomEntries(customType?) — the core data method
 *      (SessionManager is the single source of truth; it already owns
 *      appendCustomEntry + getEntries).
 *   2. ExtensionAPI.getCustomEntries — delegates to the runtime, wired by
 *      ExtensionRunner.bindCore (mirrors appendEntry).
 *
 * This file tests BOTH layers. Both are RED until the API exists.
 */
import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionAPI, createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { Extension } from "../src/core/extensions/types.js";
import { SessionManager } from "../src/core/session-manager.js";

type CustomEntryView = { customType: string; data: unknown; timestamp?: string };

// ---------------------------------------------------------------------------
// Layer 1: SessionManager.getCustomEntries (core data method)
// ---------------------------------------------------------------------------

describe("SessionManager.getCustomEntries", () => {
	it("returns custom entries in insertion order", () => {
		const s = SessionManager.inMemory();
		s.appendMessage({ role: "user", content: "hi", timestamp: 1 }); // non-custom, must be excluded
		s.appendCustomEntry("orchestrator-task-snapshot", { a: 1 });
		s.appendCustomEntry("dashboard-state", { b: 2 });
		s.appendCustomEntry("orchestrator-task-snapshot", { c: 3 });

		const customs = s.getCustomEntries();
		expect(customs).toHaveLength(3);
		expect(customs[0].customType).toBe("orchestrator-task-snapshot");
		expect(customs[0].data).toEqual({ a: 1 });
		expect(customs[1].customType).toBe("dashboard-state");
		expect(customs[1].data).toEqual({ b: 2 });
		expect(customs[2].customType).toBe("orchestrator-task-snapshot");
		expect(customs[2].data).toEqual({ c: 3 });
	});

	it("filters by customType and preserves insertion order", () => {
		const s = SessionManager.inMemory();
		s.appendCustomEntry("orchestrator-task-snapshot", { a: 1 });
		s.appendCustomEntry("dashboard-state", { b: 2 });
		s.appendCustomEntry("orchestrator-task-snapshot", { c: 3 });

		const snaps = s.getCustomEntries("orchestrator-task-snapshot");
		expect(snaps).toHaveLength(2);
		expect(snaps.every((e) => e.customType === "orchestrator-task-snapshot")).toBe(true);
		expect(snaps[0].data).toEqual({ a: 1 });
		expect(snaps[1].data).toEqual({ c: 3 });
	});

	it("returns [] when there are no custom entries at all", () => {
		const s = SessionManager.inMemory();
		s.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		expect(s.getCustomEntries()).toEqual([]);
	});

	it("returns [] when no custom entries match the filter", () => {
		const s = SessionManager.inMemory();
		s.appendCustomEntry("dashboard-state", { b: 2 });
		expect(s.getCustomEntries("orchestrator-task-snapshot")).toEqual([]);
	});

	it("includes timestamp on each returned entry", () => {
		const s = SessionManager.inMemory();
		s.appendCustomEntry("orchestrator-task-snapshot", { a: 1 });
		const [entry] = s.getCustomEntries("orchestrator-task-snapshot");
		expect(entry.timestamp).toBeTypeOf("string");
	});
});

// ---------------------------------------------------------------------------
// Layer 2: ExtensionAPI.getCustomEntries (fan read-API) delegates to the
// session via the runtime, the same way fan.appendEntry does.
// ---------------------------------------------------------------------------

/** Builds a minimal extension skeleton + its ExtensionAPI, wiring the runtime
 *  actions to a REAL SessionManager (mirrors what ExtensionRunner.bindCore
 *  does in production). */
function buildApiWithSession(session: SessionManager) {
	const runtime = createExtensionRuntime() as ReturnType<typeof createExtensionRuntime> & {
		getCustomEntries: (customType?: string) => CustomEntryView[];
	};
	// Wire write+read actions to the real session (simulates bindCore).
	runtime.appendEntry = (customType: string, data?: unknown) => session.appendCustomEntry(customType, data);
	runtime.getCustomEntries = (customType?: string) => session.getCustomEntries(customType);

	const eventBus = createEventBus();
	const extension: Extension = {
		path: "/virtual/ext.ts",
		resolvedPath: "/virtual/ext.ts",
		sourceInfo: {
			path: "/virtual/ext.ts",
			source: "test-ext",
			scope: "temporary" as const,
			origin: "top-level" as const,
		},
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		messageRenderers: new Map(),
	};

	const api = createExtensionAPI(extension, runtime, "/virtual", eventBus);
	// getCustomEntries is the new read-API (F-48); cast to access it pre-declaration.
	return api as typeof api & {
		getCustomEntries: (customType?: string) => CustomEntryView[];
	};
}

describe("ExtensionAPI.getCustomEntries (fan read-API)", () => {
	it("exposes getCustomEntries as a function on the fan API", () => {
		const api = buildApiWithSession(SessionManager.inMemory());
		expect(typeof api.getCustomEntries).toBe("function");
	});

	it("returns all custom entries through the fan API in insertion order", () => {
		const session = SessionManager.inMemory();
		const api = buildApiWithSession(session);

		api.appendEntry("orchestrator-task-snapshot", { a: 1 });
		api.appendEntry("dashboard-state", { b: 2 });
		api.appendEntry("orchestrator-task-snapshot", { c: 3 });

		const all = api.getCustomEntries();
		expect(all).toHaveLength(3);
		expect(all[0].data).toEqual({ a: 1 });
		expect(all[1].customType).toBe("dashboard-state");
		expect(all[2].data).toEqual({ c: 3 });
	});

	it("filters by customType through the fan API", () => {
		const session = SessionManager.inMemory();
		const api = buildApiWithSession(session);

		api.appendEntry("orchestrator-task-snapshot", { a: 1 });
		api.appendEntry("dashboard-state", { b: 2 });
		api.appendEntry("orchestrator-task-snapshot", { c: 3 });

		const snaps = api.getCustomEntries("orchestrator-task-snapshot");
		expect(snaps).toHaveLength(2);
		expect(snaps[0].data).toEqual({ a: 1 });
		expect(snaps[1].data).toEqual({ c: 3 });
		expect(snaps.every((e) => e.customType === "orchestrator-task-snapshot")).toBe(true);
	});

	it("returns [] through the fan API when nothing matches", () => {
		const session = SessionManager.inMemory();
		const api = buildApiWithSession(session);

		api.appendEntry("dashboard-state", { b: 2 });
		expect(api.getCustomEntries()).toHaveLength(1);
		expect(api.getCustomEntries("orchestrator-task-snapshot")).toEqual([]);
	});
});
