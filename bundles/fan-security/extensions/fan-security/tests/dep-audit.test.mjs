/**
 * TDD RED tests for F-2.4 «CLI dep-audit (cli/dep-audit.ts)».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.4» (TC-F-2.4-1/2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4 (CLI-сканеры), §5.3
 *       (npm/pnpm/yarn audit, pip-audit, cargo audit — опционально, через bash),
 *       §3.3 (exit-коды; отсутствие манифестов/утилит — сообщение, не падение),
 *       §6.1 (схема Finding, scanner: "dep-audit"), §6.2 (контракты CLI).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза) —
 * extensions/fan-security/cli/dep-audit.ts экспортирует:
 *
 *   1) scanDepAudits(targetPath: string, options?: ScanDepAuditsOptions): Promise<Report>
 *      - options.runner?: DepAuditRunner — инъекция внешних команд; где
 *        DepAuditRunner = (invocation: {cmd: string, args: string[], cwd: string})
 *          => {stdout: string, stderr: string, exitCode: number};
 *        runner вызывается для КАЖДОЙ audit-утилиты (никаких других spawn/exec
 *        в модуле); ПО УМОЛЧАНИЮ — Bun.spawnSync (spawnSync(cmd, args, {cwd}));
 *        ТЕСТЫ ВСЕГДА передают runner — дефолт реальными утилитами не покрыт;
 *      - targetPath — файл-манифест ИЛИ директория (рекурсивный обход через
 *        lib/walker.ts; node_modules/.git/… пропускаются — SKIP_DIRS);
 *      - детект манифестов ПО ИМЕНИ файла: package.json, requirements.txt,
 *        pyproject.toml, Cargo.toml;
 *      - на КАЖДЫЙ найденный манифест — ровно ОДИН вызов runner:
 *          • package.json → cmd "npm", args содержат "audit" и "--json";
 *            (lockfile-уточнение: pnpm-lock.yaml → cmd "pnpm", yarn.lock → "yarn");
 *          • requirements.txt ИЛИ pyproject.toml → cmd "pip-audit",
 *            args содержат "--format" и "json";
 *          • Cargo.toml → cmd "cargo", args содержат "audit" и "--json";
 *          • cwd = директория манифеста;
 *      - парсинг вывода (1 запись уязвимости → РОВНО 1 finding, без дублей):
 *          • npm/pnpm/yarn: JSON.vulnerabilities{} (формат npm audit v7+/v9,
 *            fixture tests/fixtures/npm-audit-output.json); severity-карта СЛОВ:
 *            critical→CRITICAL, high→HIGH, moderate→MEDIUM, low→LOW, info→INFO;
 *          • pip-audit: JSON-массив [{name, version, aliases: ["CVE-…"],
 *            fix_versions: ["…"], description}]; pip-audit не отдаёт severity →
 *            дефолт "MEDIUM" (задокументированный выбор);
 *          • cargo audit: JSON {"vulnerabilities": {"list": [{advisory: {id,
 *            title, aliases, severity?, url}, package: {name, version},
 *            versions: {patched: []}}]}} (RustSec); severity — карта слов от
 *            advisory.severity, при отсутствии поля — дефолт "HIGH";
 *      - поля Finding (схема F-2.1):
 *          • scanner = "dep-audit" для ВСЕХ findings (в т.ч. pip/cargo);
 *          • title СОДЕРЖИТ имя пакета/крейта;
 *          • cwe: первый CWE из advisory.cwe (npm) ИЛИ "CWE-1395"
 *            (Dependency on Vulnerable Third-Party Component) — дефолт, когда
 *            utility не отдаёт CWE (npm via-строка, pip-audit, cargo);
 *          • CVE-идентификаторы (паттерн CVE-\d{4}-\d+ в полях via/url/title/
 *            aliases) попадают В description — ЗАДОКУМЕНТИРОВАННЫЙ ВЫБОР
 *            (поле cwe — только для CWE-идентификаторов формата «CWE-NNN»,
 *            CVE не теряются); тест чинит именно description;
 *          • remediation: при известной fix-версии содержит «upgrade to <версия>»
 *            (npm fixAvailable.version; pip fix_versions[0]; cargo patched[0]);
 *          • file — манифест, ПО которому запускался аудит, относительно корня
 *            сканирования (POSIX-стиль); line — строка объявления пакета в
 *            манифесте (1-based); для транзитивных зависимостей (объявления нет
 *            в манифесте) — line 0 (неприменимо, разрешено схемой F-2.1);
 *          • evidence ≤ 300 символов: цитата строки манифеста с объявлением
 *            пакета (если найдена), иначе краткая цитата audit-вывода
 *            (имя + range) — всегда непустая;
 *          • confidence = "confirmed" (утилита сверяет установленные версии с БД);
 *      - утилита ОТСУТСТВУЕТ (exitCode ≠ 0 И stdout пуст/не-JSON) →
 *        предупреждение в stderr через console.error (с именем утилиты),
 *        findings от неё НЕ создаются, скан ПРОДОЛЖАЕТСЯ (частичная деградация),
 *        отчёт валиден; это НЕ ошибка сканера (exit 0 при отсутствии findings);
 *        ВАЖНО: exitCode ≠ 0 при ВАЛИДНОМ JSON в stdout — НЕ отсутствие утилиты
 *        (реальный npm audit выходит с кодом 1 при найденных уязвимостях);
 *      - манифестов НЕТ → findings=[], предупреждение «no manifests» в stderr,
 *        exit 0 (спека §3.3: информативное сообщение, не падение);
 *      - несуществующий targetPath → throw/reject (main() превращает в exit 2);
 *      - unit-функция НЕ печатает отчёт (печать — забота main()).
 *
 *   2) main(argv?: string[], options?: {runner?}): Promise<number>
 *      - argv: [target] [--format json|text]; по умолчанию process.argv.slice(2);
 *        options прокидывает runner в scanDepAudits (иначе — дефолтный);
 *      - text — ДЕФОЛТ (как F-2.2/F-2.3): stdout = renderText(report);
 *      - json: ВЕСЬ stdout — валидный JSON.stringify(report) без посторонних
 *        строк (§4.1); предупреждения (no manifests / нет утилиты) — в stderr;
 *      - main() ВОЗВРАЩАЕТ exit-код (resolveExitCode, §3.3: 0/1/2) и НЕ вызывает
 *        process.exit — он только в CLI-обёртке import.meta.main;
 *      - без позиционного аргумента → 2 + usage в stderr; несуществующий путь → 2.
 *
 * РЕШЕНИЕ ПО ЗАПУСКУ (как F-2.2/F-2.3): scanDepAudits/main тестируются НАПРЯМУЮ
 * через import (guard + requireExport); stdout/stderr перехват vi.spyOn(console,…).
 * Реальные утилиты (npm/pip/cargo) НЕ вызываются — вместо этого мок-runner,
 * возвращающий fixture-выводы; это и есть документированный seam для Green
 * («runner({cmd, args, cwd}) → {stdout, stderr, exitCode}»).
 *
 * Red-ожидание (roadmap): «TC-F-2.4-1 — падает первым: cli/dep-audit.ts не
 * существует». Все падения должны читаться как «модуля/экспорта нет» (guard-хелпер
 * даёт понятное сообщение), а не «тест сломан». Fixtures: tests/fixtures/
 * dep-fixture/ (3 манифеста: package.json, requirements.txt, Cargo.toml),
 * empty-dep-fixture/ (без манифестов), npm-audit-output.json (формат npm audit
 * v9+; пакеты fake-* и CVE-2025-99999 вымышлены). Все pip/cargo-выводы —
 * синтетические константы в этом файле с тем же смыслом.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/report.ts уже существует (F-2.1 COMPLETED) — статический импорт для ожиданий/exit-кодов
import { maskSecret, resolveExitCode, SEVERITIES } from "../lib/report.ts";

const SCANNER_URL = "../cli/dep-audit.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(testsDir, "fixtures");
const DEP_FIXTURE = path.join(FIXTURES, "dep-fixture");
const EMPTY_DEP_FIXTURE = path.join(FIXTURES, "empty-dep-fixture");
const NPM_AUDIT_OUTPUT_FILE = path.join(FIXTURES, "npm-audit-output.json");

/** Fixture-вывод `npm audit --json` (реалистичный формат npm audit v9+, фейковые пакеты). */
const NPM_AUDIT_JSON = readFileSync(NPM_AUDIT_OUTPUT_FILE, "utf8");
const NPM_AUDIT = JSON.parse(NPM_AUDIT_JSON);

