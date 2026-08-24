// F-31: Глобальный координатор бюджета.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-31
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.4
//
// Персистентный BudgetStore (F-30) поверх общего файла mission-budget.json
// (продакшн-путь ~/.fan/agent/mission-budget.json инжектится параметром).
// В одном файле живут состояния НЕСКОЛЬКИХ миссий: ключ — missionId,
// запись одной миссии не затирает остальные.
//
// Запись атомарная: <filePath>.tmp → rename на filePath; при crash во
// время записи файл не повреждён. Повреждённый/отсутствующий файл не
// бросает: load → defaults, save → файл пересоздаётся валидным.
// Все операции синхронные (как в port-pool).
//
// Формула выделения при порождении:
//   min(0.8 × remaining / planned_children, per_hop_ceiling)
// Резерв 20% остаётся родителю на синтез и ретраи; per_hop_ceiling —
// потолок на ребёнка (дефолт 30000 токенов). К USD потолок НЕ применяется:
// usd делится пропорционально с округлением до 4 знаков.
// Семантика unlimited: budgetTotal.tokens <= 0 → лимит токенов не
// действует, ребёнку выдаётся сразу per_hop_ceiling.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BudgetAmount, type BudgetState, type BudgetStore, emptyBudgetState } from "./budget-aggregator.js";

/** Общий файл бюджетов миссий. */
export interface MissionBudgetFile {
	missions: Record<string, BudgetState>;
}

/** Потолок токенов на ребёнка по умолчанию. */
const DEFAULT_PER_HOP_CEILING_TOKENS = 30_000;

/** Доля remaining, отдаваемая детям (резерв 20% — родителю). */
const CHILDREN_SHARE = 0.8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Валидация записи BudgetState: все обязательные поля на месте и корректны. */
function isValidBudgetState(v: unknown): v is BudgetState {
	if (!isPlainObject(v)) return false;
	const checkAmount = (key: string): boolean => {
		const a = v[key];
		return isPlainObject(a) && typeof a.tokens === "number" && typeof a.usd === "number";
	};
	return (
		checkAmount("budgetTotal") &&
		checkAmount("allocated") &&
		checkAmount("consumed") &&
		checkAmount("peak") &&
		isPlainObject(v.byBranch)
	);
}

/** Глубокая копия состояния (файловые данные сериализуемы в JSON). */
function cloneState(state: BudgetState): BudgetState {
	return JSON.parse(JSON.stringify(state)) as BudgetState;
}

/** Округление до 4 знаков (для USD). */
function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/**
 * Прочитать файл бюджетов миссий.
 * Файл отсутствует, повреждён или не содержит объект missions → null
 * (не бросает).
 */
export function readMissionBudgetFile(filePath: string): MissionBudgetFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.missions)) {
		return null;
	}
	return { missions: parsed.missions as Record<string, BudgetState> };
}

/**
 * Персистентный BudgetStore одной миссии в общем файле mission-budget.json.
 *
 * load(): файл отсутствует/повреждён или миссии нет в файле → defaults
 *         (defaults не заданы → emptyBudgetState(0, 0)); не бросает.
 * save(state): миссии в файле объединяются (другие не теряются), запись
 *         атомарная (<filePath>.tmp → rename), родительский каталог
 *         создаётся при отсутствии.
 */
export function createMissionBudgetStore(filePath: string, missionId: string, defaults?: BudgetState): BudgetStore {
	return {
		load(): BudgetState {
			const file = readMissionBudgetFile(filePath);
			const stored = file?.missions[missionId];
			if (isValidBudgetState(stored)) {
				return cloneState(stored);
			}
			return cloneState(defaults ?? emptyBudgetState(0, 0));
		},

		save(state: BudgetState): void {
			const file = readMissionBudgetFile(filePath) ?? { missions: {} };
			file.missions[missionId] = cloneState(state);
			mkdirSync(dirname(filePath), { recursive: true });
			const tmpPath = `${filePath}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf8");
			renameSync(tmpPath, filePath);
		},
	};
}

/**
 * Выделение бюджета на одного ребёнка при порождении.
 *
 * remaining = max(0, budgetTotal − consumed − allocated) покомпонентно;
 * tokens = floor(min(0.8 × remaining.tokens / plannedChildren, ceiling))
 *          (budgetTotal.tokens <= 0 → unlimited: сразу ceiling);
 * usd = round4(0.8 × remaining.usd / plannedChildren) — без потолка.
 * plannedChildren ≤ 0 → нули.
 */
export function computeChildAllocation(
	state: BudgetState,
	plannedChildren: number,
	perHopCeilingTokens?: number,
): BudgetAmount {
	if (!Number.isFinite(plannedChildren) || plannedChildren <= 0) {
		return { tokens: 0, usd: 0 };
	}
	const ceiling = perHopCeilingTokens ?? DEFAULT_PER_HOP_CEILING_TOKENS;

	const remainingUsd = Math.max(0, state.budgetTotal.usd - state.consumed.usd - state.allocated.usd);
	const usd = round4((CHILDREN_SHARE * remainingUsd) / plannedChildren);

	// Unlimited: лимит токенов не действует — ребёнку сразу потолок.
	if (state.budgetTotal.tokens <= 0) {
		return { tokens: ceiling, usd };
	}

	const remainingTokens = Math.max(0, state.budgetTotal.tokens - state.consumed.tokens - state.allocated.tokens);
	const tokens = Math.floor(Math.min((CHILDREN_SHARE * remainingTokens) / plannedChildren, ceiling));
	return { tokens, usd };
}
