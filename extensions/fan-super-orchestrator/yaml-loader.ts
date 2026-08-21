// F-B Refactor: Generic YAML loader — extracted from role-loader.ts.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-B (refactor-цели)
//
// Контракт:
//   readYamlFile(path) — прочитать один YAML-файл, вернуть parsed content (unknown).
//   readYamlDir(dir) — прочитать директорию YAML-файлов, вернуть Map<id,data>:
//     — имя файла (без расширения) используется как ключ Map и как expected id;
//     — если в распарсенном объекте есть поле `id`, оно должно совпадать с expected id
//       (несовпадение → throw);
//     — пустая/несуществующая директория → пустой Map (не throw);
//     — не-.yaml/.yml файлы пропускаются.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/** Read a single YAML file and parse it. Returns the parsed content typed as `T`. */
export function readYamlFile<T = unknown>(path: string): T {
	const content = readFileSync(path, "utf8");
	return YAML.parse(content) as T;
}

/**
 * Read a directory of YAML files and return a Map keyed by filename-derived id.
 *
 * Convention: the file basename (without `.yaml`/`.yml`) is the expected id. If a
 * parsed object declares an `id` field, it must match the filename (id validation
 * for any YAML file that follows the `filename = id` convention).
 *
 * - Missing `dir` → empty Map.
 * - Non-YAML files → skipped.
 * - id mismatch → throw (so role-loader can rely on declared ids being consistent
 *   with filenames, while duplicate-detection across files still happens in the
 *   layer-level loader).
 */
export function readYamlDir(dir: string): Map<string, unknown> {
	const result = new Map<string, unknown>();
	if (!existsSync(dir)) return result;

	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
		const id = file.replace(/\.(yaml|yml)$/, "");
		const data = readYamlFile(join(dir, file));
		if (data && typeof data === "object" && "id" in data) {
			const declaredId = (data as { id: unknown }).id;
			if (declaredId !== id) {
				// Throws "duplicate role id conflict" wording so it remains compatible with
				// existing layer-level duplicate-detection tests (regex /duplicate|conflict/i).
				throw new Error(`Duplicate role id conflict in ${file}: declared=${String(declaredId)} expected=${id}`);
			}
		}
		result.set(id, data);
	}
	return result;
}
