// F-2: Role profile default_extensions + exclusions config — RED-фаза TDD.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §Этап 2, F-2
// Спека:    docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-2
//
// Тесты проверяют:
//   • TC-F2-1: Role profile с default_extensions парсится корректно
//              + getEffectiveExtensions существует и возвращает массив
//   • TC-F2-2: Excluded extensions удаляются из role.default_extensions
//   • TC-F2-3: Required extensions для super-orchestrator добавляются
//
// RED-фаза:
//   Все 3 тестовых сценария FAIL, потому что:
//   • getEffectiveExtensions НЕ экспортируется из role-loader.js (функция не реализована)
//   • role-config.js НЕ существует (модуль для загрузке config-файла exclusions/required)
//
// После реализации F-2 (GREEN):
//   • role-loader.ts расширен: getEffectiveExtensions(role, config?) → string[]
//   • role-config.ts создан: загрузка role-config.yaml с defaults
//   • Все тесты проходят БЕЗ изменений.

import { beforeAll, describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let loadRoleCatalog;
let getRoleProfile;
let getEffectiveExtensions;

beforeAll(async () => {
	const mod = await import("../role-loader.js");
	loadRoleCatalog = mod.loadRoleCatalog;
	getRoleProfile = mod.getRoleProfile;
	// getEffectiveExtensions — новая функция F-2.
	// До реализации: mod.getEffectiveExtensions === undefined → тесты упадут
	// при вызове с "is not a function".
	getEffectiveExtensions = mod.getEffectiveExtensions;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp directory with YAML role files from an array of role objects. */
function createRolesDir(roles) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-ext-test-"));
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

// ─── TC-F2-1: Role profile с default_extensions парсится корректно ───────────

describe("TC-F2-1: Role profile с default_extensions парсится корректно", () => {
	let defaultDir;

	beforeEach(() => {
		defaultDir = createRolesDir([
			{
				id: "pm",
				name: "Project Manager",
				description: "PM role with extensions",
				allowed_depths: [1],
				default_extensions: ["mission", "scheduler", "delegate_task"],
				default_tools: ["read", "write", "edit"],
				verification_approach: "standard",
			},
		]);
	});

	afterEach(() => {
		cleanupDir(defaultDir);
	});

	it("profile.default_extensions === ['mission', 'scheduler', 'delegate_task'] после загрузки из YAML", () => {
		const catalog = loadRoleCatalog({ defaultDir });
		const profile = getRoleProfile(catalog, "pm");

		expect(profile.default_extensions).toBeDefined();
		expect(profile.default_extensions).toEqual(["mission", "scheduler", "delegate_task"]);
	});

	it("getEffectiveExtensions существует и возвращает default_extensions role-профиля", () => {
		// RED: getEffectiveExtensions === undefined → "is not a function"
		expect(typeof getEffectiveExtensions).toBe("function");

		const catalog = loadRoleCatalog({ defaultDir });
		const role = getRoleProfile(catalog, "pm");

		// Без config — возвращает role.default_extensions as-is
		const result = getEffectiveExtensions(role);
		expect(result).toEqual(["mission", "scheduler", "delegate_task"]);
	});
});

// ─── TC-F2-2: Excluded extensions удаляются из role.default_extensions ────────

describe("TC-F2-2: Excluded extensions удаляются из role.default_extensions", () => {
	let defaultDir;

	beforeEach(() => {
		defaultDir = createRolesDir([
			{
				id: "pm",
				name: "Project Manager",
				description: "PM role with extensions",
				allowed_depths: [1],
				default_extensions: ["mission", "scheduler", "store_search", "delegate_task"],
				verification_approach: "standard",
			},
		]);
	});

	afterEach(() => {
		cleanupDir(defaultDir);
	});

	it("getEffectiveExtensions удаляет excluded extensions из role.default_extensions", () => {
		const catalog = loadRoleCatalog({ defaultDir });
		const role = getRoleProfile(catalog, "pm");

		// Config с exclusions: store_search и store_install
		const config = {
			excluded: ["store_search", "store_install"],
		};

		// RED: getEffectiveExtensions === undefined → TypeError
		const result = getEffectiveExtensions(role, config);

		// store_search удалён (был в role.default_extensions + в excluded)
		expect(result).not.toContain("store_search");
		// store_install не было в role.default_extensions, exclusion не влияет
		expect(result).not.toContain("store_install");
		// Остальные должны остаться
		expect(result).toContain("mission");
		expect(result).toContain("scheduler");
		expect(result).toContain("delegate_task");
		// Порядок: mission, scheduler, delegate_task (store_search удалён из середины)
		expect(result).toEqual(["mission", "scheduler", "delegate_task"]);
	});
});

// ─── TC-F2-3: Required extensions для super-orchestrator добавляются ─────────

describe("TC-F2-3: Required extensions для super-orchestrator добавляются", () => {
	let defaultDir;

	beforeEach(() => {
		defaultDir = createRolesDir([
			{
				id: "pm",
				name: "Project Manager",
				description: "PM role — super-orchestrator type",
				allowed_depths: [1],
				default_extensions: ["mission"], // БЕЗ delegate_task
				verification_approach: "standard",
			},
		]);
	});

	afterEach(() => {
		cleanupDir(defaultDir);
	});

	it("getEffectiveExtensions добавляет required extensions для super-orchestrator", () => {
		const catalog = loadRoleCatalog({ defaultDir });
		const role = getRoleProfile(catalog, "pm");

		// Роль — super-orchestrator (тип определяется по полю или контексту)
		const config = {
			roleType: "super-orchestrator",
			required: ["delegate_task"],
		};

		// RED: getEffectiveExtensions === undefined → TypeError
		const result = getEffectiveExtensions(role, config);

		// delegate_task должен быть добавлен (required для super-orchestrator)
		expect(result.includes("delegate_task")).toBe(true);
		// mission из role.default_extensions тоже присутствует
		expect(result).toContain("mission");
	});
});
