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
//   - "project-create" (no detail)           — user clicked the "+" button
//     (F-3.8). The app shell opens the <fan-create-project-dialog> which
//     handles name/template/location input and POST /api/projects.
//   - "project-remove" with detail { path } — user clicked the remove button of
//     an unavailable project (F-2.13: available === false / PROJECT_NOT_FOUND).
//     The app shell calls DELETE /api/projects?path= and reloads the list.
//   - "project-update-type" with detail { path, type } — user picked a new
//     workspace type from the inline type editor (F-3.10). The app shell calls
//     PUT /api/projects?path= { type } and reloads the list (icon refresh).

import type { ProjectSummary } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, FolderOpen, FolderX, Pencil, Plus, Search, X } from "lucide";
import { icon } from "../lib/icon.js";
import { renderWorkspaceTypeIcon, WORKSPACE_TYPES } from "../lib/workspace-type.js";

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
	/** F-3.10: path of the project whose inline type editor is open (null = closed). */
	@state() typeEditorFor: string | null = null;

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
	}

	private _close(): void {
		this.open = false;
		this.typeEditorFor = null;
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

	/** F-3.8: the "+" button asks the app shell to open the create-project
	 *  dialog (which collects name/template/location and calls POST
	 *  /api/projects). The switcher itself only emits the intent. */
	requestCreateProject(): void {
		this.dispatchEvent(
			new CustomEvent("project-create", {
				bubbles: true,
				composed: true,
			}),
		);
		this._close();
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

	/** F-3.10: toggle the inline type editor for a project. */
	toggleTypeEditor(path: string): void {
		this.typeEditorFor = this.typeEditorFor === path ? null : path;
	}

	/** F-3.10: emit project-update-type with the picked type; the app shell
	 *  performs PUT /api/projects?path= and reloads the list (icon refresh).
	 *  The dropdown stays open; only the editor row closes. */
	updateProjectType(path: string, type: string): void {
		this.typeEditorFor = null;
		this.dispatchEvent(
			new CustomEvent("project-update-type", {
				detail: { path, type },
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
          ${
					current
						? renderWorkspaceTypeIcon(current.type, "w-4 h-4")
						: icon(FolderOpen, "w-4 h-4 text-muted-foreground")
				}
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

        <!-- Create-project area (F-3.8: opens the create-project dialog) -->
        <div class="border-t border-border p-1.5">
          <button
            class="add-project-btn w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md
                   text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            @click=${() => this.requestCreateProject()}
          >
            ${icon(Plus, "w-4 h-4")}
            <span>New project…</span>
          </button>
        </div>
      </div>
    `;
	}

	private _renderProjectItem(p: ProjectSummary) {
		const isActive = p.path === this.currentProject;
		// F-2.13: a project whose directory no longer exists on disk stays in the
		// list with a "not found" indicator plus a remove-from-registry button.
		const unavailable = p.available === false;

		// Outer element is a wrapper (.project-entry): the clickable row is
		// .project-item (role=option) so the remove/type-edit buttons are not
		// nested inside another button, and the F-3.10 inline type editor can
		// render as a sibling row without triggering project selection.
		return html`
      <div class="project-entry">
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
        ${renderWorkspaceTypeIcon(p.type, "w-4 h-4")}
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
        <!-- F-3.10: manual type override — opens the inline type editor.
             Registry-only, so it is offered for unavailable projects too. -->
        <button
          type="button"
          class="project-type-edit-btn shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          title="Change project type"
          aria-label="Change type of ${p.name}"
          @click=${(e: Event) => {
					e.stopPropagation();
					this.toggleTypeEditor(p.path);
				}}
        >
          ${icon(Pencil, "w-3.5 h-3.5")}
        </button>
      </div>
      ${this.typeEditorFor === p.path ? this._renderTypePicker(p) : nothing}
      </div>
    `;
	}

	/** F-3.10: inline type picker row rendered under the project item while
	 *  its editor is open. Sibling of .project-item, so clicks never trigger
	 *  project selection. */
	private _renderTypePicker(p: ProjectSummary) {
		return html`
      <div class="type-picker flex items-center gap-1 px-3 py-1.5 bg-secondary/30 border-l-2 border-transparent">
        <span class="type-picker-label text-[10px] text-muted-foreground mr-1">Type:</span>
        ${WORKSPACE_TYPES.map(
				(t) => html`
          <button
            type="button"
            class="type-option flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors
                   ${
								p.type === t
									? "bg-primary/20 text-foreground"
									: "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
							}"
            data-type=${t}
            title="Set type to ${t}"
            @click=${() => this.updateProjectType(p.path, t)}
          >
            ${renderWorkspaceTypeIcon(t, "w-3 h-3")}
            <span>${t}</span>
          </button>
        `,
			)}
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("fan-project-switcher")) {
	customElements.define("fan-project-switcher", FanProjectSwitcher);
}
