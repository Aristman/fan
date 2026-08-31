/**
 * TDD RED tests for F-2.6 «Slash-команда /security-scan (index.ts extension-factory)».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.6» (TC-F-2.6-1/2/3).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md (сводка в чат, JSON-файл > 20 findings).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ EXTENSION-API (зеркало реального, packages/agent/src/extensions.ts +
 * packages/coding-agent/src/core/extensions/loader.ts):
 *
 *   • Загрузка: jiti.import(path, {default: true}) → default export ДОЛЖЕН быть
 *     функцией → runtime делает `await factory(api)`.
 *     ⇒ index.ts: `export default function (fan: ExtensionAPI)` (sync или async).
 *   • fan.registerCommand(name, options) — options: { description?: string,
 *     getArgumentCompletions?, handler } (Omit<RegisteredCommand, "name"|"sourceInfo">).
 *   • handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>.
 *     Возвращаемое значение НЕ выводится в чат — вывод через ctx.ui.notify(
 *     message: string, type?: "info"|"warning"|"error") (паттерн fan-confluence,
 *     fan-loop). ExtensionCommandContext (минимум, используемый командой):
 *     { ui: { notify, setStatus, ... }, hasUI, cwd, model, isIdle(), signal,
 *     abort(), hasPendingMessages(), waitForIdle() }.
 *
 * КОНТРАКТ index.ts ДЛЯ GREEN (roadmap F-2.6):
 *
 *   export default function (fan) {
 *     fan.registerCommand("security-scan", { description: string, handler });
 *   }
 *   - registerCommand вызывается РОВНО 1 раз, name === "security-scan".
 *   - handler(args, ctx):
 *       1) парсит [path] [--format json|text]; format по умолчанию "text";
 *       2) БЕЗ позиционного path → usage-сообщение через ctx.ui.notify
 *          (текст содержит «usage» (регистронезависимо) и «security-scan»),
 *          сканеры НЕ запускаются, handler РАЗРЕШАЕТСЯ без исключения;
 *       3) запускает ровно по 1 разу три сканера, передавая target ПЕРВЫМ
 *          аргументом (как передан или resolved — тот же файл);
 *       4) агрегирует: summary.total = сумме findings, bySeverity — слияние
 *          по severity всех сканеров (нулевые не включаются — семантика
 *          createReport из lib/report.ts);
 *       5) сканер, отклонившийся с ошибкой, НЕ валиит остальные (частичная
 *          деградация): сводка содержит пометку об ошибке (имя сканера +
 *          индикатор «ошибка/error/fail/недоступен»), счётчики считаются
 *          только по отработавшим;
 *       6) text (дефолт): человекочитаемая сводка — имена трёх сканеров
 *          (scan-secrets / scan-patterns / dep-audit), слова severity
 *          (CRITICAL/HIGH/…), файлы findings (severity × файл), total;
 *       7) --format json: хотя бы один notify содержит строку, ЦЕЛИКОМ
 *          парсящуюся как JSON агрегата: { summary: {total, bySeverity},
 *          findings: <слияние всех, каждый со scanner>, scanners: <breakdown
 *          по сканерам — массив [{tool|scanner|name, total|summary{total}, …}>
 *          или объект {имя: …}>, target };
 *       8) > 20 findings: ДОПОЛНИТЕЛЬНО пишет полный JSON во временный файл
 *          (абсолютный путь; имя содержит «security-scan», окончание «.json»)
 *          и упоминает путь в сводке; при ≤ 20 findings текстовая сводка НЕ
 *          содержит пути к .json-файлу.
 *
 * РЕШЕНИЕ ПО DI (документировано, задание F-2.6): подмена трёх scan-функций
 * через vitest-моки модулей (vi.doMock), А НЕ через options-параметр factory:
 *   - runtime зовёт factory(api) ровно с одним аргументом — сигнатура factory
 *     должна остаться каноничной (как у fan-soul/fan-confluence/fan-loop);
 *   - паттерн vi.doMock + import(index) — устоявшийся в репо для extension-
 *     тестов (extensions/voice-ollama-tui/smoke.test.ts);
 *   - СЛЕДСТВИЕ-КОНТРАКТ: index.ts импортирует сканеры РОВНО так (для попадания
 *     vi.doMock по резолved-пути):
 *         import { scanSecrets } from "./cli/scan-secrets.ts";
 *         import { scanPatterns } from "./cli/scan-patterns.ts";
 *         import { scanDepAudits } from "./cli/dep-audit.ts";
 *   - моки возвращают валидные Report по схеме F-2.1 (собраны createReport из
 *     lib/report.ts), unit-сканеры НЕ запускаются — spawn/файловая система
 *     не затрагиваются (кроме временного файла в тесте >20 findings).
 *
 * Red-ожидание (roadmap): «TC-F-2.6-1 — падает первым: extension-файла не
 * существует». Все падения читаются как «index.ts не существует» (guard-хелпер
 * даёт понятное сообщение), а не «тест сломан». 104 старых теста остаются
 * зелёными.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/report.ts уже существует (F-2.1 COMPLETED) — статический импорт для сборки мок-отчётов
import { createReport, SEVERITIES } from "../lib/report.ts";

const EXTENSION_URL = "../index.ts";

// Спецификаторы для vi.doMock — резолвятся в те же файлы, что импортирует index.ts
const SECRETS_MODULE = "../cli/scan-secrets.ts";
const PATTERNS_MODULE = "../cli/scan-patterns.ts";
const DEPS_MODULE = "../cli/dep-audit.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

/** Порог «полный JSON в файл» из roadmap F-2.6. */
const JSON_FILE_THRESHOLD = 20;