/** Синтетический вывод `pip-audit --format json` (реальный формат: массив объектов). */
const PIP_AUDIT_OUTPUT = [
	{
		name: "fake-flask",
		version: "0.5",
		aliases: ["CVE-2026-41111"],
		fix_versions: ["1.0"],
		description: "Fake denial-of-service in fake-flask (fixture, not a real advisory).",
	},
];

/** Синтетический вывод `cargo audit --json` (RustSec-подмножество схемы cargo-audit). */
const CARGO_AUDIT_OUTPUT = {
	type: 1,
	vulnerabilities: {
		list: [
			{
				advisory: {
					id: "RUSTSEC-2026-0001",
					package: "fake-crate",
					title: "Fake remote code execution in fake-crate",
					aliases: ["CVE-2026-424242"],
					severity: "high",
					url: "https://rustsec.org/advisories/RUSTSEC-2026-0001",
				},
				versions: { patched: [">=0.2.0"] },
				package: { name: "fake-crate", version: "0.1.0" },
			},
		],
		count: 1,
		total: 1,
	},
};

/** Все 12 обязательных полей Finding по §6.1 (схема F-2.1). */
const FINDING_FIELDS = [
	"id",
	"scanner",
	"severity",
	"title",
	"file",
	"line",
	"cwe",
	"evidence",
	"description",
	"exploit",
	"remediation",
	"confidence",
];

let scannerModulePromise;

/**
 * Guard: загрузка целевого модуля. При Red (cli/dep-audit.ts нет) каждый тест
 * падает с читаемой причиной вместо сырого "Cannot find module".
 */
function loadScanner() {
	if (!scannerModulePromise) {
		scannerModulePromise = import(SCANNER_URL).catch((cause) => {
			scannerModulePromise = undefined; // разрешить повторную попытку в следующем тесте
			throw new Error(
				`cli/dep-audit.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/cli/dep-audit.ts по контракту из шапки этого файла ` +
					`(roadmap F-2.4, Red-фаза TDD): экспорт scanDepAudits(targetPath, options? & {runner?}) → ` +
					`Promise<Report> + main(argv?, options?) → Promise<number>.`,
			);
		});
	}
	return scannerModulePromise;
}

/**
 * Guard: проверка наличия экспорта с читаемым сообщением. Прозрачный Proxy,
 * поддерживающий оба стиля доступа (см. report.test.mjs / scan-secrets.test.mjs).
 * Продублирован локально, чтобы не трогать файлы F-2.1–F-2.3.
 */
