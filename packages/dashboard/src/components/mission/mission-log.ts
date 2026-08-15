// @fan/dashboard/components/mission — <mission-log> element
//
// F-40: Live mission event journal (append-only feed, last 100 entries).
//
// Data source:
//   - WS: system-wide "fan:mission-event" window CustomEvent fan-out
//         (detail: WsMissionEvent from F-47, dispatched by dashboard-app
//         from FanWsClient — same channel as "fan:budget-alert").
//         No REST endpoint — the feed is built from incoming events only.
//
// Rendering: newest events first; each entry shows timestamp, event type
// (spawn/complete/fail/abort/steer/decide), nodeId and diag text when
// present. The feed keeps the last 100 entries (FIFO eviction).
// No shadow DOM — Tailwind styles must penetrate.

import type { WsMissionEvent } from "@fan/api-gateway/types";
import type { PropertyValues } from "lit";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Roadmap limit: keep the last 100 events. */
const MAX_ENTRIES = 100;

/** Glyph + color per journal event type. */
const EVENT_META: Record<string, { glyph: string; color: string }> = {
	spawn: { glyph: "●", color: "text-blue-500" },
	complete: { glyph: "✓", color: "text-emerald-500" },
	fail: { glyph: "✗", color: "text-red-500" },
	abort: { glyph: "⊘", color: "text-amber-500" },
	steer: { glyph: "→", color: "text-violet-500" },
	decide: { glyph: "?", color: "text-amber-400" },
};

interface LogEntry {
	/** Monotonic key — unique per appended event. */
	key: number;
	timestamp: string;
	event: string;
	nodeId: string;
	diag?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("mission-log")
export class MissionLogElement extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ type: String, attribute: "mission-id" }) missionId = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() private _entries: LogEntry[] = [];

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/** Monotonic key generator for appended entries. */
	private _entrySeq = 0;

	private readonly _onMissionEvent = (ev: Event): void => {
		const detail = (ev as CustomEvent<WsMissionEvent | undefined>).detail;
		if (!detail || typeof detail !== "object") return;
		// System-wide fan-out — filter by our own mission slug.
		if (!this.missionId || detail.missionId !== this.missionId) return;
		this._append(detail);
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
	}

	override disconnectedCallback(): void {
		window.removeEventListener("fan:mission-event", this._onMissionEvent);
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		// Switching missions clears the feed (incoming events are filtered
		// by missionId, so stale entries would never be refreshed).
		if (changed.has("missionId") && this.hasUpdated) {
			this._entries = [];
		}
	}

	protected override updated(): void {
		if (this._entries.length > 0) {
			// Newest entries render first — keep the head of the feed visible.
			const container = this.querySelector<HTMLElement>(".mission-log-entries");
			if (container) container.scrollTop = 0;
		}
	}

	// -----------------------------------------------------------------------
	// WS event handling
	// -----------------------------------------------------------------------

	private _append(event: WsMissionEvent): void {
		const entry = event.entry ?? {};
		const record: LogEntry = {
			key: ++this._entrySeq,
			timestamp: typeof event.timestamp === "string" && event.timestamp ? event.timestamp : new Date().toISOString(),
			event: typeof event.event === "string" ? event.event : "unknown",
			nodeId: typeof event.nodeId === "string" ? event.nodeId : "",
		};
		const diag = firstString(entry.diag, entry.description, entry.reason, entry.message);
		if (diag !== undefined) record.diag = diag;

		// Newest first; evict oldest entries beyond the 100-entry limit.
		const entries = [record, ...this._entries];
		this._entries = entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		if (this._entries.length === 0) {
			return html`
				<div class="mission-log px-2 py-4 text-center text-muted-foreground text-xs" data-state="empty">
					No mission events yet
				</div>
			`;
		}

		return html`
			<div class="mission-log" data-state="ready">
				<div class="mission-log-entries overflow-y-auto max-h-64 space-y-0.5" data-log-scroll>
					${this._entries.map((entry) => this._renderEntry(entry))}
				</div>
			</div>
		`;
	}

	private _renderEntry(entry: LogEntry) {
		const meta = EVENT_META[entry.event] ?? { glyph: "○", color: "text-muted-foreground" };

		return html`
			<div
				class="log-entry mission-log-entry flex items-start gap-2 text-xs"
				data-log-entry
				data-event=${entry.event}
			>
				<time class="text-muted-foreground font-mono shrink-0" datetime=${entry.timestamp}>
					${formatTime(entry.timestamp)}
				</time>
				<span class="${meta.color} shrink-0" aria-hidden="true">${meta.glyph}</span>
				<span class="font-mono ${meta.color} shrink-0">${entry.event}</span>
				<span class="font-mono truncate">${entry.nodeId}</span>
				${entry.diag ? html`<span class="text-muted-foreground truncate">${entry.diag}</span>` : nothing}
			</div>
		`;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First non-empty string among the given values, if any. */
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** HH:MM:SS slice of an ISO timestamp (falls back to the raw string). */
function formatTime(iso: string): string {
	const time = iso.slice(11, 19);
	return /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : iso;
}

declare global {
	interface HTMLElementTagNameMap {
		"mission-log": MissionLogElement;
	}
}
