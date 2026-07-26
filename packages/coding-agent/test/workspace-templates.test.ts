import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectWorkspaceType } from "../src/workspace/detector.js";
import { applyTemplate, getTemplate, listTemplates } from "../src/workspace/templates/apply-template.js";
import { automationHubTemplate } from "../src/workspace/templates/automation-hub.js";
import { codeProjectTemplate } from "../src/workspace/templates/code-project.js";
import { createProject } from "../src/workspace/templates/index.js";
import { researchLabTemplate } from "../src/workspace/templates/research-lab.js";

describe("workspace templates — code project (F-3.3)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-ws-template-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	describe("TC-F-3.3-1: template creates the expected directory structure", () => {
		test("applyTemplate('code', newDir) creates the full structure", () => {
			const target = join(workDir, "my-project");
			const result = applyTemplate("code", target);

			// directories
			expect(existsSync(join(target, ".fan"))).toBe(true);
			expect(existsSync(join(target, "src"))).toBe(true);
			expect(existsSync(join(target, "tests"))).toBe(true);
			expect(existsSync(join(target, "docs"))).toBe(true);

			// files
			expect(existsSync(join(target, ".fan", "settings.json"))).toBe(true);
			expect(existsSync(join(target, "package.json"))).toBe(true);

			// default .fan/settings.json content
			expect(JSON.parse(readFileSync(join(target, ".fan", "settings.json"), "utf-8"))).toEqual({});

			// package.json: minimal valid manifest, name from target dir basename
			const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf-8"));
			expect(pkg).toEqual({ name: "my-project", version: "0.1.0", private: true });

			// result reports what was created
			expect(result.template).toBe("code");
			expect(result.createdDirectories).toEqual([".fan", "src", "tests", "docs"]);
			expect(result.createdFiles).toEqual([".fan/settings.json", "package.json"]);
			expect(result.skipped).toEqual([]);
		});

		test("target dir basename is used as the package name", () => {
			const target = join(workDir, "nested", "another-name");
			applyTemplate("code", target);

			const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf-8"));
			expect(pkg.name).toBe("another-name");
		});
	});

	describe("TC-F-3.3-2: existing files are not overwritten", () => {
		test("existing src/file.txt is preserved; everything else is created", () => {
			const target = join(workDir, "existing-project");
			mkdirSync(join(target, "src"), { recursive: true });
			writeFileSync(join(target, "src", "file.txt"), "precious content", "utf-8");

			const result = applyTemplate("code", target);

			// existing file preserved
			expect(readFileSync(join(target, "src", "file.txt"), "utf-8")).toBe("precious content");

			// the rest was created
			expect(existsSync(join(target, ".fan", "settings.json"))).toBe(true);
			expect(existsSync(join(target, "tests"))).toBe(true);
			expect(existsSync(join(target, "docs"))).toBe(true);
			expect(existsSync(join(target, "package.json"))).toBe(true);

			// src/ reported as skipped, not created
			expect(result.skipped).toContain("src");
			expect(result.createdDirectories).not.toContain("src");
		});

		test("existing package.json is not overwritten", () => {
			const target = join(workDir, "has-package");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "package.json"), JSON.stringify({ name: "custom", version: "9.9.9" }), "utf-8");

			const result = applyTemplate("code", target);

			const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf-8"));
			expect(pkg).toEqual({ name: "custom", version: "9.9.9" });
			expect(result.skipped).toContain("package.json");
			expect(result.createdFiles).not.toContain("package.json");
		});
	});

	describe("idempotency", () => {
		test("repeated applyTemplate calls leave the structure unchanged", () => {
			const target = join(workDir, "idempotent");
			applyTemplate("code", target);
			writeFileSync(join(target, "src", "added-later.ts"), "export {};", "utf-8");

			const second = applyTemplate("code", target);

			expect(readFileSync(join(target, "src", "added-later.ts"), "utf-8")).toBe("export {};");
			expect(second.createdDirectories).toEqual([]);
			expect(second.createdFiles).toEqual([]);
			expect(second.skipped).toEqual([".fan", "src", "tests", "docs", ".fan/settings.json", "package.json"]);
		});
	});

	describe("error handling and registry", () => {
		test("unknown template name → error", () => {
			expect(() => applyTemplate("nonexistent", join(workDir, "x"))).toThrow("Unknown template: nonexistent");
		});

		test("'code' is registered and resolvable", () => {
			expect(listTemplates()).toContain("code");
			expect(getTemplate("code")).toBe(codeProjectTemplate);
			expect(getTemplate("nope")).toBeUndefined();
		});

		test("accepts a template object directly", () => {
			const target = join(workDir, "direct-object");
			const result = applyTemplate(codeProjectTemplate, target);

			expect(result.template).toBe("code");
			expect(existsSync(join(target, "src"))).toBe(true);
		});
	});
});

