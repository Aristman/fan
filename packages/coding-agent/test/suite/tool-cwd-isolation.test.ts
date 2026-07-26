/**
 * F-5.3: per-session cwd in tool definitions.
 *
 * Verifies that tools created via the cwd-bound factories resolve paths and
 * execute against the captured session cwd — never process.cwd() — and that
 * two sessions with different cwds are fully isolated.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@seaagents/fan-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createAllTools, createReadTool } from "../../src/core/tools/index.js";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

describe("F-5.3: per-session cwd in tool definitions", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("TC-F-5.3-1: tools resolve relative paths against the session cwd, not process.cwd()", async () => {
		const workspace = createTempDir("fan-f53-t1-workspace");
		cleanupPaths.push(workspace);

		writeFileSync(join(workspace, "tc-f531-marker.txt"), "content-from-session-cwd");
		mkdirSync(join(workspace, "nested"), { recursive: true });
		writeFileSync(join(workspace, "nested", "deep.txt"), "nested-content");

		// The marker file does not exist relative to the test process cwd, so a
		// successful read proves resolution against the captured session cwd.
		expect(existsSync(join(process.cwd(), "tc-f531-marker.txt"))).toBe(false);

		const readTool = createReadTool(workspace);

		const rootRead = await readTool.execute("call-1", { path: "tc-f531-marker.txt" });
		expect(textOf(rootRead)).toContain("content-from-session-cwd");

		const nestedRead = await readTool.execute("call-2", { path: "nested/deep.txt" });
		expect(textOf(nestedRead)).toContain("nested-content");
	});

	it("TC-F-5.3-2: process.cwd() is never called inside tool execution", async () => {
		const workspace = createTempDir("fan-f53-t2-workspace");
		cleanupPaths.push(workspace);

		writeFileSync(join(workspace, "seed.txt"), "hello f-5.3 world");

		const tools = createAllTools(workspace);

		const spy = vi.spyOn(process, "cwd");
		try {
			await tools.read.execute("call-read", { path: "seed.txt" });
			await tools.write.execute("call-write", { path: "written.txt", content: "written by tool" });
			await tools.edit.execute("call-edit", {
				path: "seed.txt",
				edits: [{ oldText: "world", newText: "fan" }],
			});
			await tools.ls.execute("call-ls", {});
			await tools.grep.execute("call-grep", { pattern: "f-5.3" });
			await tools.find.execute("call-find", { pattern: "*.txt" });
			const bashResult = await tools.bash.execute("call-bash", { command: "echo bash-ok" });

			expect(textOf(bashResult)).toContain("bash-ok");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}

		// Sanity: the write/edit actually happened in the session cwd.
		expect(readFileSync(join(workspace, "written.txt"), "utf-8")).toBe("written by tool");
		expect(readFileSync(join(workspace, "seed.txt"), "utf-8")).toBe("hello f-5.3 fan");
	});

	it("TC-F-5.3-3: two sessions with different cwds execute tools concurrently without cross-contamination", async () => {
		const workspaceA = createTempDir("fan-f53-t3-workspace-a");
		const workspaceB = createTempDir("fan-f53-t3-workspace-b");
		const agentDir = createTempDir("fan-f53-t3-agent-dir");
		cleanupPaths.push(workspaceA, workspaceB, agentDir);

		// Same relative file name in both workspaces with distinct content.
		writeFileSync(join(workspaceA, "session-marker.txt"), "marker-A");
		writeFileSync(join(workspaceB, "session-marker.txt"), "marker-B");

		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const createSession = async (cwd: string) => {
			const settingsManager = SettingsManager.create(cwd, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			return createAgentSession({
				cwd,
				agentDir,
				model,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				resourceLoader,
			});
		};

		const { session: sessionA } = await createSession(workspaceA);
		const { session: sessionB } = await createSession(workspaceB);
		try {
			// Concurrent session-level bash execution (AgentSession.executeBash path).
			const [bashA, bashB] = await Promise.all([
				sessionA.executeBash("cat session-marker.txt"),
				sessionB.executeBash("cat session-marker.txt"),
			]);
			expect(bashA.output).toContain("marker-A");
			expect(bashA.output).not.toContain("marker-B");
			expect(bashB.output).toContain("marker-B");
			expect(bashB.output).not.toContain("marker-A");
		} finally {
			sessionA.dispose();
			sessionB.dispose();
		}

		// Concurrent tool-level execution with tools bound to each session cwd
		// (the same createAllTools(cwd) factories AgentSession uses internally).
		const toolsA = createAllTools(workspaceA);
		const toolsB = createAllTools(workspaceB);

		await Promise.all([
			toolsA.write.execute("call-wa", { path: "out.txt", content: "written-by-A" }),
			toolsB.write.execute("call-wb", { path: "out.txt", content: "written-by-B" }),
		]);

		const [readA, readB] = await Promise.all([
			toolsA.read.execute("call-ra", { path: "out.txt" }),
			toolsB.read.execute("call-rb", { path: "out.txt" }),
		]);

		expect(textOf(readA)).toContain("written-by-A");
		expect(textOf(readA)).not.toContain("written-by-B");
		expect(textOf(readB)).toContain("written-by-B");
		expect(textOf(readB)).not.toContain("written-by-A");

		// On-disk truth: each workspace contains only its own output.
		expect(readFileSync(join(workspaceA, "out.txt"), "utf-8")).toBe("written-by-A");
		expect(readFileSync(join(workspaceB, "out.txt"), "utf-8")).toBe("written-by-B");
	});
});
