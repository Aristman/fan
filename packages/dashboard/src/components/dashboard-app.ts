// @fan/dashboard/components — root <dashboard-app> element

import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { FanApiClient } from "../api/client.js";
import { FanWsClient } from "../api/ws-client.js";
import { SettingsDialog } from "./settings-dialog.js";

// Side-effect imports: register all child custom elements
import "./session-sidebar.js";
import "./chat-view.js";
import "./budget-panel.js";
import "./budget-alert-toast.js";
import "./model-settings-panel.js";
import "./analytics-view.js";

@customElement("dashboard-app")
export class DashboardApp extends LitElement {
	// -----------------------------------------------------------------------
	// Properties (set by parent bootstrap)
	// -----------------------------------------------------------------------

	@property() apiUrl = "";
	@property() token = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() currentView: "chat" | "sessions" | "budget" | "models" | "settings" | "analytics" = "sessions";
	@state() currentSessionId: string | null = null;
	@state() sidebarOpen = true;
	@state() connectionStatus: "connected" | "disconnected" | "error" = "connected";
	@state() settingsOpen = false;
	@state() currentModel: { provider: string; model: string } | null = null;

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private apiClient!: FanApiClient;
	private wsClient!: FanWsClient;
	private _boundHandleSessionSelected?: EventListener;
	private _boundHandleSessionCreated?: EventListener;
	private _boundHandleSessionDeleted?: EventListener;
	private _boundHandleNavigate?: EventListener;
	private _wsUnsubMessage: (() => void) | null = null;
	private _wsUnsubStatus: (() => void) | null = null;

	// -----------------------------------------------------------------------
	// Accessors for child components
	// -----------------------------------------------------------------------

	get api(): FanApiClient {
		return this.apiClient;
	}

	get ws(): FanWsClient {
		return this.wsClient;
	}

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

		// Create API & WS clients
		this.apiClient = new FanApiClient({ baseUrl: this.apiUrl, token: this.token });
		this.wsClient = new FanWsClient();

		// Subscribe to WS messages for budget alerts and model switches
		this._wsUnsubMessage = this.wsClient.onMessage((msg) => {
			if (msg.type === "budget_alert" && "alert" in msg) {
				// Dispatch via window so budget-alert-toast (a child of dashboard-app,
				// which has no shadow DOM) can pick it up via its window listener.
				window.dispatchEvent(
					new CustomEvent("fan:budget-alert", {
						detail: msg.alert,
						bubbles: true,
						composed: true,
					}),
				);
			}
			if (msg.type === "model_switch" && "to" in msg) {
				const to = (msg as { to: { provider: string; model: string } }).to;
				this.currentModel = { provider: to.provider, model: to.model };
			}
		});

		this._wsUnsubStatus = this.wsClient.onStatusChange((status) => {
			this.connectionStatus = status === "connected" ? "connected" : status === "error" ? "error" : "disconnected";
		});

		// Listen for session events from child components
		this._boundHandleSessionSelected = ((ev: CustomEvent) => {
			const sessionId = ev.detail?.sessionId;
			this.currentSessionId = sessionId;
			if (sessionId) {
				this.currentView = "chat";
			}
		}) as EventListener;

		this._boundHandleSessionCreated = ((ev: CustomEvent) => {
			const sessionId = ev.detail?.sessionId;
			this.currentSessionId = sessionId;
			if (sessionId) {
				this.currentView = "chat";
			}
		}) as EventListener;

		this._boundHandleSessionDeleted = ((ev: CustomEvent) => {
			const sessionId = ev.detail?.sessionId;
			if (sessionId && this.currentSessionId === sessionId) {
				this.currentSessionId = null;
				this.currentView = "sessions";
				this.wsClient.disconnect();
			}
		}) as EventListener;

		this._boundHandleNavigate = ((ev: CustomEvent) => {
			const view = ev.detail?.view;
			if (view && ["chat", "sessions", "budget", "models", "settings", "analytics"].includes(view)) {
				this.currentView = view as typeof this.currentView;
			}
		}) as EventListener;

