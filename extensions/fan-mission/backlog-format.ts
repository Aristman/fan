// F-19: Общая утилита формата записей BACKLOG.md (refactor-цель карточки F-19).
//
// Формат строки таблицы BACKLOG.md (фикстура test/fixtures/mission/sample/BACKLOG.md):
//   | id | date | idea | source | fit | value | risk | cost | score | status |
//
// Файловый IO записей остаётся в file-state-manager.ts (readBacklog/appendBacklog —
// они переиспользуются как есть); здесь — чистая логика формата записи, чтобы её
// могли совместно использовать генератор идей (F-19) и скорер идей (F-20).

import type { BacklogEntry } from "./file-state-manager.js";

/** Формат id записей генератора идей: idea-NNN (3 цифры, zero-padded). */
export const IDEA_ID_PATTERN = /^idea-(\d{3})$/;

/** Статус новой идеи до скоринга (F-20). */
export const NEW_IDEA_STATUS = "IDEA";

/** Нормализация идеи для дедупликации: lowercase + trim + схлопывание пробелов. */
export function normalizeIdea(idea: string): string {
	return idea.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Максимальный номер среди существующих id вида idea-NNN (0, если таких нет). */
export function maxIdeaNumber(entries: readonly BacklogEntry[]): number {
	let max = 0;
	for (const entry of entries) {
		const match = IDEA_ID_PATTERN.exec(entry.id);
		if (match) {
			max = Math.max(max, Number.parseInt(match[1], 10));
		}
	}
	return max;
}

/** Формат id idea-NNN из порядкового номера. */
export function formatIdeaId(num: number): string {
	return `idea-${String(num).padStart(3, "0")}`;
}

/**
 * Запись BACKLOG.md для новой идеи: fit/value/risk/cost/score = 0 —
 * плейсхолдеры, скоринг заполнит скорер F-20.
 */
export function formatIdeaEntry(opts: { id: string; date: string; idea: string; source: string }): BacklogEntry {
	return {
		id: opts.id,
		date: opts.date,
		idea: opts.idea,
		source: opts.source,
		fit: 0,
		value: 0,
		risk: 0,
		cost: 0,
		score: 0,
		status: NEW_IDEA_STATUS,
	};
}
