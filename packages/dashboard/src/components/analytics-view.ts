// @fan/dashboard/components — <analytics-view> element

import type { AnalyticsReportMeta } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ArrowLeft, BarChart3, Calendar, FileText, RefreshCw, TrendingUp } from "lucide";
import type { FanApiClient } from "../api/client.js";
import { icon } from "../lib/icon.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("analytics-view")
export class AnalyticsView extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() reports: AnalyticsReportMeta[] = [];
	@state() loading = false;
	@state() error: string | null = null;
	@state() selectedReport: string | null = null;
	@state() selectedContent: string | null = null;
	@state() detailLoading = false;
	@state() detailError: string | null = null;

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private _refreshInterval: ReturnType<typeof setInterval> | null = null;

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
		void this.loadReports();
		this._refreshInterval = setInterval(() => {
			void this.loadReports();
		}, 30_000);
	}

	override disconnectedCallback(): void {
		if (this._refreshInterval) {
			clearInterval(this._refreshInterval);
			this._refreshInterval = null;
		}
		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// Data
	// -----------------------------------------------------------------------

	async loadReports(): Promise<void> {
		if (!this.apiClient) return;
		this.loading = true;
		this.error = null;
		try {
			const res = await this.apiClient.getAnalyticsReports();
			this.reports = res.reports;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Не удалось загрузить отчёты";
			this.error = message;
			console.error("analytics-view: loadReports failed", err);
		} finally {
			this.loading = false;
		}
	}

	private async _loadDetail(name: string): Promise<void> {
		this.selectedReport = name;
		this.selectedContent = null;
		this.detailError = null;
		this.detailLoading = true;
		try {
			const res = await this.apiClient.getAnalyticsReport(name);
			this.selectedContent = res.content;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Не удалось загрузить отчёт";
			this.detailError = message;
		} finally {
			this.detailLoading = false;
		}
	}

	private _backToList(): void {
		this.selectedReport = null;
		this.selectedContent = null;
		this.detailError = null;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private _formatDate(mtime: string): string {
		try {
			return new Date(mtime).toLocaleDateString("ru-RU", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return mtime;
		}
	}

	private _formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} Б`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
	}

	private _extractDateFromName(name: string): string {
		// Patterns: <session-slug>_<date>.md or weekly_<date>.md
		const match = name.match(/(\d{4}[-_]\d{2}[-_]\d{2})/);
		return match ? match[1].replace(/_/g, "-") : "";
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		if (this.selectedReport) {
			return this._renderDetail();
		}
		return this._renderList();
	}

	private _renderList() {
		return html`
      <div class="space-y-4">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            ${icon(BarChart3, "w-5 h-5 text-muted-foreground")}
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Аналитика
            </span>
          </div>
          <button
            class="p-1 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            ?disabled=${this.loading}
            @click=${() => void this.loadReports()}
            title="Обновить отчёты"
            aria-label="Обновить отчёты"
          >
            ${icon(RefreshCw, `w-3.5 h-3.5${this.loading ? " animate-spin" : ""}`)}
          </button>
        </div>

        <!-- Loading -->
        ${
				this.loading && this.reports.length === 0
					? html`
              <div class="px-2 py-8 text-center text-muted-foreground text-sm animate-pulse">
                Загрузка отчётов…
              </div>
            `
					: nothing
			}

        <!-- Error -->
        ${
				this.error
					? html`
              <div class="px-2 py-4 text-center text-sm text-red-400">
                ${this.error}
                <button
                  class="ml-1 underline hover:text-red-300"
                  @click=${() => void this.loadReports()}
                >
                  Повторить
                </button>
              </div>
            `
					: nothing
			}

        <!-- Empty state -->
        ${
				!this.loading && !this.error && this.reports.length === 0
					? html`
              <div class="px-2 py-12 text-center text-muted-foreground">
                ${icon(TrendingUp, "w-8 h-8 mx-auto mb-3 opacity-30")}
                <p class="text-sm mb-1">Нет отчётов</p>
                <p class="text-xs opacity-70">
                  Запустите /session-analytics в FAN для генерации отчётов
                </p>
              </div>
            `
					: nothing
			}

        <!-- Report cards -->
        ${this.reports.map((r) => this._renderCard(r))}
      </div>
    `;
	}

	private _renderCard(report: AnalyticsReportMeta) {
		const dateFromName = this._extractDateFromName(report.name);
		const isWeekly = report.kind === "weekly";

		return html`
      <button
        class="w-full text-left rounded-lg border border-border p-3 space-y-1.5 transition-colors hover:bg-secondary/50 cursor-pointer"
        @click=${() => void this._loadDetail(report.name)}
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            ${icon(FileText, "w-4 h-4 shrink-0 text-muted-foreground")}
            <span class="text-sm font-medium truncate">${report.name.replace(/\.md$/, "")}</span>
          </div>
          <span
            class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
					isWeekly ? "bg-blue-500/15 text-blue-500" : "bg-emerald-500/15 text-emerald-500"
				}"
          >
            ${isWeekly ? "неделя" : "сессия"}
          </span>
        </div>
        <div class="flex items-center gap-3 text-xs text-muted-foreground">
          ${
					dateFromName
						? html`
                <span class="flex items-center gap-1">
                  ${icon(Calendar, "w-3 h-3")}
                  ${dateFromName}
                </span>
              `
						: nothing
				}
          <span>${this._formatSize(report.sizeBytes)}</span>
          <span>${this._formatDate(report.mtime)}</span>
        </div>
      </button>
    `;
	}

	private _renderDetail() {
		return html`
      <div class="space-y-4">
        <!-- Back button -->
        <button
          class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          @click=${this._backToList}
        >
          ${icon(ArrowLeft, "w-4 h-4")}
          Назад к списку
        </button>

        <!-- Title -->
        <div class="flex items-center gap-2">
          ${icon(FileText, "w-5 h-5 text-muted-foreground")}
          <span class="text-sm font-semibold">${this.selectedReport}</span>
        </div>

        <!-- Loading -->
        ${
				this.detailLoading
					? html`
              <div class="px-2 py-8 text-center text-muted-foreground text-sm animate-pulse">
                Загрузка отчёта…
              </div>
            `
					: nothing
			}

        <!-- Error -->
        ${
				this.detailError
					? html`
              <div class="px-2 py-4 text-center text-sm text-red-400">
                ${this.detailError}
                <button
                  class="ml-1 underline hover:text-red-300"
                  @click=${() => void this._loadDetail(this.selectedReport!)}
                >
                  Повторить
                </button>
              </div>
            `
					: nothing
			}

        <!-- Content -->
        ${
				this.selectedContent !== null
					? html`
              <pre class="font-mono text-xs whitespace-pre-wrap leading-relaxed bg-card border border-border rounded-lg p-4 overflow-x-auto">${this.selectedContent}</pre>
            `
					: nothing
			}
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("analytics-view")) {
	customElements.define("analytics-view", AnalyticsView);
}
