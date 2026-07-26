import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	BASE_SYSTEM_PROMPTS,
	DEFAULT_SYSTEM_PROMPT,
	loadSystemPrompt,
	readSystemPromptOverride,
	SYSTEM_PROMPT_OVERRIDE_PATH,
	substitutePromptVariables,
} from "../src/workspace/prompt-loader.js";

describe("workspace prompt loader (F-3.6)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-prompt-loader-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	function makeWorkspace(name: string): string {
		const dir = join(workDir, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function makeCodeWorkspace(name: string): string {
		const dir = makeWorkspace(name);
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, "src"));
		return dir;
	}

	function writeOverride(dir: string, content: string): void {
		mkdirSync(join(dir, ".fan", "prompts"), { recursive: true });
		writeFileSync(join(dir, SYSTEM_PROMPT_OVERRIDE_PATH), content, "utf-8");
	}

	describe("TC-F-3.6-1: default prompt for a known type", () => {
		test("code workspace without override → code template with {workspace_path} substituted", () => {
			const dir = makeCodeWorkspace("myproj");

			const prompt = loadSystemPrompt(dir);

			const workspacePath = dir.replace(/\\/g, "/");
			expect(prompt).toBe(
				BASE_SYSTEM_PROMPTS.code
					.replaceAll("{workspace_path}", workspacePath)
					.replaceAll("{project_name}", "myproj"),
			);
			expect(prompt).toContain("coding assistant");
			expect(prompt).toContain(workspacePath);
			expect(prompt).not.toContain("{workspace_path}");
			expect(prompt).not.toContain("{project_name}");
		});

		test("research workspace without override → research template mentioning docs/research/", () => {
			const dir = makeWorkspace("lab");
			mkdirSync(join(dir, "docs", "research"), { recursive: true });

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toContain("research assistant");
			expect(prompt).toContain("docs/research/");
		});

		test("automation workspace without override → automation template mentioning scripts/", () => {
			const dir = makeWorkspace("hub");
			mkdirSync(join(dir, "scripts"));
			mkdirSync(join(dir, "config"));
			writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\n", "utf-8");

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toContain("automation assistant");
			expect(prompt).toContain("/scripts/");
		});
	});

	describe("TC-F-3.6-2: custom override replaces the template", () => {
		test("existing .fan/prompts/system.md → custom content, not the template", () => {
			const dir = makeCodeWorkspace("custom");
			writeOverride(dir, "You are a pirate assistant. Arr.\n");

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toContain("You are a pirate assistant. Arr.");
			expect(prompt).not.toContain("coding assistant");
		});

		test("variables are substituted in the custom override too", () => {
			const dir = makeCodeWorkspace("vars");
			writeOverride(dir, "Workspace: {workspace_path}\nProject: {project_name}");

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toBe(`Workspace: ${dir.replace(/\\/g, "/")}\nProject: vars`);
		});

		test("override wins even for research workspaces", () => {
			const dir = makeWorkspace("research-override");
			mkdirSync(join(dir, "docs", "research"), { recursive: true });
			writeOverride(dir, "Custom research persona.");

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toContain("Custom research persona.");
			expect(prompt).not.toContain("research assistant");
		});
	});

	describe("fallbacks and edge cases", () => {
		test("unknown type → generic default prompt", () => {
			const dir = makeWorkspace("empty");

			const prompt = loadSystemPrompt(dir);

			expect(prompt).toBe(
				DEFAULT_SYSTEM_PROMPT.replaceAll("{workspace_path}", dir.replace(/\\/g, "/")).replaceAll(
					"{project_name}",
					"empty",
				),
			);
			expect(prompt).toContain("general-purpose assistant");
		});

		test("empty override file = no override → type template is used", () => {
			const dir = makeCodeWorkspace("empty-override");
			writeOverride(dir, "");

			expect(loadSystemPrompt(dir)).toContain("coding assistant");
		});

		test("whitespace-only override file = no override → type template is used", () => {
			const dir = makeCodeWorkspace("ws-override");
			writeOverride(dir, "   \n\t\n  ");

			expect(loadSystemPrompt(dir)).toContain("coding assistant");
		});

		test("explicit type option skips auto-detection", () => {
			const dir = makeWorkspace("forced");

			const prompt = loadSystemPrompt(dir, { type: "automation" });

			expect(prompt).toContain("automation assistant");
		});

		test("unreadable/missing cwd never throws → default prompt", () => {
			const prompt = loadSystemPrompt(join(workDir, "does-not-exist"));

			expect(prompt).toContain("general-purpose assistant");
		});
	});

	describe("helper functions", () => {
		test("substitutePromptVariables replaces both variables and normalizes backslashes", () => {
			const result = substitutePromptVariables("{workspace_path} :: {project_name}", join(workDir, "proj"));

			expect(result).toBe(`${join(workDir, "proj").replace(/\\/g, "/")} :: proj`);
		});

		test("substitutePromptVariables leaves unknown variables untouched", () => {
			expect(substitutePromptVariables("{other}", workDir)).toBe("{other}");
		});

		test("readSystemPromptOverride returns raw content for non-empty files", () => {
			const dir = makeWorkspace("raw");
			writeOverride(dir, "  content with padding  \n");

			expect(readSystemPromptOverride(dir)).toBe("  content with padding  \n");
		});

		test("readSystemPromptOverride returns undefined when the file is missing", () => {
			expect(readSystemPromptOverride(makeWorkspace("none"))).toBeUndefined();
		});
	});
});
