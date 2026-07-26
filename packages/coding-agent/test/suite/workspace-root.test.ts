import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRoot } from "../../src/cli/server-config.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createSessionAdapter } from "../../src/main.js";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("F-1.11: server workspace root wiring", () => {
	const cleanupPaths: Array<string | (() => Promise<void>)> = [];
	const originalRoot = process.env.FAN_WORKSPACE_ROOT;

	afterEach(async () => {
		if (originalRoot === undefined) {
			delete process.env.FAN_WORKSPACE_ROOT;
		} else {
			process.env.FAN_WORKSPACE_ROOT = originalRoot;
		}
		// Leave temp dirs before deleting them (Windows file locking) and keep
		// the process in a stable directory for the next test.
		process.chdir(tmpdir());
		for (const entry of cleanupPaths.splice(0)) {
			if (typeof entry === "string") {
				rmSync(entry, { recursive: true, force: true });
			} else {
				await entry();
			}
		}
	});

	async function createRuntimeIn(cwd: string, agentDir: string) {
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
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
		return createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, createTempDir("fan-f111-session-dir")),
		});
	}

	it("TC-F-1.11-2 (wiring): session without cwd lands in FAN_WORKSPACE_ROOT", async () => {
		const agentDir = createTempDir("fan-f111-agent-dir");
		const workspaceRoot = createTempDir("fan-f111-workspace-root");
		cleanupPaths.push(agentDir, workspaceRoot);

		// Server startup: env overrides the default; the adapter receives the
		// resolved workspace root as its fallback cwd.
		process.env.FAN_WORKSPACE_ROOT = workspaceRoot;
		const defaultCwd = resolveWorkspaceRoot();
		expect(defaultCwd).toBe(workspaceRoot);

		const runtime = await createRuntimeIn(defaultCwd, agentDir);
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		const adapter = createSessionAdapter(runtime, defaultCwd);
		const created = await adapter.createSession({});
		expect(created.cwd).toBe(workspaceRoot);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceRoot);
	});

	it("TC-F-1.11-3 (wiring): explicit cwd in the request beats FAN_WORKSPACE_ROOT", async () => {
		const agentDir = createTempDir("fan-f111-agent-dir3");
		const workspaceRoot = createTempDir("fan-f111-workspace-root3");
		const explicitWorkspace = createTempDir("fan-f111-explicit");
		cleanupPaths.push(agentDir, workspaceRoot, explicitWorkspace);

		process.env.FAN_WORKSPACE_ROOT = workspaceRoot;
		const defaultCwd = resolveWorkspaceRoot();

		const runtime = await createRuntimeIn(defaultCwd, agentDir);
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		const adapter = createSessionAdapter(runtime, defaultCwd);

		// Explicit request cwd wins over the env-configured default.
		const explicit = await adapter.createSession({ cwd: explicitWorkspace });
		expect(explicit.cwd).toBe(explicitWorkspace);
		expect(runtime.session.sessionManager.getCwd()).toBe(explicitWorkspace);

		// ...and the fallback is still the workspace root afterwards — not
		// whatever project the runtime currently has active.
		const fallback = await adapter.createSession({});
		expect(fallback.cwd).toBe(workspaceRoot);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceRoot);
	});
});
