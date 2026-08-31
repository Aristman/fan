/**
 * F-2.6 — Slash-команда `/security-scan`: тонкий агрегирующий слой над тремя
 * CLI-сканерами пакета — scan-secrets (F-2.2), scan-patterns (F-2.3),
 * dep-audit (F-2.4).
 *
 * Контракт extension-API (packages/agent/src/extensions.ts +
 * core/extensions/loader.ts): default export — factory(fan) (loader делает
 * `await factory(api)` после jiti.import({default:true}));
 * fan.registerCommand("security-scan", { description, handler });
 * handler(args, ctx) → Promise<void>, вывод ТОЛЬКО через ctx.ui.notify
 * (паттерн fan-confluence / fan-loop).
 *
 * Поведение handler (roadmap F-2.6, контракт tests/index.test.mjs):
 *   1) парсинг `[path] [--format json|text]`; format по умолчанию "text";
 *   2) без позиционного path — usage-сообщение через notify (содержит
 *      «usage» и «security-scan»), сканеры НЕ запускаются, handler resolves;
 *   3) три сканера — ровно по 1 запуску (Promise.allSettled), target —
 *      первым аргументом (как передан);
 *   4) агрегация: summary.total = сумме findings; bySeverity — слияние по
 *      всем отработавшим сканерам, нулевые severity не включаются
 *      (семантика createReport из lib/report.ts);
 *   5) упавший сканер — частичная деградация: пометка «<tool>: ошибка
 *      сканера — <причина>», счётчики считаются только по отработавшим;
 *   6) text (дефолт): человекочитаемая сводка — сканеры, counts по severity,
 *      строки «[SEVERITY] file:line — title», Total;
 *   7) --format json: ровно одно notify-сообщение, ЦЕЛИКОМ парсящееся как
 *      JSON агрегата { summary, findings, scanners, target } — вызов notify
 *      БЕЗ type-аргумента (потребитель теста собирает сообщение join'ом
 *      всех аргументов вызова, суффикс сломал бы JSON.parse);
 *   8) > 20 findings в отчёте сканера → полный JSON ЭТОГО отчёта во
 *      временный файл security-scan-*.json (os.tmpdir), абсолютный путь
 *      упоминается в сводке; ≤ 20 — файлы не пишутся.
 *
 * DI (шапка tests/index.test.mjs): сканеры подменяются тестами через
 * vi.doMock по РЕЗОЛВЛЕННОМУ пути — specifier'ы ровно "./cli/scan-secrets.ts",
 * "./cli/scan-patterns.ts", "./cli/dep-audit.ts". Резолвление ЛЕНИВОЕ —
 * `await import(...)` внутри handler при каждом запуске команды: тестовый
 * harness кэширует factory-модуль между тестами (extensionModulePromise) и
 * сбрасывает реестр модулей (vi.resetModules + vi.doMock) перед каждым
 * тестом; статические связки зафиксировались бы при первой загрузке
 * factory и vi.doMock в них не попадал бы, ленивый import каждый раз
 * перечитывает актуальный реестр (моки или реальные модули).
 *
 * Схема отчёта — lib/report.ts (F-2.1). Без внешних зависимостей:
 * node:fs/promises, node:os, node:path; типы @seaagents/fan-coding-agent —
 * type-only (стираются при исполнении).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §5.3;
 * roadmap: docs/features/security-worker/roadmap.md → F-2.6.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import type { Finding, Report, Severity } from "./lib/report.ts";

// ── Константы ───────────────────────────────────────────────────────────────

/** Имена сканеров в порядке запуска (tool из схем отчётов F-2.2–F-2.4). */
const SCANNER_NAMES = ["scan-secrets", "scan-patterns", "dep-audit"] as const;

/** Порог «полный JSON-отчёт в файл» (roadmap F-2.6: «> 20 findings»). */
const JSON_FILE_THRESHOLD = 20;

