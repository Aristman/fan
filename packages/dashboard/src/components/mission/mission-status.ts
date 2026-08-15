// @fan/dashboard/components/mission — <mission-status> element
//
// F-40: Mission status badge + iteration + budget progress.
//
// Data sources:
//   - REST: GET /api/missions/:id/status (initial load + reload on mission-id
//           change) → { mission_id, status, iteration, budget_total, consumed,
//           budget_usd, active_nodes?, stage?, ... }
//   - WS:   system-wide "fan:mission-event" window CustomEvent fan-out
//           (detail: WsMissionEvent from F-47, dispatched by dashboard-app
//           from FanWsClient — same channel as "fan:budget-alert").
//
// No shadow DOM — Tailwind styles must penetrate.

import type { WsMissionEvent } from "@fan/api-gateway/types";
import type { PropertyValues } from "lit";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Badge glyph + color for each known mission status value. */
const STATUS_META: Record<string, { glyph: string; color: string }> = {
	active: { glyph: "●", color: "text-blue-500" },
	paused: { glyph: "◐", color: "text-amber-500" },
	completed: { glyph: "✓", color: "text-emerald-500" },
	failed: { glyph: "✗", color: "text-red-500" },
	awaiting_decision: { glyph: "?", color: "text-violet-500" },
	aborted: { glyph: "⊘", color: "text-amber-500" },
};

type ViewState = "loading" | "ready" | "empty" | "not-found" | "error";

/** Mirror of the F-47 GET /api/missions/:id/status response shape. */
interface MissionStatusData {
	mission_id?: string;
	status?: string;
	iteration?: number;
	budget_total?: number;
	consumed?: number;
	budget_usd?: number;
	active_nodes?: number;
	stage?: string;
	interruptions?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("mission-status")
export class MissionStatusElement extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ type: String, attribute: "mission-id" }) missionId = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() private _view: ViewState = "loading";
	@state() private _data: MissionStatusData | undefined;
	@state() private _errorMessage = "";

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/** In-flight load promise — awaited by getUpdateComplete so consumers
	 *  awaiting `updateComplete` see the status after the fetch-driven render. */
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
			const res = await fetch(`/api/missions/${encodeURIComponent(id)}/status`, {
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

			const data = (await res.json()) as MissionStatusData | undefined;
			if (seq !== this._loadSeq || !this.isConnected) return;

			this._data = data ?? {};
			this._view = "ready";
		} catch (err) {
			if (seq !== this._loadSeq || !this.isConnected) return;
			this._data = undefined;
			this._view = "error";
			this._errorMessage = err instanceof Error ? err.message : "Network error";
			console.error("mission-status: load failed", err);
		}
	}

	// -----------------------------------------------------------------------
	// WS event handling
	// -----------------------------------------------------------------------

	private _applyEvent(event: WsMissionEvent): void {
		const entry = event.entry ?? {};
		const status =
			typeof entry.missionStatus === "string"
				? entry.missionStatus
				: typeof entry.status === "string"
					? entry.status
					: undefined;
		const iteration = typeof entry.iteration === "number" ? entry.iteration : undefined;
		const consumed = typeof entry.consumed === "number" ? entry.consumed : undefined;
		const budgetTotal = typeof entry.budget_total === "number" ? entry.budget_total : undefined;
		const activeNodes =
			typeof entry.active_nodes === "number"
				? entry.active_nodes
				: typeof entry.activeNodes === "number"
					? entry.activeNodes
					: undefined;

		if (
			status === undefined &&
			iteration === undefined &&
			consumed === undefined &&
			budgetTotal === undefined &&
			activeNodes === undefined
		) {
			return;
		}

		const data: MissionStatusData = { ...(this._data ?? {}) };
		if (status !== undefined) data.status = status;
		if (iteration !== undefined) data.iteration = iteration;
		if (consumed !== undefined) data.consumed = consumed;
		if (budgetTotal !== undefined) data.budget_total = budgetTotal;
		if (activeNodes !== undefined) data.active_nodes = activeNodes;
		this._data = data;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		if (this._view === "loading") {
			return html`
				<div class="mission-status px-2 py-4 text-center text-muted-foreground text-xs animate-pulse" data-state="loading">
					Loading mission status…
				</div>
			`;
		}

		if (this._view === "not-found") {
			return html`
				<div class="mission-status px-2 py-4 text-center text-muted-foreground text-xs" data-state="not-found">
					Mission not found
				</div>
			`;
		}

		if (this._view === "error") {
			return html`
				<div class="mission-status px-2 py-4 text-center text-xs text-red-400" data-state="error">
					Failed to load mission status${this._errorMessage ? html`: ${this._errorMessage}` : nothing}
				</div>
			`;
		}

		if (this._view === "empty" || !this._data) {
			return html`
				<div class="mission-status px-2 py-4 text-center text-muted-foreground text-xs" data-state="empty">
					No mission selected
				</div>
			`;
		}

		return this._renderStatus(this._data);
	}

	private _renderStatus(data: MissionStatusData) {
		const status = data.status ?? "unknown";
		const meta = STATUS_META[status] ?? { glyph: "○", color: "text-muted-foreground" };
		const iteration = data.iteration ?? 0;
		const consumed = data.consumed ?? 0;
		const total = data.budget_total ?? 0;
		const percent = total > 0 ? ((consumed / total) * 100).toFixed(1) : undefined;

		return html`
			<div class="mission-status space-y-1 text-xs" data-state="ready">
				<div class="flex items-center gap-2">
					<span class="${meta.color} shrink-0" aria-hidden="true">${meta.glyph}</span>
					<span class="font-medium ${meta.color}" data-status=${status}>${status}</span>
				</div>
				<div class="text-muted-foreground">
					Iteration <span class="font-mono text-foreground">${iteration}</span>
				</div>
				<div class="text-muted-foreground">
					Budget <span class="font-mono text-foreground">$${consumed.toFixed(2)}</span> /
					<span class="font-mono text-foreground">$${total.toFixed(2)}</span>
					${percent !== undefined ? html`<span>(${percent}%)</span>` : nothing}
				</div>
				${
					data.stage
						? html`
							<div class="text-muted-foreground">
								Stage <span class="text-foreground">${data.stage}</span>
							</div>
						`
						: nothing
				}
				${
					typeof data.active_nodes === "number"
						? html`
							<div class="text-muted-foreground">
								Active nodes <span class="font-mono text-foreground">${data.active_nodes}</span>
							</div>
						`
						: nothing
				}
				${
					typeof data.interruptions === "number"
						? html`
							<div class="text-muted-foreground">
								Interruptions <span class="font-mono text-foreground">${data.interruptions}</span>
							</div>
						`
						: nothing
				}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"mission-status": MissionStatusElement;
	}
}
