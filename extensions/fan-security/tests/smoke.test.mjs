/**
 * SMOKE-тест фичи security-worker — ОДИН сквозной happy-path прогон
 * «от входа до результата» по smoke-критериям этапов 1–2:
 *   roadmap: docs/features/security-worker/roadmap.md («Smoke-критерий этапа»
 *   этапа 1 и этапа 2); спека: docs/specs/spec_security-worker_2026-08-31.md
 *   (§2.3 маскирование, §3.3 exit-коды, §6.1/§6.2 схема отчёта).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * СЦЕНАРИЙ (последовательные шаги, общее состояние — объект `smoke` ниже):
 *
 *   шаг 1. Extension fan-security загружается (прямой import default factory —
 *          зеркало контракта загрузчика jiti.import({default:true}) → factory(api))
 *          → factory(mockAPI) вызывает registerCommand("security-scan") ровно
 *          1 раз с description и handler (F-2.6/TC-F-2.6-1).
 *   шаг 2. Оркестратор (импорт из fan-orchestrator, БЕЗ моков — smoke):
 *          getAgentDefinition("security") → readOnly=true, tools ровно
 *          [read, bash, grep, find, ls] (F-1.1/TC-F-1.1-1);
 *          classify_task ("проверь на уязвимости и CVE") → Worker type: security
 *          (F-1.3/TC-F-1.3-1; classifyTaskByDescription не экспортируется —
 *          вызываем публичный инструмент, паттерн test/agents-security-routing.test.mjs).
 *   шаг 3. Сканеры на fixtures (прямые вызовы функций CLI-модулей):
 *          3a scanSecrets(tests/fixtures/secrets-sample.ts) → findings ≥ 1,
 *             evidence замаскирован («AKIA…MNOP», полного секрета нет ни в одном
 *             поле отчёта), resolveExitCode = 1 (F-2.2/TC-F-2.2-1);
 *          3б scanPatterns(tests/fixtures/patterns-sample.ts) → findings ≥ 7
 *             (CWE-группы: SQLi CWE-89, weak crypto CWE-327, …), exit 1
 *             (F-2.3/TC-F-2.3-1);
 *          3в scanDepAudits(tests/fixtures/empty-dep-fixture) → findings [],
 *             exit 0 — нет манифестов, не ошибка (F-2.4/TC-F-2.4-2).
 *   шаг 4. Схема: все три отчёта валидны по createReport-контракту (F-2.1):
 *          JSON-сериализация обратима, summary консистентна с findings
 *          (total === findings.length; bySeverity — пересчитанное слияние,
 *          нулевые severity не включаются), каждый finding — ровно 12 полей §6.1.
 *   шаг 5. CLI через spawn: bun cli/scan-secrets.ts tests/fixtures/secrets-sample.ts
 *          --format json → exit 1, ЦЕЛЫЙ stdout парсится как JSON, секрет
 *          "AKIAABCDEFGHIJKLMNOP" НЕ встречается в сыром выводе (§2.3 инвариант).
 *   шаг 6. Остальные два CLI через spawn (дополнение шага 5 до smoke-критерия
 *          этапа 2 «три CLI — корректные exit-codes и валидный JSON»):
 *          scan-patterns на patterns-sample → exit 1 + валидный JSON;
 *          dep-audit на empty-dep-fixture → exit 0 + findings [].
 *
 * ЗАПУСК (одна команда, из директории пакета):
 *
 *   cd extensions/fan-security
 *   npx vitest run tests/smoke.test.mjs
 *
 *   (входит и в полный прогон пакета — vitest-конфиг пакета включает tests на *.test.mjs;
 *    vitest резолвится из корневого node_modules монорепо, собственных зависимостей
 *    не нужно; для шагов 5–6 нужен bun в PATH, как для обычного использования CLI.)
 *
 * Это smoke, а не юнит-тесты: БЕЗ vi.mock — реальная загрузка extension,
 * реальный реестр/классификатор оркестратора, реальные сканеры на fixtures,
 * реальный subprocess. Провал любого шага = фича не проходит happy path.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib + CLI fan-security (реальные модули — smoke прогоняет именно их)
import { createReport, resolveExitCode, SEVERITIES } from "../lib/report.ts";
import { scanSecrets } from "../cli/scan-secrets.ts";
import { scanPatterns } from "../cli/scan-patterns.ts";
import { scanDepAudits } from "../cli/dep-audit.ts";
// Реестр агентов оркестратора (чистый JS, без тяжёлых зависимостей)
import { getAgentDefinition } from "../../fan-orchestrator/agents/index.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, "..");

/** Fixtures (относительные пути — как в документированных командах CLI). */
const SECRETS_FIXTURE = path.join(testsDir, "fixtures", "secrets-sample.ts");
const PATTERNS_FIXTURE = path.join(testsDir, "fixtures", "patterns-sample.ts");
const EMPTY_DEP_FIXTURE = path.join(testsDir, "fixtures", "empty-dep-fixture");

