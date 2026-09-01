/**
 * F-2.4 — CLI-сканер уязвимых зависимостей `dep-audit`.
 *
 * Находит манифесты зависимостей (файл ИЛИ рекурсивный обход директории через
 * lib/walker.ts; node_modules/.git/… пропускаются — SKIP_DIRS) и запускает для
 * КАЖДОГО ровно одну audit-утилиту (§5.3 — опциональные внешние инструменты):
 * - package.json → `npm audit --json`; lockfile-уточнение: pnpm-lock.yaml в
 *   той же директории → `pnpm audit --json`, yarn.lock → `yarn audit --json`;
 * - requirements.txt ИЛИ pyproject.toml → `pip-audit --format json`;
 * - Cargo.toml → `cargo audit --json`.
 *
 * ИЗОЛЯЦИЯ CWD (F-6, patch 1.0.1 — fix security-аудита): утилита запускается
 * НЕ в директории манифеста, а во временном workspace (mkdtemp под os.tmpdir):
 * туда копируются манифест и его lockfiles (package.json + package-lock.json /
 * pnpm-lock.yaml / yarn.lock; requirements.txt / pyproject.toml; Cargo.toml +
 * Cargo.lock), cwd = workspace. Иначе npm/pip/cargo читают конфиги из cwd
 * (прежде всего .npmrc сканируемого репо) — эксфильтрация/подмена registry
 * через недоверенный каталог. Дополнительно для npm изолируется пользовательский
 * конфиг: env.npm_config_userconfig указывает на несуществующий файл внутри
 * workspace (изоляция и от пользовательского ~/.npmrc). line/evidence в
 * findings считаются по ОРИГИНАЛЬНОМУ манифесту (путь сохраняется); workspace
 * удаляется после вызова.
 *
 * Парсинг вывода (1 запись уязвимости → ровно 1 finding, без дублей):
 * - npm/pnpm/yarn: JSON.vulnerabilities{} (формат npm audit v7+/v9);
 *   severity-карта слов: critical→CRITICAL, high→HIGH, moderate→MEDIUM,
 *   low→LOW, info→INFO;
 * - pip-audit: JSON-массив [{name, version, aliases, fix_versions, description}];
 *   pip-audit не отдаёт severity → дефолт "MEDIUM" (задокументированный выбор);
 * - cargo audit: RustSec-JSON {"vulnerabilities":{"list":[…]}}; severity из
 *   advisory.severity (карта слов), при отсутствии поля — дефолт "HIGH".
 *
 * Поля Finding (схема F-2.1, §6.1):
 * - scanner = "dep-audit" для всех (в т.ч. pip/cargo);
 * - title содержит имя пакета/крейта;
 * - cwe: первый CWE из advisory.cwe (npm via-advisory) или дефолт "CWE-1395"
 *   (Dependency on Vulnerable Third-Party Component) — npm via-строка,
 *   pip-audit и cargo CWE не отдают;
 * - CVE-идентификаторы (CVE-\d{4}-\d+ в via/url/title/aliases) попадают в
 *   description — задокументированный выбор: cwe только для «CWE-NNN», CVE
 *   не теряются;
 * - remediation «upgrade to <версия>» при известном фиксе (npm
 *   fixAvailable.version, pip fix_versions[0], cargo patched[0]);
 * - file — манифест, ПО которому шёл аудит (относительно корня скана, POSIX);
 *   line — строка объявления пакета в манифесте (1-based), для транзитивных
 *   зависимостей — 0 (неприменимо, разрешено схемой);
 * - evidence ≤ 300: цитата строки манифеста с объявлением, иначе краткая
 *   цитата audit-вывода (имя + range) — всегда непустая; САНИТИЗИРУЕТСЯ через
 *   sanitizeEvidence (lib/sanitize.ts, patch 1.0.1 F-1: строка манифеста —
 *   недоверенный текст, секреты в ней маскируются — инвариант §2.3);
 * - confidence = "confirmed" (утилита сверяет установленные версии с БД).
 *
 * Деградация (§3.3 — сообщение, не падение):
 * - утилита отсутствует (exitCode ≠ 0 И stdout пуст/не-JSON) → предупреждение
 *   в stderr (с именем утилиты), findings от неё нет, скан продолжается,
 *   exit 0 при пустом отчёте; ВАЖНО: exitCode ≠ 0 при валидном JSON (реальный
 *   npm audit выходит с кодом 1 при уязвимостях) — это НЕ отсутствие утилиты;
 * - манифестов нет → findings=[], предупреждение «no manifests» в stderr,
 *   exit 0; несуществующий targetPath → throw (main() превращает в exit 2).
 *
 * Запуск внешних команд — через инъекцию runner ({cmd,args,cwd,env?}) →
 * {stdout,stderr,exitCode}; по умолчанию Bun.spawnSync. Тесты всегда
 * передают мок-runner — реальных spawn в тестах нет.
 *
 * CLI-контракт (§3.3, §4.1):
 *   bun cli/dep-audit.ts <path> [--format json|text]   (text — дефолт)
 *   main() ВОЗВРАЩАЕТ exit-код (0 чисто / 1 findings / 2 ошибка) и НЕ вызывает
 *   process.exit — он только в CLI-обёртке import.meta.main ниже.
 *   `--format json` — весь stdout валидный JSON без посторонних строк;
 *   предупреждения (нет манифестов / нет утилиты) — только в stderr.
 *
 * Без внешних зависимостей: только node:fs / node:path + lib/report.ts +
 * lib/walker.ts.
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §3.3, §4, §5.3, §6.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createReport,
	renderText,
	resolveExitCode,
	type Finding,
	type Report,
	type Severity,
} from "../lib/report.ts";
import { getPkgVersion } from "../lib/pkg.ts";
import { walkDirectory } from "../lib/walker.ts";
import { sanitizeEvidence } from "../lib/sanitize.ts";

// ── Константы сканера ────────────────────────────────────────────────────────

const TOOL = "dep-audit";
const VERSION = getPkgVersion();
// Предел evidence (§6.1, ≤ 300) — sanitizeEvidence в lib/sanitize.ts (patch 1.0.1).
/** CWE-дефолт, когда утилита не отдаёт CWE (npm via-строка, pip-audit, cargo). */
const DEFAULT_CWE = "CWE-1395";