/** Подсказка при неверных аргументах (без path). */
const USAGE =
	"Usage: /security-scan [path] [--format json|text]\n" +
	"Пример: /security-scan packages/api --format json";

// ── Типы агрегата ───────────────────────────────────────────────────────────

/** Сводка по скану (слияние по всем отработавшим сканерам). */
interface ScanSummary {
	/** Общее количество findings. */
	total: number;
	/** Слияние bySeverity; нулевые severity не включаются (§6.2). */
	bySeverity: Partial<Record<Severity, number>>;
}

/** Запись breakdown'а по одному сканеру (scanners[] в JSON-агрегате). */
interface ScannerBreakdown {
	/** Имя сканера: scan-secrets | scan-patterns | dep-audit. */
	tool: string;
	/** "ok" — отчёт получен; "error" — сканер упал (частичная деградация). */
	status: "ok" | "error";
	/** Количество findings (у упавшего — 0). */
	total: number;
	/** Сводка отчёта сканера (у упавшего — нулевая). */
	summary: ScanSummary;
	/** Причина падения (только для status === "error"). */
	error?: string;
}

/** JSON-агрегат трёх сканеров (--format json): сводка + слияние + breakdown. */
interface ScanAggregate {
	summary: ScanSummary;
	/** Слияние findings всех отработавших сканеров (каждый со scanner). */
	findings: Finding[];
	scanners: ScannerBreakdown[];
	/** Цель сканирования — как передана в команде. */
	target: string;
}

// ── Парсинг аргументов ──────────────────────────────────────────────────────

/** Разбор `[path] [--format json|text]`; format по умолчанию "text". */
function parseArgs(args: string): { target?: string; format: "text" | "json" } {
	let target: string | undefined;
	let format: "text" | "json" = "text";
	let expectFormat = false;

	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		if (expectFormat) {
			expectFormat = false;
			if (token === "json" || token === "text") {
				format = token;
			}
			continue;
		}
		if (token === "--format") {
			expectFormat = true;
		} else if (token.startsWith("--format=")) {
			const value = token.slice("--format=".length);
			if (value === "json" || value === "text") {
				format = value;
			}
		} else if (!token.startsWith("--") && target === undefined) {
			target = token;
		}
	}
	return { target, format };
}

// ── Запуск и агрегация сканеров ─────────────────────────────────────────────

/**
 * Запускает три сканера ровно по 1 разу (target — первым аргументом) и
 * агрегирует результаты. Сканер, отклонившийся с ошибкой, НЕ валидит
 * остальные (Promise.allSettled — частичная деградация): в breakdown
 * попадает запись status:"error", счётчики — только по отработавшим.
 */
async function runScanners(target: string): Promise<{
	findings: Finding[];
	scanners: ScannerBreakdown[];
	reports: Report[];
}> {
	// Ленивое резолвление ПРИ КАЖДОМ запуске (см. шапку: DI через vi.doMock +
	// vi.resetModules) — specifier'ы ровно контрактные, чтобы моки попадали
	// в модульный граф по тем же резолвленным путям.
	const settled = await Promise.allSettled([
		import("./cli/scan-secrets.ts").then((module) => module.scanSecrets(target)),
		import("./cli/scan-patterns.ts").then((module) => module.scanPatterns(target)),
		import("./cli/dep-audit.ts").then((module) => module.scanDepAudits(target)),
	]);

	const findings: Finding[] = [];
	const scanners: ScannerBreakdown[] = [];
	const reports: Report[] = [];

	for (const [index, result] of settled.entries()) {
		const tool = SCANNER_NAMES[index] ?? `scanner-${index}`;
		if (result.status === "fulfilled") {
			const report = result.value;
			reports.push(report);
			findings.push(...report.findings);
			scanners.push({
				tool,
				status: "ok",
				total: report.summary.total,
				summary: report.summary,
			});
		} else {
			const reason =
				result.reason instanceof Error ? result.reason.message : String(result.reason);
			scanners.push({
				tool,
				status: "error",
				total: 0,
				summary: { total: 0, bySeverity: {} },
				error: reason,
			});
		}
	}

	return { findings, scanners, reports };
}

