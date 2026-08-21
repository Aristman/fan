// F-B: Role loader — загрузка каталога ролей из 3 слоёв (project > global > default).
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-B
// Спека:    docs/features/super-orchestrator-v2/architecture.md §3.2, §3.3, §3.4
//
// Контракт:
//   loadRoleCatalog({ projectDir, globalDir, defaultDir }) → RoleCatalog
//     — сканирует 3 слоя, merge по id с приоритетом project > global > default;
//     — для default_tools / default_extensions / escalation_triggers — concat (dedup);
//     — для allowed_depths — replace (override полностью);
//     — для вложенных объектов (decision_style) — рекурсивный deep merge;
//     — для примитивов (description, name, verification_approach) — override;
//     — дубликаты id в пределах слоя → throw;
//     — далее resolves extends цепочки (≤3 уровня, DFS cycle detection).
//     — кэширует результат по JSON.stringify(opts) для singleton-переиспользования.
//   getRoleProfile(catalog, roleId) → RoleProfile
//     — возвращает resolved профиль (с учётом extends chain).
//   validateRoleProfile(data) → RoleProfile
//     — strict schema validation (manual guard) для полного role-профиля.
//     — допускается к вызову после merge, когда все поля гарантированно заданы.
//   clearRoleCatalogCache() — обнуляет singleton cache.
//
// YAML-парсинг делегирован `yaml-loader.ts` (см. ту).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readYamlFile } from "./yaml-loader.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoleProfile {
	id: string;
	name?: string;
	description: string;
	allowed_depths: number[];
	default_tools?: string[];
	default_extensions?: string[];
	extends?: string;
	system_prompt?: string;
	decision_style?: Record<string, unknown>;
	escalation_triggers?: string[];
	verification_approach?: string;
	verification_threshold?: number;
	[key: string]: unknown;
}

export type RoleCatalog = Map<string, RoleProfile>;

/** Поля-массивы, которые объединяются (concat) при merge, а не заменяются. */
const LIST_CONCAT_KEYS = new Set(["default_tools", "default_extensions", "escalation_triggers"]);

/** Максимальная длина extends-цепочки (в нодах): A → B → C = 3 ноды, лимит. */
const MAX_EXTENDS_CHAIN = 3;

/** Регулярка для id role-профиля: lowercase kebab-case начиная с буквы. */
const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Допустимые значения verification_approach. */
const VERIFICATION_APPROACH_VALUES = new Set(["lenient", "standard", "strict"]);

// ─── Schema validation (manual guard) ───────────────────────────────────────

/**
 * Strict schema validation для role-профиля. Применяется к merged-профилю
 * (когда все required-полей гарантированно установлены). Manual guard-подход
 * (избегаем zod-зависимости, см. package.json — zod отсутствует).
 *
 * Используется как явная API-точка: пользователь может вызвать validateRoleProfile
 * поверх полностью собранного каталога. На load не вызывается автоматически —
 * partial overrides в проектом/глобальном слоях валидны до merge.
 *
 * Схема (из architecture.md §3.2):
 *   id: string, regex /^[a-z][a-z0-9-]*$/
 *   name: string (required)
 *   description: string (required)
 *   allowed_depths: int[] [1..4] (required, non-empty)
 *   default_tools: string[] (optional)
 *   default_extensions: string[] (optional)
 *   extends: string (optional)
 *   verification_approach: "lenient" | "standard" | "strict" (optional)
 *   verification_threshold: number [0..1] (optional)
 *   escalation_triggers: string[] (optional)
 */
