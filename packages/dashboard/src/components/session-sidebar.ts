// @fan/dashboard/components — <session-sidebar> element

import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FanApiClient } from "../api/client.js";
import type { SessionSummary } from "@fan/api-gateway/types";
import { Plus, Search, Trash2, MessageSquare, Clock } from "lucide";
import type { IconNode } from "lucide";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";

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
    return [...list].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();

    this.addEventListener("fan:session-selected", this._onSessionSelected);
    this.addEventListener("fan:session-created", this._onSessionRefresh);
    this.addEventListener("fan:session-deleted", this._onSessionRefresh);
    this.addEventListener("fan:session-updated", this._onSessionRefresh);

    await this.loadSessions();
  }

  override disconnectedCallback(): void {
    this.removeEventListener("fan:session-selected", this._onSessionSelected);
    this.removeEventListener("fan:session-created", this._onSessionRefresh);
    this.removeEventListener("fan:session-deleted", this._onSessionRefresh);
    this.removeEventListener("fan:session-updated", this._onSessionRefresh);

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

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async loadSessions(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const res = await this.apiClient.listSessions();
      this.sessions = res.sessions;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load sessions";
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

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  override render() {
    return html`
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
          ${this.loading && this.sessions.length === 0
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
                : this.filteredSessions.map((session) =>
                    this._renderSessionItem(session),
                  )}
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

  private _renderSessionItem(session: SessionSummary) {
    const isActive = session.id === this.activeSessionId;

    return html`
      <button
        class="group w-full text-left px-2.5 py-2 rounded-lg transition-colors
               ${isActive
                 ? "bg-secondary/80 border-l-2 border-primary text-foreground"
                 : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground border-l-2 border-transparent"
               }"
        @click=${() => this.selectSession(session.id)}
        title=${session.title}
      >
        <div class="flex items-center gap-2">
          <div class="flex-1 min-w-0">
            <!-- Title -->
            <div class="text-sm font-medium truncate">
              ${session.title || "Untitled"}
            </div>

            <!-- Meta row: model badge + time + messages -->
            <div
              class="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground/70"
            >
              ${session.provider && session.model
                ? html`
                    <span
                      class="px-1.5 py-0 rounded bg-foreground/5 text-[10px] font-mono"
                    >
                      ${session.provider}/${session.model}
                    </span>
                  `
                : nothing}

              <span
                class="flex items-center gap-0.5"
                title=${session.updatedAt}
              >
                ${renderIcon(Clock, "w-3 h-3 shrink-0")}
                ${relativeTime(session.updatedAt)}
              </span>

              ${session.messageCount > 0
                ? html`
                    <span class="flex items-center gap-0.5 ml-auto">
                      ${renderIcon(MessageSquare, "w-3 h-3 shrink-0")}
                      ${session.messageCount}
                    </span>
                  `
                : nothing}
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
