/**
 * Общая схема отчёта security-сканера и text-рендер (F-2.1).
 *
 * Единый контракт «воркер → CLI → отчёт»: типы Finding/Report по §6.1 спеки,
 * вычисление summary из фактических findings, маскирование секретов 4+4,
 * human-readable рендер и exit-коды CLI (§3.3: 0 чисто / 1 findings / 2 ошибка).
 *
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §3.3, §6.1, §6.2.
 * Без внешних зависимостей — чистый TypeScript (runtime Bun).
 */

/** Уровень критичности finding'а (§6.1). */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** Степень подтверждённости finding'а (§6.1, §2.3). */
export type Confidence = "confirmed" | "needs-verification";

/**
 * Один результат сканирования по схеме §6.1 — ровно 12 обязательных полей.
 * `evidence` всегда содержит замаскированную цитату кода (см. {@link maskSecret}).
 */
export interface Finding {
	/** Стабильный идентификатор в рамках отчёта, напр. "SEC-001". */
	id: string;
	/** Источник: scan-secrets | scan-patterns | dep-audit | external:<tool> | llm. */
	scanner: string;
	/** Критичность из {@link SEVERITIES}. */
	severity: Severity;
	/** Краткий человекочитаемый заголовок. */
	title: string;
	/** Путь относительно корня сканирования. */
	file: string;
	/** Номер строки (1-based; 0 — если неприменимо). */
	line: number;
	/** Идентификатор CWE, напр. "CWE-798". */
	cwe: string;
	/** Замаскированная цитата кода (секреты — только 4+4 символа, §2.3). */
	evidence: string;
	/** Описание проблемы. */
	description: string;
	/** Вектор эксплуатации. */
	exploit: string;
	/** Рекомендация по устранению. */
	remediation: string;
	/** Подтверждённость: confirmed | needs-verification. */
	confidence: Confidence;
}

/** Сводка по отчёту: bySeverity консистентен с findings[] (§6.2), нулевые severity не включаются. */
export interface ReportSummary {
	/** Количество findings по severity (только ненулевые значения). */
	bySeverity: Partial<Record<Severity, number>>;
	/** Общее количество findings === findings.length. */
	total: number;
}

/**
 * Режим гибридного сканирования внешних тулов (F-2.5):
 * - "off"  — детект и запуск внешних тулов не выполняются;
 * - "auto" — детект выполнен, доменная тулза найдена и запущена (мердж);
 *           при auto без найденных тулов в отчёте остаётся "off" (TC-F-2.5-1);
 * - "only" — только внешние findings, базовый regex-скан пропущен.
 */
export type ExternalMode = "off" | "auto" | "only";

/** Результат детекта внешних тулов (F-2.5); присутствует в отчёте только если детект запускался. */
export interface ExternalToolsReport {
	/** gitleaks найден в PATH (домен scan-secrets). */
	gitleaks?: boolean;
	/** semgrep найден в PATH (домен scan-patterns). */
	semgrep?: boolean;
}

/**
 * Отчёт сканера по схеме §6.2: `{ tool, version, target, scannedAt, findings[], summary }`.
 * JSON-сериализуем без потерь; summary вычисляется, а не передаётся вручную.
 */
export interface Report {
	/** Имя сканера, напр. "scan-secrets". */
	tool: string;
	/** Версия сканера, напр. "0.1.0". */
	version: string;
	/** Цель сканирования (путь/пакет). */
	target: string;
	/** Момент сканирования, ISO-8601. */
	scannedAt: string;
	/** Найденные проблемы. */
	findings: Finding[];
	/** Вычисленная сводка (см. {@link ReportSummary}). */
	summary: ReportSummary;
	/** ФАКТИЧЕСКИ применённый режим внешних тулов (F-2.5); отсутствует в старых отчётах. */
	external?: ExternalMode;
	/** Результат детекта внешних тулов (F-2.5); присутствует только если детект запускался. */
	externalTools?: ExternalToolsReport;
}

/** Все допустимые severity в порядке убывания критичности (enum §6.1). */
export const SEVERITIES: readonly Severity[] = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
	"INFO",
] as const;