export function validateRoleProfile(data: unknown): RoleProfile {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Role profile must be a non-null object");
	}
	const p = data as Record<string, unknown>;

	// id (required, regex)
	if (typeof p.id !== "string" || !ROLE_ID_PATTERN.test(p.id)) {
		throw new Error(`Invalid role id (must match /^[a-z][a-z0-9-]*$/): ${String(p.id)}`);
	}

	// name (required)
	if (typeof p.name !== "string" || p.name.length === 0) {
		throw new Error(`Role ${p.id}: missing required field 'name' (must be non-empty string)`);
	}

	// description (required)
	if (typeof p.description !== "string" || p.description.length === 0) {
		throw new Error(`Role ${p.id}: missing required field 'description' (must be non-empty string)`);
	}

	// allowed_depths (required, non-empty array of ints in [1..4])
	if (!Array.isArray(p.allowed_depths) || p.allowed_depths.length === 0) {
		throw new Error(`Role ${p.id}: missing required field 'allowed_depths' (must be non-empty array)`);
	}
	for (const d of p.allowed_depths) {
		if (!Number.isInteger(d) || d < 1 || d > 4) {
			throw new Error(`Role ${p.id}: allowed_depths must be integers in [1..4], got ${String(d)}`);
		}
	}

	// default_tools (optional, but if present — min 1, string[])
	if (p.default_tools !== undefined) {
		if (
			!Array.isArray(p.default_tools) ||
			p.default_tools.length === 0 ||
			!p.default_tools.every((t) => typeof t === "string")
		) {
			throw new Error(`Role ${p.id}: default_tools must be non-empty array of strings`);
		}
	}

	// default_extensions (optional, string[])
	if (p.default_extensions !== undefined) {
		if (!Array.isArray(p.default_extensions) || !p.default_extensions.every((t) => typeof t === "string")) {
			throw new Error(`Role ${p.id}: default_extensions must be array of strings`);
		}
	}

	// extends (optional, string)
	if (p.extends !== undefined && typeof p.extends !== "string") {
		throw new Error(`Role ${p.id}: extends must be a string`);
	}

	// verification_approach (optional, enum)
	if (p.verification_approach !== undefined) {
		if (typeof p.verification_approach !== "string" || !VERIFICATION_APPROACH_VALUES.has(p.verification_approach)) {
			throw new Error(
				`Role ${p.id}: verification_approach must be one of lenient|standard|strict, got ${String(p.verification_approach)}`,
			);
		}
	}

	// verification_threshold (optional, number [0..1])
	if (p.verification_threshold !== undefined) {
		if (
			typeof p.verification_threshold !== "number" ||
			Number.isNaN(p.verification_threshold) ||
			p.verification_threshold < 0 ||
			p.verification_threshold > 1
		) {
			throw new Error(
				`Role ${p.id}: verification_threshold must be number in [0..1], got ${String(p.verification_threshold)}`,
			);
		}
	}

	// escalation_triggers (optional, string[])
	if (p.escalation_triggers !== undefined) {
		if (!Array.isArray(p.escalation_triggers) || !p.escalation_triggers.every((t) => typeof t === "string")) {
			throw new Error(`Role ${p.id}: escalation_triggers must be array of strings`);
		}
	}

	return p as RoleProfile;
}

// ─── Layer loading ──────────────────────────────────────────────────────────

function loadLayer(dir: string | undefined, layerName: string): Map<string, RoleProfile> {
	const layer = new Map<string, RoleProfile>();
	if (!dir || !existsSync(dir)) return layer;

	// Используем readYamlFile из yaml-loader.ts для парсинга каждого файла.
	// Уникальность проверяется по РАСПАРСЕННОМУ id, а не по filename-derived id —
	// это покрывает edge-case "две разных file, один id" (тест duplicate).
	const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	for (const file of files) {
		const filePath = join(dir, file);
		const parsed = readYamlFile<RoleProfile | null>(filePath);
		if (!parsed || typeof parsed !== "object" || !parsed.id) {
			throw new Error(`role file missing id: ${filePath} in ${layerName}`);
		}
		if (layer.has(parsed.id)) {
			throw new Error(`duplicate role id in ${layerName}: ${parsed.id}`);
		}
		layer.set(parsed.id, parsed);
	}
	return layer;
}

// ─── Deep merge ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(override)) {
		const baseVal = base[key];
		const overrideVal = override[key];
		if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
			result[key] = deepMergeObjects(baseVal, overrideVal);
		} else {
			result[key] = overrideVal;
		}
	}
	return result;
}

/** Merge двух профилей: override приоритетнее base, списки в LIST_CONCAT_KEYS — concat. */
function mergeProfile(base: RoleProfile, override: RoleProfile): RoleProfile {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(override)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overrideVal = (override as Record<string, unknown>)[key];

		if (LIST_CONCAT_KEYS.has(key) && Array.isArray(baseVal) && Array.isArray(overrideVal)) {
			result[key] = [...baseVal, ...overrideVal];
		} else if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
			result[key] = deepMergeObjects(baseVal, overrideVal);
		} else {
			result[key] = overrideVal;
		}
	}
	return result as RoleProfile;
}

