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
 * Evidence — совпавший фрагмент (match[0]), прогнанный через sanitizeEvidence
 * (lib/sanitize.ts, patch 1.0.1 F-1: маскирование секретов/высокоэнтропийных
 * токенов во ВСЕХ источниках evidence — инвариант §2.3) и обрезанный до
 * MAX_CWE_EVIDENCE_LENGTH (§6.1, ≤ 300 символов).
 *
 * Схема отчёта — lib/report.ts (F-2.1): createReport/renderText/resolveExitCode;
 * tool/scanner: "scan-patterns", file — путь относительно корня сканирования
 * (POSIX-стиль), line — 1-based.
 *
 * Гибридный режим (F-2.5): useExternal off|auto|only (дефолт auto). Доменная
 * внешняя тулза — semgrep (lib/external.ts): auto — детект всегда → externalTools
 * в отчёте, найденный semgrep запускается, вывод конвертируется и мерджится с
 * базовыми findings (дедуп [file, line, cwe||title], base wins, id EXT-*);
 * ничего не найдено → external='off'. only — базовый regex-скан пропущен;
 * тулза не найдена → findings=[] (exit 0). off — детект/запуск не выполняются.
 * Ошибка запуска тулзы → 0 внешних findings, отчёт валиден.
 *
 * CLI-контракт (§3.3, §4.1):
 *   bun cli/scan-patterns.ts <path> [--format json|text] [--use-external off|auto|only]
 *   (text/auto — дефолты; формы "--use-external V" и "--use-external=V";
 *    недопустимое значение → exit 2)
 *   main() ВОЗВРАЩАЕТ exit-код (0 чисто / 1 findings / 2 ошибка) и НЕ вызывает
 *   process.exit — он только в CLI-обёртке import.meta.main ниже.
 *   F-2 (patch 1.0.1): скан, прерванный по тайм-бюджету (дефолт 30 000 мс,
 *   проверка каждые 50 строк/файлов), даёт stderr-предупреждение и частичные
 *   результаты; 0 findings + прерван → exit 2 (недоверенный результат).
 *   `--format json` — весь stdout валидный JSON без посторонних строк.
 *
 * Без внешних зависимостей: только node:fs / node:path + lib/report.ts +
 * lib/patterns/cwe.ts (data-driven таблица, F-2.3) + lib/walker.ts (общий
 * обход ФС, F-2.3 REFACTOR) + lib/external.ts (гибридный режим: детект/
 * раннер/мердж внешних тулз, F-2.5).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §3.3, §4, §5.3, §6.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
	createReport,
	renderText,
	resolveExitCode,
	type Confidence,
	type ExternalMode,
	type ExternalToolsReport,
	type Finding,
	type Report,
	type Severity,
} from "../lib/report.ts";
import { mergeFindings, resolveExternalTools, runSemgrep, type ExternalEnv } from "../lib/external.ts";
import { getPkgVersion } from "../lib/pkg.ts";
import {
	CWE_PATTERNS,
	resolvePatternConfidence,
	type CwePattern,
} from "../lib/patterns/cwe.ts";
import { readTextFileSafe, walkDirectory } from "../lib/walker.ts";
import {
	DEFAULT_TIME_BUDGET_MS,
	clampScanLine,
	sanitizeEvidence,
} from "../lib/sanitize.ts";

// ── Константы сканера ────────────────────────────────────────────────────────

const TOOL = "scan-patterns";
const VERSION = getPkgVersion();
// Обход ФС и фильтры файлов (SKIP_DIRS, BINARY_EXTENSIONS, MAX_FILE_BYTES,
// readTextFileSafe) — lib/walker.ts, общий для обоих CLI (F-2.3 REFACTOR).
// Предел evidence (§6.1, ≤ 300) — sanitizeEvidence в lib/sanitize.ts (patch 1.0.1).

// ── Сканирование ────────────────────────────────────────────────────────────

