/**
 * Общий walker файловой системы для security-CLI (F-2.3 REFACTOR).
 *
 * Логика обхода ранее дублировалась в cli/scan-patterns.ts и cli/scan-secrets.ts
 * (~40 строк × 2); теперь оба CLI импортируют одни и те же константы и функции:
 * - SKIP_DIRS — директории, пропускаемые при обходе;
 * - BINARY_EXTENSIONS — расширения, содержимое которых не читается;
 * - MAX_FILE_BYTES — размерный предел файла (§4.1: ≤ 1 МБ);
 * - MAX_FILES / MAX_DEPTH — лимиты обхода (patch 1.0.1, F-5: защита от
 *   деградации на огромных деревьях);
 * - walkDirectory — рекурсивный обход с пропусками SKIP_DIRS и лимитами;
 * - readTextFileSafe — чтение файла как текста с фильтрами пропуска.
 *
 * Поведение обхода идентично прежнему (до рефакторинга): обход стеком, порядок
 * файлов не гарантируется (сортирует вызывающий), недоступная директория — не
 * ошибка скана, null-байт в содержимом → файл бинарный. Лимиты F-5: превышение
 * MAX_FILES/MAX_DEPTH → предупреждение в stderr + остановка обхода/ветки
 * (результат частичный, флаг в отчёт не добавляется — задокументированное
 * решение patch 1.0.1).
 *
 * Без внешних зависимостей: только node:fs / node:path.
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4, §4.1.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Размерный фильтр: файлы больше 1 МБ не сканируются (§4.1). */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Лимит файлов за обход (patch 1.0.1, F-5): превышение → предупреждение в
 * stderr + остановка обхода (результат частичный). Защита от деградации
 * на огромных деревьях (node_modules-подобные структуры, сетевые диски).
 */
export const MAX_FILES = 50_000;

/**
 * Лимит глубины обхода (patch 1.0.1, F-5): ветки глубже не обходятся
 * (предупреждение в stderr). Защита от циклов через symlink-петли и
 * патологической вложенности.
 */
export const MAX_DEPTH = 32;

/** Опции обхода (инъекция для тестов; прод-дефолты — MAX_FILES / MAX_DEPTH). */
export interface WalkOptions {
	/** Максимум файлов за обход (дефолт {@link MAX_FILES}). */
	maxFiles?: number;
	/** Максимум глубины вложенности (дефолт {@link MAX_DEPTH}). */
	maxDepth?: number;
}

/** Директории, не имеющие смысла для скана исходников. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Явно бинарные расширения — содержимое не читается. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
	".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".iso", ".dmg",
	".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".class", ".jar",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
	".sqlite", ".db", ".pdb",
]);

/**
 * Рекурсивный обход директории с пропусками SKIP_DIRS (node_modules, .git…)
 * и лимитами F-5: maxFiles (дефолт {@link MAX_FILES}) — при превышении
 * предупреждение в stderr и остановка обхода (частичный результат);
 * maxDepth (дефолт {@link MAX_DEPTH}) — ветки глубже не обходятся
 * (предупреждение в stderr). Флаг усечения в отчёт НЕ добавляется
 * (задокументированное решение patch 1.0.1) — сигнал только через stderr.
 */
export function walkDirectory(dir: string, options: WalkOptions = {}): string[] {
	const maxFiles = options.maxFiles ?? MAX_FILES;
	const maxDepth = options.maxDepth ?? MAX_DEPTH;
	const files: string[] = [];
	const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		let entries;
		try {
			entries = readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue; // недоступная директория — не ошибка скана
		}
		for (const entry of entries) {
			const full = path.join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) {
					continue;
				}
				if (current.depth + 1 > maxDepth) {
					console.error(
						`walkDirectory: достигнута максимальная глубина ${maxDepth} — «${full}» не обходится (результат частичный)`,
					);
					continue;
				}
				stack.push({ dir: full, depth: current.depth + 1 });
			} else if (entry.isFile()) {
				if (files.length >= maxFiles) {
					console.error(
						`walkDirectory: достигнут лимит ${maxFiles} файлов — обход остановлен (результат частичный)`,
					);
					return files;
				}
				files.push(full);
			}
		}
	}
	return files;
}

/**
 * Читает файл как текст для сканирования или возвращает null, если файл
 * пропускается: бинарное расширение (BINARY_EXTENSIONS), пустой файл или
 * больше MAX_FILE_BYTES (§4.1), ошибка чтения, null-байт в содержимом
 * (бинарник, не текст).
 */
export function readTextFileSafe(filePath: string): string | null {
	if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
		return null;
	}
	let stats;
	try {
		stats = statSync(filePath);
	} catch {
		return null;
	}
	if (stats.size === 0 || stats.size > MAX_FILE_BYTES) {
		return null;
	}
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	if (content.includes("\0")) {
		return null; // бинарный файл (null-байт), не текст
	}
	return content;
}