function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`cli/dep-audit.ts не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). Дополни экспорты по контракту — шапка этого файла, roadmap F-2.4.`,
		);
	}
	return new Proxy(value, {
		get(target, prop) {
			if (prop === name) {
				return target;
			}
			return Reflect.get(target, prop);
		},
	});
}

/** Перехват stdout/stderr (контракт: main()/unit печатают только через console.*). */
function captureConsole() {
	const out = [];
	const err = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
	const errSpy = vi
		.spyOn(console, "error")
		.mockImplementation((...args) => err.push(args.join(" ")));
	return {
		out,
		err,
		stdout: () => out.join("\n"),
		stderr: () => err.join("\n"),
		restore() {
			logSpy.mockRestore();
			errSpy.mockRestore();
		},
	};
}

/**
 * Мок-runner: инъекция вместо Bun.spawnSync (контракт шапки). Записывает вызовы
 * в calls; ответ по cmd — из defaults, переопределения — через overrides
 * ({...base, ...overrides[cmd]}).
 */
function makeRunner(overrides = {}) {
	const calls = [];
	const defaults = {
		npm: { stdout: NPM_AUDIT_JSON, stderr: "", exitCode: 0 },
		"pip-audit": { stdout: JSON.stringify(PIP_AUDIT_OUTPUT), stderr: "", exitCode: 0 },
		cargo: { stdout: JSON.stringify(CARGO_AUDIT_OUTPUT), stderr: "", exitCode: 0 },
	};
	const runner = (invocation) => {
		calls.push({ ...invocation });
		const base = defaults[invocation.cmd] ?? {
			stdout: "",
			stderr: `command not found: ${invocation.cmd}`,
			exitCode: 127,
		};
		return { ...base, ...(overrides[invocation.cmd] ?? {}) };
	};
	return { calls, runner };
}

/** Мок-runner, у которого ВСЕ утилиты отсутствуют (exit 127, «command not found»). */
function makeUnavailableRunner() {
	const calls = [];
	const runner = (invocation) => {
		calls.push({ ...invocation });
		return { stdout: "", stderr: `command not found: ${invocation.cmd}`, exitCode: 127 };
	};
	return { calls, runner };
}

/**
 * Обёртка makeRunner, проверяющая изоляцию cwd на момент вызова (F-6, patch
 * 1.0.1): workspace существует ТОЛЬКО во время вызова runner (удаляется после),
 * поэтому копии манифестов фиксируются внутри вызова: cwd — tmp-директория
 * (не директория манифеста), в ней лежит скопированный манифест.
 */
function makeWorkspaceCheckingRunner(overrides = {}) {
	const base = makeRunner(overrides);
	const calls = [];
	const COPIABLE = [
		"package.json",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"requirements.txt",
		"pyproject.toml",
		"Cargo.toml",
		"Cargo.lock",
	];
	const runner = (invocation) => {
		const result = base.runner(invocation);
		calls.push({
			...invocation,
			/** cwd — изолированный tmp-workspace (родитель — os.tmpdir(), как у mkdtemp). */
			cwdIsTmpWorkspace:
				path.dirname(path.resolve(invocation.cwd)) === path.resolve(tmpdir()),
			/** Файлы, скопированные в workspace на момент вызова. */
			copiedManifests: COPIABLE.filter((name) => existsSync(path.join(invocation.cwd, name))),
		});
		return result;
	};
	return { calls, runner };
}

/** Временная директория для pattern-тестов (auto-cleanup в afterEach). */
const tempDirs = [];
function makeTempDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-dep-audit-"));
	tempDirs.push(dir);
	return dir;
}

/** Записывает файл во временную директорию (строки массива → строки файла). */
function writeTempFile(dir, name, lines) {
	const file = path.join(dir, name);
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
	return file;
}

/** Строки fixture (1-based нумерация снаружи). */
function fixtureLines(file) {
	return readFileSync(file, "utf8").split(/\r?\n/);
}

/**
 * 1-based номер первой строки fixture, содержащей needle. Точное положение строки
 * фиксируется здесь (а не хардкодом номеров) — fixture можно дополнять.
 */