/** Опции scanPatterns. Формат вывода — забота main(), на Report не влияет. */
export interface ScanPatternsOptions {
	/** Формат вывода (зарезервировано: json | text). */
	format?: "json" | "text";
	/** Режим внешних сканеров (F-2.5): off | auto (дефолт) | only. */
	useExternal?: ExternalMode;
	/** Инъекция PATH для детекта/раннера внешних тулз (F-2.5, для тестов). */
	env?: ExternalEnv;
	/**
	 * Тайм-бюджет скана в мс (patch 1.0.1, F-2): дефолт DEFAULT_TIME_BUDGET_MS
	 * (30 000). Проверка Date.now() — на каждой 50-й строке/файле; при истечении
	 * скан останавливается с частичными результатами (stderr-предупреждение).
	 */
	timeBudgetMs?: number;
}

/** Результат полного скана: отчёт + флаг прерывания по тайм-бюджету (F-2). */
export interface ScanPatternsOutcome {
	/** Отчёт по схеме F-2.1 (флаг прерывания в схему НЕ добавляется). */
	report: Report;
	/** true — базовый regex-скан прерван по тайм-бюджету (частичные результаты). */
	interrupted: boolean;
}

/** Интервал проверок тайм-бюджета (F-2): каждая 50-я строка/файл. */
const TIME_BUDGET_CHECK_INTERVAL = 50;

/** Предупреждение о прерывании по бюджету — только в stderr (§4.1: stdout чист). */
function warnTimeBudget(tool: string, timeBudgetMs: number): void {
	console.error(
		`${tool}: скан прерван по тайм-бюджету (${timeBudgetMs} мс) — частичные результаты`,
	);
}

/** Тип вывода main(): json | text (text — дефолт, roadmap F-2.3). */
export type OutputFormat = "json" | "text";

/**
 * Сканирует файл или директорию (рекурсивно) на CWE-сигнатуры кода.
 * Возвращает Report по схеме F-2.1 (tool: "scan-patterns") + external-поля
 * F-2.5 (external/externalTools — см. lib/report.ts).
 * Несуществующий targetPath → throw (main() превращает в exit 2).
 *
 * Режимы useExternal (дефолт auto):
 * - off  — детект/запуск внешних не выполняются; external='off';
 * - auto — детект всегда (externalTools=результат), найденный semgrep
 *          запускается и мерджится (дедуп, base wins); не найден → 'off';
 * - only — базовый regex-скан пропущен; тулзы нет → findings=[] (exit 0).
 */
export async function scanPatterns(targetPath: string, options: ScanPatternsOptions = {}): Promise<Report> {
	return (await runScanPatterns(targetPath, options)).report;
}

/**
 * Полный скан (общий путь scanPatterns/main): отчёт + флаг прерывания по
 * тайм-бюджету. Флаг НЕ попадает в схему отчёта (решение patch 1.0.1): сигнал
 * — через stderr-предупреждение, а exit-решение принимает main() (см. ниже:
 * 0 findings + прерван → exit 2, недоверенный результат).
 */
