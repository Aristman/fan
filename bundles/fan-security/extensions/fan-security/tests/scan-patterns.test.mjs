/**
 * TDD RED tests for F-2.3 «CLI scan-patterns (cli/scan-patterns.ts)».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.3» (TC-F-2.3-1/2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4 (CLI-сканеры), §6 (формат),
 *       §3.3 (exit-коды 0/1/2), §6.1 (схема Finding), §4.4 (data-driven паттерны).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза) —
 * extensions/fan-security/cli/scan-patterns.ts экспортирует:
 *
 *   1) scanPatterns(targetPath: string, options?: ScanPatternsOptions): Promise<Report>
 *      - targetPath — файл ИЛИ директория (рекурсивный обход);
 *      - возвращает Report по схеме F-2.1 (lib/report.ts); tool: "scan-patterns",
 *        scanner каждого finding — "scan-patterns";
 *      - Finding.file — путь ОТНОСИТЕЛЬНО корня сканирования, POSIX-стиль («/»);
 *      - Finding.line — 1-based номер строки с сигнатурой;
 *      - сигнатуры CWE (data-driven таблица lib/patterns/cwe.ts — REFACTOR F-2.3):
 *          CWE-89  SQL injection: SQL-строка (SELECT/INSERT/UPDATE/DELETE…),
 *                  склеенная с переменной через «+» или «${…}»;
 *                  параметризованный запрос (placeholder «?», параметры массивом) — НЕ finding;
 *          CWE-78  command injection: exec/execSync/system с шаблоном «${…}»
 *                  или конкатенацией; execFile с массивом аргументов — НЕ finding;
 *          CWE-22  path traversal: path.join/path.resolve с пользовательским вводом
 *                  (userInput, req.params/query-подобные имена) БЕЗ нормализации;
 *                  path.join(base, path.normalize(input)) — НЕ finding;
 *          CWE-79  XSS: присваивание переменной в «.innerHTML =»; .textContent — НЕ finding;
 *          CWE-327 weak crypto: createHash("md5"/"sha1") и прямые вызовы md5()/sha1();
 *                  sha256/sha512 — НЕ findings;
 *          CWE-338 weak randomness: Math.random() в security-контексте — имя переменной
 *                  на строке содержит token|secret|password|nonce|session|csrf|otp|salt|key;
 *                  Math.random() вне security-контекста (кубик, тест-данные) — НЕ finding;
 *          CWE-329 hardcoded IV/nonce: createCipheriv/createDecipheriv, где IV —
 *                  строковый литерал (или Buffer.from(<литерал>));
 *                  IV из randomBytes/переменной — НЕ finding;
 *      - evidence — цитата совпавшего фрагмента (НЕ вся строка файла), длина
 *        ограничена разумным пределом (≤ 300 символов); маскирование секретов здесь
 *        не применяется (секреты — зона scan-secrets F-2.2), в CWE-цитатах их нет;
 *      - несуществующий targetPath → throw/reject (main() превращает в exit 2);
 *      - options не влияет на Report (формат вывода — забота main()).
 *
 *   2) main(argv?: string[]): Promise<number>
 *      - argv: [target] [--format json|text]; по умолчанию process.argv.slice(2);
 *      - text — ДЕФОЛТ (как F-2.2); text-вывод = renderText(report) в stdout;
 *      - json: ВЕСЬ stdout — валидный JSON.stringify(report) без посторонних строк
 *        (§4.1: «--format json без лишнего вывода»); stderr пуст;
 *      - вывод только через console.log (stdout) / console.error (stderr) — иначе
 *        тесты не перехватывают; message об ошибке — в stderr;
 *      - main() ВОЗВРАЩАЕТ exit-код (resolveExitCode, §3.3: 0/1/2) и НЕ вызывает
 *        process.exit — process.exit только в CLI-обёртке import.meta.main;
 *      - без позиционного аргумента → 2 (usage в stderr, §3.3); несуществующий путь → 2.
 *
 * РЕШЕНИЕ ПО ЗАПУСКУ (как F-2.2): scanPatterns/main тестируются НАПРЯМУЮ через
 * import (guard + requireExport); stdout/stderr перехват vi.spyOn(console, …).
 * Надёжно на Windows/Bun, без подпроцессов. Bun-запуск для человека:
 * bun cli/scan-patterns.ts <path> --format json (обёртка import.meta.main).
 *
 * Red-ожидание (roadmap): «TC-F-2.3-1 — падает первым: cli/scan-patterns.ts не
 * существует». Все падения должны читаться как «модуля/экспорта нет» (guard-хелпер
 * даёт понятное сообщение), а не «тест сломан». Fixtures: tests/fixtures/
 * patterns-sample.ts (пары «уязвимая строка → безопасный аналог», маркеры CWE в
 * комментариях) и clean-patterns-sample.ts (только безопасные аналоги). Секретов
 * в fixtures нет — F-2.3 тестирует CWE-сигнатуры кода, маскирование не тестируется.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/report.ts уже существует (F-2.1 COMPLETED) — статический импорт для ожиданий/exit-кодов
import { resolveExitCode, SEVERITIES } from "../lib/report.ts";

const SCANNER_URL = "../cli/scan-patterns.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(testsDir, "fixtures");
const PATTERNS_SAMPLE = path.join(FIXTURES, "patterns-sample.ts");
const CLEAN_SAMPLE = path.join(FIXTURES, "clean-patterns-sample.ts");

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

/**
 * Группы сигнатур §4 (минимум 6 по roadmap; здесь 7): маркерные подстроки
 * vulnerable-строки и безопасного аналога в tests/fixtures/patterns-sample.ts.
 * Маркеры должны быть уникальны в пределах fixture (см. шапку fixture).
 */
