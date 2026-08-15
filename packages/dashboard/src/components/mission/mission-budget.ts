// @fan/dashboard/components/mission — <mission-budget> element
//
// F-41: Mission budget bar chart — consumed vs allocated per tree branch.
//
// Data sources:
//   - REST: GET /api/missions/:id/budget (initial load + reload on mission-id
//           change) → { mission_id, budget_total, budget_usd, allocated,
//           consumed, peak, by_branch: Record<string, { allocated, consumed,
//           cost_usd }> } (mission-budget.json passthrough, F-31/F-47).
//   - WS:   system-wide "fan:mission-event" window CustomEvent fan-out
//           (detail: WsMissionEvent from F-47, dispatched by dashboard-app
//           from FanWsClient — same channel as "fan:budget-alert").
//           A "complete" event updates the branch consumed/cost live.
//
// WS reconciliation contract (_applyEvent):
//   - An event with a numeric entry.consumed is an AUTHORITATIVE branch
//     snapshot → it REPLACES branch.consumed. If the same event also carries
//     a cost (entry.cost_usd or entry.usage.costUsd), branch.cost_usd is
//     REPLACED too; if it carries no cost, cost_usd is left as-is
//     (documented behavior — the next snapshot with cost will re-sync it).
//   - A delta event ("complete" WITHOUT entry.consumed) carries only the
//     incremental cost of the completed node (cost_usd ?? usage.costUsd) →
//     it is ADDED to branch.consumed and branch.cost_usd. Applied only when
//     the event has no numeric consumed.
//   Cross-event outcomes per contract:
//     absolute {consumed:1.5} → delta {usage:{costUsd:0.3}}  = consumed 1.8
//       (delta is new consumption AFTER the snapshot — not a double-count);
//     delta → absolute {consumed:1.5, usage:{costUsd:1.5}}   = consumed 1.5,
//       cost_usd 1.5 (snapshot replaces, previous delta is NOT re-added);
//     delta → absolute {consumed:1.5} (no cost)              = consumed 1.5,
//       cost_usd kept from before (documented).
//
// Thresholds: consumed/allocated ≥ 80% → warning (amber), ≥ 95% → critical
// (red); consumed > allocated → data-over="true". Division by zero is guarded
// (budget_total=0 / allocated=0 never render NaN or Infinity).
// No shadow DOM — Tailwind styles must penetrate.

import type { WsMissionEvent } from "@fan/api-gateway/types";
import type { PropertyValues } from "lit";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ≥ 80% of allocated consumed → warning (amber). */
const WARNING_THRESHOLD = 0.8;
/** ≥ 95% of allocated consumed → critical (red). */
const CRITICAL_THRESHOLD = 0.95;

/** Bar fill color per threshold level. */
const THRESHOLD_COLORS: Record<Threshold, string> = {
	normal: "bg-blue-500",
	warning: "bg-amber-500",
	critical: "bg-red-500",
};

type Threshold = "normal" | "warning" | "critical";

type ViewState = "loading" | "ready" | "empty" | "not-found" | "error";

/** Mirror of the F-47 GET /api/missions/:id/budget response shape. */
interface BudgetBranch {
	allocated: number;
	consumed: number;
	cost_usd: number;
}

