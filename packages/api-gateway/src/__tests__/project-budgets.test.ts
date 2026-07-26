import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectBudgetStore } from "../project-budgets.js";

describe("ProjectBudgetStore (F-4.9)", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fan-pbs-"));
		filePath = join(tmpDir, "project-budgets.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null for an unknown project (missing file)", () => {
		const store = new ProjectBudgetStore(filePath);
		expect(store.get("/proj")).toBeNull();
	});

	it("set/get roundtrip and persists across store instances", () => {
		const store = new ProjectBudgetStore(filePath);
		const entry = store.set("/proj", 500);
		expect(entry.tokenLimit).toBe(500);
		expect(Date.parse(entry.updatedAt)).not.toBeNaN();

		// New instance → reads the same file.
		const reloaded = new ProjectBudgetStore(filePath);
		expect(reloaded.get("/proj")).toEqual(entry);
	});

	it("replaces an existing limit", () => {
		const store = new ProjectBudgetStore(filePath);
		store.set("/proj", 500);
		store.set("/proj", 900);
		expect(store.get("/proj")?.tokenLimit).toBe(900);
	});

	it("writes the documented on-disk format (version 1)", () => {
		const store = new ProjectBudgetStore(filePath);
		store.set("/proj", 500);
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(raw.version).toBe(1);
		expect(raw.budgets["/proj"].tokenLimit).toBe(500);
	});

	it("treats a corrupted file as an empty store", () => {
		writeFileSync(filePath, "{ not json", "utf-8");
		const store = new ProjectBudgetStore(filePath);
		expect(store.get("/proj")).toBeNull();
		// And can still write (recovery).
		store.set("/proj", 100);
		expect(store.get("/proj")?.tokenLimit).toBe(100);
	});

	it("creates the parent directory when missing", () => {
		const nested = join(tmpDir, "a", "b", "project-budgets.json");
		const store = new ProjectBudgetStore(nested);
		store.set("/proj", 100);
		expect(new ProjectBudgetStore(nested).get("/proj")?.tokenLimit).toBe(100);
	});
});
