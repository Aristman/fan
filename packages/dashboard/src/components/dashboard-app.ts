// @fan/dashboard/components — root <dashboard-app> element

import type { ProjectSummary } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { FanApiClient } from "../api/client.js";
import { FanWsClient } from "../api/ws-client.js";
import { buildProjectTypeMap } from "../lib/workspace-type.js";
import { FanCreateProjectDialog } from "./create-project-dialog.js";
import { SettingsDialog } from "./settings-dialog.js";

// Side-effect imports: register all child custom elements
import "./session-sidebar.js";
import "./project-switcher.js";
import "./create-project-dialog.js";
import "./chat-view.js";
import "./budget-panel.js";
import "./budget-alert-toast.js";
import "./model-settings-panel.js";

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

	@state() currentView: "chat" | "sessions" | "budget" | "models" | "settings" = "sessions";
	@state() currentSessionId: string | null = null;
	@state() sidebarOpen = true;
	@state() connectionStatus: "connected" | "disconnected" | "error" = "connected";
	@state() settingsOpen = false;
	@state() currentModel: { provider: string; model: string } | null = null;
	/** All projects from GET /api/projects (F-2.6) */
	@state() projects: ProjectSummary[] = [];
	/** Currently selected project path; null = all projects (F-2.6) */
	@state() currentProject: string | null = null;

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private apiClient!: FanApiClient;
	private wsClient!: FanWsClient;
	private _boundHandleSessionSelected?: EventListener;
	private _boundHandleSessionCreated?: EventListener;
	private _boundHandleSessionDeleted?: EventListener;
	private _boundHandleNavigate?: EventListener;
	private _boundHandleProjectSelect?: EventListener;
	private _boundHandleProjectCreate?: EventListener;
	private _boundHandleProjectCreated?: EventListener;
	private _boundHandleProjectRemove?: EventListener;
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
			if (view && ["chat", "sessions", "budget", "models", "settings"].includes(view)) {
				this.currentView = view as typeof this.currentView;
			}
		}) as EventListener;

		// F-2.6: project switcher events
		this._boundHandleProjectSelect = ((ev: CustomEvent) => {
			const path = ev.detail?.path ?? null;
			this.currentProject = path;
			// Notify sibling components (session list scoping is F-2.7 territory)
			window.dispatchEvent(new CustomEvent("fan:project-changed", { detail: { path } }));
		}) as EventListener;

		// F-3.8: "+" in the switcher opens the create-project dialog
		this._boundHandleProjectCreate = () => {
			FanCreateProjectDialog.open(this.apiClient);
		};

		// F-3.8: the dialog (appended to document.body, so this bubbles to
		// window, not through dashboard-app) reports a successful creation →
		// refresh the project list and switch to the new project.
		this._boundHandleProjectCreated = ((ev: CustomEvent) => {
			const path = ev.detail?.path;
			if (typeof path !== "string" || !path) return;
			void this._onProjectCreated(path);
		}) as EventListener;

		// F-2.13: remove an unavailable project from the registry
		this._boundHandleProjectRemove = ((ev: CustomEvent) => {
			const path = ev.detail?.path;
			if (typeof path !== "string" || !path) return;
			void this._removeProject(path);
		}) as EventListener;

		this.addEventListener("fan:session-selected", this._boundHandleSessionSelected);
		this.addEventListener("fan:session-created", this._boundHandleSessionCreated);
		this.addEventListener("fan:session-deleted", this._boundHandleSessionDeleted);
		this.addEventListener("fan:navigate", this._boundHandleNavigate);
		this.addEventListener("project-select", this._boundHandleProjectSelect);
		this.addEventListener("project-create", this._boundHandleProjectCreate);
		window.addEventListener("project-created", this._boundHandleProjectCreated);
		this.addEventListener("project-remove", this._boundHandleProjectRemove);

		// Load project list for the switcher (non-blocking; endpoint may not exist
		// on older servers — in that case the switcher just shows an empty state).
		void this._loadProjects();
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
		if (this._boundHandleProjectSelect) {
			this.removeEventListener("project-select", this._boundHandleProjectSelect);
		}
		if (this._boundHandleProjectCreate) {
			this.removeEventListener("project-create", this._boundHandleProjectCreate);
		}
		if (this._boundHandleProjectCreated) {
			window.removeEventListener("project-created", this._boundHandleProjectCreated);
		}
		if (this._boundHandleProjectRemove) {
			this.removeEventListener("project-remove", this._boundHandleProjectRemove);
		}

		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// Projects (F-2.6)
	// -----------------------------------------------------------------------

	private async _loadProjects(): Promise<void> {
		try {
			const res = await this.apiClient.listProjects();
			this.projects = res.projects;
		} catch (err) {
			console.warn("dashboard-app: listProjects failed (project switcher disabled)", err);
		}
	}

	/**
	 * F-3.8: a project was created via the create-project dialog — reload the
	 * registry list, then select the new project (same broadcast as a manual
	 * switch so session scoping follows).
	 */
	private async _onProjectCreated(path: string): Promise<void> {
		await this._loadProjects();
		this.currentProject = path;
		window.dispatchEvent(new CustomEvent("fan:project-changed", { detail: { path } }));
	}

	/**
	 * F-2.13: remove a project from the registry (DELETE /api/projects?path=),
	 * then reload the list. When the removed project was the current selection,
	 * the selection resets to "All projects".
	 */
	private async _removeProject(path: string): Promise<void> {
		try {
			await this.apiClient.removeProject(path);
		} catch (err) {
			console.warn("dashboard-app: removeProject failed", err);
			return;
		}
		if (this.currentProject === path) {
			this.currentProject = null;
			window.dispatchEvent(new CustomEvent("fan:project-changed", { detail: { path: null } }));
		}
		await this._loadProjects();
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
      <!-- Project switcher (F-2.6) — above the session list -->
      <div class="px-3 pt-3 pb-2 border-b border-border">
        <fan-project-switcher
          .projects=${this.projects}
          .currentProject=${this.currentProject}
        ></fan-project-switcher>
      </div>

      <div class="px-3 pt-2">
        <session-sidebar
          .apiClient=${this.apiClient}
          .activeSessionId=${this.currentSessionId}
          .projectTypes=${buildProjectTypeMap(this.projects)}
        ></session-sidebar>
      </div>

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
