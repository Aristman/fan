/**
 * FAN Store — LLM-callable tool registration.
 */

import type { ExtensionAPI } from "@itone/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ResourceType } from "./types.js";
import { StoreDatabase } from "./storage.js";
import { RepoClient } from "./repo-client.js";
import { ArchiveInstaller } from "./installer.js";
import type { StoreConfig } from "./config.js";

// ──────────────────────────────────────────────
// Tool Registration
// ──────────────────────────────────────────────

export function registerStoreTools(
	pi: ExtensionAPI,
	getDB: () => StoreDatabase,
	getRepoClient: () => RepoClient,
	getInstaller: () => ArchiveInstaller,
	getConfig: () => StoreConfig,
): void {
	// ─── store_search ────────────────────────

	pi.registerTool({
		name: "store_search",
		label: "Store Search",
		description: "Search available packages in configured FAN Store repositories",
		promptSnippet: "Search FAN Store repositories for extensions, skills, and themes",
		parameters: Type.Object({
			query: Type.String({ description: "Search query", minLength: 1 }),
			type: Type.Optional(
				Type.String({
					description: "Filter by resource type",
					enum: ["extension", "skill", "theme", "bundle"],
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const config = getConfig();
			if (config.repositories.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No repositories configured. Add one with /store repos add <name> <url>",
						},
					],
					details: undefined,
				};
			}
			const results = await getRepoClient().searchPackages(
				params.query,
				config.repositories,
				params.type,
			);
			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No packages found matching "${params.query}"` }],
					details: undefined,
				};
			}
			const lines = results.map(
				(p) =>
					`• **${p.name}** v${p.version} [${p.type}] — ${p.description}${p.author ? ` (by ${p.author})` : ""}`,
			);
			return {
				content: [
					{ type: "text" as const, text: `Found ${results.length} package(s):\n${lines.join("\n")}` },
				],
				details: undefined,
			};
		},
	});

	// ─── store_install ───────────────────────

	pi.registerTool({
		name: "store_install",
		label: "Store Install",
		description:
			"Install a package from FAN Store repositories or a local archive file (.tar.gz, .zip)",
		promptSnippet: "Install a package from FAN Store repos or local archive",
		parameters: Type.Object({
			source: Type.String({
				description: "Package name from repo, or local file path to .tar.gz/.zip archive",
				minLength: 1,
			}),
			type: Type.Optional(
				Type.String({
					description: "Resource type (required for local archives if auto-detection fails)",
					enum: ["extension", "skill", "theme"],
				}),
			),
			scope: Type.Optional(
				Type.String({ description: "Install scope", enum: ["user", "project"] }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const config = getConfig();
			const scope = (params.scope as "user" | "project") ?? config.installScope;

			const onProgress = (stage: string, detail?: string) => {
				onUpdate?.({
					content: [{ type: "text" as const, text: `📦 ${detail ?? stage}...` }],
					details: undefined,
				});
			};

			const isFilePath =
				params.source.includes("/") ||
				params.source.includes("\\") ||
				params.source.endsWith(".tar.gz") ||
				params.source.endsWith(".tgz") ||
				params.source.endsWith(".zip");

			if (isFilePath) {
				const type = params.type as ResourceType | undefined;
				onProgress("extracting", `Installing from ${params.source}`);
				const installed = await getInstaller().installFromArchive(params.source, scope, type, onProgress);
				return {
					content: [
						{
							type: "text" as const,
							text: `✅ Installed **${installed.name}** (${installed.type}) v${installed.version} from archive.\nPath: ${installed.installedPath}\n\nRun /reload to activate.`,
						},
					],
					details: undefined,
				};
			}

			const pkg = await getRepoClient().getPackage(params.source, config.repositories);
			if (!pkg) {
				return {
					content: [
						{
							type: "text" as const,
							text: `❌ Package "${params.source}" not found in any configured repository.`,
						},
					],
					details: undefined,
				};
			}
			onProgress("downloading", `Downloading ${pkg.name} v${pkg.version}...`);
			const installed = await getInstaller().installFromRepo(pkg, config.repositories, scope, signal, onProgress);
			return {
				content: [
					{
						type: "text" as const,
						text: `✅ Installed **${installed.name}** (${installed.type}) v${installed.version} from repo "${pkg.repoName}".\nPath: ${installed.installedPath}\n\nRun /reload to activate.`,
					},
				],
				details: undefined,
			};
		},
	});

	// ─── store_remove ────────────────────────

	pi.registerTool({
		name: "store_remove",
		label: "Store Remove",
		description: "Uninstall a FAN Store managed package",
		promptSnippet: "Remove an installed FAN Store package",
		parameters: Type.Object({
			name: Type.String({ description: "Package name to remove", minLength: 1 }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			const pkg = getDB().getPackage(params.name);
			if (!pkg) {
				return {
					content: [
						{
							type: "text" as const,
							text: `❌ Package "${params.name}" is not managed by FAN Store.`,
						},
					],
					details: undefined,
				};
			}

			const onProgress = (stage: string, detail?: string) => {
				onUpdate?.({
					content: [{ type: "text" as const, text: `📦 ${detail ?? stage}...` }],
					details: undefined,
				});
			};

			await getInstaller().uninstall(pkg, onProgress);
			return {
				content: [
					{
						type: "text" as const,
						text: `✅ Removed **${params.name}** (${pkg.type}) v${pkg.version}.\n\nRun /reload to apply changes.`,
					},
				],
				details: undefined,
			};
		},
	});

	// ─── store_update ────────────────────────

	pi.registerTool({
		name: "store_update",
		label: "Store Update",
		description: "Check for available updates or update a specific package",
		promptSnippet: "Check for FAN Store package updates",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description:
						"Specific package to update. If omitted, checks all repo packages for available updates.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const db = getDB();
			const config = getConfig();

			const onProgress = (stage: string, detail?: string) => {
				onUpdate?.({
					content: [{ type: "text" as const, text: `📦 ${detail ?? stage}...` }],
					details: undefined,
				});
			};

			if (config.repositories.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No repositories configured." }],
					details: undefined,
				};
			}

			if (params.name) {
				const pkg = db.getPackage(params.name);
				if (!pkg) {
					return {
						content: [
							{ type: "text" as const, text: `❌ Package "${params.name}" not found.` },
						],
						details: undefined,
					};
				}
				if (pkg.source !== "repo") {
					return {
						content: [
							{
								type: "text" as const,
								text: `❌ Package "${params.name}" was installed from ${pkg.source}, not a repository. Cannot auto-update.`,
							},
						],
						details: undefined,
					};
				}

				const repoPkg = await getRepoClient().getPackage(params.name, config.repositories);
				if (!repoPkg) {
					return {
						content: [
							{
								type: "text" as const,
								text: `❌ Package "${params.name}" not found in any repository.`,
							},
						],
						details: undefined,
					};
				}
				if (repoPkg.version === pkg.version) {
					return {
						content: [
							{
								type: "text" as const,
								text: `✅ **${params.name}** is already up to date (v${pkg.version}).`,
							},
						],
						details: undefined,
					};
				}

				const updated = await getInstaller().updateFromRepo(
					pkg,
					repoPkg,
					config.repositories,
					signal,
					onProgress,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `✅ Updated **${params.name}**: v${pkg.version} → v${updated.version}\n\nRun /reload to activate.`,
						},
					],
					details: undefined,
				};
			}

			// Check all packages
			onProgress("checking", "Checking for updates...");
			const updates = await getRepoClient().checkUpdates(db.getPackages(), config.repositories);
			db.setLastUpdateCheck(Date.now());

			if (updates.size === 0) {
				return {
					content: [{ type: "text" as const, text: "✅ All packages are up to date." }],
					details: undefined,
				};
			}

			const lines: string[] = [];
			for (const [name, info] of updates) {
				lines.push(`• **${name}**: v${info.current} → v${info.latest}`);
				db.updatePackage(name, { updateAvailable: true, updateVersion: info.latest });
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `📦 ${updates.size} update(s) available:\n${lines.join("\n")}\n\nUse store_update with a specific package name to apply updates.`,
					},
				],
				details: undefined,
			};
		},
	});

	// ─── store_list ──────────────────────────

	pi.registerTool({
		name: "store_list",
		label: "Store List",
		description: "List packages installed via FAN Store",
		promptSnippet: "List installed FAN Store packages",
		parameters: Type.Object({
			type: Type.Optional(
				Type.String({
					description: "Filter by resource type",
					enum: ["extension", "skill", "theme", "bundle"],
				}),
			),
			updatesOnly: Type.Optional(
				Type.Boolean({ description: "Show only packages with available updates" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const packages = getDB().getPackages();
			let filtered = packages;

			if (params.type) {
				filtered = filtered.filter((p) => p.type === params.type);
			}
			if (params.updatesOnly) {
				filtered = filtered.filter((p) => p.updateAvailable);
			}

			if (filtered.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No packages installed via FAN Store." }],
					details: undefined,
				};
			}

			const lines = filtered.map((p) => {
				const updateBadge = p.updateAvailable ? ` → v${p.updateVersion} available!` : "";
				const sourceBadge = p.source === "repo" ? `[${p.repoName}]` : `[${p.source}]`;
				return `• **${p.name}** v${p.version} [${p.type}] ${sourceBadge}${updateBadge}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${filtered.length} package(s) installed via FAN Store:\n${lines.join("\n")}`,
					},
				],
				details: undefined,
			};
		},
	});
}
