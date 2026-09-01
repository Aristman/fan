/**
 * TDD RED tests for F-2.2 «CLI scan-secrets (cli/scan-secrets.ts)».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.2» (TC-F-2.2-1/2/3).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4 (CLI-сканеры), §6 (формат),
 *       §2.3 (маскирование), §3.3 (exit-коды 0/1/2), §6.1 (схема Finding).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза) —
 * extensions/fan-security/cli/scan-secrets.ts экспортирует:
 *
 *   1) scanSecrets(targetPath: string, options?: ScanSecretsOptions): Promise<Report>
 *      - targetPath — файл ИЛИ директория (рекурсивный обход);
 *      - возвращает Report по схеме F-2.1 (lib/report.ts); tool: "scan-secrets";
 *      - Finding.file — путь ОТНОСИТЕЛЬНО корня сканирования;
 *      - паттерны (roadmap F-2.2): присваивания api_key= / apiKey=; AWS «AKIA+16»;
 *        OpenAI «sk-» + ≥20 символов; GitHub «ghp_» + 36; Slack «xox…»;
 *        PEM «-----BEGIN PRIVATE KEY-----» (severity HIGH|CRITICAL);
 *      - закоммиченный файл .env → finding с title, содержащим «env file committed»
 *        (регистронезависимо), severity INFO|LOW;
 *      - entropy-эвристика: высокоэнтропийная строка (≥24 символа, mixed case+digits)
 *        БЕЗ известного префикса → finding с confidence "needs-verification" (§2.3);
 *        низкоэнтропийные строки НЕ флагуются (без false positives);
 *      - evidence всегда маскируется через maskSecret из lib/report.ts (§6.2: 4+4,
 *        «AKIA…MNOP») — полный секрет НЕ утекает; cwe заполнен (формат «CWE-…»);
 *      - несуществующий targetPath → throw/reject (main() превращает в exit 2);
 *      - options не влияет на Report (формат вывода — забота main()).
 *
 *   2) main(argv?: string[]): Promise<number>
 *      - argv: [target] [--format json|text]; по умолчанию process.argv.slice(2);
 *      - text — ДЕФОЛТ (roadmap F-2.2); text-вывод = renderText(report) в stdout;
 *      - json: ВЕСЬ stdout — валидный JSON.stringify(report) без посторонних строк
 *        (§4.1: «--format json без лишнего вывода»); stderr пуст;
 *      - вывод только через console.log (stdout) / console.error (stderr) — иначе
 *        тесты не перехватывают; message об ошибке — в stderr;
 *      - main() ВОЗВРАЩАЕТ exit-код (resolveExitCode, §3.3: 0/1/2) и НЕ вызывает
 *        process.exit — process.exit только в CLI-обёртке import.meta.main;
 *      - без позиционного аргумента → 2 (валидация, §3.3); несуществующий путь → 2.
 *
 * РЕШЕНИЕ ПО ЗАПУСКУ (документировано вместо spawn): тестируем scanSecrets/main
 * НАПРЯМУЮ через import (guard + requireExport как в report.test.mjs); stdout/stderr
 * перехватываем vi.spyOn(console, …). Надёжно на Windows/Bun, без подпроцессов.
 * Bun-запуск для человека: bun cli/scan-secrets.ts <path> --format json (обёртка
 * import.meta.main → process.exit(main())). exit-коды — через resolveExitCode (F-2.1).
 *
 * Red-ожидание (roadmap): «TC-F-2.2-1 — падает первым: cli/scan-secrets.ts не
 * существует». Все падения должны читаться как «модуля/экспорта нет» (guard-хелпер
 * даёт понятное сообщение), а не «тест сломан». Fixtures в tests/fixtures/ — все
 * секреты фейковые и невалидные.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/report.ts уже существует (F-2.1 COMPLETED) — статический импорт для ожиданий/exit-кодов
import { maskSecret, resolveExitCode, SEVERITIES } from "../lib/report.ts";

const SCANNER_URL = "../cli/scan-secrets.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(testsDir, "fixtures");
const SECRETS_SAMPLE = path.join(FIXTURES, "secrets-sample.ts");
const CLEAN_SAMPLE = path.join(FIXTURES, "clean-sample.ts");
const ENV_FIXTURE_DIR = path.join(FIXTURES, "env-fixture");

/** Фейковые, невалидные seed-значения (дубликаты содержимого fixtures для ожиданий). */
const FAKE = {
	aws: "AKIAABCDEFGHIJKLMNOP", // AKIA + 16 символов — тестовый формат roadmap, невалидный
	github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234", // ghp_ + 36 символов, фейк
	slack: "xoxb-123456789012-123456789012-FakeFakeFakeFake", // фейковый формат Slack
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
 * Guard: загрузка целевого модуля. При Red (cli/scan-secrets.ts нет) каждый тест
 * падает с читаемой причиной вместо сырого "Cannot find module".
 */
function loadScanner() {
	if (!scannerModulePromise) {
		scannerModulePromise = import(SCANNER_URL).catch((cause) => {
			scannerModulePromise = undefined; // разрешить повторную попытку в следующем тесте
			throw new Error(
				`cli/scan-secrets.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/cli/scan-secrets.ts по контракту из шапки этого файла ` +
					`(roadmap F-2.2, Red-фаза TDD): экспорт scanSecrets(targetPath, options?) → Promise<Report> + main(argv?) → Promise<number>.`,
			);
		});
	}
	return scannerModulePromise;
}

/**
 * Guard: проверка наличия экспорта с читаемым сообщением. Прозрачный Proxy,
 * поддерживающий оба стиля доступа (см. report.test.mjs). Продублирован локально,
 * чтобы не трогать файл F-2.1.
 */
function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`cli/scan-secrets.ts не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). Дополни экспорты по контракту — шапка этого файла, roadmap F-2.2.`,
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

/** Временная директория для pattern-тестов (auto-cleanup в afterEach). */
const tempDirs = [];
function makeTempDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-scan-secrets-"));
	tempDirs.push(dir);
	return dir;
}

