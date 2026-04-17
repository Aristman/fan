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

import type { ExtensionFactory } from "@itone/fan-coding-agent";
import { loadConfig } from "./config.js";
import { StoreDatabase } from "./storage.js";
import { RepoClient } from "./repo-client.js";
import { ArchiveInstaller } from "./installer.js";
import { registerStoreTools } from "./store-tools.js";
import { registerStoreCommand } from "./store-command.js";

export const storeExtension: ExtensionFactory = (pi) => {
	let config = loadConfig();
	const db = new StoreDatabase();
	const repoClient = new RepoClient();
	const installer = new ArchiveInstaller(db, repoClient, config.archiveTempDir);

	const getConfig = () => config;
	const getDB = () => db;
	const getRepoClient = () => repoClient;
	const getInstaller = () => installer;

	// Register tools
	registerStoreTools(pi, getDB, getRepoClient, getInstaller, getConfig);

	// Register command
	registerStoreCommand(pi, getDB, getRepoClient, getInstaller, getConfig);

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		// Reload config on each session (user may have modified it)
		config = loadConfig();

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
	});
};

export default storeExtension;
