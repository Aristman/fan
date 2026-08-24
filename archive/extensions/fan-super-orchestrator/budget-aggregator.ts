// F-30: Агрегатор бюджета.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-30
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.4
//
// Суммирование расхода по дереву узлов: при отчёте узла (F-28) его usage
// (уже агрегированный рекурсивно за детей) добавляется в consumed с
// атрибуцией по ветке (byBranch). Инвариант: Σ allocated ≤ budgetTotal —
// сумма долей всех АКТИВНЫХ узлов не превышает потолок миссии; при
// завершении узла аллокация возвращается в пул (onNodeComplete).
//
// Двойной бюджет (токены + USD): оба лимита жёсткие и независимые,
// срабатывает первый достигнутый. Семантика этапа 0: budgetTotal.tokens === 0
// означает «лимит токенов не действует» (unlimited); аналогично usd === 0.
//
// Алерты: порог = МАКСИМУМ из двух долей consumed/budgetTotal; переход
// через 80% → onWarn (I2 steer), через 100% → onExhausted (I1 drain).
// Каждый порог однократный в рамках экземпляра агрегатора.
//
// store.save вызывается на каждой мутации — готовность к F-31
// (глобальный координатор бюджета как персистентный BudgetStore).

/** Двойная величина бюджета (токены + USD). */
export interface BudgetAmount {
	tokens: number;
	usd: number;
}

/** Состояние бюджета миссии. */
export interface BudgetState {
	/** Потолок миссии. 0 по измерению = лимит не действует (unlimited). */
	budgetTotal: BudgetAmount;
	/** Σ аллокаций активных узлов. */
	allocated: BudgetAmount;
	/** Σ фактического расхода. */
	consumed: BudgetAmount;
	/** Максимум consumed (покомпонентно); не уменьшается. */
	peak: BudgetAmount;
	/** Атрибуция расхода по веткам дерева (nodeId → расход). */
	byBranch: Record<string, BudgetAmount>;
}

/** Хранилище состояния бюджета (F-31: миссионный координатор). */
export interface BudgetStore {
	load(): BudgetState;
	save(state: BudgetState): void;
}

/** Колбэки алертов порогов расхода. */
export interface BudgetAlertHandlers {
	/** Переход через 80% (I2 steer). pct — достигнутый процент (≥ 80). */
	onWarn?: (pct: number, consumed: BudgetAmount) => void;
	/** Переход через 100% (I1 drain — останов новых порождений). */
	onExhausted?: (consumed: BudgetAmount) => void;
}

/** Отчёт об использовании (совместим с totalUsage(NodeReport) из F-28). */
export interface BudgetUsage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

/** Агрегатор бюджета миссии. */
export interface BudgetAggregator {
	/** allocated + amount ≤ budgetTotal по ОБОИМ лимитам (срабатывает первый). */
	canAllocate(amount: BudgetAmount): boolean;
	/** false без мутаций, если canAllocate false; иначе allocated += amount. */
	allocate(nodeId: string, amount: BudgetAmount): boolean;
	/** consumed += usage; byBranch[nodeId] += usage; peak = max(peak, consumed). */
	recordUsage(nodeId: string, usage: BudgetUsage): void;
	/** Узел завершился: allocated -= allocatedAmount (не ниже 0). */
	onNodeComplete(nodeId: string, allocatedAmount: BudgetAmount): void;
	/** Снимок состояния (глубокая копия). */
	state(): BudgetState;
}

/** Порог алерта I2 steer, %. */
const WARN_PCT = 80;
/** Порог алерта I1 drain, %. */
const EXHAUSTED_PCT = 100;

function zeroAmount(): BudgetAmount {
	return { tokens: 0, usd: 0 };
}

