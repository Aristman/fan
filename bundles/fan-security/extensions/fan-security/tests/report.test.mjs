/**
 * TDD RED tests for F-2.1 «Общая схема отчёта и text-рендер (lib/report.ts)».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.1» (TC-F-2.1-1, TC-F-2.1-2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §6.1 (схема Finding),
 *       §6.2 (контракты CLI: JSON, маскирование, консистентность summary),
 *       §2.3 (маскирование секретов 4+4), §3.3 (exit-коды 0/1/2).
 *
 * Целевой контракт (спецификация для implement-воркера) — lib/report.ts экспортирует:
 *   - типы (TS): Severity, Confidence, Finding, ReportSummary, Report — по схеме §6.1;
 *   - SEVERITIES: readonly массив ровно ["CRITICAL","HIGH","MEDIUM","LOW","INFO"];
 *   - createReport({ tool, version, target, findings, scannedAt? }): Report —
 *     заполняет scannedAt (ISO-строка, если не передан) и ВЫЧИСЛЯЕТ summary
 *     из фактических findings (никаких ручных подсчётов на стороне вызывающего);
 *   - maskSecret(secret: string): string — видны ровно первые 4 и последние 4 символа,
 *     между ними U+2026 HORIZONTAL ELLIPSIS («AKIA…MNOP», эталон roadmap TC-F-2.1-2);
 *     строки короче порога 9 (4+4+скрытая середина) возвращаются без изменений
 *     (спека §6.1 порог не определяет — порог фиксирует этот тест); детерминирована;
 *   - renderText(report: Report): string — для каждого finding: severity, file:line, title;
 *     пустой отчёт → осмысленное «чисто»-сообщение;
 *   - resolveExitCode(report?, error?): 0|1|2 — pure-функция: error → 2;
 *     findings.length > 0 → 1; иначе 0. Оба аргумента отсутствуют → 2 (defensive).
 *
 * Red-ожидание (roadmap): «TC-F-2.1-1 — падает первым: lib/report.ts не существует».
 * Все падения должны читаться как «модуля/экспорта нет» (guard-хелперы дают понятные
 * сообщения), а не «тест сломан».
 */
import { describe, expect, it } from "vitest";

const REPORT_URL = "../lib/report.ts";

/** Все 12 обязательных полей Finding по §6.1 (в схемном порядке). */
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

let reportModulePromise;

/**
 * Guard: загрузка целевого модуля. При Red (модуля нет) каждый тест падает
 * с читаемой причиной вместо сырого "Cannot find module".
 */
function loadReport() {
	if (!reportModulePromise) {
		reportModulePromise = import(REPORT_URL).catch((cause) => {
			reportModulePromise = undefined; // разрешить повторную попытку в следующем тесте
			throw new Error(
				`lib/report.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/lib/report.ts по схеме §6.1 спеки (roadmap F-2.1, Red-фаза TDD).`,
			);
		});
	}
	return reportModulePromise;
}

/**
 * Guard: проверка наличия экспорта с читаемым сообщением — при Red причина
 * «экспорта нет», а не безликое "received undefined".
 *
 * Возвращает прозрачный Proxy над экспортом, поддерживающий ОБА стиля доступа:
 *   - `const fn = requireExport(mod, "fn")` — прокси ведёт себя как сам экспорт
 *     (вызов, чтение свойств и Symbol-ключи форвардятся к цели);
 *   - `const { fn } = requireExport(mod, "fn")` — чтение собственного имени
 *     возвращает сам экспорт.
 * Универсально для любого имени; продакшн-экспорты остаются чистыми.
 */
function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`lib/report.ts не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). Дополни экспорты по целевому контракту — шапка этого файла, roadmap F-2.1.`,
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

/** Валидный Finding по §6.1 — все 12 обязательных полей заполнены. */
function makeFinding(overrides = {}) {
	return {
		id: "SEC-001",
		scanner: "scan-secrets",
		severity: "HIGH",
		title: "AWS Access Key в исходниках",
		file: "src/config.ts",
		line: 42,
		cwe: "CWE-798",
		evidence: "aws_access_key_id = AKIA…MNOP",
		description: "Хардкод AWS-ключа в репозитории",
		exploit: "Компрометация облачного аккаунта по утёкшему ключу",
		remediation: "Отозвать ключ, убрать из кода, вынести в секрет-менеджер",
		confidence: "confirmed",
		...overrides,
	};
}

