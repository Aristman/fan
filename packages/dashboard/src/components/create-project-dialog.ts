// @fan/dashboard/components — <fan-create-project-dialog> (F-3.8)
//
// Modal dialog for creating a new project workspace from a template.
// Submits POST /api/projects { name, template?, rootPath? } (F-3.5).
//
// Fields:
//   - Project name (required; path-traversal symbols are rejected client-side)
//   - Template radio group: Code / Research / Automation / Empty folder
//     ("Empty folder" = no template field in the request body)
//   - Location (rootPath) — optional; when empty the server applies its
//     default (workspace root → ~/projects).
//
// Events (bubbles + composed, dispatched on the element; since the dialog is
// appended to document.body they also reach window):
//   - "project-created" with detail CreateProjectResponse — fired on success,
//     right before the dialog closes. The app shell re-fetches the project
//     list and switches to the new project.
//
// Server errors (400 / 403) are shown inline; the dialog stays open.

import type { CreateProjectRequest, CreateProjectResponse } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CodeXml, Cog, FlaskConical, Folder, FolderPlus, type IconNode, X } from "lucide";
import { FanApiClient, FanApiError } from "../api/client.js";
import { icon } from "../lib/icon.js";

/** Template choices shown as a radio group (spec section 4.2). "" = empty folder. */
const TEMPLATES: { value: string; label: string; desc: string; iconNode: IconNode }[] = [
	{ value: "code", label: "Code Project", desc: "src/, tests/, docs/, package.json", iconNode: CodeXml },
	{ value: "research", label: "Research Lab", desc: "docs/research/, data/, reports/", iconNode: FlaskConical },
	{ value: "automation", label: "Automation Hub", desc: "scripts/, config/, output/, logs/", iconNode: Cog },
	{ value: "", label: "Empty Folder", desc: "Just the directory, no template", iconNode: Folder },
];

@customElement("fan-create-project-dialog")
export class FanCreateProjectDialog extends LitElement {
	// -----------------------------------------------------------------------
	// Static API — imperative creation (same pattern as SettingsDialog)
	// -----------------------------------------------------------------------

