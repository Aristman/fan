// @fan/dashboard/components — <model-settings-panel> element

import type { ModelInfo, ModelSettingData, RoutingRuleInfo, UpdateModelSettingsRequest } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { IconNode } from "lucide";
import { Cpu, Pencil, RefreshCw, Route, Save, Settings2, Star, X } from "lucide";
import type { FanApiClient } from "../api/client.js";
import { icon } from "../lib/icon.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("model-settings-panel")
export class ModelSettingsPanel extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() activeTab: "settings" | "routing" | "models" = "settings";
	@state() settings: ModelSettingData[] = [];
	@state() routingRules: RoutingRuleInfo[] = [];
	@state() models: ModelInfo[] = [];
	@state() loading = false;
	@state() saving = false;
	@state() error: string | null = null;
	@state() editingId: string | null = null;
	@state() editForm: Partial<ModelSettingData> = {};

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
		void this.loadAllData();
	}

	// -----------------------------------------------------------------------
	// Data
	// -----------------------------------------------------------------------

	async loadAllData(): Promise<void> {
		if (!this.apiClient) return;
		this.loading = true;
		this.error = null;
		try {
			const [settingsRes, modelsRes] = await Promise.all([
				this.apiClient.getModelSettings(),
				this.apiClient.getModels(),
			]);
			this.settings = settingsRes.settings;
			this.models = modelsRes.models;
			this.routingRules = modelsRes.routingRules;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Failed to load model data";
			this.error = message;
			console.error("model-settings-panel: loadAllData failed", err);
		} finally {
			this.loading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Edit helpers
	// -----------------------------------------------------------------------

	startEdit(setting: ModelSettingData): void {
		this.editingId = setting.id;
		this.editForm = {
			id: setting.id,
			provider: setting.provider,
			model: setting.model,
			temperature: setting.temperature,
			maxTokens: setting.maxTokens,
			thinking: setting.thinking,
			isDefault: setting.isDefault,
			priority: setting.priority,
		};
	}

	cancelEdit(): void {
		this.editingId = null;
		this.editForm = {};
	}

	async saveEdit(): Promise<void> {
		if (!this.editForm.provider || !this.editForm.model) return;
		this.saving = true;
		this.error = null;
		try {
			const req: UpdateModelSettingsRequest = {
				provider: this.editForm.provider,
				model: this.editForm.model,
				temperature: this.editForm.temperature ?? undefined,
				maxTokens: this.editForm.maxTokens ?? undefined,
				thinking: this.editForm.thinking ?? undefined,
			};
			await this.apiClient.updateModelSetting(req);
			this.editingId = null;
			this.editForm = {};
			await this.loadAllData();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Failed to save setting";
			this.error = message;
			console.error("model-settings-panel: saveEdit failed", err);
		} finally {
			this.saving = false;
		}
	}

	// -----------------------------------------------------------------------
	// Computed
	// -----------------------------------------------------------------------

	get modelsByProvider(): Map<string, ModelInfo[]> {
		const map = new Map<string, ModelInfo[]>();
		for (const m of this.models) {
			const list = map.get(m.provider);
			if (list) {
				list.push(m);
			} else {
				map.set(m.provider, [m]);
			}
		}
		return map;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		return html`
      <div class="model-settings-panel space-y-3">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Model Settings
          </span>
          <button
            class="p-1 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            ?disabled=${this.loading}
            @click=${() => void this.loadAllData()}
            title="Refresh model data"
            aria-label="Refresh model data"
          >
            ${icon(RefreshCw, `w-3.5 h-3.5${this.loading ? " animate-spin" : ""}`)}
          </button>
        </div>

        <!-- Tabs -->
        <div class="flex border-b border-border">
          ${this._renderTab("settings", "Model Settings", Settings2, "w-3.5 h-3.5")}
          ${this._renderTab("routing", "Routing Rules", Route, "w-3.5 h-3.5")}
          ${this._renderTab("models", "Available Models", Cpu, "w-3.5 h-3.5")}
        </div>

        <!-- Loading (initial) -->
        ${
				this.loading && this.settings.length === 0 && this.models.length === 0
					? html`
              <div class="px-2 py-8 text-center text-muted-foreground text-xs animate-pulse">
                Loading model data…
              </div>
            `
					: nothing
			}

        <!-- Error -->
        ${
				this.error
					? html`
              <div class="px-2 py-3 text-center text-xs text-red-400">
                ${this.error}
                <button
                  class="ml-1 underline hover:text-red-300"
                  @click=${() => void this.loadAllData()}
                >
                  Retry
                </button>
              </div>
            `
					: nothing
			}

        <!-- Tab content -->
        ${this.activeTab === "settings" ? this._renderSettingsTab() : nothing}
        ${this.activeTab === "routing" ? this._renderRoutingTab() : nothing}
        ${this.activeTab === "models" ? this._renderModelsTab() : nothing}
      </div>
    `;
	}

	// -----------------------------------------------------------------------
	// Tab button
	// -----------------------------------------------------------------------

	private _renderTab(tab: "settings" | "routing" | "models", label: string, iconData: IconNode, iconClass: string) {
		const isActive = this.activeTab === tab;
		return html`
      <button
        class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px
               ${
						isActive
							? "border-primary text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/20"
					}"
        @click=${() => {
				this.activeTab = tab;
			}}
      >
        ${icon(iconData, iconClass)}
        ${label}
      </button>
    `;
	}

	// -----------------------------------------------------------------------
	// Settings Tab
	// -----------------------------------------------------------------------

	private _renderSettingsTab() {
		if (this.settings.length === 0) {
			return html`
        <div class="px-2 py-8 text-center text-muted-foreground text-xs">
          ${icon(Settings2, "w-5 h-5 mx-auto mb-2 opacity-40")}
          <p>No model settings configured</p>
        </div>
      `;
		}

		return html`
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-border text-muted-foreground">
              <th class="text-left py-2 px-2 font-medium">Provider</th>
              <th class="text-left py-2 px-2 font-medium">Model</th>
              <th class="text-left py-2 px-2 font-medium">Temperature</th>
              <th class="text-left py-2 px-2 font-medium">Max Tokens</th>
              <th class="text-left py-2 px-2 font-medium">Thinking</th>
              <th class="text-left py-2 px-2 font-medium">Default</th>
              <th class="text-right py-2 px-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${this.settings.map(
					(s) => html`
                <tr class="border-b border-border/50 hover:bg-foreground/[0.02] transition-colors">
                  ${this.editingId === s.id ? this._renderEditRow(s) : this._renderDisplayRow(s)}
                </tr>
              `,
				)}
          </tbody>
        </table>
      </div>
    `;
	}

	private _renderDisplayRow(s: ModelSettingData) {
		return html`
      <td class="py-2 px-2">
        <span class="inline-block px-1.5 py-0.5 rounded bg-foreground/10 text-foreground font-mono text-[11px]">
          ${s.provider}
        </span>
      </td>
      <td class="py-2 px-2 font-mono text-foreground">${s.model}</td>
      <td class="py-2 px-2 text-muted-foreground">${s.temperature ?? "—"}</td>
      <td class="py-2 px-2 text-muted-foreground">${s.maxTokens ?? "—"}</td>
      <td class="py-2 px-2">
        ${
				s.thinking
					? html`
              <span class="inline-block px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[11px]">
                ${s.thinking}
              </span>
            `
					: html`<span class="text-muted-foreground">off</span>`
			}
      </td>
      <td class="py-2 px-2">
        ${
				s.isDefault
					? html`
              <span class="inline-flex items-center gap-1 text-amber-400 text-[11px] font-medium">
                ${icon(Star, "w-3 h-3")}
                default
              </span>
            `
					: nothing
			}
      </td>
      <td class="py-2 px-2 text-right">
        <button
          class="p-1 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
          @click=${() => this.startEdit(s)}
          title="Edit setting"
          aria-label="Edit ${s.provider}/${s.model}"
        >
          ${icon(Pencil, "w-3.5 h-3.5")}
        </button>
      </td>
    `;
	}

	private _renderEditRow(s: ModelSettingData) {
		return html`
      <td class="py-2 px-2">
        <span class="inline-block px-1.5 py-0.5 rounded bg-foreground/10 text-foreground font-mono text-[11px]">
          ${s.provider}
        </span>
      </td>
      <td class="py-2 px-2 font-mono text-foreground">${s.model}</td>
      <td class="py-2 px-2">
        <input
          type="number"
          class="w-16 px-1.5 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:border-primary"
          min="0"
          max="2"
          step="0.1"
          .value=${String(this.editForm.temperature ?? "")}
          @input=${(e: Event) => {
					const val = (e.target as HTMLInputElement).value;
					this.editForm = {
						...this.editForm,
						temperature: val === "" ? null : Number(val),
					};
				}}
        />
      </td>
      <td class="py-2 px-2">
        <input
          type="number"
          class="w-20 px-1.5 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:border-primary"
          min="0"
          .value=${String(this.editForm.maxTokens ?? "")}
          @input=${(e: Event) => {
					const val = (e.target as HTMLInputElement).value;
					this.editForm = {
						...this.editForm,
						maxTokens: val === "" ? null : Number(val),
					};
				}}
        />
      </td>
      <td class="py-2 px-2">
        <select
          class="text-xs bg-background border border-border rounded px-1.5 py-0.5 focus:outline-none focus:border-primary"
          .value=${this.editForm.thinking ?? "off"}
          @change=${(e: Event) => {
					const val = (e.target as HTMLSelectElement).value;
					this.editForm = {
						...this.editForm,
						thinking: val === "off" ? null : val,
					};
				}}
        >
          <option value="off">off</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </td>
      <td class="py-2 px-2">
        ${
				s.isDefault
					? html`
              <span class="inline-flex items-center gap-1 text-amber-400 text-[11px] font-medium">
                ${icon(Star, "w-3 h-3")}
                default
              </span>
            `
					: nothing
			}
      </td>
      <td class="py-2 px-2 text-right">
        <div class="flex items-center justify-end gap-0.5">
          <button
            class="p-1 rounded hover:bg-emerald-500/20 transition-colors text-emerald-500 hover:text-emerald-400 disabled:opacity-40"
            ?disabled=${this.saving}
            @click=${() => void this.saveEdit()}
            title="Save changes"
            aria-label="Save changes"
          >
            ${icon(Save, `w-3.5 h-3.5${this.saving ? " animate-pulse" : ""}`)}
          </button>
          <button
            class="p-1 rounded hover:bg-red-500/20 transition-colors text-red-400 hover:text-red-300"
            ?disabled=${this.saving}
            @click=${() => this.cancelEdit()}
            title="Cancel editing"
            aria-label="Cancel editing"
          >
            ${icon(X, "w-3.5 h-3.5")}
          </button>
        </div>
      </td>
    `;
	}

	// -----------------------------------------------------------------------
	// Routing Rules Tab
	// -----------------------------------------------------------------------

	private _renderRoutingTab() {
		if (this.routingRules.length === 0) {
			return html`
        <div class="px-2 py-8 text-center text-muted-foreground text-xs">
          ${icon(Route, "w-5 h-5 mx-auto mb-2 opacity-40")}
          <p>No routing rules configured</p>
        </div>
      `;
		}

		return html`
      <div class="space-y-2">
        ${this.routingRules.map((rule) => this._renderRoutingCard(rule))}
      </div>
    `;
	}

	private _renderRoutingCard(rule: RoutingRuleInfo) {
		return html`
      <div class="rounded-lg border border-border p-3 space-y-1.5 transition-colors">
        <!-- Card header: name + toggle badge -->
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">${rule.name}</span>
          <span
            class="text-[10px] font-medium px-1.5 py-0.5 rounded ${
					rule.enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-foreground/10 text-muted-foreground"
				}"
          >
            ${rule.enabled ? "ON" : "OFF"}
          </span>
        </div>
        <!-- Details -->
        <div class="space-y-1 text-xs text-muted-foreground">
          <div class="flex gap-2">
            <span class="font-medium text-foreground/70">Provider:</span>
            <span class="font-mono">${rule.provider}</span>
          </div>
          <div class="flex gap-2">
            <span class="font-medium text-foreground/70">Model:</span>
            <span class="font-mono">${rule.model}</span>
          </div>
          ${
					rule.fallback
						? html`
                <div class="flex gap-2">
                  <span class="font-medium text-foreground/70">Fallback:</span>
                  <span class="font-mono">${rule.fallback}</span>
                </div>
              `
						: nothing
				}
        </div>
      </div>
    `;
	}

	// -----------------------------------------------------------------------
	// Available Models Tab
	// -----------------------------------------------------------------------

	private _renderModelsTab() {
		if (this.models.length === 0) {
			return html`
        <div class="px-2 py-8 text-center text-muted-foreground text-xs">
          ${icon(Cpu, "w-5 h-5 mx-auto mb-2 opacity-40")}
          <p>No models available</p>
        </div>
      `;
		}

		return html`
      <div class="grid gap-2">
        ${Array.from(this.modelsByProvider.entries()).map(([provider, models]) =>
				this._renderProviderCard(provider, models),
			)}
      </div>
    `;
	}

	private _renderProviderCard(provider: string, models: ModelInfo[]) {
		return html`
      <div class="rounded-lg border border-border p-3 space-y-2">
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          ${provider}
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${models.map(
					(m) => html`
              <span
                class="inline-block px-2 py-0.5 rounded bg-foreground/10 text-foreground font-mono text-[11px] hover:bg-foreground/20 transition-colors"
                title=${m.displayName ?? m.model}
              >
                ${m.displayName ?? m.model}
              </span>
            `,
				)}
        </div>
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("model-settings-panel")) {
	customElements.define("model-settings-panel", ModelSettingsPanel);
}
