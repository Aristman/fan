/**
 * FAN Store — Main extension factory.
 *
 * Package manager extension for FAN — install extensions, skills, themes
 * from archives or custom repositories.
 *
 * Tools: store_search, store_install, store_remove, store_update, store_list
 * Commands: /store
 *
 * Config: ~/.fan/agent/store.json
 * Database: ~/.fan/agent/store-packages.json
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@seaagents/fan-coding-agent";
import { showExtensionBrowser } from "./browse-component.js";
import { loadConfig } from "./config.js";
import { ArchiveInstaller } from "./installer.js";
import { RepoClient } from "./repo-client.js";
import { StoreDatabase } from "./storage.js";
import { registerStoreCommand } from "./store-command.js";
import { registerStoreTools } from "./store-tools.js";

export const storeExtension: ExtensionFactory = (fan) => {
	let config = loadConfig();
	const db = new StoreDatabase();
	const repoClient = new RepoClient();
	const installer = new ArchiveInstaller(db, repoClient, config.archiveTempDir);

	const getConfig = () => config;
	const getDB = () => db;
	const getRepoClient = () => repoClient;
	const getInstaller = () => installer;

	// Register tools
	registerStoreTools(fan, getDB, getRepoClient, getInstaller, getConfig);

	// Register command
	registerStoreCommand(fan, getDB, getRepoClient, getInstaller, getConfig);

	// Register shortcuts for extension browser.
	// Alt+S is the default on Linux/Windows. On macOS, Option+S often produces
	// a special character (ß) instead of being treated as a shortcut, so we
	// also register Ctrl+Shift+S for macOS terminals.
	const storeShortcutHandler = (ctx: ExtensionContext) => {
		showExtensionBrowser(ctx, db, repoClient, installer, config);
	};
	fan.registerShortcut("alt+s", {
		description: "Browse extension repositories",
		handler: storeShortcutHandler,
	});
	if (process.platform === "darwin") {
		fan.registerShortcut("ctrl+shift+s", {
			description: "Browse extension repositories (macOS fallback)",
			handler: storeShortcutHandler,
		});
	}

	// Session lifecycle
	fan.on("session_start", async (_event, ctx) => {
		// Reload config on each session (user may have modified it)
		config = loadConfig();

		// ─── Phase 0: Apply staged self-update if pending ───
		const SELF_EXTENSION_DIR = join(homedir(), ".fan", "agent", "extensions", "fan-store");
		const staged = installer.getStagedUpdate(SELF_EXTENSION_DIR);
		if (staged) {
			try {
				ctx.ui.setStatus("store", `📦 Applying fan-store update → v${staged.version}...`);
				const appliedVersion = await installer.applyStagedUpdate(SELF_EXTENSION_DIR);
				ctx.ui.notify(`📦 fan-store updated → v${appliedVersion}. Run /reload to activate.`, "info");
			} catch (err) {
				ctx.ui.notify(`Self-update failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}

		const packages = db.getPackages();
		const updateCount = packages.filter((p) => p.updateAvailable).length;
		const statusText =
			updateCount > 0
				? `📦 Store: ${packages.length} packages (${updateCount} update${updateCount > 1 ? "s" : ""})`
				: `📦 Store: ${packages.length} packages`;

		ctx.ui.setStatus("store", statusText);

		// Auto-update check
		if (config.autoUpdateCheck && config.repositories.length > 0) {
			const lastCheck = db.getLastUpdateCheck();
			const intervalMs = config.autoUpdateCheckIntervalHours * 60 * 60 * 1000;

			if (Date.now() - lastCheck > intervalMs) {
				try {
					const updates = await repoClient.checkUpdates(packages, config.repositories);
					db.setLastUpdateCheck(Date.now());

					if (updates.size > 0) {
						const names = Array.from(updates.keys()).join(", ");
						ctx.ui.notify(`📦 Updates available: ${names}`, "info");
						ctx.ui.setStatus(
							"store",
							`📦 Store: ${packages.length} packages (${updates.size} update${updates.size > 1 ? "s" : ""})`,
						);
					}
				} catch {
					ctx.ui.setStatus("store", `📦 Store: ${packages.length} packages (⚠ update check failed)`);
				}
			}
		}

		// Always check if fan-store itself has an update in repos
		try {
			const selfPkg = await repoClient.getPackage("fan-store", config.repositories);
			if (selfPkg) {
				const installedSelf = db.getPackage("fan-store");
				if (!installedSelf) {
					// Track fan-store in DB even if installed manually
					let selfVersion = "unknown";
					try {
						const pkgJson = JSON.parse(await readFile(join(SELF_EXTENSION_DIR, "package.json"), "utf-8")) as {
							version?: string;
						};
						if (pkgJson.version) selfVersion = pkgJson.version;
					} catch {
						/* not found */
					}

					db.savePackage({
						name: "fan-store",
						version: selfVersion,
						type: "extension",
						source: "local",
						installedAt: Date.now(),
						installedPath: SELF_EXTENSION_DIR,
						scope: "user",
					});
				}

				const currentSelf = db.getPackage("fan-store");
				if (currentSelf && selfPkg.version !== currentSelf.version) {
					db.updatePackage("fan-store", { updateAvailable: true, updateVersion: selfPkg.version });
					const allPkgs = db.getPackages();
					const updateCount = allPkgs.filter((p) => p.updateAvailable).length;
					ctx.ui.setStatus(
						"store",
						`📦 Store: ${allPkgs.length} packages (${updateCount} update${updateCount > 1 ? "s" : ""})`,
					);
					ctx.ui.notify(`📦 fan-store update available: v${currentSelf.version} → v${selfPkg.version}`, "info");
				}
			}
		} catch {
			// ignore self-check failures
		}
	});
};

export default storeExtension;
