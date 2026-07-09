// @fan/dashboard/components — <fan-settings-dialog> tabbed settings overlay

import type { TokenInfo } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Key, Link } from "lucide";
import { FanApiClient } from "../api/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	} catch {
		return iso;
	}
}

function formatRelative(iso: string | undefined): string {
	if (!iso) return "Never";
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("fan-settings-dialog")
export class SettingsDialog extends LitElement {
	// -----------------------------------------------------------------------
	// Static API — imperative creation
	// -----------------------------------------------------------------------

	static open(apiClient: FanApiClient, apiUrl: string, token: string): SettingsDialog {
		const el = new SettingsDialog();
		el.apiClient = apiClient;
		el.apiUrl = apiUrl;
		el.token = token;
		document.body.appendChild(el);
		return el;
	}

	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;
	@property() apiUrl: string = "";
	@property() token: string = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() activeTab: "connection" | "tokens" = "connection";
	@state() connectionStatus: "idle" | "testing" | "ok" | "error" = "idle";
	@state() healthInfo: { status: string; version: string; uptime: number } | null = null;
	@state() tokens: TokenInfo[] = [];
	@state() loadingTokens: boolean = false;
	@state() newTokenName: string = "";
	@state() generating: boolean = false;
	@state() generatedToken: string | null = null;
	@state() copied: boolean = false;
	@state() testError: string | null = null;

	// -----------------------------------------------------------------------
	// No shadow DOM
	// -----------------------------------------------------------------------

	override createRenderRoot(): this {
		return this;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	override connectedCallback(): void {
		super.connectedCallback();
		this.loadTokens();
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	close(): void {
		this.remove();
	}

	async testConnection(): Promise<void> {
		this.connectionStatus = "testing";
		this.testError = null;
		this.healthInfo = null;

		try {
			const client = new FanApiClient({
				baseUrl: this.apiUrl,
				token: this.token || undefined,
			});
			const health = await client.health();
			this.connectionStatus = "ok";
			this.healthInfo = {
				status: health.status,
				version: health.version,
				uptime: health.uptime,
			};
		} catch (err) {
			this.connectionStatus = "error";
			this.testError = err instanceof Error ? err.message : "Unknown error occurred";
		}
	}

	async loadTokens(): Promise<void> {
		if (!this.apiClient) return;
		this.loadingTokens = true;
		try {
			const res = await this.apiClient.listTokens();
			this.tokens = res.tokens as TokenInfo[];
		} catch (err) {
			console.error("Failed to load tokens", err);
		} finally {
			this.loadingTokens = false;
		}
	}

	async generateToken(): Promise<void> {
		if (!this.newTokenName.trim() || !this.apiClient) return;
		this.generating = true;
		try {
			const res = await this.apiClient.generateToken(this.newTokenName.trim());
			// The full token is only returned on generation
			this.generatedToken = res.token.token;
			this.newTokenName = "";
			await this.loadTokens();
		} catch (err) {
			console.error("Failed to generate token", err);
		} finally {
			this.generating = false;
		}
	}

	async revokeToken(id: string): Promise<void> {
		if (!this.apiClient) return;
		if (!confirm("Are you sure you want to revoke this token? This action cannot be undone.")) {
			return;
		}
		try {
			await this.apiClient.revokeToken(id);
			await this.loadTokens();
		} catch (err) {
			console.error("Failed to revoke token", err);
		}
	}

	async copyToken(token: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(token);
			this.copied = true;
			setTimeout(() => {
				this.copied = false;
			}, 2000);
		} catch {
			// Fallback
			const ta = document.createElement("textarea");
			ta.value = token;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			document.body.removeChild(ta);
			this.copied = true;
			setTimeout(() => {
				this.copied = false;
			}, 2000);
		}
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		const tabs: { key: "connection" | "tokens"; label: string; icon: unknown }[] = [
			{ key: "connection", label: "Connection", icon: Link },
			{ key: "tokens", label: "API Tokens", icon: Key },
		];

		return html`
      <!-- Backdrop -->
      <div
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        @click=${(e: Event) => {
				if ((e.target as HTMLElement).classList.contains("fixed")) this.close();
			}}
      >
        <!-- Dialog -->
        <div
          class="bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
          style="width: min(800px, 90vw); height: min(600px, 85vh);"
        >
          <!-- Header -->
          <div
            class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0"
          >
            <div class="flex items-center gap-2">
              <svg
                class="w-5 h-5 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M10.325 4.317a1.5 1.5 0 011.35 0l7.5 4.33a1.5 1.5 0 010 2.606l-7.5 4.33a1.5 1.5 0 01-1.35 0l-7.5-4.33a1.5 1.5 0 010-2.606l7.5-4.33z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 12v6m0 0l-3-3m3 3l3-3"
                />
              </svg>
              <h2 class="text-base font-semibold text-foreground">Settings</h2>
            </div>
            <button
              class="p-1.5 rounded-md hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
              @click=${this.close}
              aria-label="Close settings"
            >
              <x .size=${18}></x>
            </button>
          </div>

          <!-- Mobile tab bar -->
          <div class="md:hidden flex border-b border-border shrink-0">
            ${tabs.map(
					(tab) => html`
                <button
                  class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
							this.activeTab === tab.key
								? "border-b-2 border-primary text-foreground"
								: "text-muted-foreground hover:text-foreground"
						}"
                  @click=${() => {
							this.activeTab = tab.key;
							if (tab.key === "tokens") this.loadTokens();
						}}
                >
                  ${tab.label}
                </button>
              `,
				)}
          </div>

          <!-- Body: sidebar + content -->
          <div class="flex flex-1 min-h-0">
            <!-- Sidebar (desktop) -->
            <nav class="hidden md:flex flex-col w-48 shrink-0 border-r border-border p-3 gap-1">
              ${tabs.map(
						(tab) => html`
                  <button
                    class="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${
								this.activeTab === tab.key
									? "bg-secondary text-foreground font-medium"
									: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
							}"
                    @click=${() => {
								this.activeTab = tab.key;
								if (tab.key === "tokens") this.loadTokens();
							}}
                  >
                    <link .size=${16}></link>
                    ${tab.label}
                  </button>
                `,
					)}
            </nav>

            <!-- Content area -->
            <div class="flex-1 overflow-y-auto p-5">
              ${this.activeTab === "connection" ? this._renderConnectionTab() : this._renderTokensTab()}
            </div>
          </div>
        </div>
      </div>
    `;
	}

	// -----------------------------------------------------------------------
	// Connection tab
	// -----------------------------------------------------------------------

	private _renderConnectionTab() {
		return html`
      <div class="space-y-5 max-w-lg">
        <div>
          <p class="text-sm text-muted-foreground mb-4">
            Configure the connection to your FAN runtime server.
          </p>
        </div>

        <!-- Server URL -->
        <div>
          <label
            class="block text-sm font-medium text-foreground mb-1.5"
            for="settings-url"
          >
            Server URL
          </label>
          <input
            id="settings-url"
            type="url"
            .value=${this.apiUrl}
            @input=${(e: Event) => {
					this.apiUrl = (e.target as HTMLInputElement).value;
				}}
            placeholder="http://localhost:3456"
            class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                   text-foreground placeholder:text-muted-foreground
                   focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                   transition-colors"
          />
        </div>

        <!-- Token (masked) -->
        <div>
          <label
            class="block text-sm font-medium text-foreground mb-1.5"
            for="settings-token"
          >
            API Token
          </label>
          <input
            id="settings-token"
            type="password"
            .value=${this.token}
            @input=${(e: Event) => {
					this.token = (e.target as HTMLInputElement).value;
				}}
            placeholder="••••••••••••••••"
            class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                   text-foreground placeholder:text-muted-foreground
                   focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                   transition-colors"
          />
        </div>

        <!-- Test button -->
        <div>
          <button
            ?disabled=${this.connectionStatus === "testing"}
            @click=${this.testConnection}
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium
                   rounded-lg bg-primary text-primary-foreground
                   hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
                   transition-colors"
          >
            ${
					this.connectionStatus === "testing"
						? html`
                  <loader2 .size=${14} class="animate-spin"></loader2>
                  Testing…
                `
						: html`
                  <refresh-cw .size=${14}></refresh-cw>
                  Test Connection
                `
				}
          </button>
        </div>

        <!-- Status -->
        ${
				this.connectionStatus === "ok" && this.healthInfo
					? html`
              <div
                class="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm"
              >
                <check .size=${16} class="shrink-0"></check>
                <span>
                  Connected — v${this.healthInfo.version} (uptime:
                  ${formatUptime(this.healthInfo.uptime)})
                  ${
							this.healthInfo.status === "degraded"
								? html`<span class="text-yellow-400 ml-1">(degraded)</span>`
								: nothing
						}
                </span>
              </div>
            `
					: nothing
			}
        ${
				this.connectionStatus === "error"
					? html`
              <div
                class="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"
              >
                <x .size=${16} class="shrink-0"></x>
                <span>Connection failed: ${this.testError}</span>
              </div>
            `
					: nothing
			}
      </div>
    `;
	}

	// -----------------------------------------------------------------------
	// Tokens tab
	// -----------------------------------------------------------------------

	private _renderTokensTab() {
		return html`
      <div class="space-y-5">
        <div>
          <h3 class="text-sm font-medium text-foreground mb-1">
            API Tokens
          </h3>
          <p class="text-sm text-muted-foreground">
            Manage tokens used by dashboard clients to authenticate with the FAN runtime.
          </p>
        </div>

        <!-- Generate new token -->
        <div class="flex items-end gap-3">
          <div class="flex-1">
            <label
              class="block text-sm font-medium text-foreground mb-1.5"
              for="new-token-name"
            >
              Token Name
            </label>
            <input
              id="new-token-name"
              type="text"
              .value=${this.newTokenName}
              @input=${(e: Event) => {
						this.newTokenName = (e.target as HTMLInputElement).value;
					}}
              @keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter") this.generateToken();
					}}
              placeholder="e.g. dashboard-client"
              class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                     text-foreground placeholder:text-muted-foreground
                     focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                     transition-colors"
            />
          </div>
          <button
            ?disabled=${!this.newTokenName.trim() || this.generating}
            @click=${this.generateToken}
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium
                   rounded-lg bg-primary text-primary-foreground
                   hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
                   transition-colors whitespace-nowrap"
          >
            ${
					this.generating
						? html`
                  <loader2 .size=${14} class="animate-spin"></loader2>
                  Generating…
                `
						: html`
                  <plus .size=${14}></plus>
                  Generate New Token
                `
				}
          </button>
        </div>

        <!-- Generated token (one-time display) -->
        ${
				this.generatedToken
					? html`
              <div
                class="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20"
              >
                <p class="text-sm font-medium text-amber-400 mb-2">
                  ⚠ Copy this token now — it won't be shown again!
                </p>
                <div class="flex items-center gap-2">
                  <code
                    class="flex-1 px-3 py-2 rounded bg-background/50 text-foreground text-sm font-mono break-all select-all"
                  >
                    ${this.generatedToken}
                  </code>
                  <button
                    class="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium
                           rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground
                           transition-colors whitespace-nowrap"
                    @click=${() => this.copyToken(this.generatedToken!)}
                  >
                    ${
								this.copied
									? html`
                          <check .size=${14} class="text-green-400"></check>
                          Copied
                        `
									: html`
                          <copy .size=${14}></copy>
                          Copy
                        `
							}
                  </button>
                </div>
              </div>
            `
					: nothing
			}

        <!-- Token list -->
        <div class="border border-border rounded-lg overflow-hidden">
          ${
					this.loadingTokens
						? html`
                <div class="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
                  <loader2 .size=${16} class="animate-spin"></loader2>
                  Loading tokens…
                </div>
              `
						: this.tokens.length === 0
							? html`
                  <div class="flex items-center justify-center py-8 text-muted-foreground text-sm">
                    No tokens found. Generate one above.
                  </div>
                `
							: html`
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-border bg-secondary/30">
                        <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">
                          Name
                        </th>
                        <th class="text-left px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">
                          Created
                        </th>
                        <th class="text-left px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">
                          Last Used
                        </th>
                        <th class="text-right px-4 py-2.5 font-medium text-muted-foreground">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      ${this.tokens.map(
									(tkn) => html`
                          <tr class="border-b border-border last:border-b-0 hover:bg-secondary/20 transition-colors">
                            <td class="px-4 py-3 font-medium text-foreground">
                              ${tkn.name}
                            </td>
                            <td class="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                              ${formatDate(tkn.createdAt)}
                            </td>
                            <td class="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                              ${formatRelative(tkn.lastUsed)}
                            </td>
                            <td class="px-4 py-3 text-right">
                              <button
                                class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium
                                       rounded-md text-red-400 hover:bg-red-500/10 transition-colors"
                                @click=${() => this.revokeToken(tkn.id)}
                              >
                                <trash2 .size=${12}></trash2>
                                Revoke
                              </button>
                            </td>
                          </tr>
                        `,
								)}
                    </tbody>
                  </table>
                `
				}
        </div>
      </div>
    `;
	}
}