async function runScanPatterns(targetPath: string, options: ScanPatternsOptions): Promise<ScanPatternsOutcome> {
	const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
	const budget = Date.now() + timeBudgetMs;

	let stats;
	try {
		stats = statSync(targetPath);
	} catch (cause) {
		throw new Error(`цель сканирования не существует или недоступна: ${targetPath}`, { cause });
	}

	const isDirectory = stats.isDirectory();
	const root = isDirectory ? targetPath : path.dirname(targetPath);
	const mode: ExternalMode = options.useExternal ?? "auto"; // auto — дефолт (F-2.5)

	// off: детект и запуск внешних тулз не выполняются вовсе (externalTools нет)
	if (mode === "off") {
		const base = scanBaseTarget(targetPath, isDirectory, root, budget);
		if (base.interrupted) {
			warnTimeBudget(TOOL, timeBudgetMs);
		}
		return {
			report: createReport({
				tool: TOOL,
				version: VERSION,
				target: targetPath,
				findings: base.findings,
				external: "off",
			}),
			interrupted: base.interrupted,
		};
	}

	// auto/only: детект выполняется всегда → externalTools = результат детекта
	const tools = resolveExternalTools({ env: options.env });
	const externalTools: ExternalToolsReport = {
		gitleaks: tools.gitleaks !== null,
		semgrep: tools.semgrep !== null,
	};

	// only: базовый regex-скан пропущен — только внешние (дедуп среди них);
	// доменная тулза не найдена → findings=[] (явное намерение оператора)
	if (mode === "only") {
		const external = tools.semgrep ? runSemgrep(root, tools.semgrep, options.env) : [];
		return {
			report: createReport({
				tool: TOOL,
				version: VERSION,
				target: targetPath,
				findings: mergeFindings([], external),
				external: "only",
				externalTools,
			}),
			interrupted: false, // базовый скан не выполнялся — прерывать нечего
		};
	}

	// auto: доменная тулза (semgrep) не найдена → вырождается в off (TC-F-2.5-1)
	const base = scanBaseTarget(targetPath, isDirectory, root, budget);
	if (base.interrupted) {
		warnTimeBudget(TOOL, timeBudgetMs);
	}
	if (!tools.semgrep) {
		return {
			report: createReport({
				tool: TOOL,
				version: VERSION,
				target: targetPath,
				findings: base.findings,
				external: "off",
				externalTools,
			}),
			interrupted: base.interrupted,
		};
	}

	// auto + semgrep: запуск (любая ошибка → 0 внешних) и мердж (base wins)
	const external = runSemgrep(root, tools.semgrep, options.env);
	return {
		report: createReport({
			tool: TOOL,
			version: VERSION,
			target: targetPath,
			findings: mergeFindings(base.findings, external),
			external: "auto",
			externalTools,
		}),
		interrupted: base.interrupted,
	};
}

/**
 * Базовый regex-скан (CWE-сигнатуры): обход файлов + построчное исполнение
 * таблицы. Лимиты F-2/F-5: обход — walkDirectory (MAX_FILES/MAX_DEPTH);
 * тайм-бюджет — проверка на каждой 50-й строке/файле, при истечении —
 * остановка с частичными результатами (interrupted=true).
 */
function scanBaseTarget(
	targetPath: string,
	isDirectory: boolean,
	root: string,
	budget: number,
): { findings: Finding[]; interrupted: boolean } {
	const files = isDirectory ? walkDirectory(targetPath) : [targetPath];
	files.sort();

	let counter = 0;
	const nextId = () => `SEC-${String(++counter).padStart(3, "0")}`;

	const findings: Finding[] = [];
	for (let index = 0; index < files.length; index++) {
		if (index % TIME_BUDGET_CHECK_INTERVAL === 0 && Date.now() >= budget) {
			return { findings, interrupted: true };
		}
		const scanned = scanFile(files[index]!, root, nextId, budget);
		findings.push(...scanned.findings);
		if (scanned.interrupted) {
			return { findings, interrupted: true };
		}
	}
	return { findings, interrupted: false };
}

