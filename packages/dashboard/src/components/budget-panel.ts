// @fan/dashboard/components — <budget-panel> element

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FanApiClient } from "../api/client.js";
import type { BudgetStatus } from "@fan/api-gateway/types";
import { formatCost, formatTokenCount } from "@itone/fan-web-ui";
import { AlertTriangle, DollarSign, Coins, RefreshCw } from "lucide";
import { icon } from "../lib/icon.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("budget-panel")
export class BudgetPanel extends LitElement {
  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  @property({ attribute: false }) apiClient!: FanApiClient;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  @state() budgets: BudgetStatus[] = [];
  @state() loading = false;
  @state() error: string | null = null;

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _boundOnBudgetAlert = this._handleBudgetAlert.bind(this);

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
    void this.loadBudgets();
    this._refreshInterval = setInterval(() => {
      void this.loadBudgets();
    }, 30_000);
    window.addEventListener("fan:budget-alert", this._boundOnBudgetAlert);
  }

  override disconnectedCallback(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    window.removeEventListener("fan:budget-alert", this._boundOnBudgetAlert);
    super.disconnectedCallback();
  }

  // -----------------------------------------------------------------------
  // Data
  // -----------------------------------------------------------------------

  async loadBudgets(): Promise<void> {
    if (!this.apiClient) return;
    this.loading = true;
    this.error = null;
    try {
      const res = await this.apiClient.getBudget();
      this.budgets = res.budgets;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load budget";
      this.error = message;
      console.error("budget-panel: loadBudgets failed", err);
    } finally {
      this.loading = false;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private _handleBudgetAlert(): void {
    void this.loadBudgets();
  }

  getUsagePercent(used: number, limit?: number): number {
    if (limit === undefined || limit === null || limit <= 0) return -1;
    return Math.min(100, Math.round((used / limit) * 100));
  }

  getBarColor(percent: number): string {
    if (percent < 60) return "bg-emerald-500";
    if (percent < 85) return "bg-amber-500";
    return "bg-red-500";
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  override render() {
    return html`
      <div class="budget-panel space-y-3">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Budget
          </span>
          <button
            class="p-1 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            ?disabled=${this.loading}
            @click=${() => void this.loadBudgets()}
            title="Refresh budgets"
            aria-label="Refresh budgets"
          >
            ${icon(RefreshCw, "w-3.5 h-3.5" + (this.loading ? " animate-spin" : ""))}
          </button>
        </div>

        <!-- Loading -->
        ${this.loading && this.budgets.length === 0
          ? html`
              <div class="px-2 py-4 text-center text-muted-foreground text-xs animate-pulse">
                Loading budgets…
              </div>
            `
          : nothing}

        <!-- Error -->
        ${this.error
          ? html`
              <div class="px-2 py-3 text-center text-xs text-red-400">
                ${this.error}
                <button
                  class="ml-1 underline hover:text-red-300"
                  @click=${() => void this.loadBudgets()}
                >
                  Retry
                </button>
              </div>
            `
          : nothing}

        <!-- Empty state -->
        ${!this.loading && !this.error && this.budgets.length === 0
          ? html`
              <div class="px-2 py-4 text-center text-muted-foreground text-xs">
                ${icon(Coins, "w-5 h-5 mx-auto mb-2 opacity-40")}
                <p>No budget configured</p>
              </div>
            `
          : nothing}

        <!-- Budget cards -->
        ${this.budgets.map((b) => this._renderCard(b))}
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Sub-templates
  // -----------------------------------------------------------------------

  private _renderCard(budget: BudgetStatus) {
    const tokenPercent = this.getUsagePercent(budget.tokensUsed, budget.tokenLimit);
    const costPercent = this.getUsagePercent(budget.costUsed, budget.costLimit);
    const hasTokenBar = tokenPercent >= 0;
    const hasCostBar = costPercent >= 0;
    const exceededClass = budget.exceeded
      ? "border-red-500/60"
      : "border-border";

    return html`
      <div class="rounded-lg border ${exceededClass} p-3 space-y-2.5 transition-colors">
        <!-- Card header -->
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">
            ${budget.provider} · ${this._capitalizePeriod(budget.period)}
          </span>
          ${budget.exceeded
            ? html`
                <span class="flex items-center gap-1 text-xs text-red-500 font-medium">
                  ${icon(AlertTriangle, "w-3.5 h-3.5")}
                  exceeded
                </span>
              `
            : nothing}
        </div>

        <!-- Tokens -->
        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="flex items-center gap-1 text-muted-foreground">
              ${icon(Coins, "w-3 h-3")}
              Tokens
            </span>
            <span class="text-foreground font-mono">
              ${formatTokenCount(budget.tokensUsed)}
              ${hasTokenBar
                ? html` / ${formatTokenCount(budget.tokenLimit!)}`
                : nothing}
            </span>
          </div>
          ${hasTokenBar
            ? html`
                <div class="w-full h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                  <div
                    class="h-full rounded-full bg-blue-500 transition-all duration-500"
                    style="width: ${tokenPercent}%"
                  ></div>
                </div>
                <div class="text-[10px] text-muted-foreground text-right mt-0.5">
                  ${tokenPercent}%
                </div>
              `
            : nothing}
        </div>

        <!-- Cost -->
        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="flex items-center gap-1 text-muted-foreground">
              ${icon(DollarSign, "w-3 h-3")}
              Cost
            </span>
            <span class="text-foreground font-mono">
              ${formatCost(budget.costUsed)}
              ${hasCostBar
                ? html` / ${formatCost(budget.costLimit!)}`
                : nothing}
            </span>
          </div>
          ${hasCostBar
            ? html`
                <div class="w-full h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                  <div
                    class="h-full rounded-full ${this.getBarColor(costPercent)} transition-all duration-500"
                    style="width: ${costPercent}%"
                  ></div>
                </div>
                <div class="text-[10px] text-muted-foreground text-right mt-0.5">
                  ${costPercent}%
                </div>
              `
            : nothing}
        </div>

        <!-- Exceeded notice -->
        ${budget.exceeded
          ? html`
              <div class="flex items-center gap-1.5 pt-1 text-xs text-red-500 border-t border-red-500/20">
                ${icon(AlertTriangle, "w-3 h-3 shrink-0")}
                <span>Budget exceeded: true</span>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _capitalizePeriod(period: string): string {
    return period.charAt(0).toUpperCase() + period.slice(1);
  }
}

// Guard against double-registration
if (!customElements.get("budget-panel")) {
  customElements.define("budget-panel", BudgetPanel);
}
