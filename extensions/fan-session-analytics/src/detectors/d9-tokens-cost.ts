import type { DetectFn, Finding } from "../types.js";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * D9: Tokens & Cost — best-effort extraction of token usage and cost data.
 *
 * Strategy:
 * 1. Try bun:sqlite to read from filin.db (pre-fetched by pipeline into dbTokensInfo)
 * 2. Always extract detailed breakdown from JSONL usage fields (input/output/cache)
 * 3. Merge both sources; mark the primary source in the report
 */
export const detectTokensCost: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	// Accumulate from JSONL usage fields in trajectory steps
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let hasUsageData = false;
	const models = new Set<string>();

	for (const step of t.steps) {
		if (step.model) models.add(step.model);
		if (step.tokens) {
			totalInput += step.tokens.input || 0;
			totalOutput += step.tokens.output || 0;
			// FIX MAJOR 5: accumulate cache tokens
			totalCacheRead += step.tokens.cacheRead || 0;
			totalCacheWrite += step.tokens.cacheWrite || 0;
			totalCost += step.cost || 0;
			hasUsageData = true;
		}
	}

	// Check SQLite pre-fetched data (MAJOR 6)
	const dbInfo = t.dbTokensInfo;
	const hasSqliteData = dbInfo && (dbInfo.tokens > 0 || dbInfo.cost > 0);

	if (!hasUsageData && !hasSqliteData) {
		findings.push({
			detectorId: "D9",
			severity: "low",
			title: "Данные по токенам/стоимости: недоступны",
			evidence: {
				entryIds: [],
				excerpt: `Источник: отсутствует\nДанные об использовании не найдены ни в шагах траектории, ни в базе данных.\nМодели: ${[...models].join(", ") || "не обнаружены"}`,
			},
			metrics: { totalTokens: 0, totalCost: 0, tokenSource: 0 },
		});
		return findings;
	}

	// Determine totals and source
	let source: string;
	let totalTokens: number;
	let finalCost: number;
	let tokenSourceFlag: number;

	if (hasSqliteData && !hasUsageData) {
		// SQLite only — no detailed breakdown
		totalTokens = dbInfo!.tokens;
		finalCost = dbInfo!.cost;
		source = "filin.db (bun:sqlite)";
		tokenSourceFlag = 1;
	} else if (hasSqliteData && hasUsageData) {
		// Both sources — prefer SQLite for totals, JSONL for breakdown
		totalTokens = dbInfo!.tokens || (totalInput + totalOutput + totalCacheRead + totalCacheWrite);
		finalCost = dbInfo!.cost || totalCost;
		source = "filin.db (итоги) + JSONL (детализация)";
		tokenSourceFlag = 1;
	} else {
		// JSONL only
		totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
		finalCost = totalCost;
		source = "JSONL usage-поля";
		tokenSourceFlag = 0;
	}

	findings.push({
		detectorId: "D9",
		severity: "low",
		title: `Использование токенов: ${totalTokens.toLocaleString()} токенов, стоимость: $${finalCost.toFixed(4)}`,
		evidence: {
			entryIds: [],
			excerpt: [
				`Источник: ${source}`,
				`Входные токены: ${totalInput.toLocaleString()}`,
				`Выходные токены: ${totalOutput.toLocaleString()}`,
				`Cache чтение: ${totalCacheRead.toLocaleString()}`,
				`Cache запись: ${totalCacheWrite.toLocaleString()}`,
				`Всего токенов: ${totalTokens.toLocaleString()}`,
				`Общая стоимость: $${finalCost.toFixed(4)}`,
				`Модели: ${[...models].join(", ") || "не обнаружены"}`,
			].join("\n"),
		},
		metrics: {
			totalTokens,
			totalCost: finalCost,
			totalInput,
			totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			tokenSource: tokenSourceFlag,
		},
	});

	return findings;
};

/**
 * Attempt to query filin.db for message tokens/cost.
 * Best-effort: silently fails if bun:sqlite or DB not available.
 * FIX MAJOR 6: now actually called by the pipeline before detectors run.
 */
export async function trySqliteTokens(sessionId: string): Promise<{
	tokens: number;
	cost: number;
	source: string;
} | null> {
	try {
		// Dynamic import — bun:sqlite only available in Bun runtime
		const Database = (await import("bun:sqlite" as string)).default;
		const dbPath = join(homedir(), ".fan", "agent", "filin.db");
		const db = new Database(dbPath, { readonly: true });

		try {
			// Prisma Message model: tokens Int?, cost Float?, sessionId String
			const stmt = db.prepare(
				"SELECT SUM(tokens) as tokens, SUM(cost) as cost FROM Message WHERE sessionId = ?"
			);
			const row = stmt.get(sessionId) as { tokens: number; cost: number } | null;

			if (row && (row.tokens || row.cost)) {
				return {
					tokens: row.tokens || 0,
					cost: row.cost || 0,
					source: "filin.db (bun:sqlite)",
				};
			}
		} finally {
			db.close();
		}
	} catch {
		// bun:sqlite not available or DB not accessible — silent fallback
	}

	return null;
}
