// @fan/dashboard/components — <budget-alert-toast> element

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { AlertTriangle, X } from "lucide";
import { icon } from "../lib/icon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BudgetAlertEntry {
  provider: string;
  period: string;
  alertType: string;
  message: string;
  id: string;
  /** Internal timer handle for auto-dismiss */
  _timer?: ReturnType<typeof setTimeout>;
  /** Whether the toast is fading out */
  _fading?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("budget-alert-toast")
export class BudgetAlertToast extends LitElement {
  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  @state() alerts: BudgetAlertEntry[] = [];

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _boundOnBudgetAlert = this._handleBudgetAlert.bind(this);
  private _nextId = 0;

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
    window.addEventListener("fan:budget-alert", this._boundOnBudgetAlert);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("fan:budget-alert", this._boundOnBudgetAlert);
    // Clear all timers
    for (const alert of this.alerts) {
      if (alert._timer) clearTimeout(alert._timer);
    }
    super.disconnectedCallback();
  }

  // -----------------------------------------------------------------------
  // Alert management
  // -----------------------------------------------------------------------

  private _handleBudgetAlert(event: Event): void {
    const detail = (event as CustomEvent).detail;
    if (!detail) return;

    this.addAlert({
      provider: detail.provider ?? "Unknown",
      period: detail.period ?? "daily",
      alertType: detail.alertType ?? detail.type ?? "warning",
      message: detail.message ?? "Budget alert triggered",
    });
  }

  addAlert(alert: {
    provider: string;
    period: string;
    alertType: string;
    message: string;
  }): void {
    const id = `alert-${Date.now()}-${this._nextId++}`;
    const entry: BudgetAlertEntry = { id, ...alert };
    entry._timer = setTimeout(() => {
      void this._fadeOutAndRemove(id);
    }, 10_000);

    this.alerts = [...this.alerts, entry];
  }

  removeAlert(id: string): void {
    const existing = this.alerts.find((a) => a.id === id);
    if (existing?._timer) clearTimeout(existing._timer);
    this.alerts = this.alerts.filter((a) => a.id !== id);
  }

  private async _fadeOutAndRemove(id: string): Promise<void> {
    // Mark as fading to trigger CSS transition
    this.alerts = this.alerts.map((a) =>
      a.id === id ? { ...a, _fading: true } : a,
    );

    // Wait for fade-out animation
    await new Promise((resolve) => setTimeout(resolve, 300));

    this.removeAlert(id);
  }

  openBudgetPanel(): void {
    this.dispatchEvent(
      new CustomEvent("fan:navigate", {
        detail: { view: "budget" },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Styling helpers
  // -----------------------------------------------------------------------

  private _alertBorderStyle(alertType: string): string {
    switch (alertType) {
      case "critical":
        return "border-red-500";
      case "exceeded":
        return "border-red-500 bg-red-500/10";
      default:
        return "border-amber-500";
    }
  }

  private _alertIconColor(alertType: string): string {
    switch (alertType) {
      case "critical":
        return "text-red-500";
      case "exceeded":
        return "text-red-500";
      default:
        return "text-amber-500";
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  override render() {
    if (this.alerts.length === 0) return nothing;

    return html`
      <div class="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        ${this.alerts.map((alert) => this._renderToast(alert))}
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Sub-templates
  // -----------------------------------------------------------------------

  private _renderToast(alert: BudgetAlertEntry) {
    const borderClass = this._alertBorderStyle(alert.alertType);
    const iconColor = this._alertIconColor(alert.alertType);
    const opacityClass = alert._fading ? "opacity-0" : "opacity-100";

    return html`
      <div
        class="pointer-events-auto rounded-lg border ${borderClass} bg-card shadow-lg p-3 transition-opacity duration-300 ${opacityClass}"
        @click=${() => this.openBudgetPanel()}
      >
        <!-- Header -->
        <div class="flex items-center justify-between mb-1.5">
            <span class="flex items-center gap-1.5 text-xs font-semibold">
            ${icon(AlertTriangle, "w-3.5 h-3.5 " + iconColor)}
            Budget Alert
          </span>
          <button
            class="p-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.removeAlert(alert.id);
            }}
            aria-label="Dismiss"
          >
            ${icon(X, "w-3.5 h-3.5")}
          </button>
        </div>

        <!-- Body -->
        <div class="text-xs text-muted-foreground">
          <div class="font-medium text-foreground mb-0.5">
            ${alert.provider} · ${this._capitalizePeriod(alert.period)}
          </div>
          <div>${alert.message}</div>
        </div>
      </div>
    `;
  }

  private _capitalizePeriod(period: string): string {
    return period.charAt(0).toUpperCase() + period.slice(1);
  }
}

// Guard against double-registration
if (!customElements.get("budget-alert-toast")) {
  customElements.define("budget-alert-toast", BudgetAlertToast);
}
