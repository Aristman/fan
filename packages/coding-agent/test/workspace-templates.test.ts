import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyTemplate, getTemplate, listTemplates } from "../src/workspace/templates/apply-template.js";
import { codeProjectTemplate } from "../src/workspace/templates/code-project.js";

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
