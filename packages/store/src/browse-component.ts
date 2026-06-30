/**
 * FAN Store — Interactive package browser.
 *
 * Full-screen browser with repo tabs, type filter tabs, fuzzy search,
 * details overlay, install/update/remove actions, and automatic
 * re-open after each action.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@seaagents/fan-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth } from "@seaagents/fan-tui";
import type { StoreConfig } from "./config.js";
import type { ArchiveInstaller } from "./installer.js";
import { ProgressOverlay } from "./progress-overlay.js";
import type { RepoClient } from "./repo-client.js";
import type { StoreDatabase } from "./storage.js";
import type { InstalledPackage, RepoPackage } from "./types.js";

// ─── Types ────────────────────────────────────

type PackageTypeFilter = "all" | "extension" | "skill" | "theme" | "bundle";

interface SkillFrontmatter {
	name?: string;
	description?: string;
	triggers?: string[];
	examples?: string[];
	[key: string]: unknown;
}

interface MergedPackage {
	repo: RepoPackage | null;
	installed: InstalledPackage | undefined;
}

interface BrowserData {
	allPackages: RepoPackage[];
	installedPackages: InstalledPackage[];
	updates: Map<string, { current: string; latest: string }>;
	mergedPackages: MergedPackage[];
	typeCounts: Record<PackageTypeFilter, number>;
}

type BrowserAction =
	| { type: "install"; pkg: RepoPackage }
	| { type: "update"; pkg: RepoPackage; installed: InstalledPackage }
	| { type: "remove"; pkg: RepoPackage | null; installed: InstalledPackage }
	| { type: "exit" };

interface OperationResult {
	success: boolean;
	message: string;
	cancelled?: true;
}

const CANCELLED: OperationResult = { success: false, message: "", cancelled: true };

const TYPE_FILTERS: PackageTypeFilter[] = ["all", "extension", "skill", "theme", "bundle"];

const VISIBLE_COUNT = 12;

// ─── Helpers ──────────────────────────────────

function getTypeBadge(type: string): string {
	switch (type) {
		case "extension":
			return "[ext]";
		case "skill":
			return "[skill]";
		case "theme":
			return "[theme]";
		case "bundle":
			return "[bundle]";
		default:
			return `[${type}]`;
	}
}

function getTypeLabel(tf: PackageTypeFilter): string {
	if (tf === "all") return "All";
	return tf.slice(0, 1).toUpperCase() + tf.slice(1);
}

function parseSimpleFrontmatter(yaml: string): SkillFrontmatter | null {
	try {
		const result: SkillFrontmatter = {};
		for (const line of yaml.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx === -1) continue;
			const key = trimmed.slice(0, colonIdx).trim();
			let value: unknown = trimmed.slice(colonIdx + 1).trim();
			if (
				typeof value === "string" &&
				((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			) {
				value = value.slice(1, -1);
			}
			if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
				value = value
					.slice(1, -1)
					.split(",")
					.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
					.filter(Boolean);
			}
			if (key) result[key] = value;
		}
		return Object.keys(result).length > 0 ? result : null;
	} catch {
		return null;
	}
}

function readSkillFrontmatter(installPath: string): SkillFrontmatter | null {
	try {
		const skillMdPath = `${installPath}/SKILL.md`;
		if (!existsSync(skillMdPath)) return null;
		const content = readFileSync(skillMdPath, "utf-8");
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match?.[1]) return null;
		return parseSimpleFrontmatter(match[1]);
	} catch {
		return null;
	}
}

function computeTypeCounts(mergedPackages: MergedPackage[]): Record<PackageTypeFilter, number> {
	const counts: Record<PackageTypeFilter, number> = {
		all: mergedPackages.length,
		extension: 0,
		skill: 0,
		theme: 0,
		bundle: 0,
	};
	for (const m of mergedPackages) {
		const t = (m.repo?.type ?? m.installed?.type) as PackageTypeFilter;
		if (t && t in counts) counts[t]++;
	}
	return counts;
}

function computeVisibleItems(
	mergedPackages: MergedPackage[],
	enabledRepos: { name: string }[],
	selectedRepoIndex: number,
	typeFilter: PackageTypeFilter,
	searchQuery: string,
): MergedPackage[] {
	let filtered = mergedPackages;

	// Repo filter (0 = all repos)
	if (selectedRepoIndex > 0 && selectedRepoIndex <= enabledRepos.length) {
		const repoName = enabledRepos[selectedRepoIndex - 1]!.name;
		filtered = filtered.filter((m) => m.repo?.repoName === repoName);
	}

	// Type filter
	if (typeFilter !== "all") {
		filtered = filtered.filter((m) => (m.repo?.type ?? m.installed?.type) === typeFilter);
	}

	// Fuzzy search
	if (searchQuery.trim()) {
		filtered = fuzzyFilter(filtered, searchQuery, (m) => {
			const name = m.repo?.name ?? m.installed?.name ?? "";
			const desc = m.repo?.description ?? "";
			return `${name} ${desc}`;
		});
	}

	return filtered;
}

/**
 * Show a cancellable progress overlay while performing an async operation.
 */
