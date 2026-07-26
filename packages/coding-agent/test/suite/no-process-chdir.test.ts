import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { SessionManager } from "../../src/core/session-manager.js";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("F-5.4: runtime never calls process.chdir()", () => {
	const cleanupPaths: Array<string | (() => Promise<void>)> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const entry of cleanupPaths.splice(0)) {
			if (typeof entry === "string") {
				rmSync(entry, { recursive: true, force: true });
			} else {
				await entry();
			}
		}
	});

	function createRuntimeFactory(agentDir: string): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage: AuthStorage.inMemory(),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	function spyOnChdir() {
		// Neutralize the real mutation as well: a regression must fail the
		// assertion below, not silently move the test process into a temp dir.
		return vi.spyOn(process, "chdir").mockImplementation(() => {});
	}

	it("TC-F-5.4-1: createAgentSessionRuntime / switchSession / newSession never call process.chdir", async () => {
		const agentDir = createTempDir("fan-f54-agent-dir");
		const workspaceA = createTempDir("fan-f54-workspace-a1");
		const workspaceB = createTempDir("fan-f54-workspace-b1");
		const sessionDirB = createTempDir("fan-f54-session-dir-b1");
		cleanupPaths.push(agentDir, workspaceA, workspaceB, sessionDirB);

		const sessionFileB = join(sessionDirB, "session-b.jsonl");
		writeSessionFile(sessionFileB, workspaceB);

		const chdirSpy = spyOnChdir();

		const runtime = await createAgentSessionRuntime(createRuntimeFactory(agentDir), {
			cwd: workspaceA,
			agentDir,
			sessionManager: SessionManager.create(workspaceA, createTempDir("fan-f54-session-dir-a1")),
		});
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		await runtime.switchSession(sessionFileB);
		expect(runtime.services.cwd).toBe(workspaceB);

		await runtime.newSession({ cwd: workspaceA });
		expect(runtime.services.cwd).toBe(workspaceA);

		expect(chdirSpy).not.toHaveBeenCalled();
	});

	it("TC-F-5.4-2: switch A→B→A keeps each session on its own cwd and the global cwd unchanged", async () => {
		const agentDir = createTempDir("fan-f54-agent-dir2");
		const workspaceA = createTempDir("fan-f54-workspace-a2");
		const workspaceB = createTempDir("fan-f54-workspace-b2");
		const sessionDirA = createTempDir("fan-f54-session-dir-a2");
		const sessionDirB = createTempDir("fan-f54-session-dir-b2");
		cleanupPaths.push(agentDir, workspaceA, workspaceB, sessionDirA, sessionDirB);

		const sessionFileA = join(sessionDirA, "session-a.jsonl");
		const sessionFileB = join(sessionDirB, "session-b.jsonl");
		writeSessionFile(sessionFileA, workspaceA);
		writeSessionFile(sessionFileB, workspaceB);

		const initialProcessCwd = process.cwd();
		const chdirSpy = spyOnChdir();

		const runtime = await createAgentSessionRuntime(createRuntimeFactory(agentDir), {
			cwd: workspaceA,
			agentDir,
			sessionManager: SessionManager.create(workspaceA, sessionDirA),
		});
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});
		expect(runtime.services.cwd).toBe(workspaceA);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceA);

		// A → B
		await runtime.switchSession(sessionFileB);
		expect(runtime.services.cwd).toBe(workspaceB);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceB);
		expect(process.cwd()).toBe(initialProcessCwd);

		// B → A
		await runtime.switchSession(sessionFileA);
		expect(runtime.services.cwd).toBe(workspaceA);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceA);
		expect(process.cwd()).toBe(initialProcessCwd);

		expect(chdirSpy).not.toHaveBeenCalled();
	});

	it("TC-F-5.4-3: the previous session is torn down before the new context is created", async () => {
		const agentDir = createTempDir("fan-f54-agent-dir3");
		const workspaceA = createTempDir("fan-f54-workspace-a3");
		const workspaceB = createTempDir("fan-f54-workspace-b3");
		const sessionDirB = createTempDir("fan-f54-session-dir-b3");
		cleanupPaths.push(agentDir, workspaceA, workspaceB, sessionDirB);

		const sessionFileB = join(sessionDirB, "session-b.jsonl");
		writeSessionFile(sessionFileB, workspaceB);

		let disposeCalledBeforeCreate: boolean | undefined;
		let oldSession: { dispose(): void } | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (oldSession) {
				// The factory only runs for a replacement; by then the old session
				// must already be disposed (teardown-before-create ordering).
				disposeCalledBeforeCreate = disposeSpy.mock.calls.length > 0;
			}
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage: AuthStorage.inMemory(),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspaceA,
			agentDir,
			sessionManager: SessionManager.create(workspaceA, createTempDir("fan-f54-session-dir-a3")),
		});
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		const previousSession = runtime.session;
		const previousServices = runtime.services;
		const disposeSpy = vi.spyOn(previousSession, "dispose");
		oldSession = previousSession;

		await runtime.switchSession(sessionFileB);

		// Old context released: session disposed, services object replaced.
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(disposeCalledBeforeCreate).toBe(true);
		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.services).not.toBe(previousServices);
	});
});