const GROUPS = [
	{
		cwe: "CWE-89",
		label: "SQL injection",
		vuln: `+ userName +`,
		safe: `db.query("SELECT * FROM users WHERE id = ?"`,
	},
	{
		cwe: "CWE-78",
		label: "command injection",
		vuln: "exec(`rm -rf ${userInput}`)",
		safe: `execFile("rm", ["-rf", buildDir]`,
	},
	{
		cwe: "CWE-22",
		label: "path traversal",
		vuln: "path.join(uploadDir, userInput)",
		safe: "path.join(uploadDir, path.normalize(userInput))",
	},
	{
		cwe: "CWE-79",
		label: "XSS",
		vuln: ".innerHTML = userInput",
		safe: ".textContent = userInput",
	},
	{
		cwe: "CWE-327",
		label: "weak crypto (md5)",
		vuln: `createHash("md5")`,
		safe: `createHash("sha256")`,
	},
	{
		cwe: "CWE-338",
		label: "weak randomness",
		vuln: "sessionToken = Math.random()",
		safe: "sessionId = randomBytes(16)",
	},
	{
		cwe: "CWE-329",
		label: "hardcoded IV",
		vuln: `createCipheriv("aes-256-cbc", key, "0123456789abcdef")`,
		safe: `createCipheriv("aes-256-cbc", key, randomIv)`,
	},
];

/** Дополнительные vulnerable-строки fixture вне основных групп (weak crypto: sha1, md5()). */
const EXTRA_VULN_NEEDLES = [`createHash("sha1")`, `md5(payload)`];

let scannerModulePromise;

/**
 * Guard: загрузка целевого модуля. При Red (cli/scan-patterns.ts нет) каждый тест
 * падает с читаемой причиной вместо сырого "Cannot find module".
 */
function loadScanner() {
	if (!scannerModulePromise) {
		scannerModulePromise = import(SCANNER_URL).catch((cause) => {
			scannerModulePromise = undefined; // разрешить повторную попытку в следующем тесте
			throw new Error(
				`cli/scan-patterns.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/cli/scan-patterns.ts по контракту из шапки этого файла ` +
					`(roadmap F-2.3, Red-фаза TDD): экспорт scanPatterns(targetPath, options?) → Promise<Report> + main(argv?) → Promise<number>.`,
			);
		});
	}
	return scannerModulePromise;
}