/** Манифест npm-семейства (npm/pnpm/yarn — по lockfile рядом). */
const NPM_MANIFEST = "package.json";
/** Python-манифесты (обе аудитятся pip-audit). */
const PIP_MANIFESTS: ReadonlySet<string> = new Set(["requirements.txt", "pyproject.toml"]);
/** Rust-манифест (cargo audit). */
const CARGO_MANIFEST = "Cargo.toml";
/** Все распознаваемые манифесты (детект по имени файла). */
const MANIFEST_NAMES: ReadonlySet<string> = new Set([
	NPM_MANIFEST,
	...PIP_MANIFESTS,
	CARGO_MANIFEST,
]);

/** Lockfile-уточнение npm-семейства: имя lockfile → audit-утилита. */
const NPM_LOCKFILES: ReadonlyArray<readonly [lockfile: string, cmd: string]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
];

/** Карта severity-слов утилит → схему F-2.1 (npm v7+ слова; cargo — те же). */
const SEVERITY_BY_WORD: Readonly<Record<string, Severity>> = {
	critical: "CRITICAL",
	high: "HIGH",
	moderate: "MEDIUM",
	low: "LOW",
	info: "INFO",
};

/** CVE-идентификатор (§6.2: CVE не теряются — уходят в description). */
const CVE_PATTERN = /CVE-\d{4}-\d+/g;

/**
 * Предел размера stdout audit-утилиты (patch 1.0.1, F-5): больше — недоверенный
 * вывод, парсинг не выполняется (предупреждение в stderr, манифест пропускается,
 * скан продолжается — как при отсутствии утилиты). Проверка по string.length
 * (UTF-16 единицы): для ASCII-вывода аудитов соответствует байтам; защитная
 * оценка против аномально огромного вывода (подмена утилиты/переполнение).
 */
