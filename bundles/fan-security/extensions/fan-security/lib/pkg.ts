/**
 * Версия пакета fan-security для CLI-отчётов (fix аудита: MEDIUM).
 *
 * До фикса все три CLI (scan-secrets, scan-patterns, dep-audit) рапортовали
 * захардкоженную VERSION="0.1.0", тогда как package.json компонента — 1.0.0:
 * отчёты расходились с реальной версией пакета. Теперь версия читается из
 * package.json единым хелпером — CLI-отчёты всегда отражают версию релиза.
 *
 * Гарантии:
 * - синхронное чтение (CLI вызывают VERSION на этапе инициализации модуля);
 * - без throw: любая ошибка (нет файла, битый JSON, нет поля version) → fallback;
 * - кеш модульного скоупа — package.json читается ровно один раз;
 * - new URL("../package.json", import.meta.url) — путь относительно lib/,
 *   работает во всех рантаймах: Bun (прод, jiti), vitest/Node (esbuild),
 *   single-file архив.
 *
 * Без внешних зависимостей: только node:fs.
 */

import { readFileSync } from "node:fs";

/** Кеш модульного скоупа: package.json читается один раз за жизнь процесса. */
let cachedVersion: string | undefined;

/**
 * Возвращает версию пакета из ../package.json (относительно lib/).
 * При любой ошибке чтения/парсинга или отсутствии поля version → fallback
 * (по умолчанию "0.0.0"). Никогда не бросает исключение.
 */
export function getPkgVersion(fallback = "0.0.0"): string {
	if (cachedVersion !== undefined) {
		return cachedVersion;
	}
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const version =
			typeof parsed === "object" && parsed !== null && "version" in parsed
				? (parsed as { version?: unknown }).version
				: undefined;
		cachedVersion = typeof version === "string" && version.length > 0 ? version : fallback;
	} catch {
		cachedVersion = fallback;
	}
	return cachedVersion;
}
