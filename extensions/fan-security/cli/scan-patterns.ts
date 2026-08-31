/**
 * F-2.3 — CLI-сканер CWE-сигнатур кода `scan-patterns`.
 *
 * Рекурсивно сканирует файл ИЛИ директорию на опасные кодовые конструкции
 * (data-driven таблица CWE_PATTERNS в lib/patterns/cwe.ts, §4.4):
 * - CWE-89  SQL injection — SQL-строка, склеенная «+»/«${…}» с переменной;
 * - CWE-78  command injection — exec/execSync/system с интерполяцией/конкатенацией;
 * - CWE-22  path traversal — path.join/resolve с пользовательским вводом без normalize;
 * - CWE-79  XSS — присваивание переменной в .innerHTML;
 * - CWE-327 weak crypto — md5/sha1 (createHash или прямые вызовы);
 * - CWE-338 weak randomness — Math.random() в security-контексте (contextRegex);
 * - CWE-329 hardcoded IV — createCipheriv с IV-литералом.
 *
 * Построчное исполнение таблицы: совпадение regex + контекстная проверка
 * (CwePattern.contextRegex — CWE-338 флагуется только при security-словах
 * token/secret/password/… на строке; кубик/тест-данные — не finding).
 * Evidence — совпавший фрагмент (match[0]), обрезанный до MAX_CWE_EVIDENCE_LENGTH
 * (§6.1, ≤ 300 символов); маскирование секретов здесь не применяется — секреты
 * зона scan-secrets (F-2.2), в CWE-цитатах кода литеральных секретов нет.
 *
 * Схема отчёта — lib/report.ts (F-2.1): createReport/renderText/resolveExitCode;
 * tool/scanner: "scan-patterns", file — путь относительно корня сканирования
 * (POSIX-стиль), line — 1-based.
 *
 * CLI-контракт (§3.3, §4.1):
 *   bun cli/scan-patterns.ts <path> [--format json|text]   (text — дефолт)
 *   main() ВОЗВРАЩАЕТ exit-код (0 чисто / 1 findings / 2 ошибка) и НЕ вызывает
 *   process.exit — он только в CLI-обёртке import.meta.main ниже.
 *   `--format json` — весь stdout валидный JSON без посторонних строк.
 *
 * Без внешних зависимостей: только node:fs / node:path + lib/report.ts +
 * lib/patterns/cwe.ts (data-driven таблица, F-2.3) + lib/walker.ts (общий
 * обход ФС, F-2.3 REFACTOR).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §3.3, §4, §6.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
	createReport,
	renderText,
	resolveExitCode,
	type Confidence,
	type Finding,
	type Report,
	type Severity,
} from "../lib/report.ts";
import {
	CWE_PATTERNS,
	MAX_CWE_EVIDENCE_LENGTH,
	resolvePatternConfidence,
	type CwePattern,
} from "../lib/patterns/cwe.ts";
import { readTextFileSafe, walkDirectory } from "../lib/walker.ts";

// ── Константы сканера ────────────────────────────────────────────────────────

const TOOL = "scan-patterns";
const VERSION = "0.1.0";
// Обход ФС и фильтры файлов (SKIP_DIRS, BINARY_EXTENSIONS, MAX_FILE_BYTES,
// readTextFileSafe) — lib/walker.ts, общий для обоих CLI (F-2.3 REFACTOR).

// ── Сканирование ────────────────────────────────────────────────────────────

/** Опции scanPatterns. Формат вывода — забота main(), на Report не влияет. */
export interface ScanPatternsOptions {
	/** Формат вывода (зарезервировано: json | text). */
	format?: "json" | "text";
}

/** Тип вывода main(): json | text (text — дефолт, roadmap F-2.3). */
export type OutputFormat = "json" | "text";

/**
 * Сканирует файл или директорию (рекурсивно) на CWE-сигнатуры кода.
 * Возвращает Report по схеме F-2.1 (tool: "scan-patterns").
 * Несуществующий targetPath → throw (main() превращает в exit 2).
 */
export async function scanPatterns(targetPath: string, _options: ScanPatternsOptions = {}): Promise<Report> {
	let stats;
	try {
		stats = statSync(targetPath);
	} catch (cause) {
		throw new Error(`цель сканирования не существует или недоступна: ${targetPath}`, { cause });
	}

	const isDirectory = stats.isDirectory();
	const root = isDirectory ? targetPath : path.dirname(targetPath);
	const files = isDirectory ? walkDirectory(targetPath) : [targetPath];
	files.sort();

	let counter = 0;
	const nextId = () => `SEC-${String(++counter).padStart(3, "0")}`;

	const findings: Finding[] = [];
	for (const file of files) {
		findings.push(...scanFile(file, root, nextId));
	}

	return createReport({ tool: TOOL, version: VERSION, target: targetPath, findings });
}

/** Скан одного файла: исполнение CWE_PATTERNS построчно. */
function scanFile(filePath: string, root: string, nextId: () => string): Finding[] {
	const content = readTextFileSafe(filePath);
	if (content === null) {
		return []; // бинарное расширение / пустой / > 1 МБ / ошибка чтения / null-байт
	}

	const relFile = toPosix(path.relative(root, filePath)) || path.basename(filePath);
	const findings: Finding[] = [];

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		findings.push(...scanLine(lines[index], index + 1, relFile, nextId));
	}
	return findings;
}

