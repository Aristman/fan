/**
 * F-2.5 — гибридный режим: авто-детект и запуск внешних сканеров.
 * Домены тулз: gitleaks ↔ scan-secrets, semgrep ↔ scan-patterns (§5.3 —
 * внешние тулы — ОПЦИОНАЛЬНЫЕ усилители базовых regex-сканеров).
 *
 * Состав (контракт — шапка tests/external.test.mjs):
 * - resolveExternalTools / detectExternalTools — «which-подобный» синхронный
 *   поиск по PATH БЕЗ child_process (which/where НЕ вызываются): existence-check
 *   кандидатов через statSync isFile (бит исполнения НЕ проверяется);
 *   кандидаты: win32 — <name>.cmd/.bat/.exe/bare, posix — bare; PATH из
 *   options.env.PATH (инъекция тестов) ?? process.env.PATH ?? ""; пустые
 *   сегменты и несуществующие директории молча пропускаются; функция не
 *   бросает; process.env НЕ мутируется;
 * - mergeFindings(base, external) — pure-мердж: дедуп по ключу
 *   [file POSIX, line, cwe||title], при коллизии выигрывает БАЗОВЫЙ finding;
 *   выжившие внешние идут после всех базовых в порядке входа; свежие id
 *   «EXT-001»… по порядку ВСЕХ входных внешних (включая слитые дубликаты —
 *   детерминизм и уникальность против SEC-*); входы НЕ мутируются;
 * - конвертеры gitleaksToFindings / semgrepToFindings: JSON внешней тулзы →
 *   Finding §6.1 (ровно 12 полей, scanner «external:<tool>»); Secret от
 *   gitleaks маскируется через maskSecret (§2.3 — полный секрет не попадает
 *   ни в одно поле отчёта — инвариант и для внешних findings);
 * - spawnExternal — раннер: Bun.spawnSync с АБСОЛЮТНЫМ путём из детекта,
 *   cwd = корень сканирования, env = {…process.env, PATH: инъекция ?? PATH}
 *   (инъекция протаскивается в дочерний процесс); Windows: .cmd/.bat требуют
 *   shell (cmd /c) — прямой spawn даст EINVAL;
 * - runGitleaks / runSemgrep — доменные обёртки: spawn → parse → convert;
 *   ЛЮБАЯ ошибка запуска/парсинга (не-0 exit, мусорный вывод, пусто) →
 *   0 внешних findings — скан продолжается, отчёт остаётся валидным.
 *
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §3.3, §5.3, §6.1.
 * Без внешних зависимостей: только node:fs / node:path + lib/report.ts.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { maskSecret, type ExternalMode, type ExternalToolsReport, type Finding, type Severity } from "./report.ts";
import { sanitizeEvidence } from "./sanitize.ts";

// ── Типы ────────────────────────────────────────────────────────────────────

/** Инъекция окружения для детекта/раннера (контракт F-2.5, п.7 — для тестов). */
export interface ExternalEnv {
	/** Замена process.env.PATH для поиска и дочернего процесса. */
	PATH?: string;
}

/** Опции детекта: инъекция PATH. */
export interface ExternalDetectOptions {
	env?: ExternalEnv;
}

/** Имена поддерживаемых внешних тулз. */
export type ExternalToolName = "gitleaks" | "semgrep";

/** Результат детекта: абсолютный путь к тулзе или null (не найдена). */
export interface ResolvedExternalTools {
	gitleaks: string | null;
	semgrep: string | null;
}

/** Результат детекта в булевом виде (публичный контракт detectExternalTools). */
export interface ExternalToolsDetected {
	gitleaks: boolean;
	semgrep: boolean;
}

/** Опции раннера: рабочая директория + инъекция PATH. */
export interface ExternalSpawnOptions {
	/** Корень сканирования — cwd дочернего процесса. */
	cwd: string;
	/** Инъекция окружения (протаскивается в дочерний процесс). */
	env?: ExternalEnv;
}

