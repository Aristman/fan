/**
 * Tests for resolveEnvVars (F-1.11).
 */

import { describe, expect, it } from "vitest";
import { MissingEnvVarError, resolveEnvVars } from "../src/config.js";

describe("F-1.11: resolveEnvVars", () => {
	it("resolves a single placeholder", () => {
		expect(resolveEnvVars("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
	});

	it("resolves multiple placeholders", () => {
		expect(resolveEnvVars("https://${HOST}:${PORT}/api", { HOST: "example.com", PORT: "8080" })).toBe(
			"https://example.com:8080/api",
		);
	});

	it("returns the string unchanged when there are no placeholders", () => {
		expect(resolveEnvVars("plain value", {})).toBe("plain value");
	});

	it("throws MissingEnvVarError on missing variable", () => {
		expect(() => resolveEnvVars("Bearer ${GITHUB_TOKEN}", {})).toThrow(MissingEnvVarError);
		expect(() => resolveEnvVars("Bearer ${GITHUB_TOKEN}", {})).toThrow(/GITHUB_TOKEN/);
	});

	it("does not match placeholder-like text inside larger identifiers", () => {
		// ${lowercase} should not match — only uppercase + underscore
		expect(resolveEnvVars("${lowercase}", { lowercase: "x" })).toBe("${lowercase}");
	});

	it("throws when the missing variable is among several", () => {
		expect(() => resolveEnvVars("${A}/${B}/${C}", { A: "1", C: "3" })).toThrow(MissingEnvVarError);
	});
});
