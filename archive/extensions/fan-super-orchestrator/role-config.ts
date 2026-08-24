// F-2: Role configuration loader — exclusions + required extensions.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §F-2
// Спека:    docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-2
//
// Контракт:
//   RoleConfig          — структура YAML-конфига для spawned SO:
//     spawn.excluded_extensions         — никогда не наследуются spawned узлом
//     role["super-orchestrator"].required_extensions — всегда добавляются для роли SO
//   DEFAULT_ROLE_CONFIG  — hardcoded defaults (back-compat при отсутствии файла)
//   loadRoleConfig(path?) — загружает YAML и merge-ит с defaults; отсутствующий файл → defaults
//
// Пример YAML (extensions/fan-super-orchestrator/role-config.yaml):
//   spawn:
//     excluded_extensions:
//       - store_search
//       - store_install
//   role:
//     super-orchestrator:
//       required_extensions:
//         - delegate_task

import { existsSync } from "node:fs";
import { readYamlFile } from "./yaml-loader.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoleConfig {
	/** Extensions, которые запрещено наследовать spawned узлам (security boundary). */
	spawn: {
		excluded_extensions: string[];
	};
	/** Required extensions per role type. */
	role: {
		"super-orchestrator": {
			required_extensions: string[];
		};
	};
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Hardcoded defaults — используются при отсутствии role-config.yaml.
 *
 * Back-compat: эти значения должны оставаться стабильными; любые изменения
 * должны делаться через явный YAML-overrides, не через правку константы.
 */
export const DEFAULT_ROLE_CONFIG: RoleConfig = {
	spawn: {
		// store_search/store_install — security boundary: spawned SO не должен
		// иметь доступа к FAN Store, чтобы избежать установки пакетов из ненадёжного контекста.
		excluded_extensions: ["store_search", "store_install"],
	},
	role: {
		"super-orchestrator": {
			// delegate_task — необходим для recursive spawn (SO спавнит worker'ов).
			required_extensions: ["delegate_task"],
		},
	},
};

// ─── Loader ─────────────────────────────────────────────────────────────────

/**
 * Загрузить RoleConfig из YAML-файла с merge defaults.
 *
 * @param configPath - путь к role-config.yaml; если undefined или файла нет → DEFAULT_ROLE_CONFIG.
 * @returns RoleConfig — всегда полностью заполненная структура (fallback на defaults).
 */
export function loadRoleConfig(configPath?: string): RoleConfig {
	if (!configPath || !existsSync(configPath)) {
		return DEFAULT_ROLE_CONFIG;
	}

	let parsed: Partial<RoleConfig> = {};
	try {
		parsed = readYamlFile<Partial<RoleConfig>>(configPath);
	} catch {
		// Невалидный YAML → fallback to defaults (graceful degradation).
		return DEFAULT_ROLE_CONFIG;
	}

	// Merge каждый leaf с дефолтом: частичный override сохраняет unspecified-поля
	// из DEFAULT_ROLE_CONFIG. Это позволяет проекту переопределить только,
	// например, excluded_extensions, без полного дублирования role-блока.
	return {
		spawn: {
			excluded_extensions: parsed.spawn?.excluded_extensions ?? DEFAULT_ROLE_CONFIG.spawn.excluded_extensions,
		},
		role: {
			"super-orchestrator": {
				required_extensions:
					parsed.role?.["super-orchestrator"]?.required_extensions ??
					DEFAULT_ROLE_CONFIG.role["super-orchestrator"].required_extensions,
			},
		},
	};
}