interface MissionBudgetData {
	mission_id?: string;
	budget_total?: number;
	budget_usd?: number;
	allocated?: number;
	consumed?: number;
	peak?: number;
	by_branch?: Record<string, BudgetBranch>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Value as a finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** consumed/allocated fraction, guarded against division by zero. */
function fractionOf(consumed: number, allocated: number): number {
	if (allocated > 0) return consumed / allocated;
	return consumed > 0 ? 1 : 0;
}

/** Threshold level for a consumed/allocated fraction. */
function thresholdOf(fraction: number): Threshold {
	if (fraction >= CRITICAL_THRESHOLD) return "critical";
	if (fraction >= WARNING_THRESHOLD) return "warning";
	return "normal";
}

/** Bar fill width in percent (clamped to 0..100). */
function fillPercent(fraction: number): string {
	const pct = Math.min(100, Math.max(0, fraction * 100));
	return `${pct.toFixed(1)}%`;
}

/** USD amount formatted as $x.xx. */
function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("mission-budget")
export class MissionBudgetElement extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ type: String, attribute: "mission-id" }) missionId = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() private _view: ViewState = "loading";
	@state() private _data: MissionBudgetData | undefined;
	@state() private _errorMessage = "";

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/** In-flight load promise — awaited by getUpdateComplete so consumers
	 *  awaiting `updateComplete` see the chart after the fetch-driven render. */
	private _loadPromise: Promise<void> | undefined;
	/** Guards against stale fetch results when mission-id changes mid-flight. */
	private _loadSeq = 0;

	private readonly _onMissionEvent = (ev: Event): void => {
		const detail = (ev as CustomEvent<WsMissionEvent | undefined>).detail;
		if (!detail || typeof detail !== "object") return;
		// System-wide fan-out — filter by our own mission slug.
		if (!this.missionId || detail.missionId !== this.missionId) return;
		this._applyEvent(detail);
	};

	// -----------------------------------------------------------------------
	// No shadow DOM — Tailwind styles need to penetrate
	// -----------------------------------------------------------------------

	override createRenderRoot(): this {
		return this;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("fan:mission-event", this._onMissionEvent);
		if (!this.missionId) {
			this._view = "empty";
		}
	}

	override disconnectedCallback(): void {
		window.removeEventListener("fan:mission-event", this._onMissionEvent);
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		// Reset view synchronously before render (avoids change-in-update cycles).
		if (changed.has("missionId")) {
			if (!this.missionId) {
				this._view = "empty";
				this._data = undefined;
			} else if (this.hasUpdated) {
				this._view = "loading";
				this._errorMessage = "";
			}
		}
	}

	protected override updated(changed: PropertyValues<this>): void {
		if (changed.has("missionId")) {
			this._startLoad();
		}
	}

	/** Await any in-flight load before reporting update completion, so that
	 *  `await el.updateComplete` reflects the fetch-driven render. */
	protected override getUpdateComplete(): Promise<boolean> {
		const load = this._loadPromise;
		if (!load) return super.getUpdateComplete();
		return load.then(() => super.getUpdateComplete());
	}

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------

	private _startLoad(): void {
		this._loadPromise = this._load();
	}

	private async _load(): Promise<void> {
		const id = this.missionId;
		if (!id) return; // view already reset in willUpdate

		const seq = ++this._loadSeq;

		try {
			const res = await fetch(`/api/missions/${encodeURIComponent(id)}/budget`, {
				method: "GET",
				headers: { Accept: "application/json" },
			});
			// Stale response (mission-id changed or element detached) — drop.
			if (seq !== this._loadSeq || !this.isConnected) return;

			if (!res.ok) {
				this._data = undefined;
				if (res.status === 404) {
					this._view = "not-found";
				} else {
					this._view = "error";
					this._errorMessage = `HTTP ${res.status} ${res.statusText}`.trim();
				}
				return;
			}

			const data = (await res.json()) as MissionBudgetData | undefined;
			if (seq !== this._loadSeq || !this.isConnected) return;

			this._data = data ?? {};
			this._view = "ready";
		} catch (err) {
			if (seq !== this._loadSeq || !this.isConnected) return;
			this._data = undefined;
			this._view = "error";
			this._errorMessage = err instanceof Error ? err.message : "Network error";
			console.error("mission-budget: load failed", err);
		}
	}

	// -----------------------------------------------------------------------
	// WS event handling
	// -----------------------------------------------------------------------

	private _applyEvent(event: WsMissionEvent): void {
		if (!this._data) return;
		const nodeId = typeof event.nodeId === "string" ? event.nodeId : "";
		if (!nodeId) return;

		const entry = event.entry ?? {};
		const usage = (typeof entry.usage === "object" && entry.usage !== null ? entry.usage : {}) as Record<
			string,
			unknown
		>;

		const consumed = finiteNumber(entry.consumed);
		const allocated = finiteNumber(entry.allocated);
		const costUsd = finiteNumber(entry.cost_usd);
		/** Cost delta reported by the completing node (usage.costUsd fallback). */
		const delta = costUsd ?? finiteNumber(usage.costUsd);
		const budgetTotal = finiteNumber(entry.budget_total);

		if (consumed === undefined && allocated === undefined && delta === undefined && budgetTotal === undefined) {
			return; // nothing budget-related to apply — leave the DOM untouched
		}

		const data: MissionBudgetData = { ...this._data };
		if (budgetTotal !== undefined) data.budget_total = budgetTotal;

		const byBranch: Record<string, BudgetBranch> = { ...(data.by_branch ?? {}) };
		const existing = byBranch[nodeId];
		const branch: BudgetBranch = existing ? { ...existing } : { allocated: 0, consumed: 0, cost_usd: 0 };

		if (consumed !== undefined) {
			// Authoritative snapshot (see header contract): replaces consumed.
			// If the event also carries a cost (cost_usd or usage.costUsd),
			// cost_usd is replaced too; otherwise it is left as-is.
			branch.consumed = consumed;
			if (delta !== undefined) branch.cost_usd = delta;
		} else if (delta !== undefined && event.event === "complete") {
			// Delta event (complete without consumed): incremental cost of the
			// completed node, applied only when no absolute consumed is present.
			branch.consumed += delta;
			branch.cost_usd += delta;
		}
		if (allocated !== undefined) branch.allocated = allocated;

		byBranch[nodeId] = branch;
		data.by_branch = byBranch;
		this._data = data;

		if (this._view === "empty" || this._view === "loading") {
			this._view = "ready";
		}
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		if (this._view === "loading") {
			return html`
				<div class="mission-budget px-2 py-4 text-center text-muted-foreground text-xs animate-pulse" data-state="loading">
					Loading mission budget…
				</div>
			`;
		}

		if (this._view === "not-found") {
			return html`
				<div class="mission-budget px-2 py-4 text-center text-muted-foreground text-xs" data-state="not-found">
					Mission not found
				</div>
			`;
		}

		if (this._view === "error") {
			return html`
				<div class="mission-budget px-2 py-4 text-center text-xs text-red-400" data-state="error">
					Failed to load mission budget${this._errorMessage ? html`: ${this._errorMessage}` : nothing}
				</div>
			`;
		}

		if (this._view === "empty" || !this._data) {
			return html`
				<div class="mission-budget px-2 py-4 text-center text-muted-foreground text-xs" data-state="empty">
					No mission selected
				</div>
			`;
		}

		return this._renderBudget(this._data);
	}

	private _renderBudget(data: MissionBudgetData) {
		const branches = Object.entries(data.by_branch ?? {});
		if (branches.length === 0) {
			return html`
				<div class="mission-budget px-2 py-4 text-center text-muted-foreground text-xs" data-state="empty">
					No branch budget data
				</div>
			`;
		}

		const budgetTotal = data.budget_total ?? 0;
		const consumed = data.consumed ?? 0;
		const fraction = fractionOf(consumed, budgetTotal);
		const threshold = thresholdOf(fraction);
		const over = consumed > budgetTotal;

		return html`
			<div class="mission-budget space-y-2 text-xs" data-state="ready">
				<!-- Summary: total consumed vs budget_total -->
				<div
					class="mission-budget-summary space-y-1"
					data-summary
					data-threshold=${threshold}
					data-over=${over ? "true" : "false"}
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-muted-foreground">Total</span>
						<span class="font-mono text-foreground">
							${formatUsd(consumed)} / ${formatUsd(budgetTotal)}
						</span>
					</div>
					<div class="mission-budget-track h-2 rounded bg-muted overflow-hidden">
						<div
							class="mission-budget-fill h-full ${THRESHOLD_COLORS[threshold]}"
							style="width: ${fillPercent(fraction)}"
						></div>
					</div>
					<!-- Legend: total budget, consumed, remaining -->
					<div class="mission-budget-legend flex flex-wrap gap-x-3 text-muted-foreground">
						<span>Budget <span class="font-mono text-foreground">${formatUsd(budgetTotal)}</span></span>
						<span>Consumed <span class="font-mono text-foreground">${formatUsd(consumed)}</span></span>
						<span>Remaining <span class="font-mono text-foreground">${formatUsd(budgetTotal - consumed)}</span></span>
						<span class="font-mono">${(fraction * 100).toFixed(0)}%</span>
					</div>
				</div>

				<!-- Per-branch bars -->
				<div class="mission-budget-branches space-y-1.5">
					${branches.map(([nodeId, branch]) => this._renderBranch(nodeId, branch))}
				</div>
			</div>
		`;
	}

	private _renderBranch(nodeId: string, branch: BudgetBranch) {
		const allocated = branch.allocated ?? 0;
		const consumed = branch.consumed ?? 0;
		const costUsd = branch.cost_usd ?? 0;
		const fraction = fractionOf(consumed, allocated);
		const threshold = thresholdOf(fraction);
		const over = consumed > allocated;

		return html`
			<div
				class="mission-budget-branch space-y-0.5"
				data-branch=${nodeId}
				data-threshold=${threshold}
				data-over=${over ? "true" : "false"}
			>
				<div class="flex items-center gap-2">
					<span class="font-mono truncate text-foreground">${nodeId}</span>
					<span class="ml-auto font-mono text-muted-foreground shrink-0">${formatUsd(costUsd)}</span>
				</div>
				<div class="mission-budget-track h-1.5 rounded bg-muted overflow-hidden">
					<div
						class="mission-budget-fill h-full ${THRESHOLD_COLORS[threshold]}"
						style="width: ${fillPercent(fraction)}"
					></div>
				</div>
				<div class="flex items-center justify-between text-muted-foreground">
					<span class="font-mono">${formatUsd(consumed)} / ${formatUsd(allocated)}</span>
					<span class="font-mono">${(fraction * 100).toFixed(0)}%</span>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"mission-budget": MissionBudgetElement;
	}
}