/** Записывает файл во временную директорию (строки массива → строки файла, 1-based снаружи). */
function writeTempFile(dir, name, lines) {
	const file = path.join(dir, name);
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
	return file;
}

/** Findings на конкретной строке файла (1-based). */
function findingsOnLine(report, line) {
	return report.findings.filter((f) => f.line === line);
}

/** Поиск AWS-finding по замаскированному evidence («AKIA…MNOP», эталон maskSecret). */
function awsFinding(report) {
	const masked = maskSecret(FAKE.aws); // "AKIA…MNOP"
	return report.findings.find((f) => f.evidence.includes(masked));
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("TC-F-2.2-1: находит AWS-ключ в fixture (tests/fixtures/secrets-sample.ts)", () => {
	it("scanSecrets → ≥1 finding: severity HIGH|CRITICAL, cwe CWE-798, file относительный, exit 1", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");

		const report = await scanSecrets(SECRETS_SAMPLE);

		expect(report.findings.length).toBeGreaterThanOrEqual(1);
		const finding = awsFinding(report);
		expect(finding, `нет finding с evidence «${maskSecret(FAKE.aws)}» (AWS-ключ не найден)`).toBeTruthy();
		expect(["HIGH", "CRITICAL"]).toContain(finding.severity);
		expect(finding.cwe).toBe("CWE-798");
		expect(finding.file).toBe("secrets-sample.ts"); // путь относительно корня сканирования
		expect(finding.line).toBeGreaterThanOrEqual(1);
		// Exit-код через resolveExitCode (F-2.1): есть findings → 1
		expect(resolveExitCode(report)).toBe(1);
	});

	it("evidence замаскирован: содержит 'AKIA…MNOP', полный секрет НЕ утекает (§6.2)", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");

		const report = await scanSecrets(SECRETS_SAMPLE);
		const finding = awsFinding(report);
		expect(finding).toBeTruthy();

		expect(finding.evidence).toContain(maskSecret(FAKE.aws));
		// Инвариант §2.3: секрет не воспроизводится полностью — ни в evidence, ни в других полях
		const findingText = JSON.stringify(finding);
		expect(findingText).not.toContain(FAKE.aws);
	});

	it("main --format json: валидный JSON по схеме F-2.1 (12 полей, summary консистентен), exit 1", async () => {
		const mod = await loadScanner();
		const main = requireExport(mod, "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE, "--format", "json"]);
		const stdout = console$.stdout();

		// §4.1: JSON без лишнего вывода — весь stdout парсится, stderr пуст
		expect(exitCode).toBe(1);
		expect(console$.err).toEqual([]);
		const report = JSON.parse(stdout); // бросит, если вокруг JSON есть посторонние строки

		// F-2.5: Report может нести опциональные external/externalTools (см. tests/external.test.mjs)
		const coreKeys = Object.keys(report).filter((key) => key !== "external" && key !== "externalTools");
		expect(coreKeys.sort()).toEqual(
			["findings", "scannedAt", "summary", "target", "tool", "version"].sort(),
		);
		expect(report.tool).toBe("scan-secrets");
		expect(report.findings.length).toBeGreaterThanOrEqual(1);
		expect(report.summary.total).toBe(report.findings.length);
		for (const finding of report.findings) {
			expect(Object.keys(finding).sort()).toEqual([...FINDING_FIELDS].sort());
			expect(SEVERITIES).toContain(finding.severity);
			expect(finding.scanner).toBe("scan-secrets");
			expect(finding.cwe).toMatch(/^CWE-\d+/);
			expect(["confirmed", "needs-verification"]).toContain(finding.confidence);
			expect(typeof finding.evidence).toBe("string");
			expect(finding.evidence.length).toBeGreaterThan(0);
		}
	});
});

