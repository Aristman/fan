/**
 * FAN Store — Interactive package browser component.
 *
 * Displays packages from a repository with installed status indicators.
 * Navigation: ↑↓ or j/k, Enter to install, Esc to cancel.
 */

import {
	Container,
	type Component,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@itone/fan-tui";
import type { InstalledPackage, RepoPackage } from "./types.js";

// ──────────────────────────────────────────────
// Browse result
// ──────────────────────────────────────────────

export interface BrowseResult {
	action: "install" | "cancel";
	packageName?: string;
}

// ──────────────────────────────────────────────
// Minimal theme interface (avoids importing internal Theme type)
// ──────────────────────────────────────────────

interface ThemeLike {
	fg(color: string, text: string): string;
}

// ──────────────────────────────────────────────
// Package row info
// ──────────────────────────────────────────────

interface PkgRow {
	pkg: RepoPackage;
	installed: boolean;
	instVersion?: string;
}

// ──────────────────────────────────────────────
// StoreBrowseComponent
// ──────────────────────────────────────────────

export class StoreBrowseComponent extends Container implements Focusable {
	private rows: PkgRow[] = [];
	private selectedIndex = 0;
	private scrollTop = 0;
	private maxVisible = 10;
	private listContainer: Container;
	private footerText: Text;
	private titleText: Text;
	private repoName: string;
	private onDone: (result: BrowseResult) => void;
	private theme: ThemeLike;

	// Focusable implementation
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		pkgs: RepoPackage[],
		installed: InstalledPackage[],
		repoName: string,
		_tui: TUI,
		theme: ThemeLike,
		_keybindings: unknown,
		onDone: (result: BrowseResult) => void,
	) {
		super();

		this.theme = theme;
		this.repoName = repoName;
		this.onDone = onDone;

		// Build rows
		this.rows = pkgs.map((pkg) => ({
			pkg,
			installed: installed.some((p) => p.name === pkg.name),
			instVersion: installed.find((p) => p.name === pkg.name)?.version,
		}));

		// Calculate maxVisible (conservative estimate)
		this.maxVisible = Math.max(3, Math.min(this.rows.length, 12));

		// Title
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Text(this.fg("border", "─".repeat(60)), 1, 0));
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.fg("border", "─".repeat(60)), 1, 0));

		// Footer with hints
		this.footerText = new Text("", 1, 0);
		this.addChild(this.footerText);

		this.renderStatic();
		this.renderList();
	}

	private fg(color: string, text: string): string {
		return this.theme.fg(color, text);
	}

	private renderStatic(): void {
		const count = this.rows.length;
		const installedCount = this.rows.filter((r) => r.installed).length;
		this.titleText.setText(
			`📦 ${this.fg("accent", this.repoName)} — ${count} package${count !== 1 ? "s" : ""}` +
				(installedCount > 0 ? ` (${this.fg("success", `${installedCount} installed`)})` : ""),
		);

		this.footerText.setText(
			`${this.fg("dim", "↑↓ navigate")}  ` +
				`${this.fg("dim", "Enter install")}  ` +
				`${this.fg("dim", "Esc cancel")}`,
		);
	}

	private renderList(): void {
		this.listContainer.clear();

		// Clamp scroll position
		if (this.rows.length <= this.maxVisible) {
			this.scrollTop = 0;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.rows.length - this.maxVisible));
		}

		const endIndex = Math.min(this.scrollTop + this.maxVisible, this.rows.length);

		for (let i = this.scrollTop; i < endIndex; i++) {
			const row = this.rows[i];
			if (!row) continue;

			const isSelected = i === this.selectedIndex;
			const desc = this.fg("dim", row.pkg.description);
			const type = this.fg("dim", ` [${row.pkg.type}]`);

			if (row.installed) {
				// Installed: green checkmark + green name
				const check = this.fg("success", "✓ ");
				const name = this.fg("success", row.pkg.name);
				const version = this.fg("dim", ` v${row.instVersion}`);

				if (isSelected) {
					this.listContainer.addChild(
						new Text(`${this.fg("accent", "→ ")}${check}${name}${version}${type}`, 1, 0),
					);
					this.listContainer.addChild(new Text(`      ${desc}`, 1, 0));
				} else {
					this.listContainer.addChild(
						new Text(`  ${check}${name}${version}${type}`, 1, 0),
					);
					this.listContainer.addChild(new Text(`      ${desc}`, 1, 0));
				}
			} else {
				// Not installed: plain text
				const name = row.pkg.name;
				const version = this.fg("dim", ` v${row.pkg.version}`);

				if (isSelected) {
					this.listContainer.addChild(
						new Text(`${this.fg("accent", "→ ")}${name}${version}${type}`, 1, 0),
					);
					this.listContainer.addChild(new Text(`      ${desc}`, 1, 0));
				} else {
					this.listContainer.addChild(
						new Text(`  ${name}${version}${type}`, 1, 0),
					);
					this.listContainer.addChild(new Text(`      ${desc}`, 1, 0));
				}
			}
		}

		// Scroll indicator
		if (this.rows.length > this.maxVisible) {
			const scrollText = this.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.rows.length})`,
			);
			this.listContainer.addChild(new Text(scrollText, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				if (this.selectedIndex < this.scrollTop) {
					this.scrollTop = this.selectedIndex;
				}
				this.renderList();
			}
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.selectedIndex < this.rows.length - 1) {
				this.selectedIndex++;
				if (this.selectedIndex >= this.scrollTop + this.maxVisible) {
					this.scrollTop = this.selectedIndex - this.maxVisible + 1;
				}
				this.renderList();
			}
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const row = this.rows[this.selectedIndex];
			if (row) {
				if (row.installed) {
					// Already installed — skip to next uninstalled
					const nextUninstalled = this.rows.findIndex(
						(r, idx) => idx > this.selectedIndex && !r.installed,
					);
					if (nextUninstalled !== -1) {
						this.selectedIndex = nextUninstalled;
						if (this.selectedIndex >= this.scrollTop + this.maxVisible) {
							this.scrollTop = this.selectedIndex - this.maxVisible + 1;
						}
						this.renderList();
					}
				} else {
					this.onDone({ action: "install", packageName: row.pkg.name });
				}
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onDone({ action: "cancel" });
		}
	}

	dispose(): void {
		// Nothing to clean up
	}
}
