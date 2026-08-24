// @fan/dashboard/components/mission — <mission-tree> element
//
// F-39: Live mission node tree.
//
// Data sources:
//   - REST: GET /api/missions/:id/tree (initial load + reload on mission-id change)
//   - WS:   system-wide "fan:mission-event" window CustomEvent fan-out
//           (detail: WsMissionEvent from F-47, dispatched by dashboard-app
//           from FanWsClient — same channel as "fan:budget-alert").
//
// Rendering: flat list of node rows with depth-based indentation and status
// glyphs (● active, ✓ completed, ✗ failed, ○ pending, ⊘ aborted).
// No shadow DOM — Tailwind styles must penetrate.

import type { MissionTree as MissionTreeData, MissionTreeNode } from "@fan/api-gateway/mission-api";
import type { WsMissionEvent } from "@fan/api-gateway/types";
import type { PropertyValues } from "lit";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Roadmap icon set: ● active, ✓ completed, ✗ failed, ○ pending.
 *  F-47 REST contract: GET /tree returns node status as the journal event name
 *  (spawn/complete/fail/abort — F-32 last-wins semantics), so event-name
 *  aliases map onto the same glyphs (parity with EVENT_DEFAULT_STATUS below). */
const STATUS_GLYPHS: Record<string, string> = {
	active: "●",
	spawn: "●",
	completed: "✓",
	complete: "✓",
	failed: "✗",
	fail: "✗",
	pending: "○",
	aborted: "⊘",
	abort: "⊘",
};

const STATUS_COLORS: Record<string, string> = {
	active: "text-blue-500",
	spawn: "text-blue-500",
	completed: "text-emerald-500",
	complete: "text-emerald-500",
	failed: "text-red-500",
	fail: "text-red-500",
	pending: "text-muted-foreground",
	aborted: "text-amber-500",
	abort: "text-amber-500",
};

/** Default node status applied when a journal event carries none. */
const EVENT_DEFAULT_STATUS: Record<string, string> = {
	spawn: "active",
	complete: "completed",
	fail: "failed",
	abort: "aborted",
};

type ViewState = "loading" | "ready" | "empty" | "not-found" | "error";