function lineOf(lines, needle, label = needle) {
	const index = lines.findIndex((line) => line.includes(needle));
	expect(
		index,
		`fixture не содержит строку-маркер «${label}» — обнови fixture или тест (шапка fixture)`,
	).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** Findings по имени пакета в title (контракт: title содержит имя пакета). */
function findingsForPackage(report, name) {
	return report.findings.filter((f) => f.title.includes(name));
}

/**
 * Инварианты схемы F-2.1 для отчёта dep-audit: 6 полей Report, 12 полей Finding,
 * enum'ы severity/confidence, консистентный summary, уникальные id, scanner
 * "dep-audit", относительные POSIX-пути манифестов, evidence ≤ 300, line ≥ 0
 * (0 допустим ТОЛЬКО для транзитивных зависимостей — контракт шапки).
 */
function expectDepAuditSchema(report) {
	expect(Object.keys(report).sort()).toEqual(
		["findings", "scannedAt", "summary", "target", "tool", "version"].sort(),
	);
	expect(report.tool).toBe("dep-audit");
	expect(typeof report.version).toBe("string");
	expect(report.version.length).toBeGreaterThan(0);
	expect(report.summary.total).toBe(report.findings.length);
	for (const finding of report.findings) {
		expect(Object.keys(finding).sort()).toEqual([...FINDING_FIELDS].sort());
		expect(SEVERITIES).toContain(finding.severity);
		expect(finding.scanner).toBe("dep-audit");
		expect(finding.cwe).toMatch(/^CWE-\d+$/);
		expect(["confirmed", "needs-verification"]).toContain(finding.confidence);
		expect(typeof finding.evidence).toBe("string");
		expect(finding.evidence.length, "evidence — непустая цитата").toBeGreaterThan(0);
		expect(finding.evidence.length, "evidence ограничен 300 символами (контракт шапки)").toBeLessThanOrEqual(
			300,
		);
		expect(finding.file, "путь манифеста должен быть относительным").not.toMatch(
			/^([A-Za-z]:)?[\\/]/,
		);
		expect(finding.file, "путь в POSIX-стиле").not.toContain("\\");
		expect(finding.line, "line: 1-based, 0 — для транзитивных (контракт шапки)").toBeGreaterThanOrEqual(0);
	}
	const ids = report.findings.map((f) => f.id);
	expect(new Set(ids).size, "id должны быть уникальны в рамках отчёта").toBe(ids.length);
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("TC-F-2.4-1: парсит вывод npm audit в findings (dep-fixture + npm-audit-output.json, мок-runner)", () => {
	it("scanDepAudits → ровно по 1 finding на уязвимость npm: severity-карта, title с именем пакета, scanner dep-audit, exit 1", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeRunner();

		// Предусловие: fixture содержит уязвимости трёх уровней (critical/high/moderate)
		const fixtureSeverities = Object.values(NPM_AUDIT.vulnerabilities)
			.map((v) => v.severity)
			.sort();
		expect(fixtureSeverities).toEqual(["critical", "high", "moderate"]);

		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		// Маппинг severity npm-слов → схему F-2.1 (без потерь, критерий приёмки 2)
		const critical = findingsForPackage(report, "fake-pkg-critical");
		expect(critical.length, "fake-pkg-critical: ожидался ровно 1 finding").toBe(1);
		expect(critical[0].severity, "critical → CRITICAL").toBe("CRITICAL");

		const high = findingsForPackage(report, "fake-pkg-high");
		expect(high.length, "fake-pkg-high: ожидался ровно 1 finding").toBe(1);
		expect(high[0].severity, "high → HIGH").toBe("HIGH");

		const moderate = findingsForPackage(report, "fake-pkg-moderate");
		expect(moderate.length, "fake-pkg-moderate: ожидался ровно 1 finding").toBe(1);
		expect(moderate[0].severity, "moderate → MEDIUM").toBe("MEDIUM");

		// Общие инварианты: scanner из §6.1 (для всех), title содержит имя пакета
		for (const finding of [critical[0], high[0], moderate[0]]) {
			expect(finding.scanner).toBe("dep-audit");
		}
		expect(critical[0].title).toContain("fake-pkg-critical");
		expect(high[0].title).toContain("fake-pkg-high");
		expect(moderate[0].title).toContain("fake-pkg-moderate");

		expect(resolveExitCode(report)).toBe(1);
		expect(calls.length, "манифестов в fixture 3 → 3 вызова runner").toBe(3);
	});

	it("CVE из via попадает в description, cwe — из advisory (CWE-94); задокументированный выбор шапки", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner();

		const report = await scanDepAudits(DEP_FIXTURE, { runner });
		const critical = findingsForPackage(report, "fake-pkg-critical")[0];

		// Выбор по контракту: cwe — только CWE-идентификаторы; CVE — в description
		expect(critical.cwe, "первый CWE из advisory.cwe via-адвизори").toBe("CWE-94");
		expect(critical.description, "CVE-2025-99999 (url в via) не должен потеряться").toContain(
			"CVE-2025-99999",
		);
	});

	it("транзитивная уязвимость (via-строка, без своего advisory): cwe-дефолт CWE-1395, line 0, evidence-fallback ≤ 300", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner();

		const report = await scanDepAudits(DEP_FIXTURE, { runner });
		const high = findingsForPackage(report, "fake-pkg-high")[0];

		// fake-pkg-high НЕ объявлен в dep-fixture/package.json — транзитивный
		expect(high.cwe, "нет своего advisory → дефолт CWE-1395 (контракт шапки)").toBe("CWE-1395");
		expect(high.file).toBe("package.json"); // аудит шёл ПО этому манифесту
		expect(high.line, "объявления нет в манифесте → line 0 (неприменимо)").toBe(0);
		expect(high.evidence.length).toBeGreaterThan(0);
		expect(high.evidence.length).toBeLessThanOrEqual(300);
		expect(high.evidence, "evidence-fallback содержит имя пакета").toContain("fake-pkg-high");
	});

	it("remediation «upgrade to X»: версия из fixAvailable (9.9.9) для critical", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner();

		const report = await scanDepAudits(DEP_FIXTURE, { runner });
		const critical = findingsForPackage(report, "fake-pkg-critical")[0];

		expect(critical.remediation).toMatch(/upgrade to/i);
		expect(critical.remediation).toContain("9.9.9");
	});

	it("evidence — цитата манифеста: объявление пакета + line = строка объявления (package.json:7 по fixture)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner();

		const manifestPath = path.join(DEP_FIXTURE, "package.json");
		const lines = fixtureLines(manifestPath);
		const criticalLine = lineOf(lines, `"fake-pkg-critical"`, "объявление fake-pkg-critical");
		const moderateLine = lineOf(lines, `"fake-pkg-moderate"`, "объявление fake-pkg-moderate");

		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		const critical = findingsForPackage(report, "fake-pkg-critical")[0];
		expect(critical.file).toBe("package.json");
		expect(critical.line, `объявление в манифесте на строке ${criticalLine}`).toBe(criticalLine);
		expect(critical.evidence, "evidence — строка манифеста с объявлением пакета").toContain(
			"fake-pkg-critical",
		);
		expect(critical.evidence.length).toBeLessThanOrEqual(300);

		const moderate = findingsForPackage(report, "fake-pkg-moderate")[0];
		expect(moderate.file).toBe("package.json");
		expect(moderate.line).toBe(moderateLine);

		expectDepAuditSchema(report); // полная схема F-2.1 на живом отчёте
	});

	it("low → LOW (полная severity-карта на inline-выводе во временной директории)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "package.json", ['{ "name": "low-fixture", "dependencies": {} }']);
		const lowAudit = {
			vulnerabilities: {
				"fake-pkg-low": {
					name: "fake-pkg-low",
					severity: "low",
					isDirect: true,
					via: [
						{
							source: 1099003,
							name: "fake-pkg-low",
							dependency: "fake-pkg-low",
							title: "Fake low-severity issue in fake-pkg-low",
							url: "https://github.com/advisories/GHSA-fake-low-0003",
							severity: "low",
							range: "<0.0.2",
							cwe: ["CWE-693"],
						},
					],
					effects: [],
					range: "<0.0.2",
					nodes: ["node_modules/fake-pkg-low"],
					fixAvailable: true,
				},
			},
		};
		const { runner } = makeRunner({ npm: { stdout: JSON.stringify(lowAudit) } });

		const report = await scanDepAudits(dir, { runner });

		const low = findingsForPackage(report, "fake-pkg-low");
		expect(low.length).toBe(1);
		expect(low[0].severity, "low → LOW").toBe("LOW");
		expect(resolveExitCode(report)).toBe(1);
	});
});

