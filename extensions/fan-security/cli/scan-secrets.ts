/**
 * F-2.2 — CLI-сканер секретов `scan-secrets`.
 *
 * Рекурсивно сканирует файл ИЛИ директорию на закоммиченные секреты:
 * - присваивания `api_key=` / `apiKey=` (в т.ч. `"api_key": "…"` в JSON);
 * - AWS Access Key ID — «AKIA + 16 символов» (CRITICAL);
 * - OpenAI-стиль — «sk-» + ≥20 символов (HIGH);
 * - GitHub PAT — «ghp_» + 36 (HIGH);
 * - Slack-токены — «xoxb-/xoxp-» (HIGH);
 * - PEM «-----BEGIN PRIVATE KEY-----» (CRITICAL);
 * - закоммиченный .env — по имени файла, severity INFO, title «Env file committed»;
 * - entropy-эвристика: строка ≥24 символов (mixed case + цифры, shannon > 3.5)
 *   БЕЗ известного префикса → finding `needs-verification`; низкоэнтропийные
 *   строки (например, 32×'a') НЕ флагуются — без false positives.
 *
 * Все паттерны — data-driven таблица SECRET_PATTERNS в lib/patterns/secrets.ts
 * (§4.4: добавление нового паттерна = запись в таблице, без изменения логики).
 * Там же — entropy-константы и исключённые значения (undefined|null|true|false|
 * process.env.*, пустые — не секреты).
 *
 * Инварианты (спека §2.3, §6.2): evidence ВСЕГДА маскируется через maskSecret
 * из lib/report.ts (4+4, «AKIA…MNOP») — полный секрет не утекает ни в одно поле.
 * Схема отчёта — lib/report.ts (F-2.1): createReport/renderText/resolveExitCode.
 *
 * Гибридный режим (F-2.5): useExternal off|auto|only (дефолт auto). Доменная
 * внешняя тулза — gitleaks (lib/external.ts): auto — детект всегда → отчёт несёт
 * externalTools, найденный gitleaks запускается, вывод мерджится с базовыми
 * findings (дедуп [file, line, cwe||title], base wins, id EXT-*); ничего не
 * найдено → external='off' (TC-F-2.5-1). only — базовый regex-скан пропущен,
 * тулза не найдена → findings=[] (exit 0). off — детект/запуск не выполняются.
 * Ошибка запуска тулзы → 0 внешних findings, отчёт валиден. Секреты внешних
 * findings маскируются в конвертере (§2.3 — инвариант и для внешних).
 *
 * CLI-контракт (§3.3, §4.1):
 *   bun cli/scan-secrets.ts <path> [--format json|text] [--use-external off|auto|only]
 *   (text/auto — дефолты; формы "--use-external V" и "--use-external=V";
 *    недопустимое значение → exit 2)
 *   main() ВОЗВРАЩАЕТ exit-код (0 чисто / 1 findings / 2 ошибка) и НЕ вызывает
 *   process.exit — он только в CLI-обёртке import.meta.main ниже.
 *   `--format json` — весь stdout валидный JSON без посторонних строк.
 *
 * Без внешних зависимостей: только node:fs / node:path + lib/report.ts +
 * lib/patterns/secrets.ts (data-driven таблица паттернов, F-2.2 refactor) +
 * lib/walker.ts (общий обход ФС, F-2.3 REFACTOR) + lib/external.ts (гибридный
 * режим: детект/раннер/мердж внешних тулз, F-2.5).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §3.3, §4, §5.3, §6.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
	createReport,
	maskSecret,
	renderText,
	resolveExitCode,
	type Confidence,
	type ExternalMode,
	type ExternalToolsReport,
	type Finding,
	type Report,
	type Severity,
} from "../lib/report.ts";
import { mergeFindings, resolveExternalTools, runGitleaks, type ExternalEnv } from "../lib/external.ts";
import { readTextFileSafe, walkDirectory } from "../lib/walker.ts";
import {
	ENTROPY_BARE_MIN_LENGTH,
	ENTROPY_MIN_LENGTH,
	ENTROPY_QUOTED_MIN_LENGTH,
	ENTROPY_SHANNON_THRESHOLD,
	SECRET_PATTERNS,
	isExcludedSecretValue,
	type SecretPattern,
} from "../lib/patterns/secrets.ts";

// ── Константы сканера ────────────────────────────────────────────────────────

const TOOL = "scan-secrets";
const VERSION = "0.1.0";

/** Ограничение длины evidence (цитата кода, не весь файл). */
const MAX_EVIDENCE_LENGTH = 240;
// Обход ФС и фильтры файлов (SKIP_DIRS, BINARY_EXTENSIONS, MAX_FILE_BYTES,
// readTextFileSafe) — lib/walker.ts, общий для обоих CLI (F-2.3 REFACTOR).

