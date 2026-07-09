/**
 * FAN Store — /store slash command registration.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-agent-core";
import { showExtensionBrowser } from "./browse-component.js";
import type { StoreConfig } from "./config.js";
import { saveConfig } from "./config.js";
import type { ArchiveInstaller } from "./installer.js";
import { ProgressOverlay } from "./progress-overlay.js";
import type { RepoClient } from "./repo-client.js";
import type { StoreDatabase } from "./storage.js";
import type { InstalledPackage } from "./types.js";

// ──────────────────────────────────────────────
// /store command
// ──────────────────────────────────────────────

type Ctx = ExtensionCommandContext;

const CANCELLED: OperationResult = { success: false, message: "", cancelled: true };

interface OperationResult {
	success: boolean;
	message: string;
	cancelled?: true;
}

export function registerStoreCommand(
	fan: ExtensionAPI,
	getDB: () => StoreDatabase,
	getRepoClient: () => RepoClient,
	getInstaller: () => ArchiveInstaller,
	getConfig: () => StoreConfig,
): void {
	fan.registerCommand("store", {
		description: "Package manager — search, install, update, remove extensions/skills/themes",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "help";
			const subArgs = parts.slice(1);

			switch (sub) {
				case "help":
				case "":
					return showHelp(ctx);
				case "list":
					return showList(ctx, subArgs);
				case "search":
					return showSearch(ctx, subArgs);
				case "install":
					return showInstall(ctx, subArgs);
				case "remove":
					return showRemove(ctx, subArgs);
				case "update":
					return showUpdate(ctx, subArgs);
				case "self":
					return showSelf(ctx);
				case "browse":
					return showBrowse(ctx, subArgs);
				case "repos":
					return showRepos(ctx, subArgs);
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}. Type /store for help.`, "error");
			}
		},
	});

	// ─── store help ───────────────────────────

	function showHelp(ctx: Ctx): void {
		ctx.ui.notify(
			`📦 FAN Store — Package Manager

Usage: /store <command>

Commands:
  list [type]           List installed packages
  browse                Browse & install packages interactively
  search <query>        Search available packages in repos
  install <source>      Install from repo or archive file
  remove <name>         Uninstall a package
  update [name|all]     Check updates or update package(s)
  self                  Show fan-store version & self-update
  repos                 List configured repositories
  repos add <name> <url>  Add a repository
  repos remove <name>     Remove a repository`,
			"info",
		);
	}

	// ─── store list [type] ────────────────────

	function showList(ctx: Ctx, subArgs: string[]): void {
		const db = getDB();
		const packages = db.getPackages();
		const typeFilter = subArgs[0];

		const filtered = typeFilter ? packages.filter((p) => p.type === typeFilter) : packages;

		if (filtered.length === 0) {
			ctx.ui.notify("No packages installed via FAN Store.", "info");
			return;
		}

		const lines = filtered.map((p) => {
			const updateBadge = p.updateAvailable ? ` → v${p.updateVersion} available!` : "";
			const sourceBadge = p.source === "repo" && p.repoName ? `[${p.repoName}]` : `[${p.source}]`;
			return `• ${p.name} v${p.version} [${p.type}] ${sourceBadge}${updateBadge}`;
		});

		ctx.ui.notify(`${filtered.length} package(s) installed:\n${lines.join("\n")}`, "info");
	}

	// ─── store search <query> ─────────────────

	async function showSearch(ctx: Ctx, subArgs: string[]): Promise<void> {
		const query = subArgs.join(" ");
		if (!query) {
			ctx.ui.notify("Usage: /store search <query>", "info");
			return;
		}

		const config = getConfig();
		if (config.repositories.length === 0) {
			ctx.ui.notify("No repositories configured. Add one with /store repos add <name> <url>", "error");
			return;
		}

		try {
			const results = await getRepoClient().searchPackages(query, config.repositories);
			if (results.length === 0) {
				ctx.ui.notify(`No packages found matching "${query}"`, "info");
				return;
			}

			const lines = results.map(
				(p) => `• ${p.name} v${p.version} [${p.type}] — ${p.description}${p.author ? ` (by ${p.author})` : ""}`,
			);
			ctx.ui.notify(`Found ${results.length} package(s):\n${lines.join("\n")}`, "info");
		} catch (err) {
			ctx.ui.notify(`Search failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	// ─── store install <source> ───────────────

	async function showInstall(ctx: Ctx, subArgs: string[]): Promise<void> {
		const source = subArgs[0];
		if (!source) {
			ctx.ui.notify("Usage: /store install <package-name-or-archive-path>", "info");
			return;
		}

		const config = getConfig();
		const scope = config.installScope;

		const isFilePath =
			source.includes("/") ||
			source.includes("\\") ||
			source.endsWith(".tar.gz") ||
			source.endsWith(".tgz") ||
			source.endsWith(".zip");

		const result = await ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
			const overlay = new ProgressOverlay(
				tui,
				themeInstance,
				isFilePath ? `Installing ${source}...` : `Installing ${source}...`,
				() => done(CANCELLED),
			);

			(async () => {
				try {
					const onProgress = (stage: string, detail?: string) => {
						overlay.setMessage(detail ?? stage);
					};

					let installed: InstalledPackage | undefined;
					if (isFilePath) {
						installed = await getInstaller().installFromArchive(source, scope, undefined, onProgress);
					} else {
						if (config.repositories.length === 0) {
							done({
								success: false,
								message: "No repositories configured. Add one with /store repos add <name> <url>",
							});
							return;
						}
						const pkg = await getRepoClient().getPackage(source, config.repositories);
						if (!pkg) {
							done({ success: false, message: `Package "${source}" not found in any configured repository.` });
							return;
						}
						installed = await getInstaller().installFromRepo(
							pkg,
							config.repositories,
							scope,
							overlay.signal,
							onProgress,
						);
					}

					done({
						success: true,
						message: `✅ Installed ${installed.name} (${installed.type}) v${installed.version}\nPath: ${installed.installedPath}`,
					});
				} catch (err) {
					if (overlay.signal.aborted) {
						done(CANCELLED); // cancelled
					} else {
						done({
							success: false,
							message: `❌ Install failed: ${err instanceof Error ? err.message : String(err)}`,
						});
					}
				}
			})();

			return overlay;
		});

		if (result.cancelled) {
			// cancelled
			return;
		}

		if (result.success) {
			ctx.ui.notify(result.message, "info");
			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to activate the new package.", "info");
			}
		} else {
			ctx.ui.notify(result.message, "error");
		}
	}

	// ─── store remove <name> ──────────────────

	async function showRemove(ctx: Ctx, subArgs: string[]): Promise<void> {
		const name = subArgs[0];
		if (!name) {
			ctx.ui.notify("Usage: /store remove <package-name>", "info");
			return;
		}

		const db = getDB();
		const pkg = db.getPackage(name);
		if (!pkg) {
			ctx.ui.notify(`Package "${name}" is not managed by FAN Store.`, "error");
			return;
		}

		const result = await ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
			const overlay = new ProgressOverlay(tui, themeInstance, `Removing ${name}...`, () => done(CANCELLED));

			(async () => {
				try {
					const onProgress = (_stage: string, detail?: string) => {
						overlay.setMessage(detail ?? _stage);
					};

					await getInstaller().uninstall(pkg, onProgress);
					done({ success: true, message: `✅ Removed ${name} (${pkg.type}) v${pkg.version}` });
				} catch (err) {
					if (overlay.signal.aborted) {
						done(CANCELLED);
					} else {
						done({
							success: false,
							message: `❌ Remove failed: ${err instanceof Error ? err.message : String(err)}`,
						});
					}
				}
			})();

			return overlay;
		});

		if (result.cancelled) {
			return;
		}

		if (result.success) {
			ctx.ui.notify(result.message, "info");
			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to apply changes.", "info");
			}
		} else {
			ctx.ui.notify(result.message, "error");
		}
	}

	// ─── store update [name] ──────────────────

	async function showUpdate(ctx: Ctx, subArgs: string[]): Promise<void> {
		const db = getDB();
		const config = getConfig();

		if (config.repositories.length === 0) {
			ctx.ui.notify("No repositories configured.", "error");
			return;
		}

		const name = subArgs[0];

		if (name === "all") {
			return showUpdateAll(ctx);
		}

		if (name) {
			const pkg = db.getPackage(name);
			if (!pkg) {
				ctx.ui.notify(`Package "${name}" not found.`, "error");
				return;
			}
			if (pkg.source !== "repo") {
				ctx.ui.notify(
					`Package "${name}" was installed from ${pkg.source}, not a repository. Cannot auto-update.`,
					"error",
				);
				return;
			}

			const result = await ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
				const overlay = new ProgressOverlay(tui, themeInstance, `Updating ${name}...`, () => done(CANCELLED));

				(async () => {
					try {
						const onProgress = (_stage: string, detail?: string) => {
							overlay.setMessage(detail ?? _stage);
						};

						const repoPkg = await getRepoClient().getPackage(name, config.repositories);
						if (!repoPkg) {
							done({ success: false, message: `Package "${name}" not found in any repository.` });
							return;
						}
						if (repoPkg.version === pkg.version) {
							done({ success: true, message: `✅ ${name} is already up to date (v${pkg.version}).` });
							return;
						}

						const updated = await getInstaller().updateFromRepo(
							pkg,
							repoPkg,
							config.repositories,
							overlay.signal,
							onProgress,
						);
						done({ success: true, message: `✅ Updated ${name}: v${pkg.version} → v${updated.version}` });
					} catch (err) {
						if (overlay.signal.aborted) {
							done(CANCELLED);
						} else {
							done({
								success: false,
								message: `❌ Update failed: ${err instanceof Error ? err.message : String(err)}`,
							});
						}
					}
				})();

				return overlay;
			});

			if (result.cancelled) {
				return;
			}

			if (result.success) {
				ctx.ui.notify(result.message, "info");
				try {
					await ctx.reload();
				} catch {
					ctx.ui.notify("Run /reload to activate the update.", "info");
				}
			} else {
				ctx.ui.notify(result.message, "error");
			}
		} else {
			try {
				const updates = await getRepoClient().checkUpdates(db.getPackages(), config.repositories);
				db.setLastUpdateCheck(Date.now());

				if (updates.size === 0) {
					ctx.ui.notify("✅ All packages are up to date.", "info");
					return;
				}

				const lines: string[] = [];
				for (const [pkgName, info] of updates) {
					lines.push(`• ${pkgName}: v${info.current} → v${info.latest}`);
					db.updatePackage(pkgName, { updateAvailable: true, updateVersion: info.latest });
				}

				ctx.ui.notify(
					`📦 ${updates.size} update(s) available:\n${lines.join("\n")}\n\nUse /store update <name> to apply.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Update check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	}

	// ─── store self ──────────────────────────

	async function showSelf(ctx: Ctx): Promise<void> {
		const db = getDB();
		const config = getConfig();
		const EXTENSION_DIR = join(homedir(), ".fan", "agent", "extensions", "fan-store");

		// Read current version from package.json
		let currentVersion = "unknown";
		try {
			const pkgJson = JSON.parse(await readFile(join(EXTENSION_DIR, "package.json"), "utf-8")) as {
				version?: string;
			};
			if (pkgJson.version) currentVersion = pkgJson.version;
		} catch {
			/* not found */
		}

		// Check for update in repos
		let updateAvailable = false;
		let latestVersion: string | undefined;
		if (config.repositories.length > 0) {
			try {
				const selfPkg = await getRepoClient().getPackage("fan-store", config.repositories);
				if (selfPkg && selfPkg.version !== currentVersion) {
					updateAvailable = true;
					latestVersion = selfPkg.version;
				}
			} catch {
				/* repos unreachable */
			}
		}

		if (updateAvailable && latestVersion) {
			const choice = await ctx.ui.select(`📦 FAN Store v${currentVersion} — Update available: v${latestVersion}`, [
				"Update now",
				"Cancel",
			]);
			if (choice === "Update now") {
				const selfPkg = await getRepoClient().getPackage("fan-store", config.repositories);
				if (!selfPkg) {
					ctx.ui.notify("Package fan-store not found in repositories.", "error");
					return;
				}

				const result = await ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
					const overlay = new ProgressOverlay(
						tui,
						themeInstance,
						`Updating fan-store to v${latestVersion}...`,
						() => done(CANCELLED),
					);

					(async () => {
						try {
							const onProgress = (_stage: string, detail?: string) => {
								overlay.setMessage(detail ?? _stage);
							};

							// Ensure fan-store is tracked in DB
							let existing = db.getPackage("fan-store");
							if (!existing) {
								db.savePackage({
									name: "fan-store",
									version: currentVersion,
									type: "extension",
									source: "local",
									installedAt: Date.now(),
									installedPath: EXTENSION_DIR,
									scope: "user",
								});
								existing = db.getPackage("fan-store");
							}
							if (!existing) throw new Error("Failed to create fan-store DB entry");

							await getInstaller().stageUpdate(selfPkg, EXTENSION_DIR, overlay.signal, onProgress);
							done({
								success: true,
								message: `📦 fan-store v${latestVersion} staged. Update will apply on next session start.`,
							});
						} catch (err) {
							if (overlay.signal.aborted) {
								done(CANCELLED);
							} else {
								done({
									success: false,
									message: `❌ Self-update failed: ${err instanceof Error ? err.message : String(err)}`,
								});
							}
						}
					})();

					return overlay;
				});

				if (result.cancelled) return;
				if (result.success) {
					ctx.ui.notify(result.message, "info");
				} else {
					ctx.ui.notify(result.message, "error");
				}
			}
		} else {
			ctx.ui.notify(`📦 FAN Store v${currentVersion} — Up to date`, "info");
		}
	}

	// ─── store update all ────────────────────

	async function showUpdateAll(ctx: Ctx): Promise<void> {
		const db = getDB();
		const config = getConfig();

		if (config.repositories.length === 0) {
			ctx.ui.notify("No repositories configured.", "error");
			return;
		}

		const packages = db.getPackages();
		const updatable = packages.filter((p) => p.source === "repo" && p.updateAvailable);

		if (updatable.length === 0) {
			ctx.ui.notify("✅ All packages are up to date.", "info");
			return;
		}

		const confirm = await ctx.ui.select(`Update ${updatable.length} package(s)?`, ["Yes, update all", "Cancel"]);
		if (confirm !== "Yes, update all") return;

		const result = await ctx.ui.custom<OperationResult>((tui, themeInstance, _keybindings, done) => {
			const overlay = new ProgressOverlay(tui, themeInstance, `Updating 0/${updatable.length} packages...`, () =>
				done(CANCELLED),
			);

			(async () => {
				try {
					let successCount = 0;
					let failCount = 0;
					const errors: string[] = [];

					for (const pkg of updatable) {
						if (overlay.signal.aborted) {
							done(CANCELLED);
							return;
						}

						overlay.setMessage(`Updating ${pkg.name} (${successCount + failCount + 1}/${updatable.length})...`);

						try {
							const repoPkg = await getRepoClient().getPackage(pkg.name, config.repositories);
							if (!repoPkg) {
								errors.push(`${pkg.name}: not found in repos`);
								failCount++;
								continue;
							}
							await getInstaller().updateFromRepo(pkg, repoPkg, config.repositories, overlay.signal);
							successCount++;
						} catch (err) {
							errors.push(`${pkg.name}: ${err instanceof Error ? err.message : String(err)}`);
							failCount++;
						}
					}

					let msg = `📦 Updated ${successCount} package(s).`;
					if (failCount > 0) {
						msg += ` ${failCount} failed:\n${errors.join("\n")}`;
					}

					done({ success: failCount === 0, message: msg });
				} catch (err) {
					if (overlay.signal.aborted) {
						done(CANCELLED);
					} else {
						done({
							success: false,
							message: `❌ Batch update failed: ${err instanceof Error ? err.message : String(err)}`,
						});
					}
				}
			})();

			return overlay;
		});

		if (result.cancelled) return;
		ctx.ui.notify(result.message, result.success ? "info" : "error");

		if (result.success) {
			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to activate updates.", "info");
			}
		}
	}

	// ─── store browse ──────────────────────────

	async function showBrowse(ctx: Ctx, _subArgs: string[]): Promise<void> {
		await showExtensionBrowser(ctx, getDB(), getRepoClient(), getInstaller(), getConfig());
	}

	// ─── store repos ──────────────────────────

	function showRepos(ctx: Ctx, subArgs: string[]): void {
		const reposSub = subArgs[0];

		if (reposSub === "add") {
			handleReposAdd(ctx, subArgs.slice(1));
		} else if (reposSub === "remove") {
			handleReposRemove(ctx, subArgs.slice(1));
		} else {
			handleReposList(ctx);
		}
	}

	function handleReposList(ctx: Ctx): void {
		const config = getConfig();

		if (config.repositories.length === 0) {
			ctx.ui.notify("No repositories configured.\n\nAdd one: /store repos add <name> <url>", "info");
			return;
		}

		const lines = config.repositories.map(
			(r) => `• ${r.name} — ${r.url} [${r.enabled ? "enabled" : "disabled"}] (priority ${r.priority})`,
		);

		ctx.ui.notify(`Configured repositories:\n${lines.join("\n")}`, "info");
	}

	function handleReposAdd(ctx: Ctx, subArgs: string[]): void {
		const name = subArgs[0];
		const url = subArgs[1];

		if (!name || !url) {
			ctx.ui.notify("Usage: /store repos add <name> <url>", "info");
			return;
		}

		const config = getConfig();

		if (config.repositories.some((r) => r.name === name)) {
			ctx.ui.notify(`Repository "${name}" already exists.`, "error");
			return;
		}

		config.repositories.push({
			name,
			url,
			enabled: true,
			priority: config.repositories.length,
		});

		try {
			saveConfig(config);
			ctx.ui.notify(`✅ Added repository "${name}" (${url})`, "info");
		} catch (err) {
			ctx.ui.notify(`Failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	function handleReposRemove(ctx: Ctx, subArgs: string[]): void {
		const name = subArgs[0];
		if (!name) {
			ctx.ui.notify("Usage: /store repos remove <name>", "info");
			return;
		}

		const config = getConfig();
		const index = config.repositories.findIndex((r) => r.name === name);

		if (index === -1) {
			ctx.ui.notify(`Repository "${name}" not found.`, "error");
			return;
		}

		config.repositories.splice(index, 1);

		try {
			saveConfig(config);
			ctx.ui.notify(`✅ Removed repository "${name}"`, "info");
		} catch (err) {
			ctx.ui.notify(`Failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}
}
