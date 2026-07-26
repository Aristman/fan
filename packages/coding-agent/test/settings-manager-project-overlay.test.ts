import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager project overlay (F-2.9)", () => {
	const testDir = join(process.cwd(), "test-settings-overlay-tmp");
	const agentDir = join(testDir, "agent");
	const projectA = join(testDir, "project-a");
	const projectB = join(testDir, "project-b");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectA, ".fan"), { recursive: true });
		mkdirSync(join(projectB, ".fan"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("TC-F-2.9-1: loads project settings from <cwd>/.fan/settings.json", () => {
		writeFileSync(join(projectA, ".fan", "settings.json"), JSON.stringify({ model: "gpt-4" }));

		const settings = SettingsManager.loadProjectSettings(projectA) as Record<string, unknown>;

		expect(settings.model).toBe("gpt-4");
	});

	it("TC-F-2.9-2: missing file returns {} without throwing", () => {
		const missingDir = join(testDir, "missing");

		let result: unknown;
		expect(() => {
			result = SettingsManager.loadProjectSettings(missingDir);
		}).not.toThrow();
		expect(result).toEqual({});
	});

	it("loadProjectSettings returns {} for invalid JSON without throwing", () => {
		writeFileSync(join(projectA, ".fan", "settings.json"), "{ not valid json");

		expect(SettingsManager.loadProjectSettings(projectA)).toEqual({});
	});

	it("project file settings take priority over global at creation (F-1.10 behavior)", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "global-model", theme: "dark" }));
		writeFileSync(join(projectA, ".fan", "settings.json"), JSON.stringify({ defaultModel: "project-model" }));

		const manager = SettingsManager.create(projectA, agentDir);

		expect(manager.getDefaultModel()).toBe("project-model");
		expect(manager.getTheme()).toBe("dark");
	});

	it("applyOverlay merges project settings over global (project > global)", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "global-model", theme: "dark" }));
		writeFileSync(join(projectB, ".fan", "settings.json"), JSON.stringify({ defaultModel: "gpt-4" }));
		const manager = SettingsManager.create(projectA, agentDir);
		expect(manager.getDefaultModel()).toBe("global-model");

		manager.applyOverlay(SettingsManager.loadProjectSettings(projectB));

		expect(manager.getDefaultModel()).toBe("gpt-4");
		expect(manager.getTheme()).toBe("dark"); // global keys not overridden are preserved
	});

	it("applyOverlay deep-merges nested objects with project priority", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 1000 } }));
		const manager = SettingsManager.create(projectA, agentDir);

		manager.applyOverlay({ compaction: { keepRecentTokens: 500 } });

		const compaction = manager.getCompactionSettings();
		expect(compaction.reserveTokens).toBe(1000); // from global
		expect(compaction.keepRecentTokens).toBe(500); // from overlay
	});

	it("applyOverlay replaces a previous overlay (project switch A -> B)", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		writeFileSync(join(projectA, ".fan", "settings.json"), JSON.stringify({ defaultModel: "model-a" }));
		writeFileSync(join(projectB, ".fan", "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
		const manager = SettingsManager.create(projectA, agentDir);
		expect(manager.getDefaultModel()).toBe("model-a");

		manager.applyOverlay(SettingsManager.loadProjectSettings(projectB));

		// project B layer fully replaces project A layer
		expect(manager.getDefaultModel()).toBeUndefined();
		expect(manager.getDefaultThinkingLevel()).toBe("high");
		expect(manager.getTheme()).toBe("dark");
	});

	it("resetToGlobal restores global settings", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "global-model" }));
		const manager = SettingsManager.create(projectA, agentDir);
		manager.applyOverlay({ defaultModel: "gpt-4" });
		expect(manager.getDefaultModel()).toBe("gpt-4");

		manager.resetToGlobal();

		expect(manager.getDefaultModel()).toBe("global-model");
		expect(manager.getEffectiveSettings()).toEqual({ defaultModel: "global-model" });
	});

	it("overlay is runtime-only: project-scope writes are not persisted while overlay is active", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
		const manager = SettingsManager.create(projectA, agentDir);
		manager.applyOverlay({ defaultModel: "gpt-4" });

		manager.setProjectSkillPaths(["./skills"]);
		await manager.flush();

		expect(existsSync(join(projectA, ".fan", "settings.json"))).toBe(false);
	});
});