// ── Паттерны и entropy-константы — lib/patterns/secrets.ts (§4.4) ───────────
// SECRET_PATTERNS (data-driven таблица), ENTROPY_* (именованные пороги) и
// isExcludedSecretValue импортируются в шапке модуля.

// ── Entropy-эвристика (§2.3) ────────────────────────────────────────────────

/** Shannon-энтропия строки, бит/символ (0 для пустой строки). */
function shannonEntropy(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	const counts = new Map<string, number>();
	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

/** Высокоэнтропийный токен: ≥ ENTROPY_MIN_LENGTH, mixed case + цифры, shannon > порога. */
function isHighEntropyToken(token: string): boolean {
	if (token.length < ENTROPY_MIN_LENGTH) {
		return false;
	}
	if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) {
		return false;
	}
	return shannonEntropy(token) > ENTROPY_SHANNON_THRESHOLD;
}

/**
 * Кандидаты entropy-проверки (regex собран из констант lib/patterns/secrets.ts).
 * matchAll клонирует regex — переиспользование модульных констант безопасно.
 */
const QUOTED_CANDIDATE_RE = new RegExp(
	`["'\`]([^"'\\s]{${ENTROPY_QUOTED_MIN_LENGTH},})["'\`]`,
	"g",
);
const BARE_CANDIDATE_RE = new RegExp(`[A-Za-z0-9_\\-/+=]{${ENTROPY_BARE_MIN_LENGTH},}`, "g");

/**
 * Кандидаты для entropy-проверки в строке: содержимое кавычек и «голые»
 * длинные токены (base64-тела, значения в .env без кавычек).
 */
function entropyCandidates(line: string): string[] {
	const tokens = new Set<string>();
	for (const match of line.matchAll(QUOTED_CANDIDATE_RE)) {
		if (match[1]) {
			tokens.add(match[1]);
		}
	}
	for (const match of line.matchAll(BARE_CANDIDATE_RE)) {
		tokens.add(match[0]);
	}
	return [...tokens];
}

// ── Сканирование ────────────────────────────────────────────────────────────

/** Кавычки, считающиеся закавыченностью значения (§6.2-стили строковых литералов). */
const QUOTE_CHARS = new Set(["\"", "'", "`"]);

/** Результат matchAll по паттерну с флагом d: indices capture-групп в строке. */
type MatchWithIndices = RegExpMatchArray & {
	indices?: Partial<Record<number, [number, number]>>;
};

/** Опции scanSecrets. Формат вывода — забота main(), на Report не влияет. */
export interface ScanSecretsOptions {
	/** Формат вывода (зарезервировано: json | text). */
	format?: "json" | "text";
	/** Режим внешних сканеров (F-2.5): off | auto (дефолт) | only. */
	useExternal?: ExternalMode;
	/** Инъекция PATH для детекта/раннера внешних тулз (F-2.5, для тестов). */
	env?: ExternalEnv;
}

/** Тип вывода main(): json | text (text — дефолт, roadmap F-2.2). */
export type OutputFormat = "json" | "text";