// ── Фиктивные данные (все фейковые) ─────────────────────────────────────────

/** Один Finding по схеме §6.1 — ровно 12 обязательных полей. */
function makeFinding(scanner, severity, file, line, title) {
	return {
		id: `${scanner}-T-${file}-${line}`.replace(/[^\w-]/g, "_"),
		scanner,
		severity,
		title,
		file,
		line,
		cwe: "CWE-1395",
		evidence: "[маскированная цитата…]",
		description: "Фейковое описание для теста агрегации.",
		exploit: "Фейковый вектор.",
		remediation: "Фейковая рекомендация.",
		confidence: "confirmed",
	};
}

/** Валидный Report по схеме F-2.1 (summary вычисляет createReport). */
function makeReport(tool, findings) {
	return createReport({ tool, version: "0.1.0", target: "<mock>", findings });
}

/** Дефолтный набор: 2 + 1 + 1 findings разной severity (TC-F-2.6-2 из roadmap). */
function defaultReports() {
	return {
		"scan-secrets": makeReport("scan-secrets", [
			makeFinding("scan-secrets", "CRITICAL", "src/config.ts", 12, "Hardcoded fake AWS key"),
			makeFinding("scan-secrets", "HIGH", ".env", 1, "Fake env file committed"),
		]),
		"scan-patterns": makeReport("scan-patterns", [
			makeFinding("scan-patterns", "MEDIUM", "lib/eval.ts", 42, "Fake eval usage"),
		]),
		"dep-audit": makeReport("dep-audit", [
			makeFinding("dep-audit", "LOW", "package.json", 7, "Fake vulnerable dependency"),
		]),
	};
}

// ── Моки ExtensionAPI / ExtensionCommandContext (зеркало контракта из шапки) ─

/** Mock ExtensionAPI: registerCommand — spy, остальные методы загрузки — no-op. */
function mockAPI() {
	return {
		registerCommand: vi.fn(),
		on: vi.fn(),
		registerTool: vi.fn(),
		unregisterTool: vi.fn(),
		updateTool: vi.fn(),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerMessageRenderer: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		setSessionName: vi.fn(),
		setLabel: vi.fn(),
		setActiveTools: vi.fn(),
		setModel: vi.fn(),
		setThinkingLevel: vi.fn(),
	};
}

/** Mock ExtensionCommandContext (минимум из шапки); notify копит вызовы. */
function mockCtx(cwd = testsDir) {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			input: vi.fn(),
			confirm: vi.fn(),
			custom: vi.fn(),
		},
		hasUI: true,
		cwd,
		model: undefined,
		isIdle: vi.fn(() => true),
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: vi.fn(() => false),
		waitForIdle: vi.fn(async () => {}),
	};
}

// ── Guard-загрузка + DI-подмена сканеров ─────────────────────────────────────

let extensionModulePromise;

/**
 * Guard: загрузка index.ts. При Red (файла нет) тест падает с читаемой
 * причиной вместо сырого "Cannot find module".
 */
function loadExtension() {
	if (!extensionModulePromise) {
		extensionModulePromise = import(EXTENSION_URL).catch((cause) => {
			extensionModulePromise = undefined; // разрешить повторную попытку в следующем тесте
			throw new Error(
				`index.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/index.ts по контракту из шапки этого файла ` +
					`(roadmap F-2.6, Red-фаза TDD): default export factory(fan) → ` +
					`fan.registerCommand("security-scan", { description, handler }).`,
			);
		});
	}
	return extensionModulePromise;
}

