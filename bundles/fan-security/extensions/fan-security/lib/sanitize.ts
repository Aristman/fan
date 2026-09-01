/**
 * Санитизация evidence и общие лимиты сканирования (patch 1.0.1: F-1, F-2).
 *
 * Единая точка маскирования секретов в evidence для ВСЕХ источников находок
 * (fix security-аудита F-1, MEDIUM): до патча maskSecret применялся только в
 * scan-secrets и gitleaks-конвертере, а dep-audit (сырая строка манифеста),
 * scan-patterns (сырой match[0]) и semgrep-конвертер (extra.lines) клали
 * evidence открытым текстом (PoC: токен ghp_… утекал из манифеста).
 * Инвариант спеки §2.3: секрет не утекает ни в одно поле отчёта.
 *
 * Состав:
 * - sanitizeEvidence(text) — прогон текста через SECRET_PATTERNS
 *   (lib/patterns/secrets.ts) с заменой совпадений через maskSecret, затем
 *   маскирование высокоэнтропийных токенов (entropy-детект scan-secrets,
 *   вынесен сюда как общий хелпер) и обрезка длины до 300 символов (§6.1);
 * - entropy-хелперы (shannonEntropy / isHighEntropyToken / entropyCandidates) —
 *   общий код scan-secrets и sanitizeEvidence (раньше дублировались бы);
 * - MAX_SCAN_LINE_LENGTH / clampScanLine — усечение строки перед построчным
 *   regex-матчингом (F-2 ReDoS: CWE-89/78 regex квадратичны, строка 1 МБ →
 *   десятки секунд);
 * - DEFAULT_TIME_BUDGET_MS — дефолтный тайм-бюджет скана scanPatterns/scanSecrets
 *   (F-2): истечение → остановка с частичными результатами (решение о exit-коде —
 *   на стороне CLI, см. cli/scan-patterns.ts / cli/scan-secrets.ts).
 *
 * Без внешних зависимостей; типы не нужны — чистые строковые функции.
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §4, §6.1.
 */

import { maskSecret } from "./report.ts";
import {
	ENTROPY_BARE_MIN_LENGTH,
	ENTROPY_MIN_LENGTH,
	ENTROPY_QUOTED_MIN_LENGTH,
	ENTROPY_SHANNON_THRESHOLD,
	SECRET_PATTERNS,
} from "./patterns/secrets.ts";

// ── Пределы (F-1 evidence, F-2 ReDoS/бюджет) ────────────────────────────────

/** Предел длины evidence после санитизации (§6.1: цитата, ≤ 300 символов). */
export const MAX_EVIDENCE_LENGTH = 300;

/**
 * Максимальная длина строки, передаваемой в построчный regex-матчинг (F-2).
 *
 * Обоснование: CWE-сигнатуры (lib/patterns/cwe.ts) локальны по природе —
 * уязвимая конструкция занимает одну строку кода; сигнатурных строк длиннее
 * 8 КБ в реальных исходниках не бывает (это минифицированные/сгенерированные
 * данные). Квадратичные regex (CWE-89/78) на строке 1 МБ дают десятки секунд
 * CPU — усечение до 8192 делает worst case константным.
 *
 * ПРИНЯТАЯ ПОТЕРЯ: хвост строки длиннее 8192 символов НЕ сканируется
 * (простое усечение головы, сохраняющее начало строки). Сигнатура или секрет
 * в глубине сверхдлинной строки будут пропущены — осознанный компромисс
 * против ReDoS/деградации; файл при этом > 1 МБ всё равно отсекается
 * MAX_FILE_BYTES (lib/walker.ts).
 */
export const MAX_SCAN_LINE_LENGTH = 8192;

/** Дефолтный тайм-бюджет скана, мс (F-2): истечение → частичные результаты. */
export const DEFAULT_TIME_BUDGET_MS = 30_000;

/**
 * Усекает строку до {@link MAX_SCAN_LINE_LENGTH} символов перед матчингом.
 * Строки в пределах лимита возвращаются как есть (без копирования).
 */
export function clampScanLine(line: string): string {
	return line.length > MAX_SCAN_LINE_LENGTH ? line.slice(0, MAX_SCAN_LINE_LENGTH) : line;
}