const MAX_PARSE_BYTES = 64 * 1024 * 1024;

// ── Runner: инъекция внешних команд (единственная точка spawn) ──────────────

/**
 * Вызов audit-утилиты: команда, аргументы, рабочая директория.
 * cwd — изолированный tmp-workspace (F-6, patch 1.0.1), НЕ директория манифеста.
 */
export interface DepAuditInvocation {
	cmd: string;
	args: string[];
	cwd: string;
	/**
	 * Дополнение окружения дочернего процесса (поверх process.env). F-6: для
	 * npm — npm_config_userconfig → несуществующий файл внутри workspace
	 * (изоляция от пользовательского ~/.npmrc). Не задан → чистое окружение.
	 */
	env?: Record<string, string>;
}

/** Результат вызова audit-утилиты (синхронный, как Bun.spawnSync). */
export interface DepAuditResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Seam для тестов и окружений без npm/pip/cargo: вместо spawn подставляется
 * функция. По умолчанию — Bun.spawnSync (spawnSync(cmd, args, {cwd, env})).
 */
export type DepAuditRunner = (invocation: DepAuditInvocation) => DepAuditResult;

/** Дефолтный runner — Bun.spawnSync; ошибка запуска (нет бинарника) → exit 127. */
const defaultRunner: DepAuditRunner = ({ cmd, args, cwd, env }) => {
	try {
		const result = Bun.spawnSync([cmd, ...args], {
			cwd,
			env: env ? { ...process.env, ...env } : undefined,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			exitCode: result.exitCode,
		};
	} catch (cause) {
		return {
			stdout: "",
			stderr: cause instanceof Error ? cause.message : String(cause),
			exitCode: 127,
		};
	}
};

export interface ScanDepAuditsOptions {
	/** Инъекция внешних команд (тесты передают мок; дефолт — Bun.spawnSync). */
	runner?: DepAuditRunner;
	/** Формат вывода — забота main(), на Report не влияет. */
	format?: "json" | "text";
}

// ── Типы JSON-вывода утилит (узкие helpers вместо any) ──────────────────────

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Промежуточное представление уязвимости до привязки к манифесту. */
interface FindingDraft {
	packageName: string;
	severity: Severity;
	cwe: string;
	description: string;
	exploit: string;
	remediation: string;
	/** Fallback-evidence (цитата audit-вывода, имя + range), если объявления в манифесте нет. */
	fallbackEvidence: string;
}

// ── Поиск манифестов и сборка вызовов ───────────────────────────────────────

type ManifestKind = "npm" | "pip" | "cargo";

interface ManifestTarget {
	absolutePath: string;
	kind: ManifestKind;
}

function manifestKind(fileName: string): ManifestKind {
	if (fileName === NPM_MANIFEST) {
		return "npm";
	}
	if (PIP_MANIFESTS.has(fileName)) {
		return "pip";
	}
	return "cargo";
}

/** Манифесты в директории: рекурсивный обход (SKIP_DIRS из lib/walker.ts). */
function collectManifestsInTree(rootDir: string): ManifestTarget[] {
	return walkDirectory(rootDir)
		.filter((file) => MANIFEST_NAMES.has(path.basename(file)))
		.sort()
		.map((absolutePath) => ({ absolutePath, kind: manifestKind(path.basename(absolutePath)) }));
}

/** Одиночный файл-манифест как targetPath (паритет с F-2.2/F-2.3). */
function collectFileManifest(filePath: string): ManifestTarget[] {
	const name = path.basename(filePath);
	return MANIFEST_NAMES.has(name) ? [{ absolutePath: filePath, kind: manifestKind(name) }] : [];
}

/** Префикс tmp-workspace аудита (F-6). */
const WORKSPACE_PREFIX = "fan-dep-audit-";

/** Дополнительные файлы, копируемые в workspace рядом с манифестом (F-6). */
const WORKSPACE_EXTRA_FILES: Readonly<Record<ManifestKind, readonly string[]>> = {
	npm: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
	pip: [],
	cargo: ["Cargo.lock"],
};

/**
 * Создаёт изолированный workspace для аудита одного манифеста (F-6, patch
 * 1.0.1): mkdtemp под os.tmpdir + копия манифеста и его lockfiles. Утилита
 * запускается с cwd = workspace — конфиги сканируемого репо (.npmrc и пр.)
 * не читаются. Ошибка создания → throw (caller деградирует до пропуска
 * манифеста с предупреждением, как при недоступной утилите).
 */
function createAuditWorkspace(manifest: ManifestTarget): string {
	const workspace = mkdtempSync(path.join(tmpdir(), WORKSPACE_PREFIX));
	const manifestDir = path.dirname(manifest.absolutePath);
	copyFileSync(manifest.absolutePath, path.join(workspace, path.basename(manifest.absolutePath)));
	for (const name of WORKSPACE_EXTRA_FILES[manifest.kind]) {
		const source = path.join(manifestDir, name);
		if (existsSync(source)) {
			copyFileSync(source, path.join(workspace, name));
		}
	}
	return workspace;
}

/**
 * Ровно один вызов runner на манифест; cwd = изолированный tmp-workspace
 * (F-6, patch 1.0.1: НЕ директория манифеста — защита от .npmrc-подмены).
 * lockfile-уточнение — по ОРИГИНАНАЛЬНОЙ директории манифеста (копии кладутся
 * в workspace, см. createAuditWorkspace).
 */
function buildInvocation(manifest: ManifestTarget, workspace: string): DepAuditInvocation {
	if (manifest.kind === "npm") {
		const dir = path.dirname(manifest.absolutePath);
		const lockfile = NPM_LOCKFILES.find(([name]) => existsSync(path.join(dir, name)));
		return {
			cmd: lockfile?.[1] ?? "npm",
			args: ["audit", "--json"],
			cwd: workspace,
			// F-6: изоляция пользовательского npm-конфига (~/.npmrc) — registry из
			// недоверенного конфига не должен влиять на аудит; project-.npmrc уже
			// отсечён самим cwd=workspace.
			env: { npm_config_userconfig: path.join(workspace, ".npmrc-isolated") },
		};
	}
	if (manifest.kind === "pip") {
		return { cmd: "pip-audit", args: ["--format", "json"], cwd: workspace };
	}
	return { cmd: "cargo", args: ["audit", "--json"], cwd: workspace };
}

// ── Сканирование ────────────────────────────────────────────────────────────

/**
 * Сканирует файл-манифест или директорию (рекурсивно) на уязвимые зависимости.
 * Возвращает Report по схеме F-2.1 (tool: "dep-audit").
 * Несуществующий targetPath → throw (main() превращает в exit 2).
 * Отчёт не печатается (печать — забота main()); предупреждения — console.error.
 */
export async function scanDepAudits(
	targetPath: string,
	options: ScanDepAuditsOptions = {},
): Promise<Report> {
	const runner = options.runner ?? defaultRunner;

	let stats;
	try {
		stats = statSync(targetPath);
	} catch (cause) {
		throw new Error(`цель сканирования не существует или недоступна: ${targetPath}`, { cause });
	}

	const isDirectory = stats.isDirectory();
	const root = isDirectory ? targetPath : path.dirname(targetPath);
	const manifests = isDirectory ? collectManifestsInTree(targetPath) : collectFileManifest(targetPath);

	if (manifests.length === 0) {
		// §3.3: отсутствие манифестов — информативное сообщение, не ошибка (exit 0).
		console.error(
			`dep-audit: манифесты зависимостей не найдены в ${targetPath} ` +
				`(проверяются: ${[...MANIFEST_NAMES].join(", ")}) — аудит не запускался`,
		);
		return createReport({ tool: TOOL, version: VERSION, target: targetPath, findings: [] });
	}

	let counter = 0;
	const nextId = () => `SEC-${String(++counter).padStart(3, "0")}`;

	const findings: Finding[] = [];
	for (const manifest of manifests) {
		findings.push(...auditManifest(manifest, root, runner, nextId));
	}

	return createReport({ tool: TOOL, version: VERSION, target: targetPath, findings });
}

/**
 * Аудит одного манифеста: изолированный tmp-workspace (F-6), вызов утилиты,
 * парсинг JSON, маппинг в findings. line/evidence — по ОРИГИНАЛЬНОМУ манифесту.
 * Отсутствие утилиты (exitCode ≠ 0 И stdout пуст/не-JSON) → предупреждение
 * в stderr, findings нет, скан продолжается (частичная деградация).
 * Валидный JSON при exitCode ≠ 0 (npm audit при уязвимостях) парсится нормально.
 * Ошибка создания workspace → предупреждение + манифест пропущен (не падение).
 * Workspace удаляется после вызова (finally) — там только копии манифестов.
 */
function auditManifest(
	manifest: ManifestTarget,
	root: string,
	runner: DepAuditRunner,
	nextId: () => string,
): Finding[] {
	const relFile = toPosix(path.relative(root, manifest.absolutePath)) || path.basename(manifest.absolutePath);

	let workspace: string;
	try {
		workspace = createAuditWorkspace(manifest);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		console.error(
			`dep-audit: не удалось создать изолированный workspace для ${relFile} (${detail}) — ` +
				`манифест пропущен, скан продолжается`,
		);
		return [];
	}

	try {
		return auditManifestInWorkspace(manifest, relFile, workspace, runner, nextId);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/** Тело аудита внутри workspace (вызывается из auditManifest, F-6). */
function auditManifestInWorkspace(
	manifest: ManifestTarget,
	relFile: string,
	workspace: string,
	runner: DepAuditRunner,
	nextId: () => string,
): Finding[] {
	const invocation = buildInvocation(manifest, workspace);

	let result: DepAuditResult;
	try {
		result = runner(invocation);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		console.error(
			`dep-audit: утилита "${invocation.cmd}" недоступна (ошибка запуска: ${detail}) — ` +
				`манифест ${relFile} пропущен, скан продолжается`,
		);
		return [];
	}

	// F-5 (patch 1.0.1): аномально огромный stdout — недоверенный вывод, парсинг
	// не выполняется (как отсутствие утилиты: предупреждение + манифест пропущен).
	if (result.stdout.length > MAX_PARSE_BYTES) {
		console.error(
			`dep-audit: вывод "${invocation.cmd}" для ${relFile} превышает ${MAX_PARSE_BYTES} байт — ` +
				`недоверенный вывод, манифест ${relFile} пропущен, скан продолжается`,
		);
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout.trim());
	} catch {
		if (result.exitCode !== 0) {
			const detail = firstLine(result.stderr) ?? `exit code ${result.exitCode}`;
			console.error(
				`dep-audit: утилита "${invocation.cmd}" недоступна (${detail}) — ` +
					`манифест ${relFile} пропущен, скан продолжается`,
			);
		} else {
			console.error(
				`dep-audit: вывод "${invocation.cmd}" для ${relFile} не разобран (не JSON) — манифест пропущен`,
			);
		}
		return [];
	}

	const drafts =
		manifest.kind === "npm"
			? parseNpmAudit(parsed)
			: manifest.kind === "pip"
				? parsePipAudit(parsed)
				: parseCargoAudit(parsed);

	const manifestLines = readLinesSafe(manifest.absolutePath);
	return drafts.map((draft) => finalizeFinding(draft, relFile, manifest.kind, manifestLines, nextId));
}

// ── Парсеры вывода утилит ───────────────────────────────────────────────────

function severityFromWord(word: unknown): Severity | undefined {
	if (typeof word !== "string") {
		return undefined;
	}
	return SEVERITY_BY_WORD[word.toLowerCase()];
}

/** Первый CWE-идентификатор из advisory.cwe (npm via-объект) или undefined. */
function pickCwe(advisory: JsonRecord | undefined): string | undefined {
	for (const entry of asArray(advisory?.cwe)) {
		if (typeof entry === "string" && /^CWE-\d+$/.test(entry)) {
			return entry;
		}
	}
	return undefined;
}

/** CVE-идентификаторы (CVE-\d{4}-\d+) из полей via/url/title/aliases — уникальные, по порядку. */
function extractCves(sources: unknown[]): string[] {
	const found: string[] = [];
	for (const source of sources) {
		if (source === undefined || source === null) {
			continue;
		}
		const text = typeof source === "string" ? source : JSON.stringify(source);
		if (!text) {
			continue;
		}
		for (const match of text.matchAll(CVE_PATTERN)) {
			if (!found.includes(match[0])) {
				found.push(match[0]);
			}
		}
	}
	return found;
}

function joinDescription(parts: (string | undefined)[]): string {
	return parts
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("; ");
}

/**
 * npm/pnpm/yarn audit: JSON.vulnerabilities{} (формат v7+/v9).
 * 1 запись vulnerabilities → 1 finding; cwe — из первого via-advisory,
 * для транзитивных (via-строка) — дефолт CWE-1395; CVE из via → description.
 */
function parseNpmAudit(parsed: unknown): FindingDraft[] {
	const vulnerabilities = asRecord(asRecord(parsed)?.vulnerabilities);
	if (!vulnerabilities) {
		return [];
	}

	const drafts: FindingDraft[] = [];
	for (const [key, rawVuln] of Object.entries(vulnerabilities)) {
		const vuln = asRecord(rawVuln);
		if (!vuln) {
			continue;
		}
		const name = asString(vuln.name) ?? key;
		const vias = asArray(vuln.via);
		const advisory = vias.map(asRecord).find((entry) => entry !== null) ?? undefined;
		const cves = extractCves([vias]);
		const range = asString(vuln.range);

		const fix = asRecord(vuln.fixAvailable);
		const fixVersion = fix ? asString(fix.version) : undefined;
		const remediation = fixVersion
			? `Fix available: upgrade to ${fixVersion}` +
				(fix?.isSemVerMajor === true ? " (major update)" : "")
			: vuln.fixAvailable === true
				? "Fix available: run `npm audit fix` (точная версия неизвестна)"
				: "No fix available";

		drafts.push({
			packageName: name,
			severity: severityFromWord(vuln.severity) ?? "MEDIUM",
			cwe: pickCwe(advisory) ?? DEFAULT_CWE,
			description: joinDescription([
				advisory ? (asString(advisory.title) ?? asString(advisory.name)) : undefined,
				range ? `уязвимый диапазон версий: ${range}` : undefined,
				cves.length > 0 ? `CVE: ${cves.join(", ")}` : undefined,
				vias.some((via) => typeof via === "string")
					? `транзитивная зависимость (via: ${vias
							.filter((via) => typeof via === "string")
							.join(", ")})`
					: undefined,
			]),
			exploit:
				`Эксплуатация через цепочку поставок: уязвимый код ${name} ` +
				`исполняется при использовании зависимости приложением.`,
			remediation,
			fallbackEvidence: range ? `${name} (range: ${range})` : `${name} (npm audit)`,
		});
	}
	return drafts;
}

/**
 * pip-audit --format json: JSON-массив [{name, version, aliases, fix_versions,
 * description}]. pip-audit не отдаёт severity → дефолт MEDIUM
 * (задокументированный выбор); CWE нет → дефолт CWE-1395; aliases (CVE) →
 * description; fix_versions[0] → «upgrade to».
 */
function parsePipAudit(parsed: unknown): FindingDraft[] {
	if (!Array.isArray(parsed)) {
		return [];
	}

	const drafts: FindingDraft[] = [];
	for (const rawEntry of parsed) {
		const entry = asRecord(rawEntry);
		if (!entry) {
			continue;
		}
		const name = asString(entry.name);
		if (!name) {
			continue;
		}
		const cves = extractCves([entry.aliases, entry.description]);
		const fixVersions = asArray(entry.fix_versions)
			.map((version) => (typeof version === "string" ? version : undefined))
			.filter((version): version is string => version !== undefined);
		const version = asString(entry.version);

		drafts.push({
			packageName: name,
			severity: "MEDIUM",
			cwe: DEFAULT_CWE,
			description: joinDescription([
				asString(entry.description),
				cves.length > 0 ? `CVE: ${cves.join(", ")}` : undefined,
			]),
			exploit:
				`Эксплуатация через цепочку поставок: уязвимый код ${name} ` +
				`исполняется при использовании зависимости приложением.`,
			remediation:
				fixVersions.length > 0
					? `Fix available: upgrade to ${fixVersions[0]}`
					: "No fix available (pip-audit)",
			fallbackEvidence: `${name}==${version ?? "?"}`,
		});
	}
	return drafts;
}

/**
 * cargo audit --json: RustSec-JSON {"vulnerabilities":{"list":[…]}}.
 * severity — карта слов от advisory.severity, без поля — дефолт HIGH;
 * CWE нет → дефолт CWE-1395; aliases/url (CVE) → description; patched[0] →
 * «upgrade to».
 */
function parseCargoAudit(parsed: unknown): FindingDraft[] {
	const list = asArray(asRecord(asRecord(parsed)?.vulnerabilities)?.list);

	const drafts: FindingDraft[] = [];
	for (const rawItem of list) {
		const item = asRecord(rawItem);
		if (!item) {
			continue;
		}
		const advisory = asRecord(item.advisory) ?? {};
		const pkg = asRecord(item.package) ?? {};
		const name = asString(pkg.name) ?? asString(advisory.package);
		if (!name) {
			continue;
		}
		const cves = extractCves([advisory.aliases, advisory.url]);
		const patched = asArray(asRecord(item.versions)?.patched)
			.map((entry) => (typeof entry === "string" ? entry : undefined))
			.filter((entry): entry is string => entry !== undefined);
		const advisoryId = asString(advisory.id);

		drafts.push({
			packageName: name,
			severity: severityFromWord(advisory.severity) ?? "HIGH",
			cwe: DEFAULT_CWE,
			description: joinDescription([
				asString(advisory.title),
				advisoryId ? `advisory: ${advisoryId}` : undefined,
				cves.length > 0 ? `CVE: ${cves.join(", ")}` : undefined,
			]),
			exploit:
				`Эксплуатация через цепочку поставок: уязвимый код крейта ${name} ` +
				`исполняется при использовании зависимости приложением.`,
			remediation:
				patched.length > 0
					? `Fix available: upgrade to ${patched[0]}`
					: "No fix available (cargo audit)",
			fallbackEvidence: `${name} (${advisoryId ?? "RustSec advisory"})`,
		});
	}
	return drafts;
}

// ── Привязка к манифесту: file/line/evidence ────────────────────────────────

/**
 * Ищет строку объявления пакета в манифесте (1-based) — цитата становится
 * evidence. Для транзитивных зависимостей объявления нет → null (line 0,
 * evidence — fallback из audit-вывода).
 *
 * Поиск по типу манифеста:
 * - package.json — строка, содержащая "имя" в кавычках (JSON-ключ зависимости);
 * - requirements.txt / pyproject.toml — строка с `имя==` или `имя =` (первое
 *   вхождение подстроки, как в fixture requirements.txt: комментарий с
 *   `fake-flask==0.5` предшествует объявлению);
 * - Cargo.toml — строка `имя = "…"` в [dependencies] (anchored, комментарии не
 *   матчатся).
 */
function findDeclaration(
	lines: string[],
	kind: ManifestKind,
	packageName: string,
): { line: number; evidence: string } | null {
	const escaped = escapeRegExp(packageName);
	const pattern =
		kind === "npm"
			? null
			: kind === "pip"
				? new RegExp(`${escaped}\\s*[=<>!~\\[]`)
				: new RegExp(`^\\s*"?${escaped}"?\\s*=`);

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const matched =
			kind === "npm" ? line.includes(`"${packageName}"`) : (pattern?.test(line) ?? false);
		if (matched) {
			return { line: index + 1, evidence: clipEvidence(line) };
		}
	}
	return null;
}

/** Привязка draft к манифесту: scanner "dep-audit", file/line/evidence, confirmed. */
function finalizeFinding(
	draft: FindingDraft,
	relFile: string,
	kind: ManifestKind,
	manifestLines: string[],
	nextId: () => string,
): Finding {
	const declaration = findDeclaration(manifestLines, kind, draft.packageName);
	return {
		id: nextId(),
		scanner: TOOL,
		severity: draft.severity,
		title: `Vulnerable dependency: ${draft.packageName}`,
		file: relFile,
		line: declaration ? declaration.line : 0,
		cwe: draft.cwe,
		evidence: declaration ? declaration.evidence : clipEvidence(draft.fallbackEvidence),
		description: draft.description,
		exploit: draft.exploit,
		remediation: draft.remediation,
		confidence: "confirmed",
	};
}

/**
 * Evidence ≤ 300 символов (§6.1): цитата строки манифеста или audit-вывода,
 * санитизированная через sanitizeEvidence (patch 1.0.1 F-1 — маскирование
 * секретов/высокоэнтропийных токенов во всех источниках evidence).
 */
function clipEvidence(text: string): string {
	return sanitizeEvidence(text.trim());
}

/** Строки манифеста для поиска объявлений; ошибка чтения → без объявлений. */
function readLinesSafe(filePath: string): string[] {
	try {
		return readFileSync(filePath, "utf8").split(/\r?\n/);
	} catch {
		return [];
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstLine(text: string): string | undefined {
	return asString(text.split(/\r?\n/, 1)[0]?.trim());
}

/** Относительный путь в POSIX-стиле (единый вид отчёта на Win/Linux/macOS). */
function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

// ── CLI (§3.3, §4.1) ────────────────────────────────────────────────────────

/** Тип вывода main(): json | text (text — дефолт, как F-2.2/F-2.3). */
export type OutputFormat = "json" | "text";

export interface MainOptions {
	/** Инъекция runner в scanDepAudits (иначе — дефолтный Bun.spawnSync). */
	runner?: DepAuditRunner;
}

/**
 * CLI-входная точка: парсит [target] [--format json|text], печатает отчёт и
 * ВОЗВРАЩАЕТ exit-код (resolveExitCode): 0 — чисто, 1 — findings, 2 — ошибка.
 * process.exit НЕ вызывает — только обёртка import.meta.main ниже.
 * Вывод — исключительно console.log (stdout) / console.error (stderr):
 * `--format json` — весь stdout валидный JSON без посторонних строк (§4.1).
 */
export async function main(argv?: string[], options: MainOptions = {}): Promise<number> {
	const args = argv ?? process.argv.slice(2);
	let target: string | undefined;
	let format: OutputFormat = "text"; // text — дефолт

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--format") {
			const value = args[index + 1] as OutputFormat | undefined;
			if (value !== "json" && value !== "text") {
				console.error(`dep-audit: недопустимое значение --format "${String(value)}" (ожидается json|text)`);
				return 2;
			}
			format = value;
			index += 1;
		} else if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length) as OutputFormat;
			if (value !== "json" && value !== "text") {
				console.error(`dep-audit: недопустимое значение --format "${value}" (ожидается json|text)`);
				return 2;
			}
			format = value;
		} else if (arg.startsWith("-") && arg.length > 1) {
			console.error(`dep-audit: неизвестная опция "${arg}" (поддерживается --format json|text)`);
			return 2;
		} else if (target === undefined) {
			target = arg;
		} else {
			console.error(`dep-audit: лишний позиционный аргумент "${arg}" (путь указывается один раз)`);
			return 2;
		}
	}

	if (!target) {
		console.error("Использование: bun cli/dep-audit.ts <путь> [--format json|text] (text — по умолчанию)");
		return 2;
	}

	try {
		const report = await scanDepAudits(target, { runner: options.runner });
		// §4.1: --format json без лишнего вывода — весь stdout валидный JSON
		console.log(format === "json" ? JSON.stringify(report, null, "\t") : renderText(report));
		return resolveExitCode(report);
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		console.error(`dep-audit: ${error.message}`);
		return resolveExitCode(null, error);
	}
}

// CLI-обёртка для прямого запуска: bun cli/dep-audit.ts <path> [--format …]
if (import.meta.main) {
	process.exit(await main());
}