/**
 * DI-подмена трёх сканеров + загрузка index.ts. vi.doMock регистрируется ПОСЛЕ
 * vi.resetModules() и ДО import — моки попадают в модульный граф index.ts
 * (specifiers совпадают с контрактными из шапки). overrides заменяет мок целиком
 * (напр. { scanDepAudits: vi.fn(async () => { throw new Error("boom") }) }).
 */
async function loadExtensionWithScanners(overrides = {}) {
	vi.resetModules();
	const defaults = defaultReports();
	const mocks = {
		scanSecrets: overrides.scanSecrets ?? vi.fn(async () => defaults["scan-secrets"]),
		scanPatterns: overrides.scanPatterns ?? vi.fn(async () => defaults["scan-patterns"]),
		scanDepAudits: overrides.scanDepAudits ?? vi.fn(async () => defaults["dep-audit"]),
	};
	vi.doMock(SECRETS_MODULE, () => ({ scanSecrets: mocks.scanSecrets }));
	vi.doMock(PATTERNS_MODULE, () => ({ scanPatterns: mocks.scanPatterns }));
	vi.doMock(DEPS_MODULE, () => ({ scanDepAudits: mocks.scanDepAudits }));

	const mod = await loadExtension();
	const api = mockAPI();
	await mod.default(api);

	const registerCalls = api.registerCommand.mock.calls;
	expect(registerCalls.length, "registerCommand должен быть вызван ровно 1 раз").toBe(1);
	const handler = registerCalls[0][1]?.handler;
	expect(typeof handler, "registerCommand('security-scan') должен получить handler-функцию").toBe("function");

	return { mod, api, mocks, handler };
}

/** Регистрирует extension и вызывает handler(args); возвращает ctx и текст notify. */
async function runHandler(handler, args, cwd = testsDir) {
	const ctx = mockCtx(cwd);
	await handler(args, ctx);
	const messages = ctx.ui.notify.mock.calls.map((call) => call.map(String).join(" "));
	return { ctx, messages, combined: messages.join("\n") };
}

/** Все notify-сообщения, которые ЦЕЛИКОМ парсятся как JSON. */
function jsonMessages(messages) {
	return messages
		.map((message) => {
			try {
				return JSON.parse(message);
			} catch {
				return undefined;
			}
		})
		.filter(Boolean);
}

