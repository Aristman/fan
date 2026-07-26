// @fan/dashboard/components — <fan-project-switcher> element (F-2.6)
//
// Dropdown project switcher for the dashboard sidebar.
//
// Props:
//   - .projects: ProjectSummary[]        — all projects (from GET /api/projects)
//   - .currentProject: string | null     — path of the currently selected project
//
// Events (both bubble + composed):
//   - "project-select" with detail { path } — user picked a project from the list.
//     The app shell updates its currentProject state on this event. Reloading the
//     session list scoped to the project is F-2.7 territory.
//   - "project-add" with detail { path }    — user submitted the inline "+" form.
//     MVP: the component only emits the event; registering the project on the
//     server (or creating a session with that cwd) is the app shell's decision.
//   - "project-remove" with detail { path } — user clicked the remove button of
//     an unavailable project (F-2.13: available === false / PROJECT_NOT_FOUND).
//     The app shell calls DELETE /api/projects?path= and reloads the list.

import type { ProjectSummary } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Check, ChevronDown, FolderOpen, FolderX, Plus, Search, X } from "lucide";
import { icon } from "../lib/icon.js";

@customElement("fan-project-switcher")
export class FanProjectSwitcher extends LitElement {
	// -----------------------------------------------------------------------
	// Properties
	// -----------------------------------------------------------------------

	@property({ attribute: false }) projects: ProjectSummary[] = [];
	@property({ attribute: false }) currentProject: string | null = null;

	// -----------------------------------------------------------------------
	// Internal state
	// -----------------------------------------------------------------------

	@state() open = false;
	@state() filter = "";
	@state() adding = false;
	@state() newPath = "";

	// -----------------------------------------------------------------------
	// No shadow DOM — Tailwind styles need to penetrate
	// -----------------------------------------------------------------------

	override createRenderRoot(): this {
		return this;
	}

	// -----------------------------------------------------------------------
	// Computed
	// -----------------------------------------------------------------------

	get filteredProjects(): ProjectSummary[] {
		const q = this.filter.toLowerCase().trim();
		if (!q) return this.projects;
		return this.projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
	}

	get currentProjectInfo(): ProjectSummary | null {
		return this.projects.find((p) => p.path === this.currentProject) ?? null;
	}

	// -----------------------------------------------------------------------
	// Lifecycle — close dropdown on outside click
	// -----------------------------------------------------------------------

