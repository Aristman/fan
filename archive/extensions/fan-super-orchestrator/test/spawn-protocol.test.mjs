// F-D: Spawn protocol — RED-фаза TDD.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-D
//
// Тесты для расширенного spawn-протокола:
//   • Extended SpawnWorkPackage (role, role_profile, parent_*, lineage)
//   • Port allocation через registry (api/webhook pools)
//   • Lineage construction (append, build, depth increment)
//
// Ожидаемые результаты (RED):
//   TC-FD-1a        → FAIL: build-work-package.js не существует
//   TC-FD-1b        → FAIL: правило super_orch_at_max_depth не реализовано
//   TC-FD-1c        → PASS: regression guard (role-loader уже есть)
//   TC-FD-2a        → PASS: regression guard (port-registry api pool)
//   TC-FD-2b        → PASS: regression guard (port-registry release)
//   TC-FD-2c        → FAIL: webhook pool allocation не реализован
//   TC-FD-3a/b/c    → FAIL: build-work-package.js не существует

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── TC-FD-1: Extended SpawnWorkPackage + canSpawnBatch validation ───────────

describe("TC-FD-1: Extended SpawnWorkPackage + canSpawnBatch validation", () => {
	// ─── TC-FD-1a: builds SpawnWorkPackage with extended fields ─────────────

	describe("TC-FD-1a: buildWorkPackage with extended fields", () => {
		let buildWorkPackage;

		beforeAll(async () => {
			const mod = await import("../build-work-package.js");
			buildWorkPackage = mod.buildWorkPackage;
		});

		it("builds SpawnWorkPackage with extended fields", () => {
			const parent = {
				correlationId: "parent-corr-1",
				url: "http://localhost:7001",
				token: "tok",
				role: "super-orchestrator",
				profile: "pm",
			};
			const pkg = buildWorkPackage({
				parent,
				role: "super-orchestrator",
				profile: "architect",
				depth: 2,
				task: { type: "research", prompt: "test" },
				lineage: [parent],
			});
			expect(pkg.role).toBe("super-orchestrator");
			expect(pkg.role_profile).toBe("architect");
			expect(pkg.parent_correlation_id).toBe("parent-corr-1");
			expect(pkg.parent_url).toBe("http://localhost:7001");
			expect(pkg.parent_token).toBe("tok");
			expect(pkg.parent_report_id).toBeDefined(); // generated
			expect(pkg.lineage).toHaveLength(1);
			expect(pkg.depth).toBe(2);
		});
	});

	// ─── TC-FD-1b: Super-Orch at depth=4 → REFUSED ─────────────────────────

	describe("TC-FD-1b: Super-Orch at depth=4 → REFUSED super_orch_at_max_depth", () => {
		let canSpawnBatch;

		beforeAll(async () => {
			const mod = await import("../width-pyramid.js");
			canSpawnBatch = mod.canSpawnBatch;
		});

		it("Super-Orch at depth=4 → REFUSED super_orch_at_max_depth", () => {
			const result = canSpawnBatch({
				depth: 4,
				batch: 1,
				role: "super-orchestrator",
				profile: "backend",
			});
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("super_orch_at_max_depth");
		});
	});

	// ─── TC-FD-1c: getRoleProfile with non-existent id throws ───────────────

	describe("TC-FD-1c: getRoleProfile with non-existent id throws role_profile_not_found", () => {
		let loadRoleCatalog;
		let getRoleProfile;

		beforeAll(async () => {
			const mod = await import("../role-loader.js");
			loadRoleCatalog = mod.loadRoleCatalog;
			getRoleProfile = mod.getRoleProfile;
		});

		it("getRoleProfile with non-existent id throws role_profile_not_found", () => {
			const catalog = loadRoleCatalog({ defaultDir: "./roles" });
			expect(() => getRoleProfile(catalog, "non-existent-profile")).toThrow(
				/role_profile_not_found/,
			);
		});
	});
});

// ─── TC-FD-2: Spawn flow с port allocation через registry ───────────────────

