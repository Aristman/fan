// @fan/dashboard/components — <session-sidebar> element
//
// F-2.7: sessions are rendered as a tree grouped by `SessionSummary.cwd`:
//   - Each unique cwd forms a collapsible group (toggle ▼/▶) with a session counter.
//   - Legacy sessions without a cwd (header written before F-1.12) are collected
//     into the "Без проекта" group (see NO_PROJECT_LABEL), rendered last.
//   - Status colour coding (CSS classes .status-active / .status-completed /
//     .status-error on the .status-dot element):
//       🟢 active    — the session currently selected in the app (activeSessionId)
//       🔵 completed — session has messages (messageCount > 0) and is not active
//       🟡 draft/err — session has no messages yet (draft) — SessionSummary has no
//                      explicit status field, so status is derived client-side.
//
// Project scoping UX (F-2.7 + F-2.8): the sidebar listens for the window event
// "fan:project-changed" (dispatched by dashboard-app, F-2.6).
//   - currentProject === null  → all sessions are loaded and grouped by cwd.
//   - currentProject === path  → listSessions({ project }) is used (server-side
//     filter); grouping still applies but yields a single cwd group.

import type { SessionSummary } from "@fan/api-gateway/types";
import { html, LitElement, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { IconNode } from "lucide";
import { Clock, MessageSquare, Plus, Search, Trash2 } from "lucide";
import type { FanApiClient } from "../api/client.js";

// ---------------------------------------------------------------------------
// F-2.7 grouping constants, types & helpers
// ---------------------------------------------------------------------------

/** Group key used for legacy sessions that have no cwd in their header. */
const NO_PROJECT_KEY = "__no_project__";
/** Display label for the legacy (cwd-less) group. */
export const NO_PROJECT_LABEL = "Без проекта";

/** A group of sessions sharing the same cwd (F-2.7). */
interface SessionGroup {
	/** Group identity: the cwd, or NO_PROJECT_KEY for legacy sessions. */
	key: string;
	/** Display label: basename of the cwd, or NO_PROJECT_LABEL. */
	label: string;
	/** Full cwd for the title tooltip; null for the legacy group. */
	cwd: string | null;
	sessions: SessionSummary[];
}

/** Basename of a path, tolerant of both / and \ separators. */
function pathBasename(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * Derive the display status of a session (SessionSummary has no explicit
 * status field — see header comment for the colour legend).
 */
function sessionStatus(session: SessionSummary, activeSessionId: string | null): "active" | "completed" | "error" {
	if (session.id === activeSessionId) return "active";
	if (session.messageCount > 0) return "completed";
	return "error"; // draft — created but no messages yet
}

// ---------------------------------------------------------------------------
// Icon helper — renders a lucide IconNode array as an inline <svg>
// ---------------------------------------------------------------------------

function renderIcon(node: IconNode, cls = ""): ReturnType<typeof svg> {
	const inner = node
		.map(([tag, attrs]) => {
			const attrParts: string[] = [];
			for (const [k, v] of Object.entries(attrs)) {
				// Convert camelCase → kebab-case for SVG attributes
				const attr = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
				attrParts.push(`${attr}="${v}"`);
			}
			return `<${tag} ${attrParts.join(" ")}></${tag}>`;
		})
		.join("");

	return svg`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"
    class="${cls}">${unsafeSVG(inner)}</svg>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable relative time string (e.g. "just now", "2m ago", "1h ago").
 */
function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diffMs = now - then;

	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return "just now";

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;
	@property({ attribute: false }) activeSessionId: string | null = null;

	@state() sessions: SessionSummary[] = [];
	@state() loading = false;
	@state() error: string | null = null;
	@state() searchQuery = "";
	@state() creating = false;
	/** F-2.7: selected project path; null = all projects (mirrors dashboard-app state). */
	@state() currentProject: string | null = null;
	/** F-2.7: keys of collapsed tree groups (expanded by default). */
	@state() collapsedGroups: Set<string> = new Set();

	// -----------------------------------------------------------------------
	// No shadow DOM — Tailwind styles need to penetrate
	// -----------------------------------------------------------------------

	override createRenderRoot(): this {
		return this;
	}

	// -----------------------------------------------------------------------
	// Computed
	// -----------------------------------------------------------------------

	get filteredSessions(): SessionSummary[] {
		const q = this.searchQuery.toLowerCase().trim();
		let list = this.sessions;

		if (q) {
			list = list.filter((s) => s.title.toLowerCase().includes(q));
		}

		// Sort by updatedAt descending
		return [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	}

	/**
	 * F-2.7: filtered sessions grouped by cwd.
	 * Groups are sorted by their most recently updated session (desc);
	 * the legacy "Без проекта" group is always rendered last.
	 */
	get sessionGroups(): SessionGroup[] {
		const byKey = new Map<string, SessionSummary[]>();
		for (const s of this.filteredSessions) {
			const key = s.cwd ?? NO_PROJECT_KEY;
			const arr = byKey.get(key);
			if (arr) {
				arr.push(s);
			} else {
				byKey.set(key, [s]);
			}
		}

		const groups: SessionGroup[] = [...byKey.entries()].map(([key, sessions]) => ({
			key,
			label: key === NO_PROJECT_KEY ? NO_PROJECT_LABEL : pathBasename(key),
			cwd: key === NO_PROJECT_KEY ? null : key,
			sessions,
		}));

		groups.sort((a, b) => {
			if (a.key === NO_PROJECT_KEY) return 1;
			if (b.key === NO_PROJECT_KEY) return -1;
			const aLatest = new Date(a.sessions[0].updatedAt).getTime();
			const bLatest = new Date(b.sessions[0].updatedAt).getTime();
			return bLatest - aLatest;
		});

		return groups;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	override async connectedCallback(): Promise<void> {
		super.connectedCallback();

		this.addEventListener("fan:session-selected", this._onSessionSelected);
		// Listen on window for cross-component events (session-sidebar and chat-view are siblings)
		window.addEventListener("fan:session-created", this._onSessionRefresh);
		window.addEventListener("fan:session-deleted", this._onSessionRefresh);
		window.addEventListener("fan:session-updated", this._onSessionRefresh);
		// F-2.7: re-scope the list when the project switcher selection changes
		window.addEventListener("fan:project-changed", this._onProjectChanged);

		await this.loadSessions();
	}

	override disconnectedCallback(): void {
		this.removeEventListener("fan:session-selected", this._onSessionSelected);
		window.removeEventListener("fan:session-created", this._onSessionRefresh);
		window.removeEventListener("fan:session-deleted", this._onSessionRefresh);
		window.removeEventListener("fan:session-updated", this._onSessionRefresh);
		window.removeEventListener("fan:project-changed", this._onProjectChanged);

		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// Event listeners (bound via arrow-function property)
	// -----------------------------------------------------------------------

	private _onSessionSelected = (): void => {
		this.requestUpdate();
	};

	private _onSessionRefresh = (): void => {
		void this.loadSessions();
	};

	/** F-2.7: project switcher changed → reload sessions scoped to the project. */
	private _onProjectChanged = (ev: Event): void => {
		const path = (ev as CustomEvent).detail?.path ?? null;
		this.currentProject = typeof path === "string" && path ? path : null;
		void this.loadSessions();
	};

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async loadSessions(): Promise<void> {
		this.loading = true;
		this.error = null;

		try {
			// F-2.8: scope to the selected project when one is active (server-side
			// filter); null = full list, still grouped by cwd client-side (F-2.7).
			const res = await this.apiClient.listSessions(
				this.currentProject ? { project: this.currentProject } : undefined,
			);
			this.sessions = res.sessions;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Failed to load sessions";
			this.error = message;
			console.error("session-sidebar: loadSessions failed", err);
		} finally {
			this.loading = false;
		}
	}

	async createSession(): Promise<void> {
		if (this.creating) return;

		this.creating = true;
		try {
			const res = await this.apiClient.createSession();
			this.dispatchEvent(
				new CustomEvent("fan:session-selected", {
					detail: { sessionId: res.id },
					bubbles: true,
					composed: true,
				}),
			);
			await this.loadSessions();
		} catch (err) {
			console.error("session-sidebar: createSession failed", err);
		} finally {
			this.creating = false;
		}
	}

	async deleteSession(id: string, event: Event): Promise<void> {
		event.stopPropagation();
		if (!window.confirm("Delete this session? This cannot be undone.")) return;

		try {
			const res = await this.apiClient.deleteSession(id);
			if (!res.success) {
				alert("Cannot delete this session (it may be the active runtime session).");
				return;
			}
			if (this.activeSessionId === id) {
				this.dispatchEvent(
					new CustomEvent("fan:session-selected", {
						detail: { sessionId: null },
						bubbles: true,
						composed: true,
					}),
				);
			}
		} catch (err) {
			console.error("session-sidebar: deleteSession failed", err);
			alert(`Failed to delete session: ${err instanceof Error ? err.message : "Unknown error"}`);
		} finally {
			await this.loadSessions();
		}
	}

	selectSession(id: string): void {
		this.dispatchEvent(
			new CustomEvent("fan:session-selected", {
				detail: { sessionId: id },
				bubbles: true,
				composed: true,
			}),
		);
	}

	/** F-2.7: collapse/expand a tree group (independent per group). */
	toggleGroup(key: string): void {
		const next = new Set(this.collapsedGroups);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		this.collapsedGroups = next;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		return html`
      <!-- F-2.7: status dot colours (scoped class names; no shadow DOM) -->
      <style>
        .status-dot {
          display: inline-block;
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 9999px;
          flex-shrink: 0;
        }
        .status-active    { background-color: #22c55e; } /* 🟢 green  — selected/active session */
        .status-completed { background-color: #3b82f6; } /* 🔵 blue   — has messages, not active  */
        .status-error     { background-color: #eab308; } /* 🟡 yellow — draft (no messages) / error */
      </style>

      <div class="flex flex-col gap-2">
        <!-- New session button -->
        <button
          class="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors
                 disabled:opacity-50 disabled:cursor-not-allowed"
          ?disabled=${this.creating || this.loading}
          @click=${() => void this.createSession()}
        >
          ${renderIcon(Plus, "w-4 h-4 shrink-0")}
          <span>${this.creating ? "Creating…" : "New Session"}</span>
        </button>

        <!-- Search input -->
        <div class="relative">
          <span
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          >
            ${renderIcon(Search, "w-3.5 h-3.5")}
          </span>
          <input
            type="text"
            placeholder="Search sessions…"
            class="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-border
                   bg-background placeholder:text-muted-foreground/60
                   focus:outline-none focus:ring-1 focus:ring-primary/50"
            .value=${this.searchQuery}
            @input=${(e: Event) => {
					this.searchQuery = (e.target as HTMLInputElement).value;
				}}
          />
        </div>

        <!-- Session list -->
        <div class="flex-1 overflow-y-auto -mx-1">
          ${
					this.loading && this.sessions.length === 0
						? html`
                <div
                  class="px-2 py-6 text-center text-muted-foreground text-xs animate-pulse"
                >
                  Loading sessions…
                </div>
              `
						: this.error
							? html`
                  <div class="px-2 py-4 text-center text-xs text-red-400">
                    ${this.error}
                    <button
                      class="ml-1 underline hover:text-red-300"
                      @click=${() => void this.loadSessions()}
                    >
                      Retry
                    </button>
                  </div>
                `
							: this.filteredSessions.length === 0
								? this._renderEmptyState()
								: this.sessionGroups.map((group) => this._renderGroup(group))
				}
        </div>
      </div>
    `;
	}

	// -----------------------------------------------------------------------
	// Sub-templates
	// -----------------------------------------------------------------------

	private _renderEmptyState() {
		if (this.searchQuery.trim()) {
			return html`
        <div class="px-2 py-6 text-center text-muted-foreground text-xs">
          ${renderIcon(Search, "w-5 h-5 mx-auto mb-2 opacity-40")}
          <p>No sessions match "${this.searchQuery}"</p>
        </div>
      `;
		}

		return html`
      <div class="px-2 py-6 text-center text-muted-foreground text-xs">
        ${renderIcon(MessageSquare, "w-5 h-5 mx-auto mb-2 opacity-40")}
        <p>No sessions yet</p>
      </div>
    `;
	}

	/** F-2.7: one cwd group — header (toggle + label + counter) + child sessions. */
	private _renderGroup(group: SessionGroup) {
		const collapsed = this.collapsedGroups.has(group.key);

		return html`
      <div class="tree-group" data-group-key=${group.key}>
        <button
          class="tree-group-header w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md
                 text-xs font-semibold text-muted-foreground
                 hover:text-foreground hover:bg-secondary/40 transition-colors"
          aria-expanded=${collapsed ? "false" : "true"}
          title=${group.cwd ?? NO_PROJECT_LABEL}
          @click=${() => this.toggleGroup(group.key)}
        >
          <span class="toggle-icon w-3 text-center shrink-0 select-none">${collapsed ? "▶" : "▼"}</span>
          <span class="tree-group-label flex-1 min-w-0 truncate text-left text-sm">
            ${group.label}
          </span>
          <span
            class="tree-group-count shrink-0 px-1.5 py-0 rounded bg-foreground/5 text-[10px] font-mono"
            title="${group.sessions.length} session(s)"
          >
            ${group.sessions.length}
          </span>
        </button>

        ${
				collapsed
					? nothing
					: html`
              <div class="tree-items flex flex-col gap-0.5 pl-2 border-l border-border/60 ml-2 mt-0.5">
                ${group.sessions.map((session) => this._renderSessionItem(session))}
              </div>
            `
			}
      </div>
    `;
	}

	private _renderSessionItem(session: SessionSummary) {
		const isActive = session.id === this.activeSessionId;
		const status = sessionStatus(session, this.activeSessionId);

		return html`
      <button
        class="tree-item group w-full text-left px-2.5 py-2 rounded-lg transition-colors
               ${
						isActive
							? "bg-secondary/80 border-l-2 border-primary text-foreground"
							: "hover:bg-secondary/50 text-muted-foreground hover:text-foreground border-l-2 border-transparent"
					}"
        @click=${() => this.selectSession(session.id)}
        title=${session.title}
      >
        <div class="flex items-center gap-2">
          <!-- F-2.7: status colour dot (🟢 active / 🔵 completed / 🟡 draft) -->
          <span class="status-dot status-${status}" title="Status: ${status}"></span>
          <div class="flex-1 min-w-0">
            <!-- Title -->
            <div class="text-sm font-medium truncate">
              ${session.title || "Untitled"}
            </div>

            <!-- Meta row: model badge + time + messages -->
            <div
              class="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground/70"
            >
              ${
						session.provider && session.model
							? html`
                    <span
                      class="px-1.5 py-0 rounded bg-foreground/5 text-[10px] font-mono"
                    >
                      ${session.provider}/${session.model}
                    </span>
                  `
							: nothing
					}

              <span
                class="flex items-center gap-0.5"
                title=${session.updatedAt}
              >
                ${renderIcon(Clock, "w-3 h-3 shrink-0")}
                ${relativeTime(session.updatedAt)}
              </span>

              ${
						session.messageCount > 0
							? html`
                    <span class="flex items-center gap-0.5 ml-auto">
                      ${renderIcon(MessageSquare, "w-3 h-3 shrink-0")}
                      ${session.messageCount}
                    </span>
                  `
							: nothing
					}
            </div>
          </div>

          <!-- Delete button — only visible on hover -->
          <button
            class="shrink-0 p-1 rounded opacity-40 hover:!opacity-100
                   hover:bg-red-500/20 text-muted-foreground hover:text-red-400
                   transition-all"
            title="Delete session"
            @click=${(e: Event) => void this.deleteSession(session.id, e)}
          >
            ${renderIcon(Trash2, "w-3.5 h-3.5")}
          </button>
        </div>
      </button>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("session-sidebar")) {
	customElements.define("session-sidebar", SessionSidebar);
}