/**
 * Guard: проверка наличия экспорта с читаемым сообщением. Прозрачный Proxy,
 * поддерживающий оба стиля доступа (см. report.test.mjs / scan-secrets.test.mjs).
 * Продублирован локально, чтобы не трогать файлы F-2.1/F-2.2.
 */
function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`cli/scan-patterns.ts не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). Дополни экспорты по контракту — шапка этого файла, roadmap F-2.3.`,
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

/** Перехват stdout/stderr (контракт: main() печатает только через console.*). */
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
		restore() {
			logSpy.mockRestore();
			errSpy.mockRestore();
		},
	};
}

/** Временная директория для unit-тестов (auto-cleanup в afterEach). */
const tempDirs = [];
function makeTempDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-scan-patterns-"));
	tempDirs.push(dir);
	return dir;
}

/** Записывает файл во временную директорию (строки массива → строки файла, 1-based снаружи). */
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

/** Findings на конкретной строке файла (1-based). */
function findingsOnLine(report, line) {
	return report.findings.filter((f) => f.line === line);
}

/** Findings с конкретным CWE. */
function findingsWithCwe(report, cwe) {
	return report.findings.filter((f) => f.cwe === cwe);
}

/**
 * Инварианты схемы F-2.1 для отчёта scan-patterns: 6 полей Report, 12 полей
 * Finding, enum'ы severity/confidence, консистентный summary, уникальные id,
 * относительные POSIX-пути и 1-based строки.
 */
function expectF2_1Schema(report) {
	// F-2.5: Report может нести опциональные external/externalTools (см. tests/external.test.mjs)
	const coreKeys = Object.keys(report).filter((key) => key !== "external" && key !== "externalTools");
	expect(coreKeys.sort()).toEqual(
		["findings", "scannedAt", "summary", "target", "tool", "version"].sort(),
	);
	expect(report.tool).toBe("scan-patterns");
	expect(report.summary.total).toBe(report.findings.length);
	for (const finding of report.findings) {
		expect(Object.keys(finding).sort()).toEqual([...FINDING_FIELDS].sort());
		expect(SEVERITIES).toContain(finding.severity);
		expect(finding.scanner).toBe("scan-patterns");
		expect(finding.cwe).toMatch(/^CWE-\d+$/);
		expect(["confirmed", "needs-verification"]).toContain(finding.confidence);
		expect(typeof finding.evidence).toBe("string");
		expect(finding.evidence.length).toBeGreaterThan(0);
		expect(finding.file, "путь должен быть относительным (без корня сканирования)").not.toMatch(
			/^([A-Za-z]:)?[\\/]/,
		);
		expect(finding.file, "путь в POSIX-стиле").not.toContain("\\");
		expect(finding.line).toBeGreaterThanOrEqual(1);
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

describe("TC-F-2.3-1: находит SQL-конкатенацию и md5 в fixture (tests/fixtures/patterns-sample.ts)", () => {
	it("scanPatterns → ≥2 findings: CWE-89 на строке SQL-конкатенации, CWE-327 на md5, file:line точны, exit 1", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

		const lines = fixtureLines(PATTERNS_SAMPLE);
		const sqlLine = lineOf(lines, `+ userName +`, "SQL-конкатенация");
		const md5Line = lineOf(lines, `createHash("md5")`, "md5()");

		const report = await scanPatterns(PATTERNS_SAMPLE);

		expect(report.findings.length).toBeGreaterThanOrEqual(2);
		const sqlFindings = findingsOnLine(report, sqlLine);
		expect(
			sqlFindings.some((f) => f.cwe === "CWE-89"),
			`строка ${sqlLine} (SQL-конкатенация): ожидался finding CWE-89`,
		).toBe(true);
		const md5Findings = findingsOnLine(report, md5Line);
		expect(
			md5Findings.some((f) => f.cwe === "CWE-327"),
			`строка ${md5Line} (md5): ожидался finding CWE-327`,
		).toBe(true);
		for (const finding of [...sqlFindings, ...md5Findings]) {
			expect(finding.file).toBe("patterns-sample.ts"); // путь относительно корня сканирования
		}
		// Exit-код через resolveExitCode (F-2.1): есть findings → 1
		expect(resolveExitCode(report)).toBe(1);
	});

	it("все findings соответствуют схеме F-2.1 (12 полей, scanner scan-patterns, summary консистентен)", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

		const report = await scanPatterns(PATTERNS_SAMPLE);

		expect(report.findings.length).toBeGreaterThanOrEqual(2);
		expectF2_1Schema(report);
	});

	it("main --format json: валидный JSON по схеме F-2.1 с CWE-89 и CWE-327, stderr пуст, exit 1", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([PATTERNS_SAMPLE, "--format", "json"]);
		const stdout = console$.stdout();

		// §4.1: JSON без лишнего вывода — весь stdout парсится, stderr пуст
		expect(exitCode).toBe(1);
		expect(console$.err).toEqual([]);
		const report = JSON.parse(stdout); // бросит, если вокруг JSON есть посторонние строки

		expectF2_1Schema(report);
		expect(report.findings.length).toBeGreaterThanOrEqual(2);
		const cwes = new Set(report.findings.map((f) => f.cwe));
		expect(cwes.has("CWE-89"), "нет CWE-89 (SQL injection)").toBe(true);
		expect(cwes.has("CWE-327"), "нет CWE-327 (weak crypto)").toBe(true);
	});
});