/**
 * Сканирует файл или директорию (рекурсивно) на секреты.
 * Возвращает Report по схеме F-2.1 (tool: "scan-secrets") + external-поля
 * F-2.5 (external/externalTools — см. lib/report.ts).
 * Несуществующий targetPath → throw (main() превращает в exit 2).
 *
 * Режимы useExternal (дефолт auto):
 * - off  — детект/запуск внешних не выполняются; external='off';
 * - auto — детект всегда (externalTools=результат), найденный gitleaks
 *          запускается и мерджится (дедуп, base wins); не найден → 'off';
 * - only — базовый regex-скан пропущен; тулзы нет → findings=[] (exit 0).
 */
export async function scanSecrets(targetPath: string, options: ScanSecretsOptions = {}): Promise<Report> {
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
		return createReport({
			tool: TOOL,
			version: VERSION,
			target: targetPath,
			findings: scanBaseTarget(targetPath, isDirectory, root),
			external: "off",
		});
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
		const external = tools.gitleaks ? runGitleaks(root, tools.gitleaks, options.env) : [];
		return createReport({
			tool: TOOL,
			version: VERSION,
			target: targetPath,
			findings: mergeFindings([], external),
			external: "only",
			externalTools,
		});
	}

	// auto: доменная тулза (gitleaks) не найдена → вырождается в off (TC-F-2.5-1)
	const baseFindings = scanBaseTarget(targetPath, isDirectory, root);
	if (!tools.gitleaks) {
		return createReport({
			tool: TOOL,
			version: VERSION,
			target: targetPath,
			findings: baseFindings,
			external: "off",
			externalTools,
		});
	}

	// auto + gitleaks: запуск (любая ошибка → 0 внешних) и мердж (base wins)
	const external = runGitleaks(root, tools.gitleaks, options.env);
	return createReport({
		tool: TOOL,
		version: VERSION,
		target: targetPath,
		findings: mergeFindings(baseFindings, external),
		external: "auto",
		externalTools,
	});
}

/** Базовый regex-скан (секреты): обход файлов + построчные паттерны/entropy. */
function scanBaseTarget(targetPath: string, isDirectory: boolean, root: string): Finding[] {
	const files = isDirectory ? walkDirectory(targetPath) : [targetPath];
	files.sort();

	let counter = 0;
	const nextId = () => `SEC-${String(++counter).padStart(3, "0")}`;

	const findings: Finding[] = [];
	for (const file of files) {
		findings.push(...scanFile(file, root, nextId));
	}
	return findings;
}

/** Скан одного файла: паттерны построчно + правило «закоммиченный .env». */
function scanFile(filePath: string, root: string, nextId: () => string): Finding[] {
	const content = readTextFileSafe(filePath);
	if (content === null) {
		return []; // бинарное расширение / пустой / > 1 МБ / ошибка чтения / null-байт
	}

	const relFile = toPosix(path.relative(root, filePath)) || path.basename(filePath);
	const findings: Finding[] = [];

	// Правило «закоммиченный .env» — по имени файла (severity INFO, §4/F-2.2).
	const base = path.basename(filePath).toLowerCase();
	if (base === ".env" || base.startsWith(".env.")) {
		findings.push(
			buildFinding(nextId, {
				severity: "INFO",
				cwe: "CWE-312",
				title: `Env file committed: ${base} закоммичен в репозиторий`,
				file: relFile,
				line: 1,
				evidence: base,
				description: "Файл окружения с переменными (в т.ч. секретами) хранится вместе с кодом.",
				exploit: "Любой с доступом к репозиторию получает переменные окружения: ключи, пароли, токены.",
				remediation: "Удалить .env из репозитория и истории git, добавить в .gitignore, значения — в секрет-менеджер.",
				confidence: "confirmed",
			}),
		);
	}

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		findings.push(...scanLine(lines[index], index + 1, relFile, nextId));
	}
	return findings;
}

/**
 * Confidence находки по паттерну. Если у паттерна задан bareValueConfidence,
 * закавыченность значения определяется по символам, соседним с capture-группой
 * в исходной строке (indices из флага d): кавычки с обеих сторон — литерал
 * (confirmed), иначе bare identifier/выражение → bareValueConfidence
 * (наблюдение verify F-2.2 №1: apiKey: resolvedApiKey — не хардкод).
 * Без bareValueConfidence у паттерна — всегда confirmed.
 */
