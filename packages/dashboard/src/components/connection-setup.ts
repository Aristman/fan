// @fan/dashboard/components — <connection-setup> first-launch screen

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { FanApiClient } from "../api/client.js";
import { Zap, ArrowRight, Loader2, AlertCircle } from "lucide";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

@customElement("connection-setup")
export class ConnectionSetup extends LitElement {
  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  @state() apiUrl: string = "http://localhost:3456";
  @state() token: string = "";
  @state() testing: boolean = false;
  @state() error: string | null = null;
  @state() success: boolean = false;
  @state() healthInfo: { status: string; version: string; uptime: number } | null = null;

  // -----------------------------------------------------------------------
  // No shadow DOM — Tailwind needs to penetrate
  // -----------------------------------------------------------------------

  override createRenderRoot(): this {
    return this;
  }

  // -----------------------------------------------------------------------
  // Methods
  // -----------------------------------------------------------------------

  async testConnection(): Promise<void> {
    this.testing = true;
    this.error = null;
    this.success = false;
    this.healthInfo = null;

    if (!this.token.trim()) {
      this.error = "API token is required";
      this.testing = false;
      return;
    }

    try {
      const client = new FanApiClient({
        baseUrl: this.apiUrl,
        token: this.token,
      });
      // Use listSessions (authenticated) to validate both server + token
      const sessions = await client.listSessions();
      // Also grab health info if possible
      const health = await client.health();
      this.success = true;
      this.healthInfo = {
        status: health.status,
        version: health.version,
        uptime: health.uptime,
      };
      // Auto-connect after 1s delay
      setTimeout(() => this.connect(), 1000);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error occurred";
      if (message.includes("401")) {
        this.error = "Invalid API token";
      } else {
        this.error = message;
      }
    } finally {
      this.testing = false;
    }
  }

  async connect(): Promise<void> {
    // Persist connection config
    localStorage.setItem(
      "fan-dashboard-config",
      JSON.stringify({ apiUrl: this.apiUrl, token: this.token }),
    );

    // Notify parent app
    this.dispatchEvent(
      new CustomEvent("fan:connected", {
        detail: { apiUrl: this.apiUrl, token: this.token },
        bubbles: true,
        composed: true,
      }),
    );
  }

  handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      this.testConnection();
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  override render() {
    return html`
      <div class="flex items-center justify-center min-h-screen bg-background p-4">
        <div class="max-w-md w-full bg-card border border-border rounded-xl shadow-lg p-8">
          <!-- Branding -->
          <div class="flex flex-col items-center gap-2 mb-8">
            <div class="flex items-center gap-2">
              <zap .size=${28} .strokeWidth=${2} class="text-amber-500"></zap>
              <h1 class="text-xl font-bold tracking-wide text-foreground">
                FAN Dashboard
              </h1>
            </div>
            <p class="text-sm text-muted-foreground">
              Connect to your FAN runtime
            </p>
          </div>

          <!-- Form -->
          <div class="space-y-5">
            <!-- Server URL -->
            <div>
              <label
                class="block text-sm font-medium text-foreground mb-1.5"
                for="api-url"
              >
                Server URL
              </label>
              <input
                id="api-url"
                type="url"
                .value=${this.apiUrl}
                @input=${(e: Event) =>
                  (this.apiUrl = (e.target as HTMLInputElement).value)}
                placeholder="http://localhost:3456"
                class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                       text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                       transition-colors"
              />
            </div>

            <!-- API Token -->
            <div>
              <label
                class="block text-sm font-medium text-foreground mb-1.5"
                for="api-token"
              >
                API Token
              </label>
              <input
                id="api-token"
                type="password"
                .value=${this.token}
                @input=${(e: Event) =>
                  (this.token = (e.target as HTMLInputElement).value)}
                @keydown=${this.handleKeydown}
                placeholder="Enter your API token"
                class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                       text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                       transition-colors"
              />
            </div>

            <!-- Test Button -->
            <button
              ?disabled=${this.testing}
              @click=${this.testConnection}
              class="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium
                     rounded-lg bg-primary text-primary-foreground
                     hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
            >
              ${this.testing
                ? html`
                    <loader2 .size=${16} class="animate-spin"></loader2>
                    Testing…
                  `
                : html`
                    <arrow-right .size=${16}></arrow-right>
                    Test Connection
                  `}
            </button>

            <!-- Success -->
            ${this.success && this.healthInfo
              ? html`
                  <div
                    class="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm"
                  >
                    <span class="text-green-500 text-base">✅</span>
                    <span>
                      Connected! v${this.healthInfo.version} (uptime:
                      ${formatUptime(this.healthInfo.uptime)})
                    </span>
                  </div>
                `
              : nothing}

            <!-- Error -->
            ${this.error
              ? html`
                  <div
                    class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"
                  >
                    <alert-circle
                      .size=${16}
                      class="shrink-0 mt-0.5"
                    ></alert-circle>
                    <span>Connection failed: ${this.error}</span>
                  </div>
                `
              : nothing}
          </div>

          <!-- Tip -->
          <div class="mt-6 pt-5 border-t border-border">
            <p class="text-xs text-muted-foreground text-center leading-relaxed">
              Generate a token via API:<br>
              <code class="px-1 py-0.5 rounded bg-foreground/5 text-foreground/80 text-xs font-mono">
                Invoke-RestMethod -Method POST -Uri http://localhost:3456/api/tokens -ContentType application/json -Body '{"name":"dashboard"}'
              </code>
            </p>
          </div>
        </div>
      </div>
    `;
  }
}