	static open(apiClient: FanApiClient, opts?: { defaultRootPath?: string }): FanCreateProjectDialog {
		const el = new FanCreateProjectDialog();
		el.apiClient = apiClient;
		if (opts?.defaultRootPath) el.defaultRootPath = opts.defaultRootPath;
		document.body.appendChild(el);
		return el;
	}

	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;
	/** Pre-filled location (workspace root when known). Empty = server default. */
	@property() defaultRootPath = "";

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() name = "";
	@state() template = "code";
	@state() rootPath = "";
	@state() submitting = false;
	@state() error: string | null = null;

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
		if (!this.rootPath && this.defaultRootPath) {
			this.rootPath = this.defaultRootPath;
		}
	}

	// -----------------------------------------------------------------------
	// Validation
	// -----------------------------------------------------------------------

	/**
	 * Mirrors the server-side rule (http-server POST /api/projects): the name
	 * must be a single path segment — '/', '\' and '..' are traversal and are
	 * highlighted as an error before the request is even sent.
	 */
	get nameError(): string | null {
		const n = this.name.trim();
		if (!n) return null; // emptiness is handled by the disabled submit button
		if (n.includes("/") || n.includes("\\") || n.includes("..")) {
			return "Name must be a single path segment (no '/', '\\' or '..')";
		}
		return null;
	}

	get canSubmit(): boolean {
		return this.name.trim().length > 0 && this.nameError === null && !this.submitting;
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	close(): void {
		this.remove();
	}

	async submit(): Promise<void> {
		if (!this.canSubmit || !this.apiClient) return;
		this.submitting = true;
		this.error = null;

		const body: CreateProjectRequest = { name: this.name.trim() };
		if (this.template) body.template = this.template;
		const rootPath = this.rootPath.trim();
		if (rootPath) body.rootPath = rootPath;

		try {
			const res = await this.apiClient.createProject(body);
			this.dispatchEvent(
				new CustomEvent<CreateProjectResponse>("project-created", {
					detail: res,
					bubbles: true,
					composed: true,
				}),
			);
			this.close();
		} catch (err) {
			this.error =
				err instanceof FanApiError
					? `${err.message} (HTTP ${err.status})`
					: err instanceof Error
						? err.message
						: "Failed to create project";
		} finally {
			this.submitting = false;
		}
	}

	private _onKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.stopPropagation();
			this.close();
		}
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		return html`
      <!-- Backdrop -->
      <div
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        @click=${(e: Event) => {
				if ((e.target as HTMLElement).classList.contains("fixed")) this.close();
			}}
        @keydown=${this._onKeydown}
      >
        <!-- Dialog -->
        <div
          class="create-project-dialog bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
          style="width: min(440px, 92vw);"
          role="dialog"
          aria-label="Create new project"
        >
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <div class="flex items-center gap-2">
              ${icon(FolderPlus, "w-5 h-5 text-muted-foreground")}
              <h2 class="text-base font-semibold text-foreground">New Project</h2>
            </div>
            <button
              class="cancel-btn p-1.5 rounded-md hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
              @click=${this.close}
              aria-label="Close dialog"
            >
              ${icon(X, "w-4 h-4")}
            </button>
          </div>

          <!-- Body -->
          <form
            class="p-5 space-y-4 overflow-y-auto"
            @submit=${(e: Event) => {
					e.preventDefault();
					void this.submit();
				}}
          >
            <!-- Project name -->
            <div>
              <label class="block text-sm font-medium text-foreground mb-1.5" for="cp-name">
                Project name
              </label>
              <input
                id="cp-name"
                type="text"
                class="project-name-input w-full px-3 py-2 text-sm rounded-lg border bg-background
                       text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                       transition-colors ${
						this.nameError ? "name-invalid border-destructive ring-1 ring-destructive/50" : "border-border"
					}"
                placeholder="my-project"
                .value=${this.name}
                @input=${(e: Event) => {
						this.name = (e.target as HTMLInputElement).value;
					}}
              />
              ${
					this.nameError
						? html`<p class="name-error mt-1.5 text-xs text-destructive">${this.nameError}</p>`
						: nothing
				}
            </div>

            <!-- Template radio group -->
            <fieldset>
              <legend class="block text-sm font-medium text-foreground mb-1.5">Template</legend>
              <div class="template-options space-y-1.5">
                ${TEMPLATES.map(
						(t) => html`
                    <label
                      class="template-option flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors
                             ${
								this.template === t.value
									? "border-primary bg-primary/5"
									: "border-border hover:bg-secondary/40"
							}"
                    >
                      <input
                        type="radio"
                        name="template"
                        class="template-radio accent-primary"
                        .value=${t.value}
                        .checked=${this.template === t.value}
                        @change=${() => {
								this.template = t.value;
							}}
                      />
                      ${icon(t.iconNode, "w-4 h-4 text-muted-foreground")}
                      <span class="min-w-0">
                        <span class="block text-sm font-medium text-foreground">${t.label}</span>
                        <span class="block text-xs text-muted-foreground truncate">${t.desc}</span>
                      </span>
                    </label>
                  `,
					)}
              </div>
            </fieldset>

            <!-- Location -->
            <div>
              <label class="block text-sm font-medium text-foreground mb-1.5" for="cp-root">
                Location
              </label>
              <input
                id="cp-root"
                type="text"
                class="root-path-input w-full px-3 py-2 text-sm rounded-lg border border-border bg-background
                       text-foreground placeholder:text-muted-foreground font-mono
                       focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                       transition-colors"
                placeholder="Default: workspace root (server)"
                .value=${this.rootPath}
                @input=${(e: Event) => {
						this.rootPath = (e.target as HTMLInputElement).value;
					}}
              />
              <p class="mt-1.5 text-xs text-muted-foreground">
                The project directory is created inside this folder. Leave empty to use the server default.
              </p>
            </div>

            <!-- Server error -->
            ${
					this.error
						? html`
                <div
                  class="dialog-error flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm"
                  role="alert"
                >
                  ${icon(X, "w-4 h-4 shrink-0 mt-0.5")}
                  <span>${this.error}</span>
                </div>
              `
						: nothing
				}

            <!-- Footer -->
            <div class="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                class="px-4 py-2 text-sm font-medium rounded-lg text-muted-foreground
                       hover:bg-secondary/60 hover:text-foreground transition-colors"
                @click=${this.close}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="create-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       bg-primary text-primary-foreground hover:bg-primary/90
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                ?disabled=${!this.canSubmit}
              >
                ${icon(FolderPlus, "w-4 h-4")}
                ${this.submitting ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("fan-create-project-dialog")) {
	customElements.define("fan-create-project-dialog", FanCreateProjectDialog);
}