/** Результат запуска внешней тулзы. */
export interface ExternalSpawnResult {
	/** exit 0 и stdout получен. */
	ok: boolean;
	stdout: string;
	stderr: string;
}

const TOOL_NAMES: readonly ExternalToolName[] = ["gitleaks", "semgrep"];

/** Предел длины evidence внешних findings (§6.1: цитата, не весь вывод). */
const MAX_EXTERNAL_EVIDENCE_LENGTH = 240;

// ── Детект («which-подобный» поиск по PATH без child_process) ───────────────

/** Имена-кандидаты тулзы в директории PATH (кроссплатформенно). */
function candidateNames(tool: ExternalToolName): string[] {
	return process.platform === "win32"
		? [`${tool}.cmd`, `${tool}.bat`, `${tool}.exe`, tool]
		: [tool];
}

/** Поиск тулзы в одной директории: первый существующий файл-кандидат. */
function findInDir(dir: string, tool: ExternalToolName): string | null {
	for (const name of candidateNames(tool)) {
		const candidate = path.join(dir, name);
		try {
			if (statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// несуществующий кандидат/директория — молча пропускаем
		}
	}
	return null;
}

/**
 * Резолвит абсолютные пути внешних тулз по PATH (инъекция ?? process.env).
 * Порядок PATH соблюдается; ошибки statSync проглатываются → тулза не найдена.
 */
export function resolveExternalTools(options?: ExternalDetectOptions): ResolvedExternalTools {
	const rawPath = options?.env?.PATH ?? process.env.PATH ?? "";
	const resolved: ResolvedExternalTools = { gitleaks: null, semgrep: null };
	for (const segment of rawPath.split(path.delimiter)) {
		const dir = segment.trim();
		if (dir === "") {
			continue; // пустые/мусорные сегменты игнорируются
		}
		for (const tool of TOOL_NAMES) {
			if (resolved[tool] === null) {
				resolved[tool] = findInDir(dir, tool);
			}
		}
	}
	return resolved;
}

/**
 * Публичный детект F-2.5: синхронный, без throw, process.env не мутируется.
 * PATH для поиска: options?.env?.PATH ?? process.env.PATH ?? "".
 */
export function detectExternalTools(options?: ExternalDetectOptions): ExternalToolsDetected {
	const resolved = resolveExternalTools(options);
	return { gitleaks: resolved.gitleaks !== null, semgrep: resolved.semgrep !== null };
}

// ── Раннер (spawn синхронный; абсолютный путь; cmd /c для .cmd/.bat) ──────────

/** Минимальный структурный тип Bun-раннера (без @types/bun). */
interface BunSyncApi {
	spawnSync(
		cmd: string[],
		options: { cwd: string; env: Record<string, string | undefined>; stdout: "pipe"; stderr: "pipe" },
	): { exitCode: number | null; stdout: unknown; stderr: unknown };
}

/** Bun, если рантайм — Bun; под vitest/Node его нет → node:child_process. */
const bunApi: BunSyncApi | undefined = (globalThis as { Bun?: BunSyncApi }).Bun;

/**
 * Запускает внешнюю тулзу с АБСОЛЮТНЫМ путём (из детекта). Windows: .cmd/.bat
 * через cmd /c — прямой spawn даст EINVAL. Env: {…process.env, PATH: инъекция
 * ?? process.env.PATH}. Рантаймы: Bun.spawnSync под Bun (прод-путь),
 * node:child_process.spawnSync под vitest/Node (тесты исполняются в Node).
 * Любая ошибка запуска → { ok: false } (не throw).
 */
export function spawnExternal(
	toolPath: string,
	args: readonly string[],
	options: ExternalSpawnOptions,
): ExternalSpawnResult {
	const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(toolPath);
	// ComSpec — абсолютный путь к cmd.exe: голый "cmd" Node/Bun резолвят по PATH
	// ДОЧЕРНЕГО env, а при инъекции PATH (тесты) там нет системных директорий →
	// ENOENT; абсолютный ComSpec запускается независимо от инъекции.
	const shell = process.env.ComSpec ?? "cmd";
	const cmd: string[] = needsShell ? [shell, "/c", toolPath, ...args] : [toolPath, ...args];
	const env: Record<string, string | undefined> = { ...process.env, PATH: options.env?.PATH ?? process.env.PATH };
	try {
		if (bunApi) {
			const result = bunApi.spawnSync(cmd, { cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" });
			return {
				ok: result.exitCode === 0,
				stdout: result.stdout?.toString() ?? "",
				stderr: result.stderr?.toString() ?? "",
			};
		}
		const result = nodeSpawnSync(cmd[0], cmd.slice(1), {
			cwd: options.cwd,
			env,
			windowsHide: true,
		});
		return {
			ok: !result.error && result.status === 0,
			stdout: result.stdout?.toString() ?? "",
			stderr: result.stderr?.toString() ?? result.error?.message ?? "",
		};
	} catch (cause) {
		return {
			ok: false,
			stdout: "",
			stderr: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

// ── mergeFindings (pure-мердж с дедупом, base wins) ─────────────────────────

/** Нормализация пути к файлу: обратные слэши → «/», trim (POSIX-вид). */
function normalizeFile(file: string): string {
	return file.replace(/\\/g, "/").trim();
}

/**
 * Ключ дедупликации: [нормализованный file, line, cwe || title].join("|").
 * «Тип нарушения» = cwe; при пустом cwe — title (прокси rule-id).
 */
function dedupKeyOf(finding: Finding): string {
	return [normalizeFile(finding.file), finding.line, finding.cwe || finding.title].join("|");
}

/**
 * Мердж базовых и внешних findings (контракт F-2.5, п.2):
 * - при коллизии ключа выигрывает БАЗОВЫЙ (внешний дубликат отбрасывается);
 * - выжившие внешние — после всех базовых, в порядке входа external[];
 * - внешние получают свежие id «EXT-001»… по порядку ВСЕХ входных внешних
 *   (включая слитые дубликаты — номера «съедаются» дубликатами);
 * - scanner проходит насквозь; входные массивы и их объекты НЕ мутируются.
 */
export function mergeFindings(base: Finding[], external: Finding[]): Finding[] {
	const seen = new Set<string>();
	for (const finding of base) {
		seen.add(dedupKeyOf(finding));
	}
	const merged: Finding[] = [...base];
	let counter = 0;
	for (const finding of external) {
		const id = `EXT-${String(++counter).padStart(3, "0")}`;
		const key = dedupKeyOf(finding);
		if (seen.has(key)) {
			continue; // дубликат (базы или ранее принятого внешнего) — отброшен
		}
		seen.add(key);
		merged.push({ ...finding, id });
	}
	return merged;
}

// ── Конвертеры: JSON внешней тулзы → Finding §6.1 (ровно 12 полей) ──────────

/** Плоский доступ к полям JSON без any. */
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Evidence для gitleaks: Match/Secret ПРОМАСКИРОВАННЫЙ через maskSecret (§2.3). */
function maskGitleaksEvidence(match: string, secret: string): string {
	let text = match.trim() !== "" ? match : secret;
	if (secret !== "") {
		if (text.includes(secret)) {
			text = text.split(secret).join(maskSecret(secret));
		} else {
			text = maskSecret(secret); // Match без Secret — показываем только маску секрета
		}
	}
	return text.trim().slice(0, MAX_EXTERNAL_EVIDENCE_LENGTH);
}

/** Один элемент вывода gitleaks (JSON-массив), нас интересуют только эти поля. */
export interface GitleaksItem {
	RuleID?: string;
	Description?: string;
	File?: string;
	StartLine?: number;
	Secret?: string;
	Match?: string;
}

/**
 * gitleaks → Finding[]: scanner «external:gitleaks», title содержит RuleID,
 * cwe «CWE-798», severity: RuleID /aws/i → CRITICAL, иначе HIGH,
 * confidence «confirmed», evidence — Match/Secret замаскированы (§2.3):
 * полный Secret НЕ попадает ни в одно поле отчёта. Битые элементы пропускаются.
 */
export function gitleaksToFindings(output: unknown): Finding[] {
	if (!Array.isArray(output)) {
		return [];
	}
	const findings: Finding[] = [];
	for (const raw of output) {
		const item = asRecord(raw);
		if (!item) {
			continue;
		}
		const typed = item as GitleaksItem;
		const ruleId = (asString(typed.RuleID) ?? "").trim() || "unknown-rule";
		const secret = asString(typed.Secret) ?? "";
		const match = asString(typed.Match) ?? "";
		const startLine = typeof typed.StartLine === "number" && Number.isFinite(typed.StartLine)
			? typed.StartLine
			: 0;
		const description = (asString(typed.Description) ?? "").trim();
		findings.push({
			id: "EXT-000", // свежий id назначит mergeFindings
			scanner: "external:gitleaks",
			severity: /aws/i.test(ruleId) ? "CRITICAL" : "HIGH",
			title: `${ruleId} (gitleaks)`,
			file: normalizeFile(asString(typed.File) ?? ""),
			line: startLine,
			cwe: "CWE-798",
			evidence: maskGitleaksEvidence(match, secret),
			description: description !== ""
				? description
				: `gitleaks: потенциальный закоммиченный секрет (правило "${ruleId}").`,
			exploit: "Утёкший секрет даёт прямой доступ к внешнему сервису от имени владельца ключа.",
			remediation: "Отозвать секрет, удалить его из кода и истории git; хранить в секрет-менеджере.",
			confidence: "confirmed",
		});
	}
	return findings;
}

/** metadata.cwe (строка ИЛИ массив) → первый /^CWE-\d+/, иначе — дефолт пакета. */
function resolveSemgrepCwe(metadata: JsonRecord | null): string {
	const raw = metadata?.cwe;
	const candidates = Array.isArray(raw) ? raw : [raw];
	for (const candidate of candidates) {
		const value = asString(candidate);
		if (value === undefined) {
			continue;
		}
		const match = /^CWE-\d+/.exec(value.trim());
		if (match) {
			return match[0];
		}
	}
	return "CWE-798"; // дефолт пакета
}

/** semgrep-элемент массива results. */
export interface SemgrepResultItem {
	check_id?: string;
	path?: string;
	start?: { line?: number } | null;
	extra?: {
		message?: string;
		severity?: string;
		lines?: string;
		metadata?: JsonRecord | null;
	} | null;
}

/** Слова severity semgrep → Severity схемы F-2.1; иное/отсутствует → LOW. */
const SEMGREP_SEVERITY: Readonly<Record<string, Severity>> = {
	ERROR: "HIGH",
	WARNING: "MEDIUM",
	INFO: "INFO",
};

/**
 * semgrep → Finding[]: scanner «external:semgrep», title содержит check_id,
 * severity ERROR→HIGH / WARNING→MEDIUM / INFO→INFO / иное→LOW, cwe из
 * extra.metadata.cwe (первый /^CWE-\d+/, без него «CWE-798»), confidence
 * «confirmed», evidence — extra.lines ?? extra.message, санитизированный через
 * sanitizeEvidence (patch 1.0.1 F-1: сырой код из вывода тулзы — недоверенный
 * текст, секреты в нём маскируются — инвариант §2.3) и обрезанный до лимита.
 * Битые элементы пропускаются; мусорный корень → [].
 */
export function semgrepToFindings(output: unknown): Finding[] {
	const root = asRecord(output);
	const results = root?.results;
	if (!Array.isArray(results)) {
		return [];
	}
	const findings: Finding[] = [];
	for (const raw of results) {
		const item = asRecord(raw);
		if (!item) {
			continue;
		}
		const typed = item as SemgrepResultItem;
		const checkId = (asString(typed.check_id) ?? "").trim() || "unknown-rule";
		const extra = asRecord(typed.extra) as SemgrepResultItem["extra"] | null;
		const message = asString(extra?.message) ?? "";
		const lines = asString(extra?.lines);
		const severityWord = (asString(extra?.severity) ?? "").toUpperCase();
		const start = asRecord(typed.start);
		const line = start?.line;
		findings.push({
			id: "EXT-000", // свежий id назначит mergeFindings
			scanner: "external:semgrep",
			severity: SEMGREP_SEVERITY[severityWord] ?? "LOW",
			title: `${checkId} (semgrep)`,
			file: normalizeFile(asString(typed.path) ?? ""),
			line: typeof line === "number" && Number.isFinite(line) ? line : 0,
			cwe: resolveSemgrepCwe(asRecord(extra?.metadata) ?? null),
			evidence: sanitizeEvidence((lines ?? message).trim()).slice(0, MAX_EXTERNAL_EVIDENCE_LENGTH),
			description: message.trim() !== ""
				? message.trim()
				: `semgrep: срабатывание правила "${checkId}".`,
			exploit: "Опасная конструкция эксплуатируется по контексту правила (инъекция/утечка/слабая криптография).",
			remediation: "Исправить код по рекомендации правила (параметризованные запросы, валидация ввода, безопасные API).",
			confidence: "confirmed",
		});
	}
	return findings;
}

// ── Доменные обёртки: spawn → parse → convert (любая ошибка → 0 findings) ───

/** Аргументы gitleaks (реальный запуск; моки их игнорируют). */
function gitleaksArgs(root: string): string[] {
	return [
		"detect",
		"--source",
		root,
		"--report-format",
		"json",
		"--report-path",
		"-",
		"--exit-code",
		"0",
		"--no-banner",
	];
}

/** Аргументы semgrep (реальный запуск; моки их игнорируют). */
function semgrepArgs(root: string): string[] {
	return ["scan", "--json", "--quiet", root];
}

/** Предел размера JSON-вывода внешней тулзы (patch 1.0.1, F-5): больше —
 * недоверенный вывод (защитная оценка по string.length ≈ байтам для ASCII). */
export const MAX_PARSE_BYTES = 64 * 1024 * 1024;

/** JSON.parse без throw: мусор/пусто → null; аномально огромный вывод —
 * предупреждение в stderr + null (как мусорный: скан продолжается, отчёт
 * остаётся валидным). */
function parseJsonOrNull(stdout: string): unknown {
	if (stdout.length > MAX_PARSE_BYTES) {
		console.error(
			`external: JSON-вывод внешней тулзы превышает ${MAX_PARSE_BYTES} байт — недоверенный вывод, пропущен`,
		);
		return null;
	}
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

/** Режим external в отчёте для auto-детекта (найдена доменная тулза или нет). */
export function modeForDetected(found: boolean): ExternalMode {
	return found ? "auto" : "off";
}

/** Булев вид результата детекта для отчёта (externalTools). */
export function toExternalToolsReport(resolved: ResolvedExternalTools): ExternalToolsReport {
	return { gitleaks: resolved.gitleaks !== null, semgrep: resolved.semgrep !== null };
}

/**
 * Домен scan-secrets: запуск gitleaks (если найден) и конвертация вывода.
 * cwd = корень сканирования; ЛЮБАЯ ошибка (не-0 exit, мусорный вывод, пусто)
 * → 0 внешних findings — скан продолжается, отчёт остаётся валидным.
 */
export function runGitleaks(root: string, toolPath: string, env?: ExternalEnv): Finding[] {
	const run = spawnExternal(toolPath, gitleaksArgs(root), { cwd: root, env });
	if (!run.ok) {
		return [];
	}
	return gitleaksToFindings(parseJsonOrNull(run.stdout));
}

/** Домен scan-patterns: запуск semgrep (если найден) и конвертация вывода. */
export function runSemgrep(root: string, toolPath: string, env?: ExternalEnv): Finding[] {
	const run = spawnExternal(toolPath, semgrepArgs(root), { cwd: root, env });
	if (!run.ok) {
		return [];
	}
	return semgrepToFindings(parseJsonOrNull(run.stdout));
}
