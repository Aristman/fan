// F-B: Role loader — RED-фаза TDD.
//
// Модуль ../role-loader.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля (из architecture.md §3):
//   loadRoleCatalog({ projectDir, globalDir, defaultDir }) → RoleCatalog
//     — сканирует 3 слоя, merge по id с приоритетом project > global > default
//     — дубликаты id в пределах слоя → halt с ошибкой
//   getRoleProfile(catalog, roleId) → RoleProfile
//     — возвращает resolved профиль (с учётом extends chain)
//
// RoleProfile schema (§3.2):
//   id: string              — уникальный ID, lowercase, kebab-case
//   name: string            — человекочитаемое имя
//   description: string     — краткое описание
//   allowed_depths: int[]   — [1..4]
//   extends?: string        — ID профиля-родителя
//   system_prompt?: string
//   decision_style?: { decompose: enum, verify: enum }
//   escalation_triggers?: string[]
//   verification_approach?: string
//   default_tools?: string[]
//   default_extensions?: string[]
//
// Наследование (§3.3):
//   — Цепочка extends ≤ 3 уровня
//   — Циклы детектируются DFS при загрузке
//   — Глубокий merge для вложенных объектов
//
// Покрытие (TC-карточки roadmap F-B):
//   TC-FB-1  3-слойная загрузка + merge по приоритету (project > global > default)
//   TC-FB-2  Extends chain resolution + cycle detection + chain > 3 rejection
//   TC-FB-3  10 стартовых профилей в дефолтном каталоге (smoke)

