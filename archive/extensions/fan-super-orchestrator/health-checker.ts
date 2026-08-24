// F-SO-HC: HealthChecker — периодический health-check узлов super-orchestrator
// (выделен из process-manager в REFACTOR-фазе).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.1
//
// Поведение (1:1 с прежней инлайн-реализацией в process-manager.ts):
//   • GET urlFor(id) каждые intervalMs; провал (throw или status !== 200)
//     инкрементирует счётчик, успех сбрасывает;
//   • после failThreshold провалов подряд — маркировка unhealthy,
//     onUnhealthy(id, reason) и ОДИН рестарт (onRestart); повторный
//     порог провалов — снова onUnhealthy, но без рестарта (эскалация);
//   • успех после unhealthy — onRecovered(id) (узел восстановился);
//   • узел, снятый с сопровождения (untrack) во время запроса, не
//     получает колбэков — гонка kill/tick безопасна;
//   • probe(id) — стартовый best-effort health-check: провал не фатален.
//
// healthFetch инъектируется (DI): в тестах — stub, в production — fetch.

export type HealthFetchFn = (url: string) => Promise<{ status: number }>;

export interface HealthCheckerOptions {
	/** Интервал health-check, мс. */
	intervalMs: number;
	/** Провалов подряд до маркировки unhealthy. */
	failThreshold: number;
	/** DI вместо fetch. */
	healthFetch: HealthFetchFn;
	/** URL health-endpoint для отслеживаемого узла. */
	urlFor: (id: string) => string;
	/** Эскалация: узел нездоров (после порога провалов). */
	onUnhealthy?: (id: string, reason: string) => void;
	/** Узел снова здоров после unhealthy. */
	onRecovered?: (id: string) => void;
	/** Ровно одна попытка рестарта на отслеживаемый узел. */
	onRestart?: (id: string) => void;
}

interface TrackedState {
	failures: number;
	/** Рестарт уже был (повторный порог провалов — эскалация без рестарта). */
	restarted: boolean;
	unhealthy: boolean;
}

export class HealthChecker {
	private readonly options: HealthCheckerOptions;
	private readonly states = new Map<string, TrackedState>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: HealthCheckerOptions) {
		this.options = options;
	}

	/** Взять узел на сопровождение (сброс счётчиков/флагов). */
	track(id: string): void {
		this.states.set(id, { failures: 0, restarted: false, unhealthy: false });
	}

	/** Снять узел с сопровождения (kill/остановка). Идемпотентно. */
	untrack(id: string): void {
		this.states.delete(id);
	}

	/**
	 * Стартовый best-effort health-check: сервер ещё поднимается, провал
	 * не фатален. Успех гарантирует сброс счётчика провалов.
	 */
	async probe(id: string): Promise<void> {
		try {
			const res = await this.options.healthFetch(this.options.urlFor(id));
			const state = this.states.get(id);
			if (res.status === 200 && state) {
				state.failures = 0;
			}
		} catch {
			// ignore: старт ещё не завершён
		}
	}

	/** Запустить периодические проверки. Идемпотентно. */
	start(): void {
		if (this.timer !== null) {
			return;
		}
		this.timer = setInterval(() => {
			for (const id of this.states.keys()) {
				void this.tick(id);
			}
		}, this.options.intervalMs);
	}

	/** Остановить периодические проверки. Идемпотентно. */
	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(id: string): Promise<void> {
		let ok = false;
		let detail = "unknown error";
		try {
			const res = await this.options.healthFetch(this.options.urlFor(id));
			if (res.status === 200) {
				ok = true;
			} else {
				detail = `HTTP ${res.status}`;
			}
		} catch (err) {
			detail = err instanceof Error ? err.message : String(err);
		}
		// Узел могли убить (untrack), пока шёл запрос.
		const state = this.states.get(id);
		if (!state) {
			return;
		}
		if (ok) {
			state.failures = 0;
			if (state.unhealthy) {
				state.unhealthy = false; // восстановился после рестарта
				this.options.onRecovered?.(id);
			}
			return;
		}
		state.failures += 1;
		if (state.failures >= this.options.failThreshold) {
			state.failures = 0;
			state.unhealthy = true;
			this.options.onUnhealthy?.(id, `health check failed ${this.options.failThreshold} times in a row (${detail})`);
			if (!state.restarted) {
				state.restarted = true; // ровно одна попытка рестарта
				this.options.onRestart?.(id);
			}
			// Повторный порог провалов: onUnhealthy вызван выше, рестарта
			// больше нет — эскалация на уровень выше (F-26/F-31).
		}
	}
}
