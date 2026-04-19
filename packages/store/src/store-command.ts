/**
 * FAN Store — /store slash command registration.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@itone/fan-coding-agent";
import type { StoreDatabase } from "./storage.js";
import type { RepoClient } from "./repo-client.js";
import type { ArchiveInstaller } from "./installer.js";
import type { StoreConfig } from "./config.js";
import type { RepoEntry } from "./types.js";
import { saveConfig } from "./config.js";
import { StoreBrowseComponent, type BrowseResult } from "./browse-component.js";

// ──────────────────────────────────────────────
// /store command
// ──────────────────────────────────────────────

type Ctx = ExtensionCommandContext;

export function registerStoreCommand(
	pi: ExtensionAPI,
	getDB: () => StoreDatabase,
	getRepoClient: () => RepoClient,
	getInstaller: () => ArchiveInstaller,
	getConfig: () => StoreConfig,
): void {
	pi.registerCommand("store", {
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
  update [name]         Check updates or update specific package
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

		const filtered = typeFilter
			? packages.filter((p) => p.type === typeFilter)
			: packages;

		if (filtered.length === 0) {
			ctx.ui.notify("No packages installed via FAN Store.", "info");
			return;
		}

		const lines = filtered.map((p) => {
			const updateBadge = p.updateAvailable ? ` → v${p.updateVersion} available!` : "";
			const sourceBadge =
				p.source === "repo" && p.repoName ? `[${p.repoName}]` : `[${p.source}]`;
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
			ctx.ui.notify(
				"No repositories configured. Add one with /store repos add <name> <url>",
				"error",
			);
			return;
		}

		try {
			const results = await getRepoClient().searchPackages(query, config.repositories);
			if (results.length === 0) {
				ctx.ui.notify(`No packages found matching "${query}"`, "info");
				return;
			}

			const lines = results.map(
				(p) =>
					`• ${p.name} v${p.version} [${p.type}] — ${p.description}${p.author ? ` (by ${p.author})` : ""}`,
			);
			ctx.ui.notify(`Found ${results.length} package(s):\n${lines.join("\n")}`, "info");
		} catch (err) {
			ctx.ui.notify(
				`Search failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
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

		try {
			const isFilePath =
				source.includes("/") ||
				source.includes("\\") ||
				source.endsWith(".tar.gz") ||
				source.endsWith(".tgz") ||
				source.endsWith(".zip");

			let installed;
			if (isFilePath) {
				installed = await getInstaller().installFromArchive(source, scope);
			} else {
				if (config.repositories.length === 0) {
					ctx.ui.notify(
						"No repositories configured. Add one with /store repos add <name> <url>",
						"error",
					);
					return;
				}
				const pkg = await getRepoClient().getPackage(source, config.repositories);
				if (!pkg) {
					ctx.ui.notify(
						`Package "${source}" not found in any configured repository.`,
						"error",
					);
					return;
				}
				installed = await getInstaller().installFromRepo(pkg, config.repositories, scope);
			}

			ctx.ui.notify(
				`✅ Installed ${installed.name} (${installed.type}) v${installed.version}\nPath: ${installed.installedPath}`,
				"info",
			);

			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to activate the new package.", "info");
			}
		} catch (err) {
			ctx.ui.notify(
				`Install failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
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

		try {
			await getInstaller().uninstall(pkg);
			ctx.ui.notify(`✅ Removed ${name} (${pkg.type}) v${pkg.version}`, "info");

			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to apply changes.", "info");
			}
		} catch (err) {
			ctx.ui.notify(
				`Remove failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
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

			try {
				const repoPkg = await getRepoClient().getPackage(name, config.repositories);
				if (!repoPkg) {
					ctx.ui.notify(`Package "${name}" not found in any repository.`, "error");
					return;
				}
				if (repoPkg.version === pkg.version) {
					ctx.ui.notify(`✅ ${name} is already up to date (v${pkg.version}).`, "info");
					return;
				}

				await getInstaller().uninstall(pkg);
				const updated = await getInstaller().installFromRepo(
					repoPkg,
					config.repositories,
					pkg.scope ?? "user",
				);
				ctx.ui.notify(`✅ Updated ${name}: v${pkg.version} → v${updated.version}`, "info");

				try {
					await ctx.reload();
				} catch {
					ctx.ui.notify("Run /reload to activate the update.", "info");
				}
			} catch (err) {
				ctx.ui.notify(
					`Update failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
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
				ctx.ui.notify(
					`Update check failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
	}

	// ─── store browse ──────────────────────────

	async function showBrowse(ctx: Ctx, _subArgs: string[]): Promise<void> {
		const config = getConfig();
		const enabledRepos = config.repositories.filter((r) => r.enabled);

		if (enabledRepos.length === 0) {
			ctx.ui.notify(
				"No repositories configured. Add one with /store repos add <name> <url>",
				"error",
			);
			return;
		}

		// Step 1: Select repository (skip if only one)
		let selectedRepo: RepoEntry;
		if (enabledRepos.length === 1) {
			selectedRepo = enabledRepos[0];
		} else {
			const repoOptions = enabledRepos.map((r) => `${r.name} — ${r.url}`);
			const chosen = await ctx.ui.select(
				"📦 Select repository",
				repoOptions,
			);
			if (!chosen) return; // cancelled
			const idx = repoOptions.indexOf(chosen);
			if (idx === -1) return;
			selectedRepo = enabledRepos[idx];
		}

		// Step 2: Fetch packages from repository
		ctx.ui.setWorkingMessage("Fetching packages...");
		let repoIndex;
		try {
			repoIndex = await getRepoClient().fetchIndex(selectedRepo.url);
		} catch (err) {
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.notify(
				`Failed to fetch from "${selectedRepo.name}": ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}
		ctx.ui.setWorkingMessage(undefined);

		if (repoIndex.packages.length === 0) {
			ctx.ui.notify(`Repository "${selectedRepo.name}" has no packages.`, "info");
			return;
		}

		// Step 3: Show interactive browser
		const db = getDB();
		const installed = db.getPackages();

		const result = await ctx.ui.custom<BrowseResult>(
			(tui, themeInstance, keybindings, done) => {
				return new StoreBrowseComponent(
					repoIndex.packages,
					installed,
					selectedRepo.name,
					tui,
					themeInstance,
					keybindings,
					done,
				);
			},
		);

		// Step 4: Handle result
		if (!result || result.action === "cancel" || !result.packageName) {
			return;
		}

		const pkgName = result.packageName;
		const scope = config.installScope;

		try {
			ctx.ui.setWorkingMessage(`Installing ${pkgName}...`);
			const pkg = await getRepoClient().getPackage(pkgName, config.repositories);
			if (!pkg) {
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.notify(`Package "${pkgName}" not found in repository.`, "error");
				return;
			}

			const installedPkg = await getInstaller().installFromRepo(pkg, config.repositories, scope);
			ctx.ui.setWorkingMessage(undefined);

			ctx.ui.notify(
				`✅ Installed ${installedPkg.name} (${installedPkg.type}) v${installedPkg.version}\nPath: ${installedPkg.installedPath}`,
				"info",
			);

			try {
				await ctx.reload();
			} catch {
				ctx.ui.notify("Run /reload to activate the new package.", "info");
			}
		} catch (err) {
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.notify(
				`Install failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
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
			ctx.ui.notify(
				"No repositories configured.\n\nAdd one: /store repos add <name> <url>",
				"info",
			);
			return;
		}

		const lines = config.repositories.map(
			(r) =>
				`• ${r.name} — ${r.url} [${r.enabled ? "enabled" : "disabled"}] (priority ${r.priority})`,
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
			ctx.ui.notify(
				`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
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
			ctx.ui.notify(
				`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}
}
