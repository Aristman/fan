import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPackageDir, getThemesDir } from "../src/config.js";

/**
 * Tests for getPackageDir and asset path resolution.
 *
 * The walk-up algorithm can't be tested with arbitrary __dirname (it's fixed at module load),
 * so we test:
 * 1. The algorithm logic via simulated directory structures
 * 2. FAN_PACKAGE_DIR env override (which IS respected at call time)
 * 3. The real functions in the current dev layout
 */
describe("config — getPackageDir", () => {
	const ORIGINAL_FAN_PACKAGE_DIR = process.env.FAN_PACKAGE_DIR;

	afterEach(() => {
		if (ORIGINAL_FAN_PACKAGE_DIR === undefined) {
			delete process.env.FAN_PACKAGE_DIR;
		} else {
			process.env.FAN_PACKAGE_DIR = ORIGINAL_FAN_PACKAGE_DIR;
		}
	});

	describe("FAN_PACKAGE_DIR override", () => {
		it("returns the env override value when set", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-config-env-"));
			try {
				// Create minimal package.json so module-level pkg read won't crash
				// (Note: pkg is already read at import time, but getPackageDir reads env each call)
				writeFileSync(join(tempRoot, "package.json"), '{"name":"test","version":"0.0.0"}');

				process.env.FAN_PACKAGE_DIR = tempRoot;
				const result = getPackageDir();
				expect(result).toBe(tempRoot);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("expands ~ to home directory", () => {
			const os = require("node:os") as typeof import("node:os");
			process.env.FAN_PACKAGE_DIR = "~";
			const result = getPackageDir();
			expect(result).toBe(os.homedir());
		});

		it("expands ~/path to home + path", () => {
			const os = require("node:os") as typeof import("node:os");
			process.env.FAN_PACKAGE_DIR = "~/my-package";
			const result = getPackageDir();
			// The implementation uses string concatenation (homedir() + slice(1)),
			// so on Windows the separator may be mixed. Just verify it starts with homedir.
			expect(result).toContain(os.homedir());
			expect(result.endsWith("my-package")).toBe(true);
		});
	});

	describe("current dev layout (no FAN_PACKAGE_DIR)", () => {
		beforeEach(() => {
			delete process.env.FAN_PACKAGE_DIR;
		});

		it("returns the package root, not dist/", () => {
			const result = getPackageDir();
			expect(basename(result)).not.toBe("dist");
			expect(existsSync(join(result, "package.json"))).toBe(true);
		});

		it("getThemesDir returns an existing directory", () => {
			const themesDir = getThemesDir();
			expect(existsSync(themesDir)).toBe(true);
			expect(existsSync(join(themesDir, "dark.json"))).toBe(true);
		});
	});

	describe("walk-up algorithm: dist/package.json skip", () => {
		// Test the core algorithm in isolation by simulating the walk-up logic.
		// This mirrors the exact code in getPackageDir() but with a controllable start dir.

		function simulateGetPackageDir(startDir: string): string {
			let dir = startDir;
			while (dir !== dirname(dir)) {
				if (existsSync(join(dir, "package.json"))) {
					if (basename(dir) === "dist") {
						const parent = dirname(dir);
						if (existsSync(join(parent, "package.json"))) {
							dir = parent;
							continue;
						}
					}
					return dir;
				}
				dir = dirname(dir);
			}
			return startDir;
		}

		it("monorepo dev: skips dist/package.json when parent has package.json", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-monorepo-"));
			try {
				const pkgRoot = join(tempRoot, "coding-agent");
				const distDir = join(pkgRoot, "dist");
				mkdirSync(distDir, { recursive: true });

				writeFileSync(join(pkgRoot, "package.json"), '{"name":"test","version":"1.0.0"}');
				writeFileSync(join(distDir, "package.json"), '{"name":"test","version":"1.0.0"}');

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(pkgRoot);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("standalone npm install: returns dist/ when parent has no package.json", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-npm-"));
			try {
				// node_modules/@scope/fan-coding-agent/dist/package.json (no parent pkg.json)
				const scopeDir = join(tempRoot, "node_modules", "@scope");
				const distDir = join(scopeDir, "fan-coding-agent", "dist");
				mkdirSync(distDir, { recursive: true });
				writeFileSync(join(distDir, "package.json"), '{"name":"test","version":"1.0.0"}');

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(distDir);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("clean dev build: no dist/package.json, walks up to parent", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-clean-"));
			try {
				const pkgRoot = join(tempRoot, "coding-agent");
				const distDir = join(pkgRoot, "dist");
				mkdirSync(distDir, { recursive: true });
				writeFileSync(join(pkgRoot, "package.json"), '{"name":"test","version":"1.0.0"}');
				// No package.json in dist

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(pkgRoot);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("npm published install: dist/ without package.json, parent is package root", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-publish-"));
			try {
				const pkgDir = join(tempRoot, "node_modules", "@scope", "fan-coding-agent");
				const distDir = join(pkgDir, "dist");
				mkdirSync(distDir, { recursive: true });
				writeFileSync(join(pkgDir, "package.json"), '{"name":"test","version":"1.0.0"}');

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(pkgDir);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("bun binary standalone: dist/package.json only (no parent), returns dist/", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-bun-"));
			try {
				const distDir = join(tempRoot, "standalone", "dist");
				mkdirSync(distDir, { recursive: true });
				writeFileSync(join(distDir, "package.json"), '{"name":"test","version":"1.0.0"}');
				// Parent (standalone/) has no package.json

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(distDir);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it("edge case: deeply nested dist/ with package.json in all ancestors", () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "fan-algo-deep-"));
			try {
				// Monorepo root has package.json, package root has package.json, dist has package.json
				const monorepoRoot = join(tempRoot, "monorepo");
				const pkgRoot = join(monorepoRoot, "packages", "coding-agent");
				const distDir = join(pkgRoot, "dist");
				mkdirSync(distDir, { recursive: true });

				writeFileSync(join(monorepoRoot, "package.json"), '{"name":"monorepo","version":"1.0.0"}');
				writeFileSync(join(pkgRoot, "package.json"), '{"name":"test","version":"1.0.0"}');
				writeFileSync(join(distDir, "package.json"), '{"name":"test","version":"1.0.0"}');

				const result = simulateGetPackageDir(distDir);
				expect(result).toBe(pkgRoot);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});
});