/**
 * Скан одной строки: исполнение таблицы CWE_PATTERNS (§4.4). Совпадение regex
 * становится finding'ом, если строка проходит контекстную проверку паттерна
 * (contextRegex — контекстная чувствительность, напр. CWE-338); confidence
 * разрешается через resolvePatternConfidence (вторичная проверка
 * confidenceContextRegex, напр. CWE-89 SQL-контекст). Evidence —
 * совпавший фрагмент (не вся строка файла), обрезанный до предела.
 */
function scanLine(line: string, lineNumber: number, relFile: string, nextId: () => string): Finding[] {
	const findings: Finding[] = [];

	for (const pattern of CWE_PATTERNS) {
		if (pattern.contextRegex && !pattern.contextRegex.test(line)) {
			continue; // контекст не подтверждён (напр. Math.random() вне security-слов)
		}
		for (const match of line.matchAll(pattern.regex)) {
			const fragment = match[0];
			if (!fragment) {
				continue;
			}
			findings.push(
				buildFinding(nextId, {
					severity: pattern.severity,
					cwe: pattern.cwe,
					title: pattern.title,
					file: relFile,
					line: lineNumber,
					evidence: clipEvidence(fragment),
					description: pattern.description,
					exploit: pattern.exploit,
					remediation: pattern.remediation,
					confidence: resolvePatternConfidence(line, pattern),
				}),
			);
		}
	}

	return findings;
}

/** Собирает Finding с фиксированным scanner: "scan-patterns" (схема §6.1). */
function buildFinding(
	nextId: () => string,
	params: {
		severity: Severity;
		cwe: string;
		title: string;
		file: string;
		line: number;
		evidence: string;
		description: string;
		exploit: string;
		remediation: string;
		confidence: Confidence;
	},
): Finding {
	return {
		id: nextId(),
		scanner: TOOL,
		severity: params.severity,
		title: params.title,
		file: params.file,
		line: params.line,
		cwe: params.cwe,
		evidence: params.evidence,
		description: params.description,
		exploit: params.exploit,
		remediation: params.remediation,
		confidence: params.confidence,
	};
}

/**
 * Evidence: цитата совпавшего фрагмента (НЕ вся строка файла), обрезанная до
 * MAX_CWE_EVIDENCE_LENGTH (§6.1, ≤ 300 символов). Маскирование не применяется —
 * секреты зона scan-secrets (F-2.2).
 */
function clipEvidence(fragment: string): string {
	const text = fragment.trim();
	return text.length > MAX_CWE_EVIDENCE_LENGTH
		? text.slice(0, MAX_CWE_EVIDENCE_LENGTH)
		: text;
}

/** Относительный путь в POSIX-стиле (единый вид отчёта на Win/Linux/macOS). */
function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

// ── CLI (§3.3, §4.1) ────────────────────────────────────────────────────────

/**
 * CLI-входная точка: парсит [target] [--format json|text], печатает отчёт и
 * ВОЗВРАЩАЕТ exit-код (resolveExitCode): 0 — чисто, 1 — findings, 2 — ошибка.
 * process.exit НЕ вызывает — только обёртка import.meta.main ниже.
 * Вывод — исключительно console.log (stdout) / console.error (stderr).
 */
export async function main(argv?: string[]): Promise<number> {
	const args = argv ?? process.argv.slice(2);
	let target: string | undefined;
	let format: OutputFormat = "text"; // text — дефолт (roadmap F-2.3)

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--format") {
			const value = args[index + 1] as OutputFormat | undefined;
			if (value !== "json" && value !== "text") {
				console.error(`scan-patterns: недопустимое значение --format "${String(value)}" (ожидается json|text)`);
				return 2;
			}
			format = value;
			index += 1;
		} else if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length) as OutputFormat;
			if (value !== "json" && value !== "text") {
				console.error(`scan-patterns: недопустимое значение --format "${value}" (ожидается json|text)`);
				return 2;
			}
			format = value;
		} else if (arg.startsWith("-") && arg.length > 1) {
			console.error(`scan-patterns: неизвестная опция "${arg}" (поддерживается --format json|text)`);
			return 2;
		} else if (target === undefined) {
			target = arg;
		} else {
			console.error(`scan-patterns: лишний позиционный аргумент "${arg}" (путь указывается один раз)`);
			return 2;
		}
	}

	if (!target) {
		console.error("Использование: bun cli/scan-patterns.ts <путь> [--format json|text] (text — по умолчанию)");
		return 2;
	}

	try {
		const report = await scanPatterns(target);
		// §4.1: --format json без лишнего вывода — весь stdout валидный JSON
		console.log(format === "json" ? JSON.stringify(report, null, "\t") : renderText(report));
		return resolveExitCode(report);
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		console.error(`scan-patterns: ${error.message}`);
		return resolveExitCode(null, error);
	}
}

// CLI-обёртка для прямого запуска: bun cli/scan-patterns.ts <path> [--format …]
if (import.meta.main) {
	process.exit(await main());
}