interface FlatNode {
	id: string;
	node: MissionTreeNode;
	depth: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("mission-tree")
export class MissionTree extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ type: String, attribute: "mission-id" }) missionId = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() private _view: ViewState = "loading";
	@state() private _nodes: Record<string, MissionTreeNode> = {};
	@state() private _roots: string[] = [];
	@state() private _errorMessage = "";

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/** In-flight load promise — awaited by getUpdateComplete so consumers
	 *  awaiting `updateComplete` see the tree after the fetch-driven render. */
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
				this._nodes = {};
				this._roots = [];
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
			const res = await fetch(`/api/missions/${encodeURIComponent(id)}/tree`, {
				method: "GET",
				headers: { Accept: "application/json" },
			});
			// Stale response (mission-id changed or element detached) — drop.
			if (seq !== this._loadSeq || !this.isConnected) return;

			if (!res.ok) {
				this._nodes = {};
				this._roots = [];
				if (res.status === 404) {
					this._view = "not-found";
				} else {
					this._view = "error";
					this._errorMessage = `HTTP ${res.status} ${res.statusText}`.trim();
				}
				return;
			}

			const tree = (await res.json()) as MissionTreeData | undefined;
			if (seq !== this._loadSeq || !this.isConnected) return;

			this._nodes = tree?.nodes ?? {};
			this._roots = tree?.roots ?? [];
			this._view = Object.keys(this._nodes).length > 0 ? "ready" : "empty";
		} catch (err) {
			if (seq !== this._loadSeq || !this.isConnected) return;
			this._nodes = {};
			this._roots = [];
			this._view = "error";
			this._errorMessage = err instanceof Error ? err.message : "Network error";
			console.error("mission-tree: load failed", err);
		}
	}

	// -----------------------------------------------------------------------
	// WS event handling
	// -----------------------------------------------------------------------

	private _applyEvent(event: WsMissionEvent): void {
		const nodeId = event.nodeId;
		if (!nodeId) return;

		const entry = event.entry ?? {};
		const entryStatus = typeof entry.status === "string" ? entry.status : undefined;
		const entryUsage = (entry.usage ?? undefined) as MissionTreeNode["usage"] | undefined;
		const nodes = { ...this._nodes };
		const existing = nodes[nodeId];

		if (event.event === "spawn") {
			const parentId = typeof entry.parentId === "string" ? entry.parentId : (existing?.parentId ?? null);
			const correlationId = typeof entry.correlationId === "string" ? entry.correlationId : existing?.correlationId;

			nodes[nodeId] = {
				parentId,
				children: existing?.children ?? [],
				status: entryStatus ?? EVENT_DEFAULT_STATUS.spawn,
				...(correlationId !== undefined ? { correlationId } : {}),
				...(entryUsage !== undefined ? { usage: entryUsage } : {}),
			};

			// Link into the parent's children list (or the root set).
			if (parentId && nodes[parentId]) {
				const parent = nodes[parentId];
				if (!parent.children.includes(nodeId)) {
					nodes[parentId] = { ...parent, children: [...parent.children, nodeId] };
				}
			} else if (parentId === null && !this._roots.includes(nodeId)) {
				this._roots = [...this._roots, nodeId];
			}
		} else {
			const status = entryStatus ?? EVENT_DEFAULT_STATUS[event.event];
			if (!existing && !status) return; // unknown event for unknown node — ignore
			const updated: MissionTreeNode = existing
				? { ...existing }
				: { parentId: null, children: [], status: status ?? "pending" };
			if (status) updated.status = status;
			if (entryUsage !== undefined) updated.usage = { ...updated.usage, ...entryUsage };
			nodes[nodeId] = updated;
		}

		this._nodes = nodes;
		if (this._view === "empty" || this._view === "loading") {
			this._view = "ready";
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/** Flatten the tree into depth-annotated rows (roots first, DFS order).
	 *  Orphan nodes (parent missing/unreachable) render at depth 0. */
	private _flatten(): FlatNode[] {
		const out: FlatNode[] = [];
		const visited = new Set<string>();

		const visit = (id: string, depth: number): void => {
			if (visited.has(id)) return;
			visited.add(id);
			const node = this._nodes[id];
			if (!node) return;
			out.push({ id, node, depth });
			for (const child of node.children ?? []) visit(child, depth + 1);
		};

		for (const root of this._roots) visit(root, 0);
		for (const id of Object.keys(this._nodes)) {
			if (!visited.has(id)) visit(id, 0);
		}
		return out;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		if (this._view === "loading") {
			return html`
				<div class="mission-tree px-2 py-4 text-center text-muted-foreground text-xs animate-pulse" data-state="loading">
					Loading mission tree…
				</div>
			`;
		}

		if (this._view === "not-found") {
			return html`
				<div class="mission-tree px-2 py-4 text-center text-muted-foreground text-xs" data-state="not-found">
					Mission not found
				</div>
			`;
		}

		if (this._view === "error") {
			return html`
				<div class="mission-tree px-2 py-4 text-center text-xs text-red-400" data-state="error">
					Failed to load mission tree${this._errorMessage ? html`: ${this._errorMessage}` : nothing}
				</div>
			`;
		}

		const rows = this._flatten();
		if (this._view === "empty" || rows.length === 0) {
			return html`
				<div class="mission-tree px-2 py-4 text-center text-muted-foreground text-xs" data-state="empty">
					No mission nodes yet
				</div>
			`;
		}

		return html`
			<div class="mission-tree" data-state="ready">
				${rows.map(({ id, node, depth }) => this._renderNode(id, node, depth))}
			</div>
		`;
	}

	private _renderNode(id: string, node: MissionTreeNode, depth: number) {
		const glyph = STATUS_GLYPHS[node.status] ?? "○";
		const color = STATUS_COLORS[node.status] ?? "text-muted-foreground";
		const usd = node.usage?.usd;

		return html`
			<div
				class="mission-node flex items-center gap-2 py-0.5 text-xs"
				style="padding-left: ${depth * 14}px"
				data-node-id=${id}
				data-depth=${depth}
				data-status=${node.status}
				title=${node.correlationId ?? id}
			>
				<span class="${color} shrink-0" aria-hidden="true">${glyph}</span>
				<span class="font-mono truncate">${id}</span>
				${
					usd !== undefined
						? html`<span class="ml-auto text-muted-foreground font-mono shrink-0">$${usd.toFixed(2)}</span>`
						: nothing
				}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"mission-tree": MissionTree;
	}
}