describe("TC-F-2.2-2: чистый файл — 0 findings (tests/fixtures/clean-sample.ts)", () => {
	it("scanSecrets → findings=[], exit 0", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");

		const report = await scanSecrets(CLEAN_SAMPLE);

		expect(report.findings).toEqual([]);
		expect(resolveExitCode(report)).toBe(0);
	});

	it("main --format json → валидный JSON с findings: [], exit 0", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([CLEAN_SAMPLE, "--format", "json"]);

		expect(exitCode).toBe(0);
		const report = JSON.parse(console$.stdout());
		expect(report.findings).toEqual([]);
		expect(report.summary.total).toBe(0);
		expect(report.summary.bySeverity).toEqual({});
	});
});

describe("TC-F-2.2-3: .env в сканируемой директории — finding (tests/fixtures/env-fixture/)", () => {
	it("находит 'env file committed': severity INFO|LOW, file '.env', exit 1", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");

		const report = await scanSecrets(ENV_FIXTURE_DIR);

		const envFinding = report.findings.find((f) => /env file/i.test(f.title));
		expect(envFinding, "нет finding о закоммиченном .env (title должен содержать 'env file committed')").toBeTruthy();
		expect(envFinding.file).toBe(".env"); // относительный путь внутри директории
		expect(["INFO", "LOW"]).toContain(envFinding.severity);
		expect(resolveExitCode(report)).toBe(1);
	});

	it("обычный файл рядом с .env не даёт false positives", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");

		const report = await scanSecrets(ENV_FIXTURE_DIR);

		expect(report.findings.filter((f) => f.file === "README.md")).toEqual([]);
	});
});