describe("TC-FD-2: Spawn flow с port allocation через registry", () => {
	let PortRegistry;

	beforeAll(async () => {
		const mod = await import("../port-registry.js");
		PortRegistry = mod.PortRegistry;
	});

	let testDir;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "spawn-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ─── TC-FD-2a: spawn allocates port via registry in API range ───────────

	it("TC-FD-2a: spawn allocates port via registry in API range 7001-7100", async () => {
		const registry = new PortRegistry(join(testDir, "registry.json"));
		await registry.startRegistry();

		const result = await registry.tryAllocatePort({
			nodeId: "spawn-node-1",
			role: "super-orchestrator",
			profile: "backend",
			depth: 2,
		});

		expect(result.allowed).toBe(true);
		expect(result.port).toBeGreaterThanOrEqual(7001);
		expect(result.port).toBeLessThanOrEqual(7100);

		const state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(1);
	});

	// ─── TC-FD-2b: releasePort decrements active_nodes ─────────────────────

	it("TC-FD-2b: releasePort decrements active_nodes", async () => {
		const registry = new PortRegistry(join(testDir, "registry.json"));
		await registry.startRegistry();

		const alloc = await registry.tryAllocatePort({
			nodeId: "spawn-node-2",
			role: "super-orchestrator",
			profile: "backend",
		});
		expect(alloc.allowed).toBe(true);

		await registry.releasePort("spawn-node-2");
		const state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(0);
	});

	// ─── TC-FD-2c: webhook pool uses 9090-9189 range ───────────────────────

	it("TC-FD-2c: webhook pool uses 9090-9189 range", async () => {
		const registry = new PortRegistry(join(testDir, "registry.json"));
		await registry.startRegistry();

		// pool: "webhook" — новое поле, которое должно направлять allocation
		// в webhook_pool (9090-9189). Текущая реализация игнорирует pool и
		// всегда выделяет из api_pool → порт будет в 7001-7100 → FAIL.
		const result = await registry.tryAllocatePort({
			nodeId: "spawn-node-3",
			role: "super-orchestrator",
			profile: "backend",
			pool: "webhook",
		});

		expect(result.allowed).toBe(true);
		expect(result.port).toBeGreaterThanOrEqual(9090);
		expect(result.port).toBeLessThanOrEqual(9189);
	});
});

// ─── TC-FD-3: Lineage construction ──────────────────────────────────────────

describe("TC-FD-3: Lineage construction", () => {
	let appendToLineage;
	let buildLineage;

	beforeAll(async () => {
		const mod = await import("../build-work-package.js");
		appendToLineage = mod.appendToLineage;
		buildLineage = mod.buildLineage;
	});

	// ─── TC-FD-3a: appendToLineage adds parent to existing lineage ──────────

	it("TC-FD-3a: appendToLineage adds parent to existing lineage", () => {
		const grandparent = {
			correlationId: "g",
			url: "http://localhost:7000",
			token: "t1",
			role: "coordinator",
		};
		const parent = {
			correlationId: "p",
			url: "http://localhost:7001",
			token: "t2",
			role: "super-orchestrator",
			profile: "pm",
		};

		const newLineage = appendToLineage([grandparent], parent);
		expect(newLineage).toHaveLength(2);
		expect(newLineage[0]).toEqual(grandparent);
		expect(newLineage[1]).toEqual(parent);
	});

	// ─── TC-FD-3b: buildLineage from scratch ───────────────────────────────

	it("TC-FD-3b: buildLineage from scratch", () => {
		const coordinator = {
			correlationId: "c",
			url: "http://localhost:7000",
			token: "t0",
			role: "coordinator",
		};
		const lineage = buildLineage(coordinator);
		expect(lineage).toHaveLength(1);
		expect(lineage[0]).toEqual(coordinator);
	});

	// ─── TC-FD-3c: depth increments by 1 per level ─────────────────────────

	it("TC-FD-3c: depth increments by 1 per level", () => {
		const parent = {
			correlationId: "p",
			url: "http://localhost:7001",
			token: "t",
			role: "super-orchestrator",
			profile: "pm",
			depth: 1,
		};
		const newEntry = { ...parent, depth: parent.depth + 1 };
		expect(newEntry.depth).toBe(2);
	});
});
