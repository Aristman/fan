/**
 * Tests for ExtensionAPI.newSession() (ralph-loop mission mode, S1).
 *
 * - Fresh runtime without a host binding: fail-safe refusal { cancelled: true }.
 * - After runner.bindCommandContext(): opts and result pass through to the
 *   host's newSession handler.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionAPI, createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionCommandContextActions,
	ExtensionRuntime,
} from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

function buildTestApi(runtime: ExtensionRuntime): ExtensionAPI {
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
	return createExtensionAPI(extension, runtime, "/virtual", createEventBus());
}

describe("ExtensionAPI.newSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-newsession-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("fail-safe: fresh runtime without host binding refuses with { cancelled: true }", async () => {
		const runtime = createExtensionRuntime();
		const api = buildTestApi(runtime);

		await expect(api.newSession()).resolves.toEqual({ cancelled: true });
		await expect(api.newSession({ parentSession: "/tmp/parent.jsonl" })).resolves.toEqual({ cancelled: true });
	});

	it("after bindCommandContext: forwards opts and result to the host handler", async () => {
		const runtime = createExtensionRuntime();
		const api = buildTestApi(runtime);

		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runner = new ExtensionRunner([], runtime, "/virtual", sessionManager, modelRegistry);

		const newSessionHandler = vi.fn(async () => ({ cancelled: false }));
		const commandActions: ExtensionCommandContextActions = {
			waitForIdle: async () => {},
			newSession: newSessionHandler,
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		};
		runner.bindCommandContext(commandActions);

		const opts = { parentSession: "/tmp/parent.jsonl" };
		await expect(api.newSession(opts)).resolves.toEqual({ cancelled: false });
		expect(newSessionHandler).toHaveBeenCalledTimes(1);
		expect(newSessionHandler).toHaveBeenCalledWith(opts);
	});

	it("after bindCommandContext: propagates host cancellation", async () => {
		const runtime = createExtensionRuntime();
		const api = buildTestApi(runtime);

		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runner = new ExtensionRunner([], runtime, "/virtual", sessionManager, modelRegistry);

		runner.bindCommandContext({
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		});

		await expect(api.newSession()).resolves.toEqual({ cancelled: true });
	});
});