describe("Покрытие паттернов §4 (присваивания, sk-, ghp_, xox, PEM, entropy)", () => {
	/** Одна временная директория + файл со «вредными» строками на известных позициях. */
	async function scanPatternLines() {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");
		const dir = makeTempDir();
		writeTempFile(dir, "sample.ts", [
			`const apiKey = "zyxwvutsrqponmlkjihgfedcba098765";`, // line 1: apiKey= присваивание
			`const api_key = "abcdefghijklmnopqrstuv012345";`, // line 2: api_key= присваивание
			`const openaiKey = "sk-FAKE1234567890abcdefghijklmnop";`, // line 3: sk- (OpenAI-стиль)
			`const githubPat = "${FAKE.github}";`, // line 4: ghp_ + 36
			`const slackToken = "${FAKE.slack}";`, // line 5: xox (Slack)
			`const padding = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`, // line 6: НИЗКАЯ энтропия — не finding
			`const entropy = "Zx9Q2vLm4Nr8Ts6Wy1Bc5Hd7Fj3Gk0Pa";`, // line 7: высокая энтропия, без префикса
		]);
		return { report: await scanSecrets(dir), secretLines: [1, 2, 3, 4, 5, 7] };
	}

	it("api_key= / apiKey= присваивания → finding на каждой из строк 1–2", async () => {
		const { report } = await scanPatternLines();
		for (const line of [1, 2]) {
			expect(findingsOnLine(report, line).length, `строка ${line} (api_key=/apiKey=) не найдена`).toBeGreaterThan(0);
		}
	});

	it("sk- (OpenAI-стиль) → finding на строке 3", async () => {
		const { report } = await scanPatternLines();
		expect(findingsOnLine(report, 3).length).toBeGreaterThan(0);
	});

	it("ghp_ +36 и xox (GitHub/Slack) → findings на строках 4–5", async () => {
		const { report } = await scanPatternLines();
		expect(findingsOnLine(report, 4).length).toBeGreaterThan(0);
		expect(findingsOnLine(report, 5).length).toBeGreaterThan(0);
	});

	it("entropy: высокоэнтропийная строка без префикса → finding needs-verification (строка 7)", async () => {
		const { report } = await scanPatternLines();
		const entropyFindings = findingsOnLine(report, 7);
		expect(entropyFindings.length).toBeGreaterThan(0);
		expect(entropyFindings.some((f) => f.confidence === "needs-verification")).toBe(true);
	});

	it("entropy: низкоэнтропийная строка (32×'a') → false positive отсутствует (строка 6)", async () => {
		const { report } = await scanPatternLines();
		expect(findingsOnLine(report, 6)).toEqual([]);
	});

	it("все findings по паттернам: маскирование evidence, cwe заполнен, путь относительный", async () => {
		const { report, secretLines } = await scanPatternLines();
		expect(report.findings.length).toBeGreaterThan(0);
		for (const finding of report.findings) {
			expect(finding.file).toBe("sample.ts");
			expect(finding.cwe).toMatch(/^CWE-\d+/);
			// Полные фейковые секреты не воспроизводятся (§2.3)
			for (const secret of Object.values(FAKE)) {
				expect(JSON.stringify(finding)).not.toContain(secret);
			}
		}
		for (const line of secretLines) {
			expect(findingsOnLine(report, line).length, `строка ${line} не найдена`).toBeGreaterThan(0);
		}
	});

	it("PEM BEGIN PRIVATE KEY → finding HIGH|CRITICAL на строке ключа; ключ не утекает в evidence", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");
		const dir = makeTempDir();
		const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQFakeFakeFake";
		writeTempFile(dir, "key.pem", [
			"-----BEGIN PRIVATE KEY-----",
			pemBody,
			"FakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake",
			"-----END PRIVATE KEY-----",
		]);

		const report = await scanSecrets(dir);

		const pemFindings = report.findings.filter((f) => f.line === 1);
		expect(pemFindings.length).toBeGreaterThan(0);
		expect(pemFindings[0].severity, "PEM-ключ должен быть HIGH или CRITICAL").toMatch(/^(HIGH|CRITICAL)$/);
		// Тело ключа не воспроизводится полностью (§2.3)
		expect(JSON.stringify(report.findings)).not.toContain(pemBody);
	});
});

describe("F-3 (patch 1.0.1): короткое значение api_key маскируется целиком", () => {
	it("api_key с 8-символьным значением → finding с замаскированной evidence «…», значение НЕ в отчёте", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");
		const dir = makeTempDir();
		writeTempFile(dir, "short-key.ts", [`const apiKey = "shortkey";`]); // значение ровно 8 символов

		const report = await scanSecrets(dir, { useExternal: "off" });

		const findings = report.findings.filter((f) => /api[_-]?key/i.test(f.title));
		expect(findings.length, "короткое присваивание api_key должно давать finding").toBeGreaterThan(0);
		for (const finding of findings) {
			// fix F-3: раньше len<9 маскировался без изменений → «shortkey» утекал в evidence
			expect(finding.evidence, "короткое значение не должно попадать в evidence открытым текстом").not.toContain(
				"shortkey",
			);
			expect(finding.evidence, "evidence содержит полную маску «…» (maskSecret len<9)").toContain("…");
		}
		// Инвариант §2.3: значение не воспроизводится ни в одном поле отчёта
		expect(JSON.stringify(report)).not.toContain("shortkey");
	});
});

