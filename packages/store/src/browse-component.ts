/**
 * FAN Store — Interactive package browser.
 *
 * Full-screen browser with repo tabs, install/update/remove actions,
 * and automatic re-open after each action.
 */

import type { ExtensionContext } from "@itone/fan-coding-agent";
import type { StoreDatabase } from "./storage.js";
import type { RepoClient } from "./repo-client.js";
import type { ArchiveInstaller } from "./installer.js";
import type { StoreConfig } from "./config.js";
import type { RepoPackage, InstalledPackage } from "./types.js";
import { getKeybindings } from "@itone/fan-tui";
import { ProgressOverlay } from "./progress-overlay.js";

// ─── Types ────────────────────────────────────

interface BrowserData {
	allPackages: RepoPackage[];
	installedPackages: InstalledPackage[];
	updates: Map<string, { current: string; latest: string }>;
}

type BrowserAction =
	| { type: "install"; pkg: RepoPackage }
	| { type: "update"; pkg: RepoPackage; installed: InstalledPackage }
	| { type: "remove"; pkg: RepoPackage; installed: InstalledPackage }
	| { type: "exit" };

interface OperationResult {
	success: boolean;
	message: string;
	cancelled?: true;
}

const CANCELLED: OperationResult = { success: false, message: "", cancelled: true };

// ─── Helpers ──────────────────────────────────