import { beforeAll, describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let loadRoleCatalog;
let getRoleProfile;

beforeAll(async () => {
	const mod = await import("../role-loader.js");
	loadRoleCatalog = mod.loadRoleCatalog;
	getRoleProfile = mod.getRoleProfile;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp directory with YAML role files from an array of role objects. */
function createRolesDir(roles) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-loader-test-"));
	for (const role of roles) {
		const filePath = path.join(dir, `${role.id}.yaml`);
		fs.writeFileSync(filePath, YAML.stringify(role), "utf-8");
	}
	return dir;
}

/** Recursively remove a temp directory. */
function cleanupDir(dir) {
	if (dir && fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ─── TC-FB-1: 3-слойная загрузка + merge по приоритету ──────────────────────

describe("TC-FB-1: 3-слойная загрузка + merge по приоритету (project > global > default)", () => {
	let projectDir;
	let globalDir;
	let defaultDir;

	beforeEach(() => {
		// Default layer: full role with all fields
		defaultDir = createRolesDir([
			{
				id: "backend",
				name: "Backend Engineer",
				description: "Default backend role",
				allowed_depths: [2, 3, 4],
				default_tools: ["code_research", "bash", "edit", "write"],
				verification_approach: "standard",
				verification_threshold: 0.5,
			},
		]);

		// Global layer: partial override — adds a custom tool via deep merge
		globalDir = createRolesDir([
			{
				id: "backend",
				description: "Global backend override",
				default_tools: ["custom_tool"],
			},
		]);

		// Project layer: highest priority — overrides description
		projectDir = createRolesDir([
			{
				id: "backend",
				description: "custom",
			},
		]);
	});

	afterEach(() => {
		cleanupDir(projectDir);
		cleanupDir(globalDir);
		cleanupDir(defaultDir);
	});

	it("project description takes priority over global and default", () => {
		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const backend = getRoleProfile(catalog, "backend");
		expect(backend.description).toBe("custom");
	});

	it("default_tools: deep merge — global appends to default list", () => {
		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const backend = getRoleProfile(catalog, "backend");
		// Default tools should include both defaults and the global custom_tool
		expect(backend.default_tools).toContain("code_research");
		expect(backend.default_tools).toContain("bash");
		expect(backend.default_tools).toContain("edit");
		expect(backend.default_tools).toContain("write");
		expect(backend.default_tools).toContain("custom_tool");
	});

	it("allowed_depths remains from default when not overridden", () => {
		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const backend = getRoleProfile(catalog, "backend");
		expect(backend.allowed_depths).toEqual([2, 3, 4]);
	});

	it("role only in default layer — loaded as-is", () => {
		// Remove project and global overrides for this test
		cleanupDir(projectDir);
		cleanupDir(globalDir);
		projectDir = createRolesDir([]);
		globalDir = createRolesDir([]);

		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const backend = getRoleProfile(catalog, "backend");
		expect(backend.description).toBe("Default backend role");
		expect(backend.default_tools).toEqual(["code_research", "bash", "edit", "write"]);
	});

	it("duplicate id within same layer → throws error", () => {
		// Two roles with same id in project layer
		cleanupDir(projectDir);
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-loader-dup-"));
		fs.writeFileSync(
			path.join(projectDir, "backend.yaml"),
			YAML.stringify({ id: "backend", description: "first" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(projectDir, "backend-dup.yaml"),
			YAML.stringify({ id: "backend", description: "second" }),
			"utf-8",
		);

		expect(() => loadRoleCatalog({ projectDir, globalDir, defaultDir })).toThrow(
			/duplicate|already exists|conflict/i,
		);
	});
});

// ─── TC-FB-2: Extends chain + cycle detection + depth limit ─────────────────

describe("TC-FB-2: Extends chain resolution + cycle detection + chain > 3 rejection", () => {
	let dirs = [];

	beforeEach(() => {
		dirs = [];
	});

	afterEach(() => {
		for (const d of dirs) cleanupDir(d);
		dirs = [];
	});

	function makeLayer(roles) {
		const dir = createRolesDir(roles);
		dirs.push(dir);
		return dir;
	}

	it("(a) extends chain A → B → C: A gets all fields from C via deep merge through B", () => {
		const defaultDir = makeLayer([
			{
				id: "c",
				name: "Role C",
				description: "Base role C",
				allowed_depths: [2, 3],
				default_tools: ["tool_c"],
				verification_approach: "strict",
			},
			{
				id: "b",
				name: "Role B",
				description: "Middle role B",
				allowed_depths: [2, 3, 4],
				extends: "c",
				default_tools: ["tool_b"],
			},
			{
				id: "a",
				name: "Role A",
				description: "Top role A",
				extends: "b",
			},
		]);
		const projectDir = makeLayer([]);
		const globalDir = makeLayer([]);

		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const roleA = getRoleProfile(catalog, "a");

		// A should inherit from B which inherits from C
		expect(roleA.description).toBe("Top role A"); // A's own
		expect(roleA.allowed_depths).toEqual([2, 3, 4]); // B overrides C
		expect(roleA.default_tools).toContain("tool_b"); // B's own
		expect(roleA.default_tools).toContain("tool_c"); // inherited from C via deep merge
		expect(roleA.verification_approach).toBe("strict"); // inherited from C
	});

	it("(b) cycle A → B → A: throws Error with cycle path", () => {
		const defaultDir = makeLayer([
			{
				id: "a",
				name: "Role A",
				description: "Cyclic A",
				extends: "b",
			},
			{
				id: "b",
				name: "Role B",
				description: "Cyclic B",
				extends: "a",
			},
		]);
		const projectDir = makeLayer([]);
		const globalDir = makeLayer([]);

		expect(() => loadRoleCatalog({ projectDir, globalDir, defaultDir })).toThrow(
			/Cycle detected in extends: A → B → A|cycle.*a.*b.*a/i,
		);
	});

	it("(c) extends chain > 3 levels (A → B → C → D): throws Error with chain path", () => {
		const defaultDir = makeLayer([
			{
				id: "a",
				name: "Role A",
				description: "Too deep A",
				extends: "b",
			},
			{
				id: "b",
				name: "Role B",
				description: "Too deep B",
				extends: "c",
			},
			{
				id: "c",
				name: "Role C",
				description: "Too deep C",
				extends: "d",
			},
			{
				id: "d",
				name: "Role D",
				description: "Too deep D",
			},
		]);
		const projectDir = makeLayer([]);
		const globalDir = makeLayer([]);

		expect(() => loadRoleCatalog({ projectDir, globalDir, defaultDir })).toThrow(
			/Extends chain too deep: A → B → C → D.*max 3|chain.*deep.*max.*3/i,
		);
	});

	it("extends chain exactly 3 levels (A → B → C): allowed (boundary)", () => {
		const defaultDir = makeLayer([
			{
				id: "c",
				name: "Role C",
				description: "Base C",
				allowed_depths: [2],
			},
			{
				id: "b",
				name: "Role B",
				description: "Middle B",
				extends: "c",
			},
			{
				id: "a",
				name: "Role A",
				description: "Top A",
				extends: "b",
			},
		]);
		const projectDir = makeLayer([]);
		const globalDir = makeLayer([]);

		// 3 levels = A → B → C is exactly at the limit, should NOT throw
		const catalog = loadRoleCatalog({ projectDir, globalDir, defaultDir });
		const roleA = getRoleProfile(catalog, "a");
		expect(roleA.description).toBe("Top A");
		expect(roleA.allowed_depths).toEqual([2]); // inherited from C
	});

	it("extends referencing non-existent role → throws error", () => {
		const defaultDir = makeLayer([
			{
				id: "a",
				name: "Role A",
				description: "Orphan A",
				extends: "nonexistent",
			},
		]);
		const projectDir = makeLayer([]);
		const globalDir = makeLayer([]);

		expect(() => loadRoleCatalog({ projectDir, globalDir, defaultDir })).toThrow(
			/not found|unknown|missing|nonexistent/i,
		);
	});
});

// ─── TC-FB-3: 10 стартовых профилей (smoke) ─────────────────────────────────

describe("TC-FB-3: 10 стартовых профилей в дефолтном каталоге (smoke)", () => {
	const EXPECTED_PROFILES = [
		"pm",
		"architect",
		"research",
		"backend",
		"frontend",
		"mobile",
		"qa",
		"refactor",
		"docs",
		"devops",
	];

	const EXPECTED_DEPTHS = {
		pm: [1],
		architect: [1, 2],
		research: [2, 3],
		backend: [2, 3, 4],
		frontend: [2, 3, 4],
		mobile: [2, 3, 4],
		qa: [2, 3, 4],
		refactor: [2, 3],
		docs: [3, 4],
		devops: [2, 3, 4],
	};

	it("default roles directory contains exactly 10 .yaml files", () => {
		const normalizedRolesDir = path.resolve(__dirname, "..", "roles");

		const files = fs.readdirSync(normalizedRolesDir).filter((f) => f.endsWith(".yaml"));
		expect(files.length).toBe(10);

		const ids = files.map((f) => f.replace(".yaml", "")).sort();
		expect(ids).toEqual([...EXPECTED_PROFILES].sort());
	});

	it("each profile parses successfully and has required fields", () => {
		const normalizedRolesDir = path.resolve(__dirname, "..", "roles");

		const files = fs.readdirSync(normalizedRolesDir).filter((f) => f.endsWith(".yaml"));

		for (const file of files) {
			const content = fs.readFileSync(path.join(normalizedRolesDir, file), "utf-8");
			const role = YAML.parse(content);

			// Required fields per §3.2
			expect(role).toHaveProperty("id");
			expect(role).toHaveProperty("name");
			expect(role).toHaveProperty("description");
			expect(role).toHaveProperty("allowed_depths");

			// id must match filename
			expect(role.id).toBe(file.replace(".yaml", ""));

			// id must be lowercase kebab-case
			expect(role.id).toMatch(/^[a-z][a-z0-9-]*$/);

			// allowed_depths must be non-empty array of integers in [1..4]
			expect(Array.isArray(role.allowed_depths)).toBe(true);
			expect(role.allowed_depths.length).toBeGreaterThan(0);
			for (const d of role.allowed_depths) {
				expect(Number.isInteger(d)).toBe(true);
				expect(d).toBeGreaterThanOrEqual(1);
				expect(d).toBeLessThanOrEqual(4);
			}
		}
	});

	it("allowed_depths matches §3.4 SPEC table for each profile", () => {
		const normalizedRolesDir = path.resolve(__dirname, "..", "roles");

		for (const [profileId, expectedDepths] of Object.entries(EXPECTED_DEPTHS)) {
			const filePath = path.join(normalizedRolesDir, `${profileId}.yaml`);
			const content = fs.readFileSync(filePath, "utf-8");
			const role = YAML.parse(content);
			expect(role.allowed_depths).toEqual(expectedDepths);
		}
	});

	it("loadRoleCatalog with only defaultDir loads all 10 profiles", () => {
		const normalizedRolesDir = path.resolve(__dirname, "..", "roles");

		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-loader-empty-"));
		try {
			const catalog = loadRoleCatalog({
				projectDir: emptyDir,
				globalDir: emptyDir,
				defaultDir: normalizedRolesDir,
			});

			// All 10 profiles should be accessible
			for (const profileId of EXPECTED_PROFILES) {
				const profile = getRoleProfile(catalog, profileId);
				expect(profile).toBeTruthy();
				expect(profile.id).toBe(profileId);
			}
		} finally {
			cleanupDir(emptyDir);
		}
	});
});