describe("F-2 (patch 1.0.1): длинная строка и тайм-бюджет", () => {
	it("файл с ~1 МБ одной строкой сканируется < 5 сек (усечение MAX_SCAN_LINE_LENGTH)", async () => {
		const { scanSecrets } = requireExport(await loadScanner(), "scanSecrets");
		const dir = makeTempDir();
		// Одна строка ~999 КБ (< MAX_FILE_BYTES = 1 МБ), низкоэнтропийное содержимое
		// (паддинг — не секрет, findings не ожидается).
		const bigLine = `const pad = "${"a".repeat(999_000)}";`;
		writeTempFile(dir, "big-line.txt", [bigLine]);

		const started = Date.now();
		const report = await scanSecrets(dir, { useExternal: "off" });
		const elapsedMs = Date.now() - started;

		expect(elapsedMs, `скан занял ${elapsedMs} мс — усечение строки не сработало`).toBeLessThan(5000);
		expect(report.summary.total, "низкоэнтропийный паддинг — не секрет, чисто").toBe(0);
	});

	it("тайм-бюджет истёк (timeBudgetMs: 0) → stderr-предупреждение, exit 2 при 0 findings (недоверенный результат)", async () => {
		const main = requireExport(await loadScanner(), "main");
		const dir = makeTempDir();
		writeTempFile(dir, "clean.txt", ["const a = 1;"]);

		const console$ = captureConsole();
		const exitCode = await main([dir, "--use-external", "off", "--format", "json"], { timeBudgetMs: 0 });
		const stderr = console$.err.join("\n");
		const stdout = console$.stdout();
		console$.restore();

		expect(stderr, "предупреждение о прерывании — в stderr").toMatch(/тайм-бюджет/);
		expect(stderr).toMatch(/частичные результаты/);
		const report = JSON.parse(stdout);
		expect(report.findings).toEqual([]);
		expect(exitCode, "0 findings + прерван → exit 2 (решение patch 1.0.1, F-2)").toBe(2);
	});

	it("скан в пределах бюджета (дефолт) — без предупреждений, обычный exit-код (регрессия F-2)", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE, "--use-external", "off", "--format", "json"]);
		const stderr = console$.err.join("\n");
		console$.restore();

		expect(stderr, "без предупреждений при обычном скане").toBe("");
		expect(exitCode).toBe(1); // fixture с секретами
	});
});

describe("CLI-контракт: --format text (дефолт), exit 2 при ошибке", () => {
	it("text — ДЕФОЛТ: вывод НЕ JSON, содержит severity и file (renderText)", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE]); // без --format → text

		expect(exitCode).toBe(1);
		const stdout = console$.stdout();
		expect(() => JSON.parse(stdout)).toThrow(); // text, а не JSON
		expect(stdout).toMatch(/(CRITICAL|HIGH)/); // severity
		expect(stdout).toContain("secrets-sample.ts"); // file
	});

	it("--format text явно: формат renderText — '[SEVERITY] file:line — title'", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		await main([SECRETS_SAMPLE, "--format", "text"]);

		const stdout = console$.stdout();
		expect(stdout).toMatch(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/);
		expect(stdout).toMatch(/secrets-sample\.ts:\d+/); // file:line
	});

	it("несуществующий путь: scanSecrets reject; main → 2 (ошибка старше)", async () => {
		const mod = await loadScanner();
		const scanSecrets = requireExport(mod, "scanSecrets");
		const main = requireExport(mod, "main");
		const nonexistent = path.join(makeTempDir(), "no-such-dir");

		await expect(scanSecrets(nonexistent)).rejects.toThrow();

		const console$ = captureConsole();
		const exitCode = await main([nonexistent, "--format", "json"]);
		expect(exitCode).toBe(2);
		expect(console$.err.join("\n").length).toBeGreaterThan(0); // сообщение об ошибке — в stderr
	});

	it("main без позиционного аргумента → 2 (валидация аргументов, §3.3)", async () => {
		const main = requireExport(await loadScanner(), "main");

		const console$ = captureConsole();
		const exitCode = await main([]);

		expect(exitCode).toBe(2);
	});
});
