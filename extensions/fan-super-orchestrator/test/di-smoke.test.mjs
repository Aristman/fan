// Smoke-test for LockBackend DI (F-C refactor).
// Проверяет: FileLockBackend + SqliteLockBackend контракт + DI в PortRegistry.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FileLockBackend,
	PortRegistry,
	SqliteLockBackend,
} from "../port-registry.js";

let testDir;

beforeAll(() => {
	testDir = mkdtempSync(join(tmpdir(), "lock-di-smoke-"));
});

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe("LockBackend interface (F-C refactor)", () => {
	it("FileLockBackend.acquire returns release fn, idempotent on second call", async () => {
		const backend = new FileLockBackend();
		const fakePath = join(testDir, "fake-registry-1.json");
		const release = await backend.acquire(fakePath);
		expect(typeof release).toBe("function");
		await release(); // первый release
		await expect(release()).resolves.toBeUndefined(); // idempotent
	});

	it("SqliteLockBackend throws explicit 'future work' error", () => {
		const backend = new SqliteLockBackend();
		expect(() => backend.acquire("/tmp/anything")).toThrow(
			/SqliteLockBackend not implemented/,
		);
	});

	it("PortRegistry accepts custom LockBackend via constructor (DI)", async () => {
		// Без файла — startRegistry должен создать свежий v2.
		const customPath = join(testDir, "di-registry.json");
		const customBackend = new FileLockBackend();
		const registry = new PortRegistry(customPath, customBackend);
		const state = await registry.startRegistry();
		expect(state.version).toBe(2);
	});

	it("PortRegistry defaults to FileLockBackend when no second arg", async () => {
		const defaultPath = join(testDir, "default-registry.json");
		const registry = new PortRegistry(defaultPath);
		const state = await registry.startRegistry();
		expect(state.version).toBe(2);
	});

	it("In-memory fake backend через DI: tryAllocatePort работает", async () => {
		// Fake-backend, реализующий LockBackend — без файловой системы.
		const inMemoryBackend = {
			async acquire() {
				return async () => {};
			},
		};
		const customPath = join(testDir, "fake-registry.json");
		const registry = new PortRegistry(customPath, inMemoryBackend);
		const state = await registry.startRegistry();
		expect(state.version).toBe(2);
		const alloc = await registry.tryAllocatePort({
			nodeId: "fake-1",
			role: "orchestrator",
			depth: 1,
		});
		expect(alloc.allowed).toBe(true);
	});
});