/** Скан одного файла: исполнение CWE_PATTERNS построчно (+ тайм-бюджет, F-2). */
function scanFile(
	filePath: string,
	root: string,
	nextId: () => string,
	budget: number,
): { findings: Finding[]; interrupted: boolean } {
	const content = readTextFileSafe(filePath);
	if (content === null) {
		return { findings: [], interrupted: false }; // бинарное расширение / пустой / > 1 МБ / ошибка чтения / null-байт
	}

	const relFile = toPosix(path.relative(root, filePath)) || path.basename(filePath);
	const findings: Finding[] = [];

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		if (index % TIME_BUDGET_CHECK_INTERVAL === 0 && Date.now() >= budget) {
			return { findings, interrupted: true };
		}
		findings.push(...scanLine(lines[index]!, index + 1, relFile, nextId));
	}
	return { findings, interrupted: false };
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
	// F-2 (patch 1.0.1): усечение строки до MAX_SCAN_LINE_LENGTH перед матчингом —
	// ReDoS-защита (квадратичные CWE-89/78 regex); потеря хвостов задокументирована
	// в JSDoc MAX_SCAN_LINE_LENGTH (lib/sanitize.ts).
	const scanLineText = clampScanLine(line);

	for (const pattern of CWE_PATTERNS) {
		if (pattern.contextRegex && !pattern.contextRegex.test(scanLineText)) {
			continue; // контекст не подтверждён (напр. Math.random() вне security-слов)
		}
		for (const match of scanLineText.matchAll(pattern.regex)) {
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
					confidence: resolvePatternConfidence(scanLineText, pattern),
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
 * Evidence: цитата совпавшего фрагмента (НЕ вся строка файла), прогнанная через
 * sanitizeEvidence (patch 1.0.1 F-1: секреты/высокоэнтропийные токены в цитате
 * маскируются — инвариант §2.3 распространён на все источники evidence) и
 * обрезанная до MAX_CWE_EVIDENCE_LENGTH (§6.1, ≤ 300 символов).
 */
function clipEvidence(fragment: string): string {
	return sanitizeEvidence(fragment.trim());
}

/** Относительный путь в POSIX-стиле (единый вид отчёта на Win/Linux/macOS). */
function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

// ── CLI (§3.3, §4.1) ────────────────────────────────────────────────────────

export interface MainOptions {
	/** Тайм-бюджет скана в мс (patch 1.0.1, F-2); дефолт — DEFAULT_TIME_BUDGET_MS. */
	timeBudgetMs?: number;
}

/**
 * CLI-входная точка: парсит [target] [--format json|text]
 * [--use-external off|auto|only], печатает отчёт и ВОЗВРАЩАЕТ exit-код:
 * 0 — чисто, 1 — findings, 2 — ошибка (§3.3). F-2 (patch 1.0.1): скан,
 * прерванный по тайм-бюджету, при 0 findings — НЕдоверенный результат →
 * exit 2 (при наличии findings — обычный exit 1). process.exit НЕ вызывает —
 * только обёртка import.meta.main ниже.
 * Вывод — исключительно console.log (stdout) / console.error (stderr).
 */
export async function main(argv?: string[], options: MainOptions = {}): Promise<number> {
	const args = argv ?? process.argv.slice(2);
	let target: string | undefined;
	let format: OutputFormat = "text"; // text — дефолт (roadmap F-2.3)
	let useExternal: ExternalMode = "auto"; // auto — дефолт (F-2.5)

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
		} else if (arg === "--use-external") {
			const value = args[index + 1] as ExternalMode | undefined;
			if (value !== "off" && value !== "auto" && value !== "only") {
				console.error(
					`scan-patterns: недопустимое значение --use-external "${String(value)}" (ожидается off|auto|only)`,
				);
				return 2;
			}
			useExternal = value;
			index += 1;
		} else if (arg.startsWith("--use-external=")) {
			const value = arg.slice("--use-external=".length) as ExternalMode;
			if (value !== "off" && value !== "auto" && value !== "only") {
				console.error(`scan-patterns: недопустимое значение --use-external "${value}" (ожидается off|auto|only)`);
				return 2;
			}
			useExternal = value;
		} else if (arg.startsWith("-") && arg.length > 1) {
			console.error(`scan-patterns: неизвестная опция "${arg}" (поддерживаются --format json|text и --use-external off|auto|only)`);
			return 2;
		} else if (target === undefined) {
			target = arg;
		} else {
			console.error(`scan-patterns: лишний позиционный аргумент "${arg}" (путь указывается один раз)`);
			return 2;
		}
	}

	if (!target) {
		console.error(
			"Использование: bun cli/scan-patterns.ts <путь> [--format json|text] [--use-external off|auto|only] (text/auto — по умолчанию)",
		);
		return 2;
	}

	try {
		const { report, interrupted } = await runScanPatterns(target, {
			useExternal,
			timeBudgetMs: options.timeBudgetMs,
		});
		// §4.1: --format json без лишнего вывода — весь stdout валидный JSON
		console.log(format === "json" ? JSON.stringify(report, null, "\t") : renderText(report));
		// F-2: прерванный скан + 0 findings → exit 2 (недоверенный результат)
		return interrupted && report.findings.length === 0 ? 2 : resolveExitCode(report);
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