function patternConfidence(line: string, match: MatchWithIndices, pattern: SecretPattern): Confidence {
	if (!pattern.bareValueConfidence) {
		return "confirmed";
	}
	const indices = match.indices?.[pattern.captureGroup];
	if (!indices) {
		return "confirmed"; // нет indices (паттерн без флага d) — поведение прежнее
	}
	const before = indices[0] > 0 ? line[indices[0] - 1] : "";
	const after = indices[1] < line.length ? line[indices[1]] : "";
	return QUOTE_CHARS.has(before) && QUOTE_CHARS.has(after) ? "confirmed" : pattern.bareValueConfidence;
}

/**
 * Ключ дедупликации: выравнивает entropy-кандидат и regex-находку одного и того
 * же секрета (наблюдение verify F-2.2 №2). Класс символов «голого» токена
 * включает `=`, поэтому в .env-стиле (`NAME=value`) entropy-кандидат захватывает
 * имя переменной и разделитель (`API_KEY=abc…`), тогда как regex-паттерн кладёт
 * в matchedSecrets только значение. Нормализуем ОБЕ стороны: если токен начинается
 * с имени переменной (без `=` внутри) и непустого значения после `=`, ключ —
 * значение после ПЕРВОГО `=` (первый, не последний: хвостовые `=` — base64-padding,
 * и обе стороны нормализуются одинаково). Остальные токены возвращаются как есть.
 */
function dedupKey(token: string): string {
	const eq = token.indexOf("=");
	if (eq > 0) {
		const value = token.slice(eq + 1);
		if (value.length > 0 && /^[A-Za-z0-9_-]+$/.test(token.slice(0, eq))) {
			return value;
		}
	}
	return token;
}

/** Скан одной строки: паттерны секретов + entropy-эвристика (без префиксных). */
function scanLine(line: string, lineNumber: number, relFile: string, nextId: () => string): Finding[] {
	const findings: Finding[] = [];
	const matchedSecrets = new Set<string>();

	for (const pattern of SECRET_PATTERNS) {
		for (const match of line.matchAll(pattern.regex)) {
			const secret = match[pattern.captureGroup];
			if (!secret) {
				continue;
			}
			// Исключённые значения попадают в matchedSecrets ДО выхода: entropy
			// не должна переоткрывать их как «подозрительные строки». Ключ —
			// нормализованный (см. dedupKey), как и при проверке entropy-токенов.
			matchedSecrets.add(dedupKey(secret));
			if (isExcludedSecretValue(secret)) {
				continue; // undefined|null|true|false|process.env.*, пустые — не секреты
			}
			findings.push(
				buildFinding(nextId, {
					severity: pattern.severity,
					cwe: pattern.cwe,
					title: pattern.title,
					file: relFile,
					line: lineNumber,
					evidence: maskedEvidence(line, secret),
					description: pattern.description,
					exploit: pattern.exploit,
					remediation: pattern.remediation,
					confidence: patternConfidence(line, match, pattern),
				}),
			);
		}
	}

	for (const token of entropyCandidates(line)) {
		if (matchedSecrets.has(dedupKey(token)) || !isHighEntropyToken(token)) {
			continue; // токен с известным префиксом уже дал finding (нормализованный ключ)
		}
		findings.push(
			buildFinding(nextId, {
				severity: "MEDIUM",
				cwe: "CWE-798",
				title: "Подозрительная высокоэнтропийная строка (возможный секрет)",
				file: relFile,
				line: lineNumber,
				evidence: maskedEvidence(line, token),
				description:
					`Строка из ${token.length} символов (смешанный регистр + цифры, ` +
					"высокая энтропия) без известного префикса может быть секретом.",
				exploit: "Если это секрет — утечка доступа, аналогично хардкоду ключей.",
				remediation: "Проверить вручную (needs-verification); если секрет — отозвать и убрать из кода.",
				confidence: "needs-verification",
			}),
		);
	}

	return findings;
}