/** Порог маскирования: строки короче не маскируются (нечего скрывать). */
const MASK_THRESHOLD = 9;
/** Разделитель скрытой середины — U+2026 HORIZONTAL ELLIPSIS. */
const MASK_SEPARATOR = "…";
/** Количество видимых символов с каждого края секрета (§2.3: «первые/последние 4 символа»). */
const MASK_VISIBLE = 4;
/** Минимум гарантированно скрытых символов середины (на границе порога хвост укорачивается). */
const MASK_MIN_HIDDEN = 2;

/** Аргумент {@link createReport}: findings, scannedAt и external-поля опциональны. */
export interface CreateReportInput {
	tool: string;
	version: string;
	target: string;
	findings?: Finding[];
	scannedAt?: string;
	/** Passthrough фактического режима внешних тулов (F-2.5). */
	external?: ExternalMode;
	/** Passthrough результата детекта внешних тулов (F-2.5). */
	externalTools?: ExternalToolsReport;
}

/**
 * Собирает Report: заполняет scannedAt (ISO-8601, если не передан) и ВЫЧИСЛЯЕТ
 * summary из фактических findings — вызывающий не считает вручную (§6.2).
 * Нулевые severity в bySeverity не попадают.
 */
export function createReport(input: CreateReportInput): Report {
	const findings = input.findings ?? [];

	const bySeverity: Partial<Record<Severity, number>> = {};
	for (const severity of SEVERITIES) {
		const count = findings.filter((f) => f.severity === severity).length;
		if (count > 0) {
			bySeverity[severity] = count;
		}
	}

	const report: Report = {
		tool: input.tool,
		version: input.version,
		target: input.target,
		scannedAt: input.scannedAt ?? new Date().toISOString(),
		findings,
		summary: { bySeverity, total: findings.length },
	};
	// F-2.5: опциональные external-поля — passthrough ТОЛЬКО когда заданы,
	// чтобы §6.2 six-key контракт сохранялся для вызовов без гибридного режима
	// (строгое равенство ключей в tests/report.test.mjs / F-2.1).
	if (input.external !== undefined) {
		report.external = input.external;
	}
	if (input.externalTools !== undefined) {
		report.externalTools = input.externalTools;
	}
	return report;
}

/**
 * Маскирует секрет: видны первые {@link MASK_VISIBLE} символа, скрытая середина
 * (минимум {@link MASK_MIN_HIDDEN} символов) и хвост — до 4 символов
 * («AKIA…MNOP», TC-F-2.1-2). На границе порога (len = 9) хвостовых видно 3,
 * чтобы скрыть минимум 2 символа середины. Строки короче порога 9 возвращаются
 * без изменений. Чистая и детерминированная.
 */
export function maskSecret(secret: string): string {
	if (secret.length < MASK_THRESHOLD) {
		return secret;
	}
	const hidden = Math.max(secret.length - 2 * MASK_VISIBLE, MASK_MIN_HIDDEN);
	return (
		secret.slice(0, MASK_VISIBLE) +
		MASK_SEPARATOR +
		secret.slice(MASK_VISIBLE + hidden)
	);
}

/**
 * Рендерит отчёт в human-readable text: для каждого finding — severity,
 * file:line и title. Пустой отчёт → осмысленное «чисто»-сообщение.
 */
export function renderText(report: Report): string {
	if (report.findings.length === 0) {
		return (
			`Чисто: уязвимостей не найдено ` +
			`(${report.tool} v${report.version}, target: ${report.target}, ${report.scannedAt})`
		);
	}

	const lines: string[] = [
		`Security report: ${report.tool} v${report.version} — target: ${report.target} (${report.scannedAt})`,
		`Total: ${report.summary.total}`,
		"",
	];
	for (const finding of report.findings) {
		lines.push(`[${finding.severity}] ${finding.file}:${finding.line} — ${finding.title}`);
	}
	return lines.join("\n");
}

/**
 * Exit-код CLI по §3.3: 0 — скан чистый, 1 — есть findings, 2 — ошибка.
 * Pure-функция; error старше findings; нет ни отчёта, ни ошибки → 2 (defensive:
 * чистоту доказать нечем).
 */
export function resolveExitCode(report?: Report | null, error?: Error | null): 0 | 1 | 2 {
	if (error || !report) {
		return 2;
	}
	return report.findings.length > 0 ? 1 : 0;
}