describe("(а) pip-audit и cargo audit: парсинг вывода на том же dep-fixture (мок-runner)", () => {
	it("pip-audit JSON-массив: fake-flask → MEDIUM (дефолт), CVE-2026-41111 в description, upgrade to 1.0, файл requirements.txt", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeRunner();

		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		const pipCalls = calls.filter((call) => call.cmd === "pip-audit");
		expect(pipCalls.length, "один вызов pip-audit на requirements.txt").toBe(1);
		expect(pipCalls[0].args).toContain("--format");
		expect(pipCalls[0].args).toContain("json");
		// F-6 (patch 1.0.1): cwd — изолированный tmp-workspace, НЕ директория манифеста
		expect(path.resolve(pipCalls[0].cwd), "cwd не должен быть директорией манифеста (F-6)").not.toBe(
			path.resolve(DEP_FIXTURE),
		);
		expect(path.dirname(path.resolve(pipCalls[0].cwd)), "cwd — tmp-workspace под os.tmpdir").toBe(
			path.resolve(tmpdir()),
		);
		const flask = findingsForPackage(report, "fake-flask");
		expect(flask.length, "fake-flask: ровно 1 finding").toBe(1);
		expect(flask[0].severity, "pip-audit не отдаёт severity → дефолт MEDIUM (контракт шапки)").toBe(
			"MEDIUM",
		);
		expect(flask[0].cwe, "без CWE-данных → дефолт CWE-1395").toBe("CWE-1395");
		expect(flask[0].description).toContain("CVE-2026-41111");
		expect(flask[0].remediation).toMatch(/upgrade to/i);
		expect(flask[0].remediation).toContain("1.0");
		expect(flask[0].file).toBe("requirements.txt");

		const reqLines = fixtureLines(path.join(DEP_FIXTURE, "requirements.txt"));
		expect(flask[0].line).toBe(lineOf(reqLines, "fake-flask==", "объявление fake-flask"));
		expect(flask[0].evidence).toContain("fake-flask");
	});

	it("cargo audit RustSec-JSON: fake-crate → HIGH (advisory.severity), CVE-2026-424242 в description, upgrade to 0.2.0", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeRunner();

		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		const cargoCalls = calls.filter((call) => call.cmd === "cargo");
		expect(cargoCalls.length, "один вызов cargo audit на Cargo.toml").toBe(1);
		expect(cargoCalls[0].args).toContain("audit");
		expect(cargoCalls[0].args).toContain("--json");

		const crate = findingsForPackage(report, "fake-crate");
		expect(crate.length, "fake-crate: ровно 1 finding").toBe(1);
		expect(crate[0].severity, 'advisory.severity "high" → HIGH').toBe("HIGH");
		expect(crate[0].cwe).toBe("CWE-1395");
		expect(crate[0].description).toContain("CVE-2026-424242");
		expect(crate[0].remediation).toMatch(/upgrade to/i);
		expect(crate[0].remediation).toContain("0.2.0");
		expect(crate[0].file).toBe("Cargo.toml");
		expect(crate[0].evidence).toContain("fake-crate");
	});
});

