// F-SO-SETUP: smoke-тест каркаса fan-super-orchestrator.
//
// Проверяет:
//   • index.ts импортируется так же, как loader (default export — функция);
//   • фабрика вызывается без исключений;
//   • обязательные файлы каркаса существуют.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("fan-super-orchestrator scaffold", () => {
	it("index.ts импортируется, default export — функция (ExtensionFactory)", async () => {
		const mod = await import("../index.js");
		expect(typeof mod.default).toBe("function");
	});

	it("фабрика вызывается без исключений", async () => {
		const mod = await import("../index.js");
		expect(() => mod.default({})).not.toThrow();
	});

	it("обязательные файлы каркаса существуют", () => {
		for (const file of ["package.json", "index.ts", "vitest.config.ts", "DEPLOY.toml", "README.md"]) {
			expect(existsSync(join(root, file)), `нет файла ${file}`).toBe(true);
		}
	});
});