async function withProgressOverlay(
	ctx: ExtensionContext,
	message: string,
	operation: (signal: AbortSignal, setMessage: (msg: string) => void) => Promise<OperationResult>,
): Promise<OperationResult> {
	return ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
		const overlay = new ProgressOverlay(tui, themeInstance, message, () => done(CANCELLED));

		(async () => {
			try {
				const result = await operation(overlay.signal, (msg) => overlay.setMessage(msg));
				done(result);
			} catch (err) {
				if (overlay.signal.aborted) {
					done(CANCELLED);
				} else {
					done({
						success: false,
						message: `❌ ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
		})();

		return overlay;
	});
}

// ─── Merge helper ────────────────────────────

function buildMergedPackages(allPackages: RepoPackage[], installedPackages: InstalledPackage[]): MergedPackage[] {
	const merged: MergedPackage[] = allPackages.map((repo) => ({
		repo,
		installed: installedPackages.find((i) => i.name === repo.name),
	}));

	// Include locally installed packages not present in remote index
	const repoNames = new Set(allPackages.map((p) => p.name));
	for (const local of installedPackages) {
		if (!repoNames.has(local.name)) {
			merged.push({ repo: null, installed: local });
		}
	}

	return merged;
}

// ─── Main entry point ────────────────────────

export async function showExtensionBrowser(
	ctx: ExtensionContext,
	db: StoreDatabase,
	repoClient: RepoClient,
	installer: ArchiveInstaller,
	config: StoreConfig,
): Promise<void> {
	const enabledRepos = config.repositories.filter((r) => r.enabled);
	if (enabledRepos.length === 0) {
		ctx.ui.notify("No repositories configured.", "error");
		return;
	}

	// ── Phase 1: Load all data ──
	const rawData = await ctx.ui.custom<BrowserData | null>((tui, themeInstance, _kb, done) => {
		const overlay = new ProgressOverlay(tui, themeInstance, "Loading packages...", () => done(null));

		(async () => {
			try {
				const installedPackages = db.getPackages();
				const repoInstalled = installedPackages.filter((p) => p.source === "repo");

				const [updatesMap] = await Promise.all([repoClient.checkUpdates(repoInstalled, config.repositories)]);

				// Fetch packages via repoClient (deduplication built-in)
				const allPackages = await repoClient.getAllPackages(config.repositories);
				allPackages.sort((a, b) => a.name.localeCompare(b.name));

				// Enrich installed packages with update status
				for (const installed of installedPackages) {
					const update = updatesMap.get(installed.name);
					if (installed.source === "repo" && update) {
						installed.updateAvailable = true;
						installed.updateVersion = update.latest;
					}
				}

				// Build merged packages (remote + local-only)
				const mergedPackages = buildMergedPackages(allPackages, installedPackages);

				const typeCounts = computeTypeCounts(mergedPackages);

				done({ allPackages, installedPackages, updates: updatesMap, mergedPackages, typeCounts });
			} catch (err) {
				ctx.ui.notify(`Failed to load packages: ${err instanceof Error ? err.message : String(err)}`, "error");
				done(null);
			}
		})();

		return overlay;
	});

	if (!rawData) return;
	const data: BrowserData = rawData;

	// ── Phase 2: Interactive browser loop ──

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const action = await ctx.ui.custom<BrowserAction>((tui, theme, _kb, done) => {
			// ── State ──
			let focusTarget: "list" | "search" | "details" = "list";
			let selectedRepoIndex = 0; // 0 = All repos
			let typeFilterIndex = 0;
			let searchQuery = "";
			let searchFocused = false;
			let selectedIndex = 0;
			let scrollOffset = 0;
			let showDetails = false;
			let detailPkg: MergedPackage | null = null;

			const REPO_TABS = ["All", ...enabledRepos.map((r) => r.name)];
			const searchInput = new Input();
			searchInput.focused = false;
			searchInput.setValue("");

			// ── Compute visible items ──
			let visibleItems: MergedPackage[] = [];

			function rebuildVisible(): void {
				const typeFilter = TYPE_FILTERS[typeFilterIndex] as PackageTypeFilter;
				visibleItems = computeVisibleItems(
					data.mergedPackages,
					enabledRepos,
					selectedRepoIndex,
					typeFilter,
					searchQuery,
				);
				// Clamp selection
				if (visibleItems.length === 0) {
					selectedIndex = 0;
					scrollOffset = 0;
				} else if (selectedIndex >= visibleItems.length) {
					selectedIndex = visibleItems.length - 1;
				}
				if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
				if (selectedIndex >= scrollOffset + VISIBLE_COUNT)
					scrollOffset = Math.max(0, selectedIndex - VISIBLE_COUNT + 1);
			}

			rebuildVisible();

			// ── Render helpers ──

			function renderRepoTabs(width: number): string {
				const tabParts = REPO_TABS.map((repo, i) => {
					const active = i === selectedRepoIndex;
					const label = ` ${repo} `;
					return active ? `►${label}◄` : label;
				});
				return truncateToWidth(tabParts.join(theme.fg("dim", " │ ")), width, "…");
			}

			function renderTypeTabs(width: number): string {
				const parts = TYPE_FILTERS.map((tf, i) => {
					const count = data.typeCounts[tf];
					const label = `${getTypeLabel(tf)}(${count})`;
					return typeFilterIndex === i ? theme.bg("selectedBg", ` ${label} `) : ` ${label} `;
				});
				return truncateToWidth(parts.join(" "), width);
			}

			function renderSearchRow(): string {
				if (searchFocused) {
					const inputLines = searchInput.render(60);
					return theme.fg("muted", " 🔍 ") + (inputLines[0] || "");
				} else if (searchQuery) {
					return theme.fg("muted", ` 🔍 ${searchQuery}`);
				} else {
					return theme.fg("dim", " 🔍 type to search... (/)");
				}
			}

			function renderPackageList(width: number): string[] {
				const lines: string[] = [];
				const slice = visibleItems.slice(scrollOffset, scrollOffset + VISIBLE_COUNT);

				for (let i = 0; i < slice.length; i++) {
					const m = slice[i];
					const globalIdx = scrollOffset + i;
					const isSelected = globalIdx === selectedIndex;
					const { repo, installed } = m;

					// Effective display values (fall back to installed data for local-only packages)
					const displayName = repo?.name ?? installed?.name ?? "unknown";
					const displayType = repo?.type ?? installed?.type ?? "extension";
					const displayVersion = repo?.version ?? installed?.version ?? "?";
					const displayDesc = repo?.description ?? (installed ? "Locally installed (not in repo)" : "");

					// Cursor
					const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";

					// Status icon
					let statusIcon = theme.fg("dim", "○");
					if (installed) {
						statusIcon = installed.updateAvailable ? theme.fg("warning", "↑") : theme.fg("success", "✓");
					}

					// Name
					const nameStr = isSelected ? theme.bold(displayName) : displayName;

					// Type badge
					const typeStr = theme.fg("dim", getTypeBadge(displayType));

					// Version
					let versionStr: string;
					if (installed && installed.updateAvailable && installed.updateVersion) {
						versionStr = theme.fg("warning", `${installed.version} → ${installed.updateVersion}`);
					} else if (installed) {
						versionStr = theme.fg("success", `v${displayVersion}`);
					} else {
						versionStr = theme.fg("muted", `v${displayVersion}`);
					}

					// Description (truncated via truncateToWidth on the full line)
					const line = `${cursor}${statusIcon} ${nameStr}  ${typeStr} ${versionStr}  ${theme.fg("dim", displayDesc)}`;
					lines.push(truncateToWidth(line, width, "…"));
				}

				return lines;
			}

			function renderDetailsOverlay(width: number): string[] {
				if (!detailPkg) return [];
				const lines: string[] = [];
				const { repo, installed } = detailPkg;

				// Effective display values (fall back to installed data for local-only packages)
				const detailName = repo?.name ?? installed?.name ?? "unknown";
				const detailType = repo?.type ?? installed?.type ?? "extension";
				const detailVersion = repo?.version ?? installed?.version ?? "?";
				const detailDesc = repo?.description ?? (installed ? "Locally installed (not in repo)" : "No description");
				const detailRepoName = repo?.repoName ?? "local";

				const w = Math.min(width - 2, 80);
				const isSkill = detailType === "skill";
				const skillFrontmatterData = isSkill ? readSkillFrontmatter(installed?.installedPath ?? "") : null;

				// Top border
				lines.push(theme.fg("border", "─".repeat(w)));

				// Header
				const typeBadge = `[${detailType}]`;
				lines.push(
					truncateToWidth(` ${theme.bold(detailName)} ${theme.fg("dim", `v${detailVersion}`)} ${typeBadge}`, w),
				);
				lines.push("");

				// Description
				lines.push(truncateToWidth(` ${detailDesc}`, w));
				lines.push("");

				// Info section
				lines.push(truncateToWidth(` ${theme.fg("accent", "── Info ──")}`, w));
				lines.push(truncateToWidth(`  Repo:     ${detailRepoName}`, w));
				if (repo?.updatedAt) {
					lines.push(truncateToWidth(`  Updated:  ${new Date(repo.updatedAt).toISOString().split("T")[0]}`, w));
				}
				if (installed) {
					lines.push(truncateToWidth(`  Path:     ${installed.installedPath}`, w));
					lines.push(truncateToWidth(`  Status:   ${theme.fg("success", "installed")} v${installed.version}`, w));
				} else {
					lines.push(truncateToWidth(`  Status:   ${theme.fg("muted", "not installed")}`, w));
				}

				// Skill-specific section
				lines.push("");
				if (isSkill && skillFrontmatterData) {
					lines.push(` ${theme.fg("accent", "── Skill ──")}`);
					if (skillFrontmatterData.description) {
						lines.push(truncateToWidth(`  Desc:     ${skillFrontmatterData.description}`, w));
					}
					const skip = new Set(["name", "description"]);
					for (const [k, v] of Object.entries(skillFrontmatterData)) {
						if (!skip.has(k) && typeof v !== "object") {
							lines.push(truncateToWidth(`  ${k}:       ${String(v)}`, w));
						}
					}
				}

				lines.push("");
				lines.push(theme.fg("border", "─".repeat(w)));

				// Actions footer
				const actions: string[] = [];
				if (!installed) actions.push("ENTER install");
				if (installed?.updateAvailable) actions.push("ENTER update");
				if (installed) actions.push("R remove");
				actions.push("ESC back");
				lines.push(truncateToWidth(theme.fg("dim", ` ${actions.join(" │ ")}`), w));

				return lines;
			}

			// ── Return component ──
			return {
				render: (width: number): string[] => {
					const lines: string[] = [];

					// ── Repo tabs ──
					lines.push(renderRepoTabs(width));

					// ── Type filter tabs ──
					lines.push(renderTypeTabs(width));

					// ── Search row ──
					lines.push(renderSearchRow());

					// ── Package count ──
					lines.push(theme.fg("dim", ` ${visibleItems.length} package${visibleItems.length !== 1 ? "s" : ""}`));
					lines.push("");

					// ── Package list ──
					const listLines = renderPackageList(width);
					lines.push(...listLines);

					// ── Scroll indicator ──
					if (visibleItems.length > VISIBLE_COUNT) {
						lines.push("");
						lines.push(
							truncateToWidth(
								theme.fg(
									"dim",
									`[${scrollOffset + 1}–${Math.min(scrollOffset + VISIBLE_COUNT, visibleItems.length)} of ${visibleItems.length}]`,
								),
								width,
							),
						);
					}

					// ── Details overlay ──
					if (showDetails && detailPkg) {
						lines.push("");
						const overlayLines = renderDetailsOverlay(width);
						lines.push(...overlayLines);
					}

					// ── Footer ──
					lines.push("");
					if (focusTarget === "search") {
						lines.push(truncateToWidth(theme.fg("dim", " ESC/↓ unfocus │ Type to fuzzy search"), width));
					} else if (showDetails) {
						lines.push(truncateToWidth(theme.fg("dim", " ENTER action │ R remove │ ESC back"), width));
					} else {
						lines.push(
							truncateToWidth(
								theme.fg(
									"dim",
									"↑↓ navigate │ ←→ repos │ TAB type filter │ / search │ ENTER action │ BSPC remove │ ESC exit",
								),
								width,
							),
						);
					}

					return lines;
				},

				invalidate: () => tui.requestRender(),

				handleInput: (input: string): void => {
					// ── Details overlay mode ──
					if (showDetails && detailPkg) {
						if (matchesKey(input, Key.escape)) {
							showDetails = false;
							detailPkg = null;
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.enter)) {
							const { repo, installed } = detailPkg;
							if (!installed && repo) {
								done({ type: "install", pkg: repo });
							} else if (installed?.updateAvailable && repo) {
								done({ type: "update", pkg: repo, installed });
							}
							return;
						}
						if (matchesKey(input, "r") && detailPkg.installed) {
							done({ type: "remove", pkg: detailPkg.repo, installed: detailPkg.installed });
							return;
						}
						return;
					}

					// ── Search mode ──
					if (searchFocused) {
						if (matchesKey(input, Key.escape)) {
							searchFocused = false;
							searchInput.focused = false;
							focusTarget = "list";
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.enter) || matchesKey(input, Key.down)) {
							searchFocused = false;
							searchInput.focused = false;
							focusTarget = "list";
							tui.requestRender();
							return;
						}
						searchInput.handleInput(input);
						const newQuery = searchInput.getValue();
						if (newQuery !== searchQuery) {
							searchQuery = newQuery;
							rebuildVisible();
						}
						return;
					}

					// ── List mode ──

					// ESC — exit
					if (matchesKey(input, Key.escape)) {
						done({ type: "exit" });
						return;
					}

					// "/" or Ctrl+F — focus search
					if (matchesKey(input, Key.slash) || matchesKey(input, Key.ctrl("f"))) {
						searchFocused = true;
						searchInput.focused = true;
						focusTarget = "search";
						tui.requestRender();
						return;
					}

					// TAB — cycle type filter forward
					if (matchesKey(input, Key.tab)) {
						typeFilterIndex = (typeFilterIndex + 1) % TYPE_FILTERS.length;
						rebuildVisible();
						tui.requestRender();
						return;
					}

					// Shift+TAB — cycle type filter backward
					if (matchesKey(input, Key.shift(Key.tab))) {
						typeFilterIndex = (typeFilterIndex - 1 + TYPE_FILTERS.length) % TYPE_FILTERS.length;
						rebuildVisible();
						tui.requestRender();
						return;
					}

					// ← — prev repo tab
					if (matchesKey(input, Key.left)) {
						if (selectedRepoIndex > 0) {
							selectedRepoIndex--;
							rebuildVisible();
						}
						tui.requestRender();
						return;
					}

					// → — next repo tab
					if (matchesKey(input, Key.right)) {
						if (selectedRepoIndex < REPO_TABS.length - 1) {
							selectedRepoIndex++;
							rebuildVisible();
						}
						tui.requestRender();
						return;
					}

					// ↑ — scroll up
					if (matchesKey(input, Key.up) || input === "k") {
						if (selectedIndex > 0) {
							selectedIndex--;
							if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
						}
						tui.requestRender();
						return;
					}

					// ↓ — scroll down
					if (matchesKey(input, Key.down) || input === "j") {
						if (selectedIndex < visibleItems.length - 1) {
							selectedIndex++;
							if (selectedIndex >= scrollOffset + VISIBLE_COUNT)
								scrollOffset = selectedIndex - VISIBLE_COUNT + 1;
						}
						tui.requestRender();
						return;
					}

					// ENTER — install, update, or show details
					if (matchesKey(input, Key.enter)) {
						const m = visibleItems[selectedIndex];
						if (!m) return;
						const { repo, installed } = m;
						if (!installed && repo) {
							done({ type: "install", pkg: repo });
						} else if (installed?.updateAvailable && repo) {
							done({ type: "update", pkg: repo, installed });
						} else {
							// Installed & up to date → show details overlay
							detailPkg = m;
							showDetails = true;
							tui.requestRender();
						}
						return;
					}

					// BACKSPACE — remove
					if (matchesKey(input, Key.backspace)) {
						const m = visibleItems[selectedIndex];
						if (!m) return;
						if (m.installed) {
							done({ type: "remove", pkg: m.repo, installed: m.installed });
						} else {
							ctx.ui.notify(`${m.repo?.name ?? "unknown"} is not installed`, "info");
						}
						return;
					}
				},
			};
		});

		// ── Handle action outside the UI ──
		if (action.type === "exit") return;

		if (action.type === "install") {
			const result = await withProgressOverlay(
				ctx,
				`Installing ${action.pkg.name}...`,
				async (signal, setMessage) => {
					await installer.installFromRepo(
						action.pkg,
						config.repositories,
						config.installScope,
						signal,
						(_stage, detail) => setMessage(detail ?? _stage),
					);
					return { success: true, message: `✅ Installed ${action.pkg.name} v${action.pkg.version}` };
				},
			);

			if (result.cancelled) continue;
			ctx.ui.notify(result.message, result.success ? "info" : "error");
			if (result.success) {
				data.installedPackages = db.getPackages();
				data.mergedPackages = buildMergedPackages(data.allPackages, data.installedPackages);
				data.typeCounts = computeTypeCounts(data.mergedPackages);
			}
		} else if (action.type === "update") {
			const result = await withProgressOverlay(ctx, `Updating ${action.pkg.name}...`, async (signal, setMessage) => {
				await installer.updateFromRepo(
					action.installed,
					action.pkg,
					config.repositories,
					signal,
					(_stage, detail) => setMessage(detail ?? _stage),
				);
				return {
					success: true,
					message: `✅ Updated ${action.pkg.name}: v${action.installed.version} → v${action.pkg.version}`,
				};
			});

			if (result.cancelled) continue;
			ctx.ui.notify(result.message, result.success ? "info" : "error");

			if (result.success) {
				const newUpdates = await repoClient.checkUpdates(
					data.installedPackages.filter((p) => p.source === "repo"),
					config.repositories,
				);
				data.updates = newUpdates;
				data.installedPackages = data.installedPackages.map((inst) => {
					if (inst.name === action.pkg.name) {
						const update = newUpdates.get(action.pkg.name);
						return {
							...inst,
							version: action.pkg.version,
							updateAvailable: !!update,
							updateVersion: update?.latest,
						};
					}
					return inst;
				});
				data.mergedPackages = buildMergedPackages(data.allPackages, data.installedPackages);
				data.typeCounts = computeTypeCounts(data.mergedPackages);
			}
		} else if (action.type === "remove") {
			const removeName = action.pkg?.name ?? action.installed.name;
			const confirmed = await ctx.ui.select(`Remove ${removeName}?`, ["Yes", "No"]);
			if (confirmed !== "Yes") continue;

			const result = await withProgressOverlay(ctx, `Removing ${removeName}...`, async (_signal, setMessage) => {
				await installer.uninstall(action.installed, (_stage, detail) => setMessage(detail ?? _stage));
				return { success: true, message: `✅ Removed ${removeName}` };
			});

			if (result.cancelled) continue;
			ctx.ui.notify(result.message, result.success ? "info" : "error");

			if (result.success) {
				data.installedPackages = data.installedPackages.filter((i) => i.name !== removeName);
				data.updates.delete(removeName);
				data.mergedPackages = buildMergedPackages(data.allPackages, data.installedPackages);
				data.typeCounts = computeTypeCounts(data.mergedPackages);
			}
		}

		// Loop continues — UI re-opens with fresh data
	}
}
