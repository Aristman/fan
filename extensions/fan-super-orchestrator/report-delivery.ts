// F-E: HTTP delivery для lineage-escalation.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-E
//
// Разделение ответственности (из roadmap F-E): «разделить доставку
// (HTTP POST) и запись (file IO)». Этот модуль — исключительно доставка:
// POST-запрос на /api/deliver-report к указанному ancestor. Запись
// orphan-файлов остаётся в walk-up.ts, recovery-цикл — в
// orphan-recovery.ts.
//
// Используется обоими:
//   • walk-up.ts        — deliverToAncestor() для каждого hop вверх
//     по lineage до coordinator.
//   • orphan-recovery.ts — deliverToAncestor() при re-delivery
//     сохранённого orphan-отчёта.
//
// Идемпотентность обеспечивается через parentReportId на стороне
// получателя, а не в этом модуле.

import type { LineageEntry } from "./build-work-package.js";

export interface DeliverOpts {
	/** Узел-получатель (immediate parent при walk-up, или coordinator
	 *  при orphan-recovery). */
	target: LineageEntry;
	/** Idempotency key, по которому получатель ожидает отчёт. */
	parentReportId: string;
	/** correlationId узла-отправителя (для observability на стороне
	 *  получателя). */
	fromCorrelationId: string;
	/** Полезная нагрузка отчёта. */
	payload: Record<string, unknown>;
	/** Fetch-инжекция (для тестирования). */
	fetch: typeof fetch;
	/** Таймаут одного POST. По умолчанию 30s. */
	timeoutMs?: number;
}

export interface DeliverResult {
	ok: boolean;
	status: number;
	error?: string;
}

/** Доставить отчёт ancestor-узлу через HTTP POST /api/deliver-report.
 *
 *  Семантика:
 *  • Возвращает `{ ok: false, status: 0, error }` на любую сетевую
 *    ошибку или таймаут. Это позволяет walk-up корректно эскалировать
 *    на следующий hop, а orphan-recovery — корректно инкрементировать
 *    счётчик failed.
 *  • HTTP-ошибки (4xx/5xx) трактуются как `ok: false, status: N` —
 *    это уже был получен ответ, retry на том же узле бесполезен,
 *    но walk-up всё равно попробует grandparent (TC-FE-1b обрабатывает
 *    именно reject, а не !ok, см. тест ниже — поведение совместимо
 *    с walk-up, потому что walk-up проверяет `response.ok` после
 *    успешного fetch; здесь мы нормализуем оба случая через `ok`).
 *
 *  Нормализация ошибок:
 *    • AbortError (timeout) → error: "timeout" или "aborted".
 *    • TypeError (network) → error: <message>.
 *    • Другое → error: <message>.
 */
export async function deliverToAncestor(opts: DeliverOpts): Promise<DeliverResult> {
	const timeoutMs = opts.timeoutMs ?? 30000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	try {
		timer = setTimeout(() => controller.abort(), timeoutMs);
		const response = await opts.fetch(`${opts.target.url}/api/deliver-report`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.target.token}`,
			},
			body: JSON.stringify({
				parentReportId: opts.parentReportId,
				fromCorrelationId: opts.fromCorrelationId,
				payload: opts.payload,
			}),
			signal: controller.signal,
		});
		return { ok: response.ok, status: response.status };
	} catch (err) {
		const message = err instanceof Error ? (err.name === "AbortError" ? "aborted" : err.message) : String(err);
		return { ok: false, status: 0, error: message };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