describe("(в) несколько манифестов в дереве: по одному вызову runner на манифест", () => {
	it("дерево root package.json + apps/backend/requirements.txt + crates/native/Cargo.toml → 3 вызова, cwd = изолированный tmp-workspace с копией манифеста (F-6), findings слиты", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const tree = makeTempDir();
		writeTempFile(tree, "package.json", ['{ "name": "tree-root", "dependencies": {} }']);
		mkdirSync(path.join(tree, "apps", "backend"), { recursive: true });
		writeFileSync(
			path.join(tree, "apps", "backend", "requirements.txt"),
			"fake-flask==0.5\n",
			"utf8",
		);
		mkdirSync(path.join(tree, "crates", "native"), { recursive: true });
		writeFileSync(
			path.join(tree, "crates", "native", "Cargo.toml"),
			'[package]\nname = "tree-native"\nversion = "0.1.0"\n\n[dependencies]\nfake-crate = "0.1"\n',
			"utf8",
		);
		// F-6: копии манифестов проверяются ВНУТРИ вызова runner — workspace живёт
		// только на время вызова утилиты.
		const { calls, runner } = makeWorkspaceCheckingRunner();

		const report = await scanDepAudits(tree, { runner });

		expect(calls.length, "по одному вызову на каждый манифест дерева").toBe(3);
		const byCmd = Object.fromEntries(calls.map((call) => [call.cmd, call]));
		expect(Object.keys(byCmd).sort()).toEqual(["cargo", "npm", "pip-audit"]);
		for (const cmd of ["npm", "pip-audit", "cargo"]) {
			const call = byCmd[cmd];
			expect(
				call.cwdIsTmpWorkspace,
				`${cmd}: cwd — изолированный tmp-workspace, не директория манифеста (F-6)`,
			).toBe(true);
			expect(path.resolve(call.cwd), `${cmd}: cwd не совпадает с корнем скана`).not.toBe(path.resolve(tree));
		}
		// Копии манифестов лежат в workspace на момент вызова утилиты
		expect(byCmd.npm.copiedManifests).toContain("package.json");
		expect(byCmd["pip-audit"].copiedManifests).toContain("requirements.txt");
		expect(byCmd.cargo.copiedManifests).toContain("Cargo.toml");

		// Findings всех трёх утилит слиты в один отчёт (3 npm + 1 pip + 1 cargo)
		expect(report.findings.length).toBe(5);
		expectDepAuditSchema(report);
		// file — относительно корня сканирования, POSIX (путь ОРИГИНАЛЬНОГО манифеста)
		const flask = findingsForPackage(report, "fake-flask")[0];
		expect(flask.file).toBe(path.posix.join("apps", "backend", "requirements.txt"));
	});

	it("node_modules не обходится: вложенный package.json в node_modules НЕ аудируется", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "package.json", ['{ "name": "with-nm", "dependencies": {} }']);
		mkdirSync(path.join(dir, "node_modules", "evil"), { recursive: true });
		writeFileSync(path.join(dir, "node_modules", "evil", "package.json"), '{ "name": "evil" }', "utf8");
		const { calls, runner } = makeRunner();

		await scanDepAudits(dir, { runner });

		expect(calls.length, "SKIP_DIRS (lib/walker.ts): node_modules пропускается").toBe(1);
		expect(calls[0].cmd).toBe("npm");
	});

	it("lockfile-уточнение: pnpm-lock.yaml рядом с package.json → pnpm audit (не npm)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "package.json", ['{ "name": "pnpm-fixture", "dependencies": {} }']);
		writeTempFile(dir, "pnpm-lock.yaml", ["lockfileVersion: '9.0'"]);
		const { calls, runner } = makeRunner();

		await scanDepAudits(dir, { runner });

		expect(calls.length, "одна утилита на package.json (по lockfile)").toBe(1);
		expect(calls[0].cmd).toBe("pnpm");
		expect(calls[0].args).toContain("audit");
		expect(calls[0].args).toContain("--json");
	});

	it("pyproject.toml распознаётся как pip-манифест (roadmap F-2.4: 4 формата)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "pyproject.toml", [
			"[project]",
			'name = "fake-proj"',
			'version = "0.1.0"',
		]);
		const { calls, runner } = makeRunner();

		await scanDepAudits(dir, { runner });

		expect(calls.length).toBe(1);
		expect(calls[0].cmd).toBe("pip-audit");
		expect(calls[0].args).toContain("--format");
	});

	it("одиночный файл-манифест как targetPath (паритет с scan-secrets/scan-patterns)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		const manifest = writeTempFile(dir, "package.json", ['{ "name": "single-file" }']);
		const { calls, runner } = makeRunner();

		const report = await scanDepAudits(manifest, { runner });

		expect(calls.length).toBe(1);
		expect(report.target).toBe(manifest);
	});
});

