// F-37: Манифесты инструментов (декларативные, на узел).
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-37
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
//
// Манифест инструментов — allow-list имён инструментов на узел. Пакет работ
// (F-27) несёт поле toolManifest; при spawn дочернего fan server манифест
// конвертируется в флаг `--tools read,write,...` (work-package.buildToolArgs /
// toFlag). Попытка вызова инструмента вне манифеста отклоняется isAllowed с
// диагностикой `tool '<name>' not in manifest`.
//
// Двухуровневый enforcement:
//   • Fail-fast (L0, до spawn): depth2-integration.run() валидирует манифест
//     validateManifest'ом; при невалидном манифесте пишет в tree-journal
//     событие tool_blocked (diag = причина валидации) и бросает
//     InvalidToolManifestError — ни один дочерний процесс не порождается.
//   • Рантайм-блок (дочерний узел): --tools в argv fan server физически
//     ограничивает набор активных инструментов сессии — LLM дочернего узла
//     не может вызвать инструмент вне манифеста (инструмент не зарегистрирован
//     в AgentSession), поэтому журналирование рантайм-отказов на дочернем
//     узле не требуется.
//
// Семантика: undefined/null → полный ALLOWED_TOOLS (дефолт); пустой массив,
// не-массив, не-строки и неизвестные имена → InvalidToolManifestError.
// Дубликаты допускаются и дедуплицируются (порядок первого появления).

/** Полный набор допустимых имён инструментов (дефолтный манифест).
 *  Контракт с ядром: read/write/edit/bash/grep/find/ls — ключи allTools
 *  (packages/coding-agent/dist/core/tools/index.js); store_search /
 *  store_install — инструменты FAN Store (packages/store/src/store-tools.ts,
 *  регистрируются расширением). Держать синхронным — проверяется контракт-
 *  тестом test/tool-manifest-contract.test.mjs. */
export const ALLOWED_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"store_search",
	"store_install",
];

// TODO(F-37 refactor): вынести допустимый набор в конфигурацию
// (allowed-tools.json) для расширения без изменения кода — цель рефакторинга
// roadmap. До этого набор расширяется через opts.allowedTools ниже.

/** Опции функций манифеста. */
export interface ToolManifestOptions {
	/** Переопределение допустимого набора (дефолт — ALLOWED_TOOLS). */
	allowedTools?: readonly string[];
}

/** Ошибка невалидного манифеста инструментов (сериализуема: name + message). */
export class InvalidToolManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidToolManifestError";
	}
}

/** Разрешает допустимый набор: opts.allowedTools ?? ALLOWED_TOOLS. */
function resolveAllowedTools(opts?: ToolManifestOptions): readonly string[] {
	return opts?.allowedTools ?? ALLOWED_TOOLS;
}

/**
 * Валидирует манифест инструментов и возвращает dedupe'd копию.
 *
 * - undefined/null → полный допустимый набор (дефолт);
 * - не-массив → InvalidToolManifestError;
 * - пустой массив → InvalidToolManifestError;
 * - не-строка в массиве → InvalidToolManifestError;
 * - имя вне допустимого набора → InvalidToolManifestError (message содержит имя);
 * - дубликаты → дедуплицируются, порядок первого появления сохраняется.
 *
 * @throws InvalidToolManifestError — манифест невалиден.
 */
export function validateManifest(manifest: unknown, opts?: ToolManifestOptions): string[] {
	const allowed = resolveAllowedTools(opts);
	if (manifest === undefined || manifest === null) {
		return [...allowed];
	}
	if (!Array.isArray(manifest)) {
		throw new InvalidToolManifestError(`tool manifest must be an array, got ${typeof manifest}`);
	}
	if (manifest.length === 0) {
		throw new InvalidToolManifestError("tool manifest must not be empty");
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of manifest) {
		if (typeof item !== "string") {
			throw new InvalidToolManifestError(
				`tool manifest entries must be strings, got ${item === null ? "null" : typeof item}`,
			);
		}
		if (!allowed.includes(item)) {
			throw new InvalidToolManifestError(`tool '${item}' is not in the allowed tool set`);
		}
		if (!seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}

/**
 * Конвертирует манифест в строковый spawn-флаг: "--tools read,write".
 * Пустой массив → "" (безопасно; не должен вызываться после validateManifest).
 */
export function toFlag(manifest: readonly string[]): string {
	if (manifest.length === 0) {
		return "";
	}
	return `--tools ${manifest.join(",")}`;
}

/** Результат проверки допуска инструмента. */
export interface ToolAllowResult {
	allowed: boolean;
	/** Диагностика отказа: "tool '<name>' not in manifest" (для tool_blocked). */
	diag?: string;
}

/**
 * Проверяет допуск инструмента по манифесту (case-sensitive).
 * toolName в манифесте → { allowed: true }; иначе diag для tree-journal.
 */
export function isAllowed(manifest: readonly string[], toolName: string): ToolAllowResult {
	if (manifest.includes(toolName)) {
		return { allowed: true };
	}
	return { allowed: false, diag: `tool '${toolName}' not in manifest` };
}