function getTypeBadge(type: string): string {
	switch (type) {
		case "extension": return "[ext]";
		case "skill": return "[skill]";
		case "theme": return "[theme]";
		case "bundle": return "[bundle]";
		default: return `[${type}]`;
	}
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
	const data = await ctx.ui.custom<BrowserData | null>((tui, themeInstance, _kb, done) => {
		const overlay = new ProgressOverlay(tui, themeInstance, "Loading packages...", () => done(null));

		(async () => {
			try {
				const installedPackages = db.getPackages();
				const repoInstalled = installedPackages.filter((p) => p.source === "repo");

				const [updatesMap] = await Promise.all([
					repoClient.checkUpdates(repoInstalled, config.repositories),
				]);

				// Fetch packages per-repo to tag each with repoName
				const allPackages: RepoPackage[] = [];
				const seen = new Set<string>();
				for (const repo of enabledRepos) {
					try {
						const index = await repoClient.fetchIndex(repo.url);
						for (const pkg of index.packages) {
							if (seen.has(pkg.name)) continue;
							seen.add(pkg.name);
							allPackages.push({ ...pkg, repoName: repo.name, repoUrl: repo.url });
						}
					} catch {
						// skip unreachable repos
					}
				}
				allPackages.sort((a, b) => a.name.localeCompare(b.name));

				// Enrich installed packages with update status
				for (const installed of installedPackages) {
					const update = updatesMap.get(installed.name);
					if (installed.source === "repo" && update) {
						installed.updateAvailable = true;
						installed.updateVersion = update.latest;
					}
				}

				done({ allPackages, installedPackages, updates: updatesMap });
			} catch (err) {
				ctx.ui.notify(
					`Failed to load packages: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				done(null);
			}
		})();

		return overlay;
	});

	if (!data) return;

	// ── Phase 2: Interactive browser loop ──
	const REPO_TABS = ["All", ...enabledRepos.map((r) => r.name)];
	const kb = getKeybindings();

	const getFilteredPackages = (repoIndex: number): RepoPackage[] => {
		if (repoIndex === 0) return data.allPackages;
		return data.allPackages.filter((p) => p.repoName === REPO_TABS[repoIndex]);
	};

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const action = await ctx.ui.custom<BrowserAction>((tui, theme, _kb, done) => {
			let selectedRepoIndex = 0;
			let selectedPackageIndex = 0;
			let scrollOffset = 0;
			let packagesForDisplay = getFilteredPackages(0);
			const visibleCount = 12;

			return {
				render: (width: number): string[] => {
					const lines: string[] = [];

					// ── Repo tabs ──
					const tabParts = REPO_TABS.map((repo, i) => {
						const active = i === selectedRepoIndex;
						const label = ` ${repo} `;
						return active ? `►${label}◄` : label;
					});
					lines.push(tabParts.join(theme.fg("dim", " │ ")));

					// ── Package count ──
					lines.push(
						theme.fg("dim", `${packagesForDisplay.length} package${packagesForDisplay.length !== 1 ? "s" : ""}`),
					);
					lines.push("");

					// ── Package list ──
					const slice = packagesForDisplay.slice(scrollOffset, scrollOffset + visibleCount);
					for (let i = 0; i < slice.length; i++) {
						const pkg = slice[i];
						const globalIdx = scrollOffset + i;
						const isSelected = globalIdx === selectedPackageIndex;

						const installed = data.installedPackages.find((inst) => inst.name === pkg.name);

						// Cursor
						const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";

						// Status icon
						let statusIcon = theme.fg("dim", "○");
						if (installed) {
							statusIcon = installed.updateAvailable
								? theme.fg("warning", "↑")
								: theme.fg("success", "✓");
						}

						// Name
						const nameStr = isSelected ? theme.bold(pkg.name) : pkg.name;

						// Type badge
						const typeStr = theme.fg("dim", getTypeBadge(pkg.type));

						// Version
						let versionStr: string;
						if (installed && installed.updateAvailable && installed.updateVersion) {
							versionStr = theme.fg("warning", `${installed.version} → ${installed.updateVersion}`);
						} else if (installed) {
							versionStr = theme.fg("success", `v${pkg.version}`);
						} else {
							versionStr = theme.fg("muted", `v${pkg.version}`);
						}

						// Description (truncated)
						const descMaxLen = Math.max(10, width - 4 - 2 - pkg.name.length - 2 - 7 - 2 - versionStr.length - 2);
						const desc = pkg.description;
						const truncated = desc.length > descMaxLen ? desc.slice(0, descMaxLen - 1) + "…" : desc;

						lines.push(`${cursor}${statusIcon} ${nameStr}  ${typeStr} ${versionStr}  ${theme.fg("dim", truncated)}`);
					}

					// ── Scroll indicator ──
					if (packagesForDisplay.length > visibleCount) {
						lines.push("");
						lines.push(
							theme.fg(
								"dim",
								`[${scrollOffset + 1}–${Math.min(scrollOffset + visibleCount, packagesForDisplay.length)} of ${packagesForDisplay.length}]`,
							),
						);
					}

					// ── Footer ──
					lines.push("");
					lines.push(
						theme.fg(
							"dim",
							"↑↓ navigate │ ←→ repos │ ENTER install/update │ BACKSPACE remove │ ESC exit",
						),
					);

					return lines;
				},

				invalidate: () => tui.requestRender(),

				handleInput: (input: string): void => {
					const pkg = packagesForDisplay[selectedPackageIndex];

					// ESC — exit
					if (kb.matches(input, "tui.select.cancel")) {
						done({ type: "exit" });
						return;
					}

					// ← — prev repo tab
					if (input === "\u001b[D") {
						if (selectedRepoIndex > 0) {
							selectedRepoIndex--;
							selectedPackageIndex = 0;
							scrollOffset = 0;
							packagesForDisplay = getFilteredPackages(selectedRepoIndex);
						}
						tui.requestRender();
						return;
					}

					// → — next repo tab
					if (input === "\u001b[C") {
						if (selectedRepoIndex < REPO_TABS.length - 1) {
							selectedRepoIndex++;
							selectedPackageIndex = 0;
							scrollOffset = 0;
							packagesForDisplay = getFilteredPackages(selectedRepoIndex);
						}
						tui.requestRender();
						return;
					}

					if (!pkg) return;

					const installed = data.installedPackages.find((i) => i.name === pkg.name);

					// ↑ — scroll up
					if (kb.matches(input, "tui.select.up") || input === "k") {
						if (selectedPackageIndex > 0) {
							selectedPackageIndex--;
							if (selectedPackageIndex < scrollOffset) scrollOffset = selectedPackageIndex;
						}
						tui.requestRender();
					// ↓ — scroll down
					} else if (kb.matches(input, "tui.select.down") || input === "j") {
						if (selectedPackageIndex < packagesForDisplay.length - 1) {
							selectedPackageIndex++;
							if (selectedPackageIndex >= scrollOffset + visibleCount)
								scrollOffset = selectedPackageIndex - visibleCount + 1;
						}
						tui.requestRender();
					// ENTER — install or update
					} else if (kb.matches(input, "tui.select.confirm") || input === "\n") {
						if (installed && installed.updateAvailable) {
							done({ type: "update", pkg, installed });
						} else if (!installed) {
							done({ type: "install", pkg });
						} else {
							ctx.ui.notify(`${pkg.name} is already up to date`, "info");
						}
					// BACKSPACE — remove
					} else if (input === "\u007f" || input === "\b") {
						if (installed) {
							done({ type: "remove", pkg, installed });
						} else {
							ctx.ui.notify(`${pkg.name} is not installed`, "info");
						}
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
			}

		} else if (action.type === "update") {
			const result = await withProgressOverlay(
				ctx,
				`Updating ${action.pkg.name}...`,
				async (signal, setMessage) => {
					await installer.updateFromRepo(
						action.installed,
						action.pkg,
						config.repositories,
						signal,
						(_stage, detail) => setMessage(detail ?? _stage),
					);
					return { success: true, message: `✅ Updated ${action.pkg.name}: v${action.installed.version} → v${action.pkg.version}` };
				},
			);

			if (result.cancelled) continue;
			ctx.ui.notify(result.message, result.success ? "info" : "error");

			if (result.success) {
				// Refresh update status for the updated package
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
			}

		} else if (action.type === "remove") {
			const confirmed = await ctx.ui.select(`Remove ${action.pkg.name}?`, ["Yes", "No"]);
			if (confirmed !== "Yes") continue;

			const result = await withProgressOverlay(
				ctx,
				`Removing ${action.pkg.name}...`,
				async (_signal, setMessage) => {
					await installer.uninstall(action.installed, (_stage, detail) => setMessage(detail ?? _stage));
					return { success: true, message: `✅ Removed ${action.pkg.name}` };
				},
			);

			if (result.cancelled) continue;
			ctx.ui.notify(result.message, result.success ? "info" : "error");

			if (result.success) {
				data.installedPackages = data.installedPackages.filter((i) => i.name !== action.pkg.name);
				data.updates.delete(action.pkg.name);
			}
		}

		// Loop continues — UI re-opens with fresh data
	}
}