		this.addEventListener("fan:session-selected", this._boundHandleSessionSelected);
		this.addEventListener("fan:session-created", this._boundHandleSessionCreated);
		this.addEventListener("fan:session-deleted", this._boundHandleSessionDeleted);
		this.addEventListener("fan:navigate", this._boundHandleNavigate);
	}

	override willUpdate(changed: Map<string, unknown>): void {
		// Connect WS when currentSessionId changes to a non-null value
		if (changed.has("currentSessionId")) {
			this._connectWsToSession(this.currentSessionId);
		}
	}

	override disconnectedCallback(): void {
		this.wsClient.disconnect();

		if (this._wsUnsubMessage) {
			this._wsUnsubMessage();
			this._wsUnsubMessage = null;
		}
		if (this._wsUnsubStatus) {
			this._wsUnsubStatus();
			this._wsUnsubStatus = null;
		}
		if (this._boundHandleSessionSelected) {
			this.removeEventListener("fan:session-selected", this._boundHandleSessionSelected);
		}
		if (this._boundHandleSessionCreated) {
			this.removeEventListener("fan:session-created", this._boundHandleSessionCreated);
		}
		if (this._boundHandleSessionDeleted) {
			this.removeEventListener("fan:session-deleted", this._boundHandleSessionDeleted);
		}
		if (this._boundHandleNavigate) {
			this.removeEventListener("fan:navigate", this._boundHandleNavigate);
		}

		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// WebSocket management
	// -----------------------------------------------------------------------

	private _connectWsToSession(sessionId: string | null): void {
		if (!this.wsClient || !this.apiUrl || !this.token || !sessionId) return;
		// Disconnect from previous session
		this.wsClient.disconnect();
		// Connect to new session
		this.wsClient.connect(this.apiUrl, sessionId, this.token);
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	private _openSettings(): void {
		SettingsDialog.open(this.apiClient, this.apiUrl, this.token);
	}

	private _toggleSidebar(): void {
		this.sidebarOpen = !this.sidebarOpen;
	}

	private _closeSidebar(): void {
		this.sidebarOpen = false;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		const statusDot =
			this.connectionStatus === "connected"
				? "bg-green-500"
				: this.connectionStatus === "error"
					? "bg-red-500"
					: "bg-yellow-500";

		// Sidebar content (shared between desktop and mobile)
		const sidebarContent = html`
      <session-sidebar
        .apiClient=${this.apiClient}
        .activeSessionId=${this.currentSessionId}
      ></session-sidebar>

      <!-- Budget mini widget -->
      <div class="border-t border-border px-3 pt-3 pb-1">
        <button
          class="text-sm text-muted-foreground hover:text-foreground w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/50 transition-colors"
          @click=${() => {
					this.currentView = "budget";
				}}
        >
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Budget Overview
        </button>
      </div>

      <!-- Models link -->
      <div class="px-3 py-1">
        <button
          class="text-sm text-muted-foreground hover:text-foreground w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/50 transition-colors"
          @click=${() => {
					this.currentView = "models";
				}}
        >
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Model Settings
        </button>
      </div>

      <!-- Analytics link -->
      <div class="px-3 py-1">
        <button
          class="text-sm text-muted-foreground hover:text-foreground w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/50 transition-colors"
          @click=${() => {
					this.currentView = "analytics";
				}}
        >
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 3v18h18M7 16l4-4 4 4 4-6" />
          </svg>
          Аналитика
        </button>
      </div>
    `;

		return html`
      <div class="flex flex-col h-screen bg-background text-foreground overflow-hidden">
        <!-- ── Budget Alert Toasts (fixed) ─────────────────────────────── -->
        <budget-alert-toast></budget-alert-toast>

        <!-- ── Header ─────────────────────────────────────────────────── -->
        <header
          class="flex items-center justify-between h-12 px-4 border-b border-border shrink-0"
          style="height: var(--header-height)"
        >
          <div class="flex items-center gap-3">
            <!-- Hamburger — visible on mobile -->
            <button
              class="md:hidden p-1 rounded hover:bg-foreground/10 transition-colors"
              @click=${this._toggleSidebar}
              aria-label="Toggle sidebar"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span class="font-semibold text-sm tracking-wide select-none">FAN Dashboard</span>
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span class="w-2 h-2 rounded-full ${statusDot} inline-block"></span>
              ${this.connectionStatus}
            </span>
            ${
					this.currentModel
						? html`
                  <span
                    class="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded bg-foreground/5 text-muted-foreground font-mono"
                    title="Current model"
                  >
                    ${this.currentModel.provider}/${this.currentModel.model}
                  </span>
                `
						: nothing
				}
          </div>

          <button
            class="p-1.5 rounded hover:bg-foreground/10 transition-colors"
            @click=${this._openSettings}
            aria-label="Settings"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317a1.5 1.5 0 011.35 0l7.5 4.33a1.5 1.5 0 010 2.606l-7.5 4.33a1.5 1.5 0 01-1.35 0l-7.5-4.33a1.5 1.5 0 010-2.606l7.5-4.33z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 12v6m0 0l-3-3m3 3l3-3" />
            </svg>
          </button>
        </header>

        <!-- ── Body (sidebar + main) ───────────────────────────────────── -->
        <div class="flex flex-1 min-h-0">
          <!-- Mobile backdrop -->
          ${
					this.sidebarOpen
						? html`<div
                class="md:hidden fixed inset-0 z-20 bg-black/40"
                @click=${this._closeSidebar}
              ></div>`
						: ""
				}

          <!-- Desktop sidebar -->
          <aside
            class="hidden md:flex flex-col border-r border-border overflow-y-auto shrink-0"
            style="width: var(--sidebar-width)"
          >
            ${sidebarContent}
          </aside>

          <!-- Mobile sidebar overlay -->
          ${
					this.sidebarOpen
						? html`
                <aside
                  class="md:hidden fixed inset-y-0 left-0 z-30 flex flex-col border-r border-border overflow-y-auto bg-background"
                  style="top: var(--header-height); width: var(--sidebar-width)"
                >
                  ${sidebarContent}
                </aside>
              `
						: nothing
				}

          <!-- Main area -->
          <main class="flex-1 min-w-0 overflow-hidden flex flex-col">
            ${
					this.currentView === "chat" && this.currentSessionId
						? html`
                  <chat-view
                    .apiClient=${this.apiClient}
                    .wsClient=${this.wsClient}
                    .sessionId=${this.currentSessionId}
                  ></chat-view>
                `
						: this.currentView === "budget"
							? html`
                    <div class="flex-1 overflow-y-auto p-6">
                      <h2 class="text-xl font-semibold mb-4">Budget Overview</h2>
                      <budget-panel .apiClient=${this.apiClient}></budget-panel>
                    </div>
                  `
							: this.currentView === "models"
								? html`
                      <div class="flex-1 overflow-y-auto p-6">
                        <h2 class="text-xl font-semibold mb-4">Model Settings</h2>
                        <model-settings-panel .apiClient=${this.apiClient}></model-settings-panel>
                      </div>
                  `
								: this.currentView === "analytics"
									? html`
                        <div class="flex-1 overflow-y-auto p-6">
                          <h2 class="text-xl font-semibold mb-4">Аналитика</h2>
                          <analytics-view .apiClient=${this.apiClient}></analytics-view>
                        </div>
                      `
									: this.currentView === "settings"
										? html`
                        <div class="flex-1 overflow-y-auto p-6">
                          <h2 class="text-xl font-semibold mb-4">Settings</h2>
                          <p class="text-sm text-muted-foreground">
                            Use the gear icon in the header to open settings.
                          </p>
                        </div>
                      `
										: html`
                        <!-- Empty state / welcome -->
                        <div class="flex-1 flex items-center justify-center text-muted-foreground">
                          <div class="text-center">
                            <svg
                              class="w-12 h-12 opacity-30 mx-auto mb-3"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              stroke-width="1.5"
                            >
                              <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p class="text-lg mb-2">Select a session or create a new one</p>
                            <p class="text-sm">Use the sidebar to browse sessions</p>
                          </div>
                        </div>
                      `
				}
          </main>
        </div>
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("dashboard-app")) {
	customElements.define("dashboard-app", DashboardApp);
}