// ─── Extends chain resolution (DFS + cycle detection + depth limit) ────────

function resolveExtends(id: string, catalog: Map<string, RoleProfile>, chain: string[]): RoleProfile {
	// Cycle detection: если id уже в chain — вычислить участок цикла.
	if (chain.includes(id)) {
		const cycleStart = chain.indexOf(id);
		const cyclePath = chain.slice(cycleStart).concat(id);
		throw new Error(`Cycle detected in extends: ${cyclePath.map((s) => s.toUpperCase()).join(" → ")}`);
	}

	const profile = catalog.get(id);
	if (!profile) {
		throw new Error(`extends target not found: ${id}`);
	}

	// Base case: extends отсутствует — возвращаем профиль как есть.
	if (!profile.extends) {
		return profile;
	}

	const newChain = [...chain, id];

	// Проверка глубины: если newChain уже содержит MAX_EXTENDS_CHAIN нод,
	// дальнейший extends сделает цепочку длиннее лимита.
	if (newChain.length >= MAX_EXTENDS_CHAIN) {
		const fullPath = newChain.concat(profile.extends);
		throw new Error(
			`Extends chain too deep: ${fullPath.map((s) => s.toUpperCase()).join(" → ")} (max ${MAX_EXTENDS_CHAIN})`,
		);
	}

	// Рекурсивно resolve родителя, затем merge (parent base, current override).
	const parent = resolveExtends(profile.extends, catalog, newChain);
	return mergeProfile(parent, profile);
}

// ─── Singleton cache ────────────────────────────────────────────────────────

interface CachedCatalog {
	signature: string;
	catalog: RoleCatalog;
}

let cachedCatalog: CachedCatalog | null = null;

/** Сброс singleton-кэша. Экспортируется для тестов и для случаев runtime-сброса. */
export function clearRoleCatalogCache(): void {
	cachedCatalog = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function loadRoleCatalog(opts: { projectDir?: string; globalDir?: string; defaultDir: string }): RoleCatalog {
	// Cache signature: JSON.stringify(opts) — undefined-ключи выбрасываются, но
	// для нашего API это норма (projectDir/globalDir — optional).
	const signature = JSON.stringify(opts);
	if (cachedCatalog && cachedCatalog.signature === signature) {
		return cachedCatalog.catalog;
	}

	const defaultLayer = loadLayer(opts.defaultDir, "default");
	const globalLayer = loadLayer(opts.globalDir, "global");
	const projectLayer = loadLayer(opts.projectDir, "project");

	// Собираем union всех id из трёх слоёв.
	const allIds = new Set<string>();
	for (const m of [defaultLayer, globalLayer, projectLayer]) {
		for (const id of m.keys()) allIds.add(id);
	}

	const merged = new Map<string, RoleProfile>();
	for (const id of allIds) {
		let profile = defaultLayer.get(id) ?? ({} as RoleProfile);
		if (globalLayer.has(id)) {
			profile = mergeProfile(profile, globalLayer.get(id)!);
		}
		if (projectLayer.has(id)) {
			profile = mergeProfile(profile, projectLayer.get(id)!);
		}
		// Гарантируем, что у merged-профиля есть id (пустые слои не должны ломать).
		if (!profile.id) profile.id = id;
		merged.set(id, profile);
	}

	// Resolves extends цепочки на merged-каталоге. Порядок обхода — естественный
	// (insertion order из layer Maps), resolveExtends рекурсивно через merged.
	// Семантика цепочки: для каждого id поднимаемся по extends-цепочке, накапливая
	// merge (parent base, current override). Циклы и превышение MAX_EXTENDS_CHAIN
	// детектируются в resolveExtends и пробрасываются до ближайшего вызова.
	const resolved: RoleCatalog = new Map();
	for (const id of allIds) {
		resolved.set(id, resolveExtends(id, merged, []));
	}

	cachedCatalog = { signature, catalog: resolved };
	return resolved;
}

export function getRoleProfile(catalog: RoleCatalog, id: string): RoleProfile {
	if (!catalog.has(id)) {
		throw new Error(`role_profile_not_found: ${id}`);
	}
	return catalog.get(id)!;
}