/** Собирает Finding с фиксированным scanner: "scan-secrets" (схема §6.1). */
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
 * Evidence: строка с секретом, заменённым на maskSecret(secret) (§6.2: маскирование
 * ВСЕГДА, «AKIA…MNOP»). Полный секрет не попадает ни в одно поле отчёта.
 */
function maskedEvidence(line: string, secret: string): string {
	const masked = maskSecret(secret);
	const index = line.indexOf(secret);
	const text = index === -1 ? line : line.slice(0, index) + masked + line.slice(index + secret.length);
	return text.trim().slice(0, MAX_EVIDENCE_LENGTH);
}

/** Относительный путь в POSIX-стиле (единый вид отчёта на Win/Linux/macOS). */
function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

// ── CLI (§3.3, §4.1) ────────────────────────────────────────────────────────

/** CLI-входная точка: парсит [target] [--format json|text] [--use-external off|auto|only],
 * печатает отчёт и ВОЗВРАЩАЕТ exit-код (resolveExitCode): 0 — чисто, 1 — findings,
 * 2 — ошибка. process.exit НЕ вызывает — только обёртка import.meta.main ниже.
 * Вывод — исключительно console.log (stdout) / console.error (stderr).
 */
export async function main(argv?: string[]): Promise<number> {
	const args = argv ?? process.argv.slice(2);
	let target: string | undefined;
	let format: OutputFormat = "text"; // text — дефолт (roadmap F-2.2)
	let useExternal: ExternalMode = "auto"; // auto — дефолт (F-2.5)

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--format") {
			const value = args[index + 1] as OutputFormat | undefined;
			if (value !== "json" && value !== "text") {
				console.error(`scan-secrets: недопустимое значение --format "${String(value)}" (ожидается json|text)`);
				return 2;
			}
			format = value;
			index += 1;
		} else if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length) as OutputFormat;
			if (value !== "json" && value !== "text") {
				console.error(`scan-secrets: недопустимое значение --format "${value}" (ожидается json|text)`);
				return 2;
			}
			format = value;
		} else if (arg === "--use-external") {
			const value = args[index + 1] as ExternalMode | undefined;
			if (value !== "off" && value !== "auto" && value !== "only") {
				console.error(
					`scan-secrets: недопустимое значение --use-external "${String(value)}" (ожидается off|auto|only)`,
				);
				return 2;
			}
			useExternal = value;
			index += 1;
		} else if (arg.startsWith("--use-external=")) {
			const value = arg.slice("--use-external=".length) as ExternalMode;
			if (value !== "off" && value !== "auto" && value !== "only") {
				console.error(`scan-secrets: недопустимое значение --use-external "${value}" (ожидается off|auto|only)`);
				return 2;
			}
			useExternal = value;
		} else if (arg.startsWith("-") && arg.length > 1) {
			console.error(`scan-secrets: неизвестная опция "${arg}" (поддерживаются --format json|text и --use-external off|auto|only)`);
			return 2;
		} else if (target === undefined) {
			target = arg;
		} else {
			console.error(`scan-secrets: лишний позиционный аргумент "${arg}" (путь указывается один раз)`);
			return 2;
		}
	}

	if (!target) {
		console.error(
			"Использование: bun cli/scan-secrets.ts <путь> [--format json|text] [--use-external off|auto|only] (text/auto — по умолчанию)",
		);
		return 2;
	}

	try {
		const report = await scanSecrets(target, { useExternal });
		// §4.1: --format json без лишнего вывода — весь stdout валидный JSON
		console.log(format === "json" ? JSON.stringify(report, null, "\t") : renderText(report));
		return resolveExitCode(report);
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		console.error(`scan-secrets: ${error.message}`);
		return resolveExitCode(null, error);
	}
}

// CLI-обёртка для прямого запуска: bun cli/scan-secrets.ts <path> [--format …]
if (import.meta.main) {
	process.exit(await main());
}