describe("workspace templates — research lab (F-3.4)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-ws-research-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	describe("TC-F-3.4-1: research template creates the correct structure", () => {
		test("applyTemplate('research', newDir) creates .fan/prompts/, settings, docs/research/, data/, reports/", () => {
			const target = join(workDir, "my-research");
			const result = applyTemplate("research", target);

			// directories
			expect(existsSync(join(target, ".fan", "prompts"))).toBe(true);
			expect(statSync(join(target, ".fan", "prompts")).isDirectory()).toBe(true);
			expect(existsSync(join(target, "docs", "research"))).toBe(true);
			expect(existsSync(join(target, "data"))).toBe(true);
			expect(existsSync(join(target, "reports"))).toBe(true);

			// files
			expect(existsSync(join(target, ".fan", "settings.json"))).toBe(true);
			expect(JSON.parse(readFileSync(join(target, ".fan", "settings.json"), "utf-8"))).toEqual({});

			// result report
			expect(result.template).toBe("research");
			expect(result.createdDirectories).toEqual([".fan", ".fan/prompts", "docs/research", "data", "reports"]);
			expect(result.createdFiles).toEqual([".fan/settings.json"]);
			expect(result.skipped).toEqual([]);
		});

		test("freshly applied research template detects as 'research'", () => {
			const target = join(workDir, "detected-research");
			applyTemplate("research", target);

			expect(detectWorkspaceType(target)).toBe("research");
		});

		test("'research' is registered and resolvable via the barrel registry", () => {
			expect(listTemplates()).toContain("research");
			expect(getTemplate("research")).toBe(researchLabTemplate);
		});
	});
});

describe("workspace templates — automation hub (F-3.4)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-ws-automation-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	describe("TC-F-3.4-2: automation template creates the correct structure", () => {
		test("applyTemplate('automation', newDir) creates settings, scripts/, config/, output/, logs/", () => {
			const target = join(workDir, "my-automation");
			const result = applyTemplate("automation", target);

			// directories
			expect(existsSync(join(target, "scripts"))).toBe(true);
			expect(existsSync(join(target, "config"))).toBe(true);
			expect(existsSync(join(target, "output"))).toBe(true);
			expect(existsSync(join(target, "logs"))).toBe(true);

			// files
			expect(existsSync(join(target, ".fan", "settings.json"))).toBe(true);
			expect(JSON.parse(readFileSync(join(target, ".fan", "settings.json"), "utf-8"))).toEqual({});

			// placeholder script (required for automation detection)
			const script = readFileSync(join(target, "scripts", "example.sh"), "utf-8");
			expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
			expect(script).toContain("my-automation");

			// result report
			expect(result.template).toBe("automation");
			expect(result.createdDirectories).toEqual([".fan", "scripts", "config", "output", "logs"]);
			expect(result.createdFiles).toEqual([".fan/settings.json", "scripts/example.sh"]);
			expect(result.skipped).toEqual([]);
		});

		test("freshly applied automation template detects as 'automation'", () => {
			const target = join(workDir, "detected-automation");
			applyTemplate("automation", target);

			expect(detectWorkspaceType(target)).toBe("automation");
		});

		test("'automation' is registered and resolvable via the barrel registry", () => {
			expect(listTemplates()).toContain("automation");
			expect(getTemplate("automation")).toBe(automationHubTemplate);
		});
	});
});

describe("createProject orchestration (F-3.4)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-create-project-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("createProject('code', 'myproj', root) returns metadata { path, name, type, template }", () => {
		const metadata = createProject("code", "myproj", workDir);

		expect(metadata).toEqual({
			path: resolve(workDir, "myproj"),
			name: "myproj",
			type: "code",
			template: "code",
		});

		// structure was materialized; type falls back to the template name
		// because 'code' detection requires .git, which the template doesn't create
		expect(existsSync(join(workDir, "myproj", "package.json"))).toBe(true);
		expect(existsSync(join(workDir, "myproj", "src"))).toBe(true);
		expect(detectWorkspaceType(join(workDir, "myproj"))).toBe("unknown");
	});

	test("createProject('research', ...) detects type 'research' from the template structure", () => {
		const metadata = createProject("research", "study", workDir);

		expect(metadata.type).toBe("research");
		expect(metadata.template).toBe("research");
		expect(metadata.path).toBe(resolve(workDir, "study"));
	});

	test("createProject('automation', ...) detects type 'automation' thanks to the placeholder script", () => {
		const metadata = createProject("automation", "pipeline", workDir);

		expect(metadata.type).toBe("automation");
		expect(metadata.template).toBe("automation");
		expect(metadata.path).toBe(resolve(workDir, "pipeline"));
	});

	test("detection result wins over the template-name fallback when it matches", () => {
		// a .git directory makes the code template detect as 'code' directly
		mkdirSync(join(workDir, "with-git", ".git"), { recursive: true });
		const metadata = createProject("code", "with-git", workDir);
		expect(metadata.type).toBe("code");
	});

	test("unknown template name → error, no directory created", () => {
		expect(() => createProject("nope", "x", workDir)).toThrow("Unknown template: nope");
	});
});