describe("Покрытие 7 групп сигнатур §4 на fixture: vulnerable-строка → finding, safe-аналог → 0", () => {
	for (const group of GROUPS) {
		it(`${group.label} (${group.cwe}): finding с ${group.cwe} на уязвимой строке; безопасный аналог — 0 findings`, async () => {
			const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

			const lines = fixtureLines(PATTERNS_SAMPLE);
			const vulnLine = lineOf(lines, group.vuln, `${group.label}: vulnerable-строка`);
			const safeLine = lineOf(lines, group.safe, `${group.label}: safe-аналог`);
			expect(vulnLine, "vulnerable- и safe-строки не должны совпадать").not.toBe(safeLine);

			const report = await scanPatterns(PATTERNS_SAMPLE);

			const vulnFindings = findingsOnLine(report, vulnLine);
			expect(
				vulnFindings.some((f) => f.cwe === group.cwe),
				`строка ${vulnLine} (${group.label}): ожидался ${group.cwe}, получены: [${vulnFindings.map((f) => f.cwe).join(", ")}]`,
			).toBe(true);
			expect(
				findingsOnLine(report, safeLine),
				`безопасный аналог (строка ${safeLine}) не должен давать findings (false positive)`,
			).toEqual([]);
		});
	}

	it("weak crypto: sha1 → CWE-327 (вторая сигнатура группы)", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

		const lines = fixtureLines(PATTERNS_SAMPLE);
		const sha1Line = lineOf(lines, `createHash("sha1")`, "sha1");

		const report = await scanPatterns(PATTERNS_SAMPLE);

		const sha1Findings = findingsOnLine(report, sha1Line);
		expect(
			sha1Findings.some((f) => f.cwe === "CWE-327"),
			`строка ${sha1Line} (sha1): ожидался CWE-327`,
		).toBe(true);
	});

	it("нет false positives: все findings лежат только на vulnerable-строках fixture", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

		const lines = fixtureLines(PATTERNS_SAMPLE);
		const vulnLines = new Set(
			[...GROUPS.map((g) => g.vuln), ...EXTRA_VULN_NEEDLES].map((needle) =>
				lineOf(lines, needle),
			),
		);

		const report = await scanPatterns(PATTERNS_SAMPLE);
		expect(report.findings.length).toBeGreaterThan(0);

		for (const finding of report.findings) {
			expect(
				vulnLines.has(finding.line),
				`finding на неожиданной строке ${finding.line} (${finding.cwe} «${finding.title}») — false positive на безопасном коде`,
			).toBe(true);
		}
	});
});

