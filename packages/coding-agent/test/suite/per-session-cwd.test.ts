import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function writeProjectSettings(workspaceDir: string, settings: Record<string, unknown>): void {
	const configDir = join(workspaceDir, ".fan");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "settings.json"), JSON.stringify(settings));
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

describe("F-1.10: per-session cwd services", () => {
	const cleanupPaths: Array<string | (() => Promise<void>)> = [];

	afterEach(async () => {
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

	it("TC-F-1.10-1: services load settings and resources from the workspace cwd, not globally", async () => {
		const agentDir = createTempDir("fan-f110-agent-dir");
		const workspace = createTempDir("fan-f110-workspace");
		cleanupPaths.push(agentDir, workspace);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultModel: "global-model", defaultProvider: "global-provider" }),
		);
		writeProjectSettings(workspace, { defaultModel: "model-a" });
		writeFileSync(join(workspace, "AGENTS.md"), "workspace A context");

		const services = await createAgentSessionServices({
			cwd: workspace,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(services.cwd).toBe(workspace);

		// SettingsManager: project settings come from <cwd>/.fan/settings.json
		// and override the global <agentDir>/settings.json values.
		expect(services.settingsManager.getDefaultModel()).toBe("model-a");
		expect(services.settingsManager.getProjectSettings().defaultModel).toBe("model-a");
		// Global scope itself is untouched by the project value.
		expect(services.settingsManager.getGlobalSettings().defaultModel).toBe("global-model");
		// Project settings do not redefine values that only exist globally.
		expect(services.settingsManager.getDefaultProvider()).toBe("global-provider");

		// ResourceLoader: project context files discovered from the workspace cwd.
		const agentsFiles = services.resourceLoader.getAgentsFiles().agentsFiles;
		expect(agentsFiles.some((file) => file.path === join(workspace, "AGENTS.md"))).toBe(true);
	});

	it("TC-F-1.10-2: switchSession recreates services for the target cwd without touching process.cwd()", async () => {
		const agentDir = createTempDir("fan-f110-agent-dir2");
		const workspaceA = createTempDir("fan-f110-workspace-a");
		const workspaceB = createTempDir("fan-f110-workspace-b");
		const sessionDirA = createTempDir("fan-f110-session-dir-a");
		const sessionDirB = createTempDir("fan-f110-session-dir-b");
		cleanupPaths.push(agentDir, workspaceA, workspaceB, sessionDirA, sessionDirB);

		writeProjectSettings(workspaceA, { defaultModel: "model-a" });
		writeProjectSettings(workspaceB, { defaultModel: "model-b" });
		writeFileSync(join(workspaceB, "AGENTS.md"), "workspace B context");

		// Persisted session for project B (header records the session cwd).
		const sessionFileB = join(sessionDirB, "session-b.jsonl");
		writeSessionFile(sessionFileB, workspaceB);

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

		// F-5.4: the runtime never mutates the global process cwd.
		const initialProcessCwd = process.cwd();

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspaceA,
			agentDir,
			sessionManager: SessionManager.create(workspaceA, sessionDirA),
		});
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		// Initial state: runtime lives in project A, global cwd untouched.
		expect(process.cwd()).toBe(initialProcessCwd);
		expect(runtime.services.cwd).toBe(workspaceA);
		expect(runtime.services.settingsManager.getDefaultModel()).toBe("model-a");
		const servicesA = runtime.services;

		const result = await runtime.switchSession(sessionFileB);
		expect(result.cancelled).toBe(false);

		// F-5.4: process.cwd() is NOT changed on switch...
		expect(process.cwd()).toBe(initialProcessCwd);
		// ...services are recreated bound to the session cwd, not the process.
		expect(runtime.services).not.toBe(servicesA);
		expect(runtime.services.cwd).toBe(workspaceB);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceB);

		// SettingsManager now reads <workspaceB>/.fan/settings.json.
		expect(runtime.services.settingsManager.getDefaultModel()).toBe("model-b");
		expect(runtime.services.settingsManager.getProjectSettings().defaultModel).toBe("model-b");

		// ResourceLoader discovers project resources for workspace B.
		const agentsFiles = runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
		expect(agentsFiles.some((file) => file.path === join(workspaceB, "AGENTS.md"))).toBe(true);
	});

	it("TC-F-1.10-2b: newSession({ cwd }) also recreates services bound to the target cwd", async () => {
		const agentDir = createTempDir("fan-f110-agent-dir3");
		const workspaceA = createTempDir("fan-f110-workspace-a3");
		const workspaceB = createTempDir("fan-f110-workspace-b3");
		cleanupPaths.push(agentDir, workspaceA, workspaceB);

		writeProjectSettings(workspaceA, { defaultModel: "model-a" });
		writeProjectSettings(workspaceB, { defaultModel: "model-b" });

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

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspaceA,
			agentDir,
			sessionManager: SessionManager.create(workspaceA, createTempDir("fan-f110-session-dir-a3")),
		});
		cleanupPaths.push(async () => {
			await runtime.dispose();
		});

		expect(runtime.services.settingsManager.getDefaultModel()).toBe("model-a");

		const result = await runtime.newSession({ cwd: workspaceB });
		expect(result.cancelled).toBe(false);

		// F-5.4: the session cwd moves to workspace B, the global process cwd
		// does not.
		expect(runtime.services.cwd).toBe(workspaceB);
		expect(runtime.session.sessionManager.getCwd()).toBe(workspaceB);
		expect(runtime.services.settingsManager.getDefaultModel()).toBe("model-b");
	});
});