/** Report с 3 findings (2 HIGH, 1 LOW) — сценарий TC-F-2.1-1. */
function makeThreeFindingInput() {
	return {
		tool: "scan-secrets",
		version: "0.1.0",
		target: "packages/api",
		findings: [
			makeFinding({ id: "SEC-001", severity: "HIGH" }),
			makeFinding({ id: "SEC-002", severity: "HIGH", line: 43 }),
			makeFinding({ id: "SEC-003", severity: "LOW", title: ".env закоммичен" }),
		],
	};
}

describe("TC-F-2.1-1: JSON-сериализация валидна и summary консистентна", () => {
	it("createReport → JSON.stringify → JSON.parse без ошибок; все поля Finding сериализуются", async () => {
		const { createReport } = requireExport(await loadReport(), "createReport");
		const input = makeThreeFindingInput();

		const report = createReport(input);
		const parsed = JSON.parse(JSON.stringify(report));

		// Верхнеуровневая схема §6.2: { tool, version, target, scannedAt, findings[], summary }
		expect(Object.keys(parsed).sort()).toEqual(
			["findings", "scannedAt", "summary", "target", "tool", "version"].sort(),
		);
		expect(parsed.tool).toBe(input.tool);
		expect(parsed.version).toBe(input.version);
		expect(parsed.target).toBe(input.target);
		expect(parsed.findings).toHaveLength(3);

		// Каждый finding: ровно 12 полей §6.1, значения сериализуются без потерь
		for (const [i, finding] of parsed.findings.entries()) {
			expect(Object.keys(finding).sort()).toEqual([...FINDING_FIELDS].sort());
			expect(finding).toEqual(input.findings[i]);
		}
	});

	it("summary.total = 3 и bySeverity = {HIGH: 2, LOW: 1} — вычислен из фактических findings, не вручную", async () => {
		const { createReport } = requireExport(await loadReport(), "createReport");
		const report = createReport(makeThreeFindingInput());

		// Roadmap: bySeverity === {HIGH:2, LOW:1} → нулевые severity в bySeverity не включаются
		expect(report.summary.total).toBe(3);
		expect(report.summary.bySeverity).toEqual({ HIGH: 2, LOW: 1 });

		// Консистентность переживает JSON-раундтрип (§6.2: bySeverity консистентен с findings[])
		const parsed = JSON.parse(JSON.stringify(report));
		expect(parsed.summary).toEqual(report.summary);
	});

	it("scannedAt: авто-заполняется ISO-строкой; явно переданный — сохраняется", async () => {
		const { createReport } = requireExport(await loadReport(), "createReport");

		const auto = createReport(makeThreeFindingInput());
		expect(typeof auto.scannedAt).toBe("string");
		expect(Number.isNaN(Date.parse(auto.scannedAt))).toBe(false);

		const fixedAt = "2026-08-31T12:00:00.000Z";
		const fixed = createReport({ ...makeThreeFindingInput(), scannedAt: fixedAt });
		expect(fixed.scannedAt).toBe(fixedAt);
	});
});

describe("Схема §6.1: severity enum", () => {
	it("SEVERITIES — ровно 5 значений CRITICAL|HIGH|MEDIUM|LOW|INFO", async () => {
		const { SEVERITIES } = requireExport(await loadReport(), "SEVERITIES", "const");
		expect(SEVERITIES).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
	});
});

describe("TC-F-2.1-2: maskSecret — маскирование секретов (4+4 символа)", () => {
	it("AKIAABCDEFGHIJKLMNOP → 'AKIA…MNOP': видны ровно первые 4 и последние 4 символа", async () => {
		const { maskSecret } = requireExport(await loadReport(), "maskSecret");
		const secret = "AKIAABCDEFGHIJKLMNOP"; // 20 символов: AKIA + 12 скрытых + MNOP

		const masked = maskSecret(secret);

		// Эталон roadmap TC-F-2.1-2: 'AKIA…MNOP', разделитель — U+2026 HORIZONTAL ELLIPSIS
		expect(masked).toBe("AKIA…MNOP");
		// Инвариант: середина секрета не утекает в вывод (§2.3: не воспроизводить секреты полностью)
		expect(masked).not.toContain(secret.slice(4, -4));
	});

	it("строки короче порога (len < 9) маскируются целиком — «…» (fix F-3, patch 1.0.1)", async () => {
		// Фикс-обоснование (patch 1.0.1): короткие токены не должны утекать даже частично.
		// Раньше len < 9 возвращался без изменений — PoC аудита: api_key="shortkey"
		// (8 симв.) попадал в evidence открытым текстом. Теперь — полное маскирование.
		const { maskSecret } = requireExport(await loadReport(), "maskSecret");
		expect(maskSecret("")).toBe("…");
		expect(maskSecret("short")).toBe("…");
		expect(maskSecret("12345678")).toBe("…");
	});

	it("граница порога: строка из 9 символов маскируется (скрыто 2 символа E,F; хвост 3 GHI)", async () => {
		const { maskSecret } = requireExport(await loadReport(), "maskSecret");
		const masked = maskSecret("ABCDEFGHI");
		expect(masked).toBe("ABCD…GHI");
		expect(masked).not.toContain("E");
	});

	it("детерминирована: повторные вызовы дают идентичный результат", async () => {
		const { maskSecret } = requireExport(await loadReport(), "maskSecret");
		const secret = "AKIAABCDEFGHIJKLMNOP";
		expect(maskSecret(secret)).toBe(maskSecret(secret));
	});
});