/** Нормализует scanners-breakdown (массив ИЛИ объект) в Map имя → total. */
function scannerTotals(agg) {
	const raw = agg?.scanners;
	const entries = Array.isArray(raw)
		? raw
		: Object.entries(raw ?? {}).map(([key, value]) => ({ key, ...value }));
	const totals = new Map();
	for (const entry of entries) {
		const name = entry.tool ?? entry.scanner ?? entry.name ?? entry.key;
		if (!name) continue;
		const total =
			entry.total ??
			entry.summary?.total ??
			Object.values(entry.summary?.bySeverity ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
		totals.set(name, typeof total === "number" ? total : undefined);
	}
	return totals;
}

/** Временная директория-цель сканирования (auto-cleanup в afterEach). */
const tempDirs = [];
const tempArtifacts = [];
function makeTempDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-security-scan-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const file of tempArtifacts.splice(0)) {
		rmSync(file, { force: true });
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ═════════════════════════════════════════════════════════════════════════════
// TC-F-2.6-1: Команда регистрируется при загрузке extension
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.6-1: Команда регистрируется при загрузке extension", () => {
	it("default export — функция (контракт загрузчика: jiti.import({default:true}) → factory(api))", async () => {
		const mod = await loadExtension();

		expect(typeof mod.default, "index.ts должен экспортировать default-функцию (factory)").toBe(
			"function",
		);
	});

	it("factory(api) → registerCommand вызван ровно 1 раз: name='security-scan', с description и handler-функцией", async () => {
		const { api } = await loadExtensionWithScanners();

		expect(api.registerCommand).toHaveBeenCalledTimes(1);
		const [name, options] = api.registerCommand.mock.calls[0];
		expect(name).toBe("security-scan");
		expect(options).toEqual(
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// TC-F-2.6-2: Handler агрегирует три сканера (моки: 2 + 1 + 1 findings)
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.6-2: Handler агрегирует три сканера", () => {
	it("каждый сканер запущен ровно 1 раз с целевым путём первым аргументом", async () => {
		const target = makeTempDir();
		const { handler, mocks } = await loadExtensionWithScanners();

		await runHandler(handler, `${target} --format json`);

		for (const name of ["scanSecrets", "scanPatterns", "scanDepAudits"]) {
			const mock = mocks[name];
			expect(mock, `${name}: ровно 1 вызов`).toHaveBeenCalledTimes(1);
			const targetArg = mock.mock.calls[0][0];
			expect(
				path.resolve(String(targetArg)),
				`${name}: целевой путь первым аргументом`,
			).toBe(path.resolve(target));
		}
	});

	it("--format json: агрегированный JSON консистентен (total=4, bySeverity — слияние, counts 2/1/1 по сканерам)", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners();
		const { messages } = await runHandler(handler, `${target} --format json`);

		const aggregates = jsonMessages(messages);
		expect(
			aggregates.length,
			"при --format json хотя бы одно notify-сообщение должно быть целиком валидным JSON",
		).toBeGreaterThanOrEqual(1);
		const agg = aggregates[aggregates.length - 1];

		// Суммарный summary консистентен (критерий приёмки 2 из roadmap)
		expect(agg.summary.total).toBe(4);
		expect(agg.findings.length).toBe(4);
		expect(agg.summary.bySeverity).toEqual({ CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 });
		for (const severity of Object.keys(agg.summary.bySeverity)) {
			expect(SEVERITIES).toContain(severity);
		}

		// Counts по трём scanner'ам
		const totals = scannerTotals(agg);
		expect(totals.get("scan-secrets")).toBe(2);
		expect(totals.get("scan-patterns")).toBe(1);
		expect(totals.get("dep-audit")).toBe(1);
		expect([...totals.values()].reduce((sum, n) => sum + (n ?? 0), 0)).toBe(agg.summary.total);

		// Слияние findings: каждый scanner представлен, target проставлен
		const scannersInFindings = new Set(agg.findings.map((f) => f.scanner));
		expect([...scannersInFindings].sort()).toEqual(["dep-audit", "scan-patterns", "scan-secrets"]);
		expect(String(agg.target ?? "")).toBeTruthy();
	});

	it("text (дефолт): человекочитаемая сводка — имена трёх сканеров, severity-слова, total", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners();
		const { combined } = await runHandler(handler, target); // без --format → text

		expect(combined, "имя scanner'а scan-secrets").toContain("scan-secrets");
		expect(combined, "имя scanner'а scan-patterns").toContain("scan-patterns");
		expect(combined, "имя scanner'а dep-audit").toContain("dep-audit");
		for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
			expect(combined, `severity ${severity} упомянута в сводке`).toContain(severity);
		}
		expect(combined, "total findings упомянут в сводке").toMatch(/\b4\b/);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// TC-F-2.6-3: Неверные аргументы — usage-подсказка
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.6-3: Неверные аргументы — usage-подсказка", () => {
	it("handler('') → resolves, usage (usage + security-scan), сканеры НЕ запущены", async () => {
		const { handler, mocks } = await loadExtensionWithScanners();

		const { combined } = await runHandler(handler, ""); // roadmap: handler('')

		expect(combined.toLowerCase()).toContain("usage");
		expect(combined).toContain("security-scan");
		expect(mocks.scanSecrets).not.toHaveBeenCalled();
		expect(mocks.scanPatterns).not.toHaveBeenCalled();
		expect(mocks.scanDepAudits).not.toHaveBeenCalled();
	});

	it("handler('--format json') без пути → usage, сканеры НЕ запущены, без исключения", async () => {
		const { handler, mocks } = await loadExtensionWithScanners();

		const { combined } = await runHandler(handler, "--format json");

		expect(combined.toLowerCase()).toContain("usage");
		expect(mocks.scanSecrets).not.toHaveBeenCalled();
		expect(mocks.scanPatterns).not.toHaveBeenCalled();
		expect(mocks.scanDepAudits).not.toHaveBeenCalled();
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// Дополнения к roadmap-кейсам
// ═════════════════════════════════════════════════════════════════════════════

describe("(а) text-сводка: severity × файл, человекочитаемая", () => {
	it("каждый finding представлен парой (severity, file) в сводке", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners();
		const { combined } = await runHandler(handler, target);

		const expected = [
			["CRITICAL", "src/config.ts"],
			["HIGH", ".env"],
			["MEDIUM", "lib/eval.ts"],
			["LOW", "package.json"],
		];
		for (const [severity, file] of expected) {
			expect(combined, `${severity} × ${file}: severity в сводке`).toContain(severity);
			expect(combined, `${severity} × ${file}: файл в сводке`).toContain(file);
		}
	});
});

describe("(б) --format json: полный агрегат (findings со scanner, target) в чате", () => {
	it("JSON-сообщение содержит полное слияние findings (по 12 полей схемы) и target", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners();
		const { messages } = await runHandler(handler, `${target} --format json`);

		const aggregates = jsonMessages(messages);
		expect(aggregates.length).toBeGreaterThanOrEqual(1);
		const agg = aggregates[aggregates.length - 1];

		expect(agg.findings.length).toBe(4);
		for (const finding of agg.findings) {
			expect(finding.scanner).toBeTruthy();
			expect(SEVERITIES).toContain(finding.severity);
			expect(typeof finding.file).toBe("string");
		}
		expect(path.resolve(String(agg.target))).toBe(path.resolve(target));
	});
});

describe("(в) > 20 findings → полный JSON в файл + путь в сводке; ≤ 20 — файл не пишется", () => {
	it("25 findings: сводка содержит абсолютный путь к security-scan-*.json; файл существует и консистентен", async () => {
		const target = makeTempDir();
		const many = Array.from({ length: 25 }, (_, i) =>
			makeFinding("scan-secrets", "INFO", `src/file${i}.ts`, i + 1, `Fake issue #${i}`),
		);
		const { handler } = await loadExtensionWithScanners({
			scanSecrets: vi.fn(async () => makeReport("scan-secrets", many)),
		});
		const { combined } = await runHandler(handler, target); // text-режим: сводка + путь к файлу

		const match = combined.match(/[^\s"']*security-scan[^\s"']*\.json/i);
		expect(match, "путь к JSON-файлу должен быть упомянут в сводке").toBeTruthy();

		const filePath = match[0];
		tempArtifacts.push(filePath);
		expect(path.isAbsolute(filePath), "путь к файлу — абсолютный").toBe(true);
		expect(existsSync(filePath), "JSON-файл записан на диск").toBe(true);

		const agg = JSON.parse(readFileSync(filePath, "utf8"));
		expect(agg.findings.length).toBe(25);
		expect(agg.summary.total).toBe(25);
		expect(agg.summary.bySeverity).toEqual({ INFO: 25 });
	});

	it("4 findings (≤ порога): текстовая сводка НЕ содержит пути к .json-файлу", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners();
		const { combined } = await runHandler(handler, target);

		// Абсолютный путь к .json (имя файла findings «package.json» — НЕ путь)
		expect(combined).not.toMatch(/(?:[A-Za-z]:)?[/\\][^\s"']*\.json/i);
	});
});

describe("(г) ошибка одного сканера — частичная деградация, остальные не валидся", () => {
	it("dep-audit упал: handler resolves, JSON-агрегат содержит только 2+1, dep-audit не в counts", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners({
			scanDepAudits: vi.fn(async () => {
				throw new Error("npm audit failed (fake)");
			}),
		});
		const { messages } = await runHandler(handler, `${target} --format json`);

		const aggregates = jsonMessages(messages);
		expect(aggregates.length).toBeGreaterThanOrEqual(1);
		const agg = aggregates[aggregates.length - 1];

		expect(agg.summary.total).toBe(3); // 2 secrets + 1 patterns, без упавшего
		expect(agg.findings.length).toBe(3);
		const totals = scannerTotals(agg);
		expect(totals.get("scan-secrets")).toBe(2);
		expect(totals.get("scan-patterns")).toBe(1);
		expect(totals.get("dep-audit") ?? 0, "упавший сканер не даёт счётчик findings").toBe(0);
	});

	it("text-режим: сводка помечает dep-audit как ошибочный, но показывает результаты остальных", async () => {
		const target = makeTempDir();
		const { handler } = await loadExtensionWithScanners({
			scanDepAudits: vi.fn(async () => {
				throw new Error("npm audit failed (fake)");
			}),
		});
		const { combined } = await runHandler(handler, target);

		expect(combined, "имя упавшего сканера в сводке").toContain("dep-audit");
		expect(combined, "маркер ошибки в сводке").toMatch(/ошиб|error|fail|недоступен/i);
		expect(combined, "scan-secrets отработал — severity упомянута").toContain("CRITICAL");
		expect(combined, "scan-patterns отработал — severity упомянута").toContain("MEDIUM");
		expect(combined, "total только по отработавшим (3)").toMatch(/\b3\b/);
	});
});