/** Санитайзер: конечное число ≥ 0, иначе 0. */
function safeNum(v: number): number {
	return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Проверка: оба поля — конечные неотрицательные числа. */
function isValidAmount(amount: BudgetAmount): boolean {
	return Number.isFinite(amount.tokens) && amount.tokens >= 0 && Number.isFinite(amount.usd) && amount.usd >= 0;
}

function cloneAmount(amount: BudgetAmount): BudgetAmount {
	return { tokens: amount.tokens, usd: amount.usd };
}

function cloneState(state: BudgetState): BudgetState {
	const byBranch: Record<string, BudgetAmount> = {};
	for (const [nodeId, amount] of Object.entries(state.byBranch)) {
		byBranch[nodeId] = cloneAmount(amount);
	}
	return {
		budgetTotal: cloneAmount(state.budgetTotal),
		allocated: cloneAmount(state.allocated),
		consumed: cloneAmount(state.consumed),
		peak: cloneAmount(state.peak),
		byBranch,
	};
}

/** Пустое состояние с заданным потолком миссии. */
export function emptyBudgetState(totalTokens: number, totalUsd: number): BudgetState {
	return {
		budgetTotal: { tokens: totalTokens, usd: totalUsd },
		allocated: zeroAmount(),
		consumed: zeroAmount(),
		peak: zeroAmount(),
		byBranch: {},
	};
}

/** In-memory BudgetStore (хелпер для тестов); load/save возвращают копии. */
export function makeInMemoryStore(initial: BudgetState): BudgetStore {
	let current = cloneState(initial);
	return {
		load: () => cloneState(current),
		save: (state: BudgetState) => {
			current = cloneState(state);
		},
	};
}

/** Проверка одного измерения: total === 0 → лимит не действует. */
function fitsLimit(allocated: number, amount: number, total: number): boolean {
	if (total <= 0) {
		return true;
	}
	return allocated + amount <= total;
}

/** Максимум из двух долей consumed/budgetTotal (0..∞); total === 0 → доля 0. */
function maxShare(state: BudgetState): number {
	const tokenShare = state.budgetTotal.tokens > 0 ? state.consumed.tokens / state.budgetTotal.tokens : 0;
	const usdShare = state.budgetTotal.usd > 0 ? state.consumed.usd / state.budgetTotal.usd : 0;
	return Math.max(tokenShare, usdShare);
}

/** Агрегатор бюджета: состояние живёт в инжектированном BudgetStore. */
export function createBudgetAggregator(store: BudgetStore, alerts?: BudgetAlertHandlers): BudgetAggregator {
	const current = store.load();
	// Алерты однократные на порог в рамках экземпляра агрегатора.
	let warned = false;
	let exhausted = false;

	function fireAlerts(): void {
		const pct = maxShare(current) * 100;
		if (pct >= WARN_PCT && !warned) {
			warned = true;
			alerts?.onWarn?.(pct, cloneAmount(current.consumed));
		}
		if (pct >= EXHAUSTED_PCT && !exhausted) {
			exhausted = true;
			alerts?.onExhausted?.(cloneAmount(current.consumed));
		}
	}

	return {
		canAllocate(amount: BudgetAmount): boolean {
			if (!isValidAmount(amount)) {
				return false;
			}
			return (
				fitsLimit(current.allocated.tokens, amount.tokens, current.budgetTotal.tokens) &&
				fitsLimit(current.allocated.usd, amount.usd, current.budgetTotal.usd)
			);
		},

		allocate(_nodeId: string, amount: BudgetAmount): boolean {
			if (!isValidAmount(amount)) {
				return false;
			}
			if (
				!fitsLimit(current.allocated.tokens, amount.tokens, current.budgetTotal.tokens) ||
				!fitsLimit(current.allocated.usd, amount.usd, current.budgetTotal.usd)
			) {
				return false;
			}
			current.allocated.tokens += amount.tokens;
			current.allocated.usd += amount.usd;
			store.save(cloneState(current));
			return true;
		},

		recordUsage(nodeId: string, usage: BudgetUsage): void {
			const tokens = safeNum(usage.inputTokens ?? 0) + safeNum(usage.outputTokens ?? 0);
			const usd = safeNum(usage.costUsd ?? 0);

			current.consumed.tokens += tokens;
			current.consumed.usd += usd;

			const branch = current.byBranch[nodeId] ?? zeroAmount();
			branch.tokens += tokens;
			branch.usd += usd;
			current.byBranch[nodeId] = branch;

			current.peak.tokens = Math.max(current.peak.tokens, current.consumed.tokens);
			current.peak.usd = Math.max(current.peak.usd, current.consumed.usd);

			store.save(cloneState(current));
			fireAlerts();
		},

		onNodeComplete(_nodeId: string, allocatedAmount: BudgetAmount): void {
			const tokens = safeNum(allocatedAmount.tokens);
			const usd = safeNum(allocatedAmount.usd);
			current.allocated.tokens = Math.max(0, current.allocated.tokens - tokens);
			current.allocated.usd = Math.max(0, current.allocated.usd - usd);
			store.save(cloneState(current));
		},

		state(): BudgetState {
			return cloneState(current);
		},
	};
}