	private _onDocumentClick = (e: Event): void => {
		if (!this.open) return;
		if (!e.composedPath().includes(this)) {
			this._close();
		}
	};

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("click", this._onDocumentClick);
	}

	override disconnectedCallback(): void {
		document.removeEventListener("click", this._onDocumentClick);
		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	private _toggle(): void {
		this.open = !this.open;
		if (!this.open) this._resetTransient();
	}

	private _close(): void {
		this.open = false;
		this._resetTransient();
	}

	private _resetTransient(): void {
		this.adding = false;
		this.newPath = "";
	}

	selectProject(path: string): void {
		this.dispatchEvent(
			new CustomEvent("project-select", {
				detail: { path },
				bubbles: true,
				composed: true,
			}),
		);
		this._close();
	}

	submitNewProject(): void {
		const path = this.newPath.trim();
		if (!path) return;
		this.dispatchEvent(
			new CustomEvent("project-add", {
				detail: { path },
				bubbles: true,
				composed: true,
			}),
		);
		this._resetTransient();
	}

	/** F-2.13: emit project-remove for an unavailable project (stopPropagation
	 *  so the click does not also select the project). */
	removeProject(path: string): void {
		this.dispatchEvent(
			new CustomEvent("project-remove", {
				detail: { path },
				bubbles: true,
				composed: true,
			}),
		);
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		const current = this.currentProjectInfo;
		const label = current ? current.name : this.currentProject ? this.currentProject : "All projects";

		return html`
      <!-- Dropdown appearance animation (scoped by unique class names) -->
      <style>
        .fan-dropdown-panel {
          animation: fan-dropdown-in 120ms ease-out;
          transform-origin: top left;
        }
        @keyframes fan-dropdown-in {
          from { opacity: 0; transform: scale(0.97) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      </style>

      <div class="relative">
        <!-- Trigger button -->
        <button
          class="switcher-trigger w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                 border border-border bg-background hover:bg-secondary/50 transition-colors"
          aria-haspopup="listbox"
          aria-expanded=${this.open ? "true" : "false"}
          @click=${() => this._toggle()}
        >
          ${icon(FolderOpen, "w-4 h-4 text-muted-foreground")}
          <span class="flex-1 min-w-0 truncate text-left">${label}</span>
          ${
					current
						? html`<span class="session-count shrink-0 px-1.5 py-0 rounded bg-foreground/5 text-[10px] font-mono text-muted-foreground">${current.sessionCount}</span>`
						: nothing
				}
          ${icon(ChevronDown, `w-4 h-4 text-muted-foreground transition-transform ${this.open ? "rotate-180" : ""}`)}
        </button>

        ${this.open ? this._renderDropdown() : nothing}
      </div>
    `;
	}

	private _renderDropdown() {
		return html`
      <div
        class="fan-dropdown-panel absolute left-0 right-0 top-full mt-1 z-40
               rounded-lg border border-border bg-background shadow-lg shadow-black/20
               flex flex-col overflow-hidden"
        role="listbox"
      >
        <!-- Filter input -->
        <div class="relative p-2 border-b border-border">
          <span class="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
            ${icon(Search, "w-3.5 h-3.5")}
          </span>
          <input
            type="text"
            placeholder="Filter projects…"
            class="filter-input w-full pl-7 pr-2 py-1 text-sm rounded-md border border-border
                   bg-background placeholder:text-muted-foreground/60
                   focus:outline-none focus:ring-1 focus:ring-primary/50"
            .value=${this.filter}
            @input=${(e: Event) => {
					this.filter = (e.target as HTMLInputElement).value;
				}}
          />
        </div>

        <!-- Project list -->
        <div class="max-h-56 overflow-y-auto py-1">
          ${
					this.filteredProjects.length === 0
						? html`
                <div class="px-3 py-4 text-center text-xs text-muted-foreground">
                  ${this.projects.length === 0 ? "No projects yet" : `No projects match "${this.filter}"`}
                </div>
              `
						: this.filteredProjects.map((p) => this._renderProjectItem(p))
				}
        </div>

        <!-- Add-project area -->
        <div class="border-t border-border p-1.5">
          ${
					this.adding
						? html`
                <form
                  class="add-form flex items-center gap-1.5"
                  @submit=${(e: Event) => {
							e.preventDefault();
							this.submitNewProject();
						}}
                >
                  <input
                    type="text"
                    placeholder="/absolute/path/to/project"
                    class="new-path-input flex-1 min-w-0 px-2 py-1 text-sm rounded-md border border-border
                           bg-background placeholder:text-muted-foreground/60
                           focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
                    .value=${this.newPath}
                    @input=${(e: Event) => {
								this.newPath = (e.target as HTMLInputElement).value;
							}}
                  />
                  <button
                    type="submit"
                    class="shrink-0 p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    title="Add project"
                    ?disabled=${!this.newPath.trim()}
                  >
                    ${icon(Check, "w-3.5 h-3.5")}
                  </button>
                  <button
                    type="button"
                    class="shrink-0 p-1.5 rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
                    title="Cancel"
                    @click=${() => this._resetTransient()}
                  >
                    ${icon(X, "w-3.5 h-3.5")}
                  </button>
                </form>
              `
						: html`
                <button
                  class="add-project-btn w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md
                         text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                  @click=${() => {
							this.adding = true;
						}}
                >
                  ${icon(Plus, "w-4 h-4")}
                  <span>Add project…</span>
                </button>
              `
				}
        </div>
      </div>
    `;
	}

	private _renderProjectItem(p: ProjectSummary) {
		const isActive = p.path === this.currentProject;
		// F-2.13: a project whose directory no longer exists on disk stays in the
		// list with a "not found" indicator plus a remove-from-registry button.
		const unavailable = p.available === false;

		// Outer element is a div (role=option) so the remove button of an
		// unavailable project is not nested inside another button.
		return html`
      <div
        class="project-item w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer
               ${
						isActive
							? "active bg-secondary/80 border-l-2 border-primary text-foreground"
							: "hover:bg-secondary/50 text-muted-foreground hover:text-foreground border-l-2 border-transparent"
					}"
        role="option"
        aria-selected=${isActive ? "true" : "false"}
        title=${p.path}
        @click=${() => this.selectProject(p.path)}
      >
        <span class="flex-1 min-w-0">
          <span class="block truncate font-medium">${p.name}</span>
          <span class="block truncate text-[10px] font-mono text-muted-foreground/70">${p.path}</span>
          ${
					unavailable
						? html`
                <span class="not-found-label flex items-center gap-1 mt-0.5 text-[10px] text-yellow-500">
                  ${icon(FolderX, "w-3 h-3 shrink-0")}
                  <span>Not found on disk</span>
                </span>
              `
						: nothing
				}
        </span>
        ${
				unavailable
					? html`
              <button
                type="button"
                class="project-remove-btn shrink-0 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="Remove from registry"
                aria-label="Remove ${p.name} from registry"
                @click=${(e: Event) => {
							e.stopPropagation();
							this.removeProject(p.path);
						}}
              >
                ${icon(X, "w-3.5 h-3.5")}
              </button>
            `
					: html`
            <span
              class="session-count shrink-0 px-1.5 py-0 rounded bg-foreground/5 text-[10px] font-mono text-muted-foreground"
              title="${p.sessionCount} session(s)"
            >
              ${p.sessionCount}
            </span>
          `
			}
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("fan-project-switcher")) {
	customElements.define("fan-project-switcher", FanProjectSwitcher);
}
