// F-E: Orphan-report storage (atomic write + _index.json).
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-E
//
// Хранение отчётов, которые не удалось доставить по lineage (все hops
// exhausted). Структура:
//
//   <missionDir>/orphan-reports/
//     _index.json              ← список reportId
//     <reportId>.json          ← содержимое отчёта
//
// Все записи — атомарные (tmp → rename), _index.json синхронизирован
// с содержимым каталога.

import {
	writeFileSync,
	readFileSync,
	renameSync,
	mkdirSync,
	existsSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface WriteOrphanOpts {
	reportId: string;
	missionDir: string;
	payload: Record<string, unknown>;
}

const ORPHAN_DIR = "orphan-reports";
const INDEX_FILE = "_index.json";

/** Записать orphan-отчёт атомарно (tmp → rename) и обновить _index.json. */
export function writeOrphanReport(opts: WriteOrphanOpts): void {
	const dir = join(opts.missionDir, ORPHAN_DIR);
	mkdirSync(dir, { recursive: true });

	const finalPath = join(dir, `${opts.reportId}.json`);
	const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
	const content = {
		reportId: opts.reportId,
		writtenAt: new Date().toISOString(),
		payload: opts.payload,
	};
	writeFileSync(tmpPath, JSON.stringify(content, null, 2));
	renameSync(tmpPath, finalPath);

	updateIndex(dir, opts.reportId, "add");
}

/** Прочитать _index.json (список reportId). Пустой массив, если файла нет. */
export function readOrphanReportsIndex(missionDir: string): string[] {
	const indexPath = join(missionDir, ORPHAN_DIR, INDEX_FILE);
	if (!existsSync(indexPath)) return [];
	try {
		return JSON.parse(readFileSync(indexPath, "utf8")) as string[];
	} catch {
		return [];
	}
}

/** Удалить orphan-отчёт и обновить _index.json. */
export function removeOrphanReport(missionDir: string, reportId: string): void {
	const path = join(missionDir, ORPHAN_DIR, `${reportId}.json`);
	if (existsSync(path)) unlinkSync(path);
	const dir = join(missionDir, ORPHAN_DIR);
	updateIndex(dir, reportId, "remove");
}

/** Список reportId из имён файлов в orphan-reports/ (источник истины для recovery). */
export function listOrphanReportIds(missionDir: string): string[] {
	const dir = join(missionDir, ORPHAN_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && f !== INDEX_FILE)
		.map((f) => f.replace(/\.json$/, ""));
}

function updateIndex(
	dir: string,
	reportId: string,
	action: "add" | "remove",
): void {
	const indexPath = join(dir, INDEX_FILE);
	let current: string[] = [];
	if (existsSync(indexPath)) {
		try {
			current = JSON.parse(readFileSync(indexPath, "utf8")) as string[];
		} catch {
			current = [];
		}
	}
	if (action === "add" && !current.includes(reportId)) {
		current.push(reportId);
	} else if (action === "remove") {
		current = current.filter((id) => id !== reportId);
	}

	// Atomic write of index.
	const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(current, null, 2));
	renameSync(tmpPath, indexPath);
}