describe("exit-code helpers (§3.3: 0 чисто / 1 findings / 2 ошибка)", () => {
	it("resolveExitCode: пустой findings → 0 (скан чистый)", async () => {
		const { createReport, resolveExitCode } = await loadReport().then((m) => ({
			createReport: requireExport(m, "createReport"),
			resolveExitCode: requireExport(m, "resolveExitCode"),
		}));
		const report = createReport({ ...makeThreeFindingInput(), findings: [] });
		expect(resolveExitCode(report)).toBe(0);
	});

	it("resolveExitCode: есть findings → 1", async () => {
		const { createReport, resolveExitCode } = await loadReport().then((m) => ({
			createReport: requireExport(m, "createReport"),
			resolveExitCode: requireExport(m, "resolveExitCode"),
		}));
		const report = createReport(makeThreeFindingInput());
		expect(resolveExitCode(report)).toBe(1);
	});

	it("resolveExitCode: ошибка → 2, даже при наличии findings (ошибка старше)", async () => {
		const { createReport, resolveExitCode } = await loadReport().then((m) => ({
			createReport: requireExport(m, "createReport"),
			resolveExitCode: requireExport(m, "resolveExitCode"),
		}));
		const report = createReport(makeThreeFindingInput());
		expect(resolveExitCode(null, new Error("сканер упал"))).toBe(2);
		expect(resolveExitCode(report, new Error("сканер упал"))).toBe(2);
	});

	it("resolveExitCode: нет ни отчёта, ни ошибки → 2 (defensive: чистоту доказать нечем)", async () => {
		const { resolveExitCode } = requireExport(await loadReport(), "resolveExitCode");
		expect(resolveExitCode(undefined, undefined)).toBe(2);
	});
});

describe("text-рендер (renderText, §6.1 → human-readable)", () => {
	it("содержит severity, file:line и title для каждого finding", async () => {
		const m = await loadReport();
		const createReport = requireExport(m, "createReport");
		const renderText = requireExport(m, "renderText");

		const findings = [
			makeFinding({ id: "SEC-001", severity: "HIGH", title: "SQL-инъекция", file: "src/db.ts", line: 10 }),
			makeFinding({
				id: "SEC-002",
				severity: "LOW",
				title: "Слабый хеш md5",
				file: "lib/util.ts",
				line: 77,
				confidence: "needs-verification",
			}),
		];
		const text = renderText(
			createReport({ tool: "scan-patterns", version: "0.1.0", target: "packages/api", findings }),
		);

		expect(typeof text).toBe("string");
		for (const finding of findings) {
			expect(text).toContain(finding.severity);
			expect(text).toContain(`${finding.file}:${finding.line}`);
			expect(text).toContain(finding.title);
		}
	});

	it("пустой отчёт рендерится в осмысленное «чисто»-сообщение", async () => {
		const m = await loadReport();
		const createReport = requireExport(m, "createReport");
		const renderText = requireExport(m, "renderText");

		const text = renderText(
			createReport({ tool: "scan-patterns", version: "0.1.0", target: "packages/api", findings: [] }),
		);

		expect(typeof text).toBe("string");
		expect(text.trim().length).toBeGreaterThan(0);
		// «Чисто»-сообщение: чист/clean/no findings — формулировка на стороне реализации
		expect(text).toMatch(/чист|clean|no findings/i);
	});
});