describe("F-1 (patch 1.0.1): evidence dep-audit санитизируется — секреты не утекают из манифеста", () => {
	/** Фейковый GitHub PAT в формате ghp_ + 36 (PoC аудита F-1: утечка из манифеста). */
	const LEAKED_TOKEN = `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234`;

	it("манифест с ghp_-токеном в строке dependency → evidence замаскирован, сырой токен отсутствует", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "package.json", [
			`{`,
			`  "name": "leak-fixture",`,
			`  "dependencies": { "fake-pkg-leak": "github:evil/repo#${LEAKED_TOKEN}" }`,
			`}`,
		]);
		// Мок npm audit: уязвимость для объявленного пакета — цитата его строки пойдёт в evidence
		const audit = {
			vulnerabilities: {
				"fake-pkg-leak": {
					name: "fake-pkg-leak",
					severity: "high",
					isDirect: true,
					via: [
						{
							source: 1,
							name: "fake-pkg-leak",
							dependency: "fake-pkg-leak",
							title: "Fake issue in fake-pkg-leak",
							url: "https://github.com/advisories/GHSA-fake-leak-0001",
							severity: "high",
							range: "<1.0.0",
							cwe: ["CWE-400"],
						},
					],
					effects: [],
					range: "<1.0.0",
					nodes: [],
					fixAvailable: true,
				},
			},
		};
		const { runner } = makeRunner({ npm: { stdout: JSON.stringify(audit) } });

		const report = await scanDepAudits(dir, { runner });

		const finding = findingsForPackage(report, "fake-pkg-leak")[0];
		expect(finding, "уязвимость для объявленного пакета найдена").toBeTruthy();
		expect(finding.evidence, "evidence — цитата строки манифеста (предусловие F-1)").toContain("fake-pkg-leak");
		expect(finding.evidence, "токен промаскирован в evidence (sanitizeEvidence, §2.3)").toContain(
			maskSecret(LEAKED_TOKEN),
		);
		// Инвариант §2.3: сырой токен не воспроизводится НИ В ОДНОМ поле отчёта
		expect(JSON.stringify(finding)).not.toContain(LEAKED_TOKEN);
		expect(JSON.stringify(report)).not.toContain(LEAKED_TOKEN);
	});
});

describe("TC-F-2.4-2: нет манифестов — корректное сообщение, не ошибка (tests/fixtures/empty-dep-fixture/)", () => {
	it("scanDepAudits → findings=[], отчёт валиден, runner НЕ вызван, предупреждение «no manifests» в stderr, exit 0", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		expect(existsSync(EMPTY_DEP_FIXTURE), "fixture пустой директории на месте").toBe(true);
		const { calls, runner } = makeRunner(); // не должен вызваться ни разу

		const console$ = captureConsole();
		const report = await scanDepAudits(EMPTY_DEP_FIXTURE, { runner });

		expect(calls.length, "без манифестов утилиты не запускаются").toBe(0);
		expect(report.findings).toEqual([]);
		expectDepAuditSchema(report);
		expect(resolveExitCode(report)).toBe(0);
		// Информативное сообщение (не ошибка) — в stderr, stdout unit-функции чист
		expect(console$.stderr()).toMatch(/манифест|manifest/i);
		expect(console$.stdout()).toBe("");
	});

	it("main --format json: exit 0, валидный JSON с findings=[], предупреждение в stderr", async () => {
		const main = requireExport(await loadScanner(), "main");
		const { runner } = makeRunner();

		const console$ = captureConsole();
		const exitCode = await main([EMPTY_DEP_FIXTURE, "--format", "json"], { runner });

		expect(exitCode).toBe(0);
		const report = JSON.parse(console$.stdout()); // весь stdout — валидный JSON
		expect(report.findings).toEqual([]);
		expect(report.summary.total).toBe(0);
		expect(console$.stderr()).toMatch(/манифест|manifest/i);
	});

	it("main text (дефолт): exit 0, «Чисто»-сводка в stdout, предупреждение в stderr", async () => {
		const main = requireExport(await loadScanner(), "main");
		const { runner } = makeRunner();

		const console$ = captureConsole();
		const exitCode = await main([EMPTY_DEP_FIXTURE], { runner }); // без --format → text

		expect(exitCode).toBe(0);
		const stdout = console$.stdout();
		expect(() => JSON.parse(stdout)).toThrow(); // text, а не JSON
		expect(stdout.toLowerCase()).toContain("чисто"); // renderText пустого отчёта
		expect(console$.stderr()).toMatch(/манифест|manifest/i);
	});
});

describe("(б) утилита отсутствует — предупреждение, не падение (спека §3.3)", () => {
	it("все утилиты отсутствуют (exit 127, command not found): findings=[], отчёт валиден, имена утилит в stderr, exit 0", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeUnavailableRunner();

		const console$ = captureConsole();
		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		expect(calls.length, "попытка запуска по каждой утилите (3 манифеста)").toBe(3);
		expect(report.findings, "отсутствующая утилита не создаёт findings").toEqual([]);
		expectDepAuditSchema(report);
		expect(resolveExitCode(report)).toBe(0); // это НЕ ошибка сканера
		const stderr = console$.stderr();
		expect(stderr).toContain("npm");
		expect(stderr).toContain("pip-audit");
		expect(stderr).toContain("cargo");
	});

	it("частичная деградация: недоступен только npm — pip/cargo findings остаются, exit 1, npm в stderr", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner({
			npm: { stdout: "", stderr: "command not found: npm", exitCode: 127 },
		});

		const console$ = captureConsole();
		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		expect(findingsForPackage(report, "fake-pkg-critical")).toEqual([]);
		expect(findingsForPackage(report, "fake-flask").length).toBe(1); // pip-audit работает
		expect(findingsForPackage(report, "fake-crate").length).toBe(1); // cargo audit работает
		expect(resolveExitCode(report)).toBe(1);
		expect(console$.stderr()).toContain("npm");
	});

	it("npm audit exit 1 с ВАЛИДНЫМ JSON (реальное поведение при уязвимостях) — это НЕ отсутствие утилиты", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { runner } = makeRunner({
			npm: { exitCode: 1, stderr: "npm audit reported vulnerabilities" },
		}); // stdout остаётся NPM_AUDIT_JSON

		const console$ = captureConsole();
		const report = await scanDepAudits(DEP_FIXTURE, { runner });

		expect(findingsForPackage(report, "fake-pkg-critical").length, "JSON парсится несмотря на exit 1").toBe(1);
		expect(findingsForPackage(report, "fake-pkg-high").length).toBe(1);
		expect(findingsForPackage(report, "fake-pkg-moderate").length).toBe(1);
		expect(resolveExitCode(report)).toBe(1);
		expect(console$.stderr()).not.toMatch(/npm.*не|not found/i); // нет ложного «утилита отсутствует»
	});
});