describe("TC-F-2.3-2: чистый fixture — 0 findings, exit 0 (tests/fixtures/clean-patterns-sample.ts)", () => {
	it("scanPatterns → findings=[], exit 0", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");

		const report = await scanPatterns(CLEAN_SAMPLE);

		expect(report.findings).toEqual([]);
		expect(resolveExitCode(report)).toBe(0);
	});

	it("main --format json → валидный JSON с findings: [], bySeverity {}, stderr пуст, exit 0", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([CLEAN_SAMPLE, "--format", "json"]);

		expect(exitCode).toBe(0);
		expect(console$.err).toEqual([]);
		const report = JSON.parse(console$.stdout());
		expect(report.findings).toEqual([]);
		expect(report.summary.total).toBe(0);
		expect(report.summary.bySeverity).toEqual({});
	});
});

describe("Evidence: совпавший фрагмент, а не вся строка файла", () => {
	it("evidence ограничен разумным пределом (≤ 300 символов), даже если строка файла длинная", async () => {
		const { scanPatterns } = requireExport(await loadScanner(), "scanPatterns");
		const dir = makeTempDir();
		const padHead = "x".repeat(200);
		const padTail = "y".repeat(200);
		const longLine = `const head = "${padHead}"; document.getElementById("out").innerHTML = userInput; const tail = "${padTail}";`;
		writeTempFile(dir, "long-line.ts", [longLine]);
		expect(longLine.length).toBeGreaterThan(300); // предусловие: строка длиннее предела

		const report = await scanPatterns(dir);

		const xssFindings = findingsWithCwe(report, "CWE-79");
		expect(xssFindings.length, "CWE-79 не найден на длинной строке").toBeGreaterThan(0);
		for (const finding of xssFindings) {
			expect(finding.evidence.length, "evidence должен быть ограничен (совпавший фрагмент, не вся строка)").toBeLessThanOrEqual(
				300,
			);
			expect(finding.evidence).not.toContain(padTail); // хвост строки не должен попадать в цитату
		}
		expect(report.findings[0].file).toBe("long-line.ts"); // относительный путь от корня сканирования
	});
});

describe("CLI-контракт: --format text (дефолт), usage, exit 2 при ошибке", () => {
	it("text — ДЕФОЛТ: вывод НЕ JSON, содержит severity и file (renderText), exit 1", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([PATTERNS_SAMPLE]); // без --format → text

		expect(exitCode).toBe(1);
		const stdout = console$.stdout();
		expect(() => JSON.parse(stdout)).toThrow(); // text, а не JSON
		expect(stdout).toMatch(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/); // severity
		expect(stdout).toContain("patterns-sample.ts"); // file
	});

	it("--format text явно: формат renderText — '[SEVERITY] file:line — title'", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		await main([PATTERNS_SAMPLE, "--format", "text"]);

		const stdout = console$.stdout();
		expect(stdout).toMatch(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/);
		expect(stdout).toMatch(/patterns-sample\.ts:\d+/); // file:line
	});

	it("несуществующий путь: scanPatterns reject; main → 2, сообщение об ошибке в stderr", async () => {
		const mod = await loadScanner();
		const scanPatterns = requireExport(mod, "scanPatterns");
		const main = requireExport(mod, "main");
		const nonexistent = path.join(makeTempDir(), "no-such-dir");

		await expect(scanPatterns(nonexistent)).rejects.toThrow();

		const console$ = captureConsole();
		const exitCode = await main([nonexistent, "--format", "json"]);
		expect(exitCode).toBe(2);
		expect(console$.err.join("\n").length).toBeGreaterThan(0); // сообщение об ошибке — в stderr
	});

	it("main без позиционного аргумента → 2 (usage в stderr, §3.3)", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([]);

		expect(exitCode).toBe(2);
		const stderr = console$.err.join("\n");
		expect(stderr.length).toBeGreaterThan(0);
		expect(stderr).toMatch(/usage|использование/i); // usage-сообщение при пустых аргументах
	});
});
