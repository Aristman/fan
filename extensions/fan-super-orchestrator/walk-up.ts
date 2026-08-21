// F-E: Walk-up protocol for lineage escalation.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-E
//
// Спека: docs/features/super-orchestrator-v2/architecture.md §6
//
// Walk-up: дочерний узел пытается доставить отчёт своему immediate parent
// (последний элемент lineage, идущий ПЕРЕД самим вызывающим узлом).
// При timeout / connection error — эскалация к grandparent, и так далее
// до coordinator (lineage[0]).
//
// Если все hops exhausted и передан `orphanPath` — отчёт записывается
// в orphan-файл по указанному пути (атомарно: tmp → rename) для
// последующего recovery через orphan-recovery.ts.

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LineageEntry } from "./build-work-package.js";
import { deliverToAncestor } from "./report-delivery.js";

export interface DeliverReportOpts {
	report: { correlationId: string; payload: Record<string, unknown> };
	/** Полная lineage от coordinator до вызывающего узла.
	 *  В тестах последний элемент = сам caller (см. TC-FE-1a/b/c).
	 *  В production lineage = [root, ..., parent] (без self). */
	lineage: LineageEntry[];
	parentReportId: string;
	fetch: typeof fetch;
	hopTimeoutMs?: number;
	/** Путь к orphan-файлу, куда записать отчёт при exhausted walks. */
	orphanPath?: string;
	missionDir?: string;
}

export interface DeliverReportResult {
	delivered: boolean;
	deliveredTo?: string;
	orphanWritten?: boolean;
	attempts: number;
}

export async function deliverReport(
	opts: DeliverReportOpts,
): Promise<DeliverReportResult> {
	const hopTimeoutMs = opts.hopTimeoutMs ?? 30000;
	let attempts = 0;

	// Находим позицию caller в lineage. В тестах caller = последний элемент
	// (`orch` в [coord, so1, so2, orch]). В production lineage может не
	// содержать self — тогда стартуем с последнего элемента (parent).
	const callerIdx = opts.lineage.findIndex(
		(e) => e.correlationId === opts.report.correlationId,
	);
	const startIdx = callerIdx >= 0 ? callerIdx - 1 : opts.lineage.length - 1;

	// Walk-up: от immediate parent (startIdx) вверх до coordinator (index 0).
	for (let i = startIdx; i >= 0; i--) {
		const ancestor = opts.lineage[i];
		attempts++;
		// HTTP POST делегирован в report-delivery.ts (TC-FE-1a/b/c: и
		// network-error, и !response.ok трактуются как «следующий hop»).
		const result = await deliverToAncestor({
			target: ancestor,
			parentReportId: opts.parentReportId,
			fromCorrelationId: opts.report.correlationId,
			payload: opts.report.payload,
			fetch: opts.fetch,
			timeoutMs: hopTimeoutMs,
		});
		if (result.ok) {
			return {
				delivered: true,
				deliveredTo: ancestor.correlationId,
				attempts,
			};
		}
		// !ok → timeout / network error / non-2xx → пробуем следующего предка.
	}

	// Все hops exhausted. Если передан orphanPath — пишем orphan-файл.
	if (opts.orphanPath) {
		mkdirSync(dirname(opts.orphanPath), { recursive: true });
		const content = {
			reportId: opts.parentReportId,
			writtenAt: new Date().toISOString(),
			payload: {
				correlationId: opts.report.correlationId,
				payload: opts.report.payload,
			},
		};
		// Atomic write: tmp → rename.
		const tmpPath = `${opts.orphanPath}.tmp.${process.pid}.${Date.now()}`;
		writeFileSync(tmpPath, JSON.stringify(content, null, 2));
		renameSync(tmpPath, opts.orphanPath);
		return { delivered: false, orphanWritten: true, attempts };
	}

	return { delivered: false, attempts };
}