// ── Entropy-детект (общий хелпер; раньше — cli/scan-secrets.ts, §2.3) ───────

/** Shannon-энтропия строки, бит/символ (0 для пустой строки). */
export function shannonEntropy(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	const counts = new Map<string, number>();
	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

/** Высокоэнтропийный токен: ≥ ENTROPY_MIN_LENGTH, mixed case + цифры, shannon > порога. */
export function isHighEntropyToken(token: string): boolean {
	if (token.length < ENTROPY_MIN_LENGTH) {
		return false;
	}
	if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) {
		return false;
	}
	return shannonEntropy(token) > ENTROPY_SHANNON_THRESHOLD;
}

/**
 * Кандидаты entropy-проверки (regex собран из констант lib/patterns/secrets.ts).
 * matchAll клонирует regex — переиспользование модульных констант безопасно.
 */
const QUOTED_CANDIDATE_RE = new RegExp(
	`["'\`]([^"'\\s]{${ENTROPY_QUOTED_MIN_LENGTH},})["'\`]`,
	"g",
);
const BARE_CANDIDATE_RE = new RegExp(`[A-Za-z0-9_\\-/+=]{${ENTROPY_BARE_MIN_LENGTH},}`, "g");

/**
 * Кандидаты для entropy-проверки в строке: содержимое кавычек и «голые»
 * длинные токены (base64-тела, значения в .env без кавычек).
 */
export function entropyCandidates(line: string): string[] {
	const tokens = new Set<string>();
	for (const match of line.matchAll(QUOTED_CANDIDATE_RE)) {
		if (match[1]) {
			tokens.add(match[1]);
		}
	}
	for (const match of line.matchAll(BARE_CANDIDATE_RE)) {
		tokens.add(match[0]);
	}
	return [...tokens];
}

// ── sanitizeEvidence (F-1) ──────────────────────────────────────────────────

/**
 * Санитизирует цитату для evidence находки (инвариант §2.3 — секрет не утекает
 * ни в одно поле отчёта):
 *
 * 1) прогон через SECRET_PATTERNS (lib/patterns/secrets.ts): каждое совпадение
 *    известного формата (ghp_…, AKIA…, sk-…, xox…, PEM, api_key=…) заменяется
 *    на maskSecret (4+4, «ghp_ABCD…wxyz»; короткие — целиком «…», fix F-3);
 * 2) высокоэнтропийные токены без известного префикса (entropy-детект выше)
 *    заменяются на маскированный вид — консервативно: потенциальный секрет
 *    не остаётся в открытом виде даже без распознанного формата;
 * 3) длина обрезается до {@link MAX_EVIDENCE_LENGTH} (≤ 300, §6.1).
 *
 * Детерминирована; не бросает. Вызывающий при необходимости дополнительно
 * триммит/обрезает под свой лимит (напр. MAX_EXTERNAL_EVIDENCE_LENGTH = 240).
 */
export function sanitizeEvidence(text: string): string {
	let result = text;

	// Шаг 1: известные форматы секретов → maskSecret. Свежий RegExp на каждый
	// паттерн: модульные regex с флагом g не должны тянуть lastIndex между вызовами.
	for (const pattern of SECRET_PATTERNS) {
		const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
		result = result.replace(regex, (match: string, ...groups: unknown[]) => {
			const secret =
				pattern.captureGroup > 0 ? (groups[pattern.captureGroup - 1] as string | undefined) : match;
			if (typeof secret !== "string" || secret.length === 0) {
				return match; // пустой/отсутствующий захват скрывать нечего
			}
			return maskSecret(secret);
		});
	}

	// Шаг 2: высокоэнтропийные токены без известного префикса → маскированный вид.
	for (const token of entropyCandidates(result)) {
		if (!isHighEntropyToken(token)) {
			continue;
		}
		result = result.split(token).join(maskSecret(token));
	}

	// Шаг 3: предел длины evidence (§6.1).
	return result.length > MAX_EVIDENCE_LENGTH ? result.slice(0, MAX_EVIDENCE_LENGTH) : result;
}