/** Фейковый AWS-ключ из fixture (roadmap TC-F-2.2-1) и его маска 4+4 (TC-F-2.1-2). */
const FAKE_AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const MASKED_AWS_KEY = "AKIA…MNOP";

/** Контракт агента security (roadmap F-1.1). */
const EXPECTED_SECURITY_TOOLS = ["read", "bash", "grep", "find", "ls"];

/** Схема §6.1: ровно 12 обязательных полей Finding. */
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
].sort();

/** Общее состояние последовательных шагов smoke-сценария. */
const smoke = {
	/** Отчёты шага 3 (прямые вызовы сканеров) — валидируются схемой в шаге 4. */
	reports: {},
};

// ── Хелперы ───────────────────────────────────────────────────────────────────

/** Mock ExtensionAPI (минимум, потребляемый index.ts): registerCommand — vi.fn()-spy. */
function mockAPI() {
	return {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		unregisterTool: vi.fn(),
		on: vi.fn(),
	};
}

/**
 * Запускает CLI-сканер через bun (subprocess) и возвращает нормализованный результат.
 * Бросает читаемую ошибку, если bun недоступен (нужен для шагов 5–6).
 */
function runCli(cliFile, targetArg) {
	const result = spawnSync("bun", [cliFile, targetArg, "--format", "json"], {
		cwd: pkgDir,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) {
		throw new Error(
			`Не удалось запустить bun (нужен в PATH для smoke-шагов CLI): ${result.error.message}`,
		);
	}
	return result;
}

/** Проверяет один Report по createReport-контракту F-2.1 (§6.1/§6.2). */
function expectValidReport(report, expectedTool) {
	expect(report.tool, "tool отчёта").toBe(expectedTool);
	expect(typeof report.version, "version отчёта — строка").toBe("string");
	expect(report.target, "target проставлен").toBeTruthy();
	expect(Number.isNaN(Date.parse(report.scannedAt)), "scannedAt — ISO-8601").toBe(false);

	// JSON-сериализация обратима без потерь (§6.2: «JSON-сериализуем без потерь»)
	const roundTrip = JSON.parse(JSON.stringify(report));
	expect(roundTrip).toEqual(report);

	// summary консистентна с фактическими findings: total и bySeverity пересчитываются
	expect(report.summary.total).toBe(report.findings.length);
	const recomputed = {};
	for (const finding of report.findings) {
		recomputed[finding.severity] = (recomputed[finding.severity] ?? 0) + 1;
	}
	expect(report.summary.bySeverity, "bySeverity — слияние по findings, нулевые не включаются").toEqual(recomputed);

	// Каждый finding — ровно 12 полей схемы §6.1 с валидными enum
	for (const finding of report.findings) {
		expect(Object.keys(finding).sort(), `finding ${finding.id}: ровно 12 полей §6.1`).toEqual(FINDING_FIELDS);
		expect(SEVERITIES, `finding ${finding.id}: severity из enum`).toContain(finding.severity);
		expect(["confirmed", "needs-verification"], `finding ${finding.id}: confidence из enum`).toContain(
			finding.confidence,
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Smoke: security-worker — сквозной happy path
// ═══════════════════════════════════════════════════════════════════════════════

describe("Smoke: security-worker — сквозной happy path (extension → оркестратор → сканеры → схема → CLI)", { timeout: 60_000 }, () => {
	it("шаг 1: extension fan-security загружается — factory(mockAPI) регистрирует /security-scan", async () => {
		// Прямой import = зеркало контракта загрузчика: jiti.import({default:true}) → factory(api)
		const mod = await import("../index.ts");
		expect(typeof mod.default, "default export — factory-функция (контракт loader'а)").toBe("function");

		const api = mockAPI();
		expect(() => mod.default(api), "factory выполняется без исключений").not.toThrow();

		expect(api.registerCommand, "registerCommand вызван ровно 1 раз").toHaveBeenCalledTimes(1);
		const [name, options] = api.registerCommand.mock.calls[0];
		expect(name).toBe("security-scan");
		expect(options, "описание команды — строка").toEqual(
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	it("шаг 2: оркестратор — getAgentDefinition('security') readOnly+tools, classify('проверь на уязвимости и CVE') → security", async () => {
		// Реестр агентов (F-1.1/TC-F-1.1-1)
		const def = getAgentDefinition("security");
		expect(def, "агент security зарегистрирован в AGENT_REGISTRY").toBeTruthy();
		expect(def.type).toBe("security");
		expect(def.readOnly, "readOnly=true (security-воркер ничего не изменяет)").toBe(true);
		expect(def.tools, "tools ровно [read, bash, grep, find, ls]").toEqual(EXPECTED_SECURITY_TOOLS);
		expect(def.icon).toBe("🔒");

		// Routing (F-1.3/TC-F-1.3-1): classifyTaskByDescription не экспортируется —
		// вызываем публичный инструмент classify_task (паттерн agents-security-routing.test.mjs)
		const { registerOrchestratorTools } = await import("../../fan-orchestrator/orchestrator-tools.js");
		let classifyTool;
		const mockFan = {
			registerTool: (toolDef) => {
				if (toolDef.name === "classify_task") classifyTool = toolDef;
			},
			registerCommand: () => {},
			registerAgent: () => {},
		};
		registerOrchestratorTools(mockFan, null, {});
		expect(classifyTool, "инструмент classify_task зарегистрирован").toBeTruthy();

		const result = await classifyTool.execute("smoke-call-id", { description: "проверь на уязвимости и CVE" }, {}, undefined, {});
		const text = result?.content?.[0]?.text ?? "";
		const workerType = /Worker type:\s*(\S+)/.exec(text)?.[1];
		expect(workerType, "security-фраза направляется на security, а не verify/implement").toBe("security");
	});

	it("шаг 3а: scanSecrets(secrets-sample.ts) — findings ≥ 1, evidence замаскирован, exit 1", async () => {
		const report = await scanSecrets(SECRETS_FIXTURE);
		smoke.reports.secrets = report;

		expect(report.tool).toBe("scan-secrets");
		expect(report.findings.length, "минимум один finding (AWS-ключ)").toBeGreaterThanOrEqual(1);
		expect(resolveExitCode(report), "есть findings → exit 1 (§3.3)").toBe(1);

		// AWS-ключ: severity HIGH/CRITICAL, CWE-798, evidence в маске 4+4 (TC-F-2.2-1)
		const aws = report.findings.find((f) => f.cwe === "CWE-798" && f.evidence.includes(MASKED_AWS_KEY));
		expect(aws, "AWS-ключ найден с маскированным evidence «AKIA…MNOP»").toBeTruthy();
		expect(["HIGH", "CRITICAL"], "severity AWS-ключа HIGH или CRITICAL").toContain(aws.severity);

		// Инвариант §2.3: полный секрет НЕ встречается НИ В ОДНОМ поле отчёта
		expect(JSON.stringify(report), "полный секрет отсутствует во всём отчёте").not.toContain(FAKE_AWS_KEY);
	});

	it("шаг 3б: scanPatterns(patterns-sample.ts) — findings ≥ 7 (CWE-группы), exit 1", async () => {
		const report = await scanPatterns(PATTERNS_FIXTURE);
		smoke.reports.patterns = report;

		expect(report.tool).toBe("scan-patterns");
		expect(report.findings.length, "минимум 7 findings по CWE-сигнатурам").toBeGreaterThanOrEqual(7);
		expect(resolveExitCode(report), "есть findings → exit 1 (§3.3)").toBe(1);

		// CWE-группы: SQLi и weak crypto обязательны (TC-F-2.3-1), всего ≥ 6 групп
		const cweGroups = [...new Set(report.findings.map((f) => f.cwe))];
		expect(cweGroups, "CWE-группы из fixture").toEqual(expect.arrayContaining(["CWE-89", "CWE-327"]));
		expect(cweGroups.length, "минимум 6 различных CWE-групп (критерий приёмки F-2.3)").toBeGreaterThanOrEqual(6);
	});

	it("шаг 3в: scanDepAudits(empty-dep-fixture) — findings [], exit 0 (нет манифестов — не ошибка)", async () => {
		const report = await scanDepAudits(EMPTY_DEP_FIXTURE);
		smoke.reports.deps = report;

		expect(report.tool).toBe("dep-audit");
		expect(report.findings, "нет манифестов → findings пустой массив").toEqual([]);
		expect(resolveExitCode(report), "чистый скан → exit 0, НЕ ошибка (TC-F-2.4-2)").toBe(0);
	});

	it("шаг 4: схема — все три отчёта валидны по createReport-контракту (summary консистентна, 12 полей finding)", () => {
		// Эталон контракта: createReport сам вычисляет summary (TC-F-2.1-1)
		const contract = createReport({
			tool: "smoke",
			version: "0.0.0",
			target: "<contract>",
			findings: [
				{ scanner: "smoke", severity: "HIGH" },
				{ scanner: "smoke", severity: "HIGH" },
				{ scanner: "smoke", severity: "LOW" },
			],
		});
		expect(contract.summary).toEqual({ bySeverity: { HIGH: 2, LOW: 1 }, total: 3 });

		const reports = smoke.reports;
		expect(Object.keys(reports).sort(), "шаг 3 отработал — все три отчёта собраны").toEqual([
			"deps",
			"patterns",
			"secrets",
		]);
		expectValidReport(reports.secrets, "scan-secrets");
		expectValidReport(reports.patterns, "scan-patterns");
		expectValidReport(reports.deps, "dep-audit");
	});

	it("шаг 5: CLI spawn `bun cli/scan-secrets.ts secrets-sample --format json` — exit 1, валидный JSON, секрет не в сыром выводе", () => {
		const result = runCli("cli/scan-secrets.ts", "tests/fixtures/secrets-sample.ts");

		expect(result.status, "exit-код процесса = 1 (есть findings, §3.3)").toBe(1);
		expect(result.stdout?.trim(), "stdout непустой").toBeTruthy();

		// Целый stdout — валидный JSON (--format json без посторонних строк, §4.1)
		let report;
		expect(() => {
			report = JSON.parse(result.stdout);
		}, "stdout целиком парсится как JSON").not.toThrow();
		expect(report.tool).toBe("scan-secrets");
		expect(report.findings.length).toBeGreaterThanOrEqual(1);
		expect(resolveExitCode(report), "exit-код по отчёту консистентен (1)").toBe(1);

		// Маскирование в СЫРОМ выводе: полного секрета нет, маска 4+4 есть (§2.3)
		expect(result.stdout, "сырой stdout НЕ содержит полного секрета").not.toContain(FAKE_AWS_KEY);
		const aws = report.findings.find((f) => f.cwe === "CWE-798");
		expect(aws?.evidence, "evidence AWS-ключа замаскирован («AKIA…MNOP»)").toContain(MASKED_AWS_KEY);
	});

	it("шаг 6: CLI spawn scan-patterns (exit 1 + JSON) и dep-audit (exit 0 + []) — «три CLI» smoke-критерия этапа 2", () => {
		// scan-patterns: findings → exit 1, валидный JSON
		const patterns = runCli("cli/scan-patterns.ts", "tests/fixtures/patterns-sample.ts");
		expect(patterns.status, "scan-patterns: exit 1").toBe(1);
		const patternsReport = JSON.parse(patterns.stdout);
		expect(patternsReport.tool).toBe("scan-patterns");
		expect(patternsReport.findings.length, "scan-patterns: findings ≥ 7").toBeGreaterThanOrEqual(7);

		// dep-audit на пустом fixture: нет манифестов → exit 0, findings [] (не ошибка)
		const deps = runCli("cli/dep-audit.ts", "tests/fixtures/empty-dep-fixture");
		expect(deps.status, "dep-audit: exit 0").toBe(0);
		const depsReport = JSON.parse(deps.stdout);
		expect(depsReport.tool).toBe("dep-audit");
		expect(depsReport.findings, "dep-audit: findings []").toEqual([]);
	});
});
