// F-E: Recovery для orphan-отчётов с идемпотентностью.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-E
//
// При старте (или по расписанию) узел сканирует orphan-reports/ и
// пытается доставить каждый отчёт указанному deliveryTarget.
// Идемпотентность обеспечивается через Set parentReportId —
// повторные попытки для уже доставленного отчёта пропускаются.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listOrphanReportIds, removeOrphanReport } from "./orphan-storage.js";
import type { LineageEntry } from "./build-work-package.js";
import { deliverToAncestor } from "./report-delivery.js";

export interface RecoverOrphanReportsOpts {
	missionDir: string;
	deliveryTarget: LineageEntry;
	fetch: typeof fetch;
	/** Pre-populated Set parentReportId для skip-логики. */
	idempotencyCache?: Set<string>;
}

export interface RecoverOrphanReportsResult {
	delivered: number;
	skipped: number;
	failed: number;
}

export async function recoverOrphanReports(
	opts: RecoverOrphanReportsOpts,
): Promise<RecoverOrphanReportsResult> {
	const cache = opts.idempotencyCache ?? new Set<string>();
	// Локальный seen-set: предотвращает двойной подсчёт skip для
	// нескольких orphan-файлов с одинаковым parentReportId в одном
	// вызове recovery (см. TC-FE-3b).
	const skippedSeen = new Set<string>();

	const ids = listOrphanReportIds(opts.missionDir);
	let delivered = 0;
	let skipped = 0;
	let failed = 0;

	for (const id of ids) {
		const filePath = join(opts.missionDir, "orphan-reports", `${id}.json`);
		if (!existsSync(filePath)) continue;

		const content = JSON.parse(readFileSync(filePath, "utf8"));
		const parentReportId: string | undefined =
			content.payload?.parentReportId;

		if (parentReportId && cache.has(parentReportId)) {
			// Считаем skip только для первого вхождения данного
			// parentReportId в текущем вызове (TC-FE-3b: 2 файла,
			// 1 skip).
			if (!skippedSeen.has(parentReportId)) {
				skippedSeen.add(parentReportId);
				skipped++;
			}
			continue;
		}

		// HTTP POST делегирован в report-delivery.ts (TC-FE-3a: ok →
		// cache+remove+delivered; !ok → failed; TC-FE-3b/c не доходят
		// до fetch благодаря idempotency и пустому списку).
		const result = await deliverToAncestor({
			target: opts.deliveryTarget,
			parentReportId: content.reportId,
			fromCorrelationId: content.payload?.correlationId,
			payload: content.payload?.payload,
			fetch: opts.fetch,
		});

		if (result.ok) {
			if (parentReportId) cache.add(parentReportId);
			removeOrphanReport(opts.missionDir, id);
			delivered++;
		} else {
			failed++;
		}
	}

	return { delivered, skipped, failed };
}