describe("(г) CLI-контракт: text дефолт, --format json, exit 0/1/2, usage", () => {
	it("text — ДЕФОЛТ: stdout НЕ JSON, содержит [SEVERITY] и file:line, exit 1", async () => {
		const main = requireExport(await loadScanner(), "main");
		const { runner } = makeRunner();

		const console$ = captureConsole();
		const exitCode = await main([DEP_FIXTURE], { runner }); // без --format → text

		expect(exitCode).toBe(1);
		const stdout = console$.stdout();
		expect(() => JSON.parse(stdout)).toThrow(); // text, а не JSON
		expect(stdout).toMatch(/\[(CRITICAL|HIGH|MEDIUM)\]/); // severity из мок-аудита
		expect(stdout).toContain("package.json"); // манифест как file
		expect(stdout).toMatch(/package\.json:\d+/); // file:line в формате renderText
	});

	it("--format json: весь stdout — валидный JSON по схеме F-2.1, ровно 5 findings (3 npm + pip + cargo), stderr пуст, exit 1", async () => {
		const main = requireExport(await loadScanner(), "main");
		const { runner } = makeRunner();

		const console$ = captureConsole();
		const exitCode = await main([DEP_FIXTURE, "--format", "json"], { runner });
		const stdout = console$.stdout();

		expect(exitCode).toBe(1);
		expect(console$.err, "все утилиты на месте — предупреждений нет").toEqual([]);
		const report = JSON.parse(stdout); // бросит, если вокруг JSON есть посторонние строки

		expectDepAuditSchema(report);
		expect(report.findings.length, "3 npm + 1 pip-audit + 1 cargo, без дублей").toBe(5);
	});

	it("несуществующий путь: scanDepAudits reject; main → 2, сообщение об ошибке в stderr", async () => {
		const mod = await loadScanner();
		const scanDepAudits = requireExport(mod, "scanDepAudits");
		const main = requireExport(mod, "main");
		const nonexistent = path.join(makeTempDir(), "no-such-dir");

		await expect(scanDepAudits(nonexistent, { runner: makeUnavailableRunner().runner })).rejects.toThrow();

		const console$ = captureConsole();
		const exitCode = await main([nonexistent, "--format", "json"], { runner: makeUnavailableRunner().runner });
		expect(exitCode).toBe(2);
		expect(console$.stderr().length).toBeGreaterThan(0); // сообщение об ошибке — в stderr
	});

	it("main без позиционного аргумента → 2 (usage в stderr, §3.3)", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([], { runner: makeUnavailableRunner().runner });

		expect(exitCode).toBe(2);
		const stderr = console$.stderr();
		expect(stderr.length).toBeGreaterThan(0);
		expect(stderr).toMatch(/usage|использование/i); // usage при пустых аргументах
	});
});

describe("F-6 (patch 1.0.1): dep-audit вне недоверенного cwd — изоляция npm-конфига и копии", () => {
	it("npm: env.npm_config_userconfig указывает внутрь workspace (изоляция от ~/.npmrc)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeWorkspaceCheckingRunner();

		await scanDepAudits(DEP_FIXTURE, { runner });

		const npmCalls = calls.filter((call) => call.cmd === "npm");
		expect(npmCalls.length).toBe(1);
		const userconfig = npmCalls[0].env?.npm_config_userconfig;
		expect(userconfig, "npm_config_userconfig должен быть задан (изоляция ~/.npmrc, F-6)").toBeTruthy();
		expect(
			path.dirname(path.resolve(userconfig)),
			"userconfig — внутри изолированного workspace",
		).toBe(path.resolve(npmCalls[0].cwd));
	});

	it("pip-audit и cargo не получают env-оверрайдов (минимальный фикс — только cwd-изоляция)", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const { calls, runner } = makeWorkspaceCheckingRunner();

		await scanDepAudits(DEP_FIXTURE, { runner });

		for (const cmd of ["pip-audit", "cargo"]) {
			const call = calls.find((entry) => entry.cmd === cmd);
			expect(call, `${cmd}: вызов был`).toBeTruthy();
			expect(call.env, `${cmd}: без env-оверрайдов (минимальный фикс F-6)`).toBeUndefined();
		}
	});

	it("lockfile копируется в workspace: pnpm-lock.yaml рядом с package.json → доступен утилите в cwd", async () => {
		const { scanDepAudits } = requireExport(await loadScanner(), "scanDepAudits");
		const dir = makeTempDir();
		writeTempFile(dir, "package.json", ['{ "name": "pnpm-fixture", "dependencies": {} }']);
		writeTempFile(dir, "pnpm-lock.yaml", ["lockfileVersion: '9.0'"]);
		const { calls, runner } = makeWorkspaceCheckingRunner();

		await scanDepAudits(dir, { runner });

		expect(calls.length).toBe(1);
		expect(calls[0].cmd, "lockfile-уточнение по ОРИГИНАЛЬНОЙ директории манифеста").toBe("pnpm");
		expect(calls[0].copiedManifests, "копии манифеста и lockfile в workspace").toEqual(
			expect.arrayContaining(["package.json", "pnpm-lock.yaml"]),
		);
	});
});