/** Слияние bySeverity всех findings; нулевые severity не включаются (§6.2). */
function mergeBySeverity(findings: Finding[]): Partial<Record<Severity, number>> {
	const bySeverity: Partial<Record<Severity, number>> = {};
	for (const finding of findings) {
		bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
	}
	return bySeverity;
}

/**
 * > 20 findings в отчёте сканера → полный JSON ЭТОГО отчёта во временный
 * файл security-scan-*.json (os.tmpdir, абсолютный путь). Возвращает пути
 * записанных файлов для упоминания в сводке.
 */
async function dumpOversizedReports(reports: Report[]): Promise<string[]> {
	const paths: string[] = [];
	for (const report of reports) {
		if (report.findings.length <= JSON_FILE_THRESHOLD) {
			continue;
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filePath = path.join(tmpdir(), `security-scan-${report.tool}-${stamp}.json`);
		await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
		paths.push(filePath);
	}
	return paths;
}

// ── Рендеры ─────────────────────────────────────────────────────────────────

/** Человекочитаемая сводка: сканеры, severity × файл, total, путь к JSON. */
function renderTextSummary(aggregate: ScanAggregate, filePaths: string[]): string {
	const lines: string[] = [`Security scan: ${aggregate.target}`];

	for (const entry of aggregate.scanners) {
		if (entry.status === "error") {
			lines.push(`${entry.tool}: ошибка сканера — ${entry.error ?? "недоступен"}`);
			continue;
		}
		const counts = Object.entries(entry.summary.bySeverity)
			.map(([severity, count]) => `${severity}: ${count}`)
			.join(", ");
		lines.push(`${entry.tool}: ${entry.total} findings${counts ? ` (${counts})` : " — чисто"}`);
	}

	for (const finding of aggregate.findings) {
		lines.push(`  [${finding.severity}] ${finding.file}:${finding.line} — ${finding.title}`);
	}

	lines.push(`Total: ${aggregate.summary.total} findings`);

	if (filePaths.length > 0) {
		lines.push(`Полный отчёт (JSON): ${filePaths.join(", ")}`);
	}

	return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function securityScanHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { target, format } = parseArgs(args);

	// Без path — usage, сканеры не запускаются, handler resolves без исключения.
	if (!target) {
		ctx.ui.notify(USAGE, "warning");
		return;
	}

	const { findings, scanners, reports } = await runScanners(target);

	const aggregate: ScanAggregate = {
		summary: { total: findings.length, bySeverity: mergeBySeverity(findings) },
		findings,
		scanners,
		target,
	};
	const filePaths = await dumpOversizedReports(reports);

	if (format === "json") {
		for (const entry of scanners) {
			if (entry.status === "error") {
				ctx.ui.notify(
					`security-scan: сканер недоступен (ошибка) — ${entry.tool}: ${entry.error ?? ""}`,
					"warning",
				);
			}
		}
		// РОВНО ОДНО сообщение-агрегат и БЕЗ type-аргумента: сообщение должно
		// ЦЕЛИКОМ парситься как JSON (см. шапку файла).
		ctx.ui.notify(JSON.stringify(aggregate, null, 2));
		if (filePaths.length > 0) {
			ctx.ui.notify(`security-scan: полный отчёт — ${filePaths.join(", ")}`, "info");
		}
		return;
	}

	ctx.ui.notify(renderTextSummary(aggregate, filePaths), "info");
}

// ── Extension factory ───────────────────────────────────────────────────────

/** Factory extension'а: регистрирует slash-команду security-scan. */
export default function (fan: ExtensionAPI): void {
	fan.registerCommand("security-scan", {
		description:
			"Security-аудит пути: scan-secrets + scan-patterns + dep-audit; сводка в чат, --format json — полный JSON",
		handler: securityScanHandler,
	});
}
