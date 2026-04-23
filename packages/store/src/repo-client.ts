/**
 * FAN Store — Repository client for fetching package indices and downloading archives.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstalledPackage, RepoEntry, RepoIndex, RepoPackage } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
	data: RepoIndex;
	fetchedAt: number;
}

export class RepoClient {
	private indexCache = new Map<string, CacheEntry>();

	private isOffline(): boolean {
		const value = process.env.FAN_OFFLINE;
		if (!value) return false;
		return value === "1" || value === "true" || value.toLowerCase() === "yes";
	}

	private static isFileUrl(url: string): boolean {
		try {
			return new URL(url).protocol === "file:";
		} catch {
			return url.startsWith("file://");
		}
	}

	/**
	 * Fetch repository index JSON from a URL.
	 * Returns cached result if within TTL.
	 */
	async fetchIndex(repoUrl: string): Promise<RepoIndex> {
		const isFile = RepoClient.isFileUrl(repoUrl);

		if (!isFile && this.isOffline()) {
			const cached = this.indexCache.get(repoUrl);
			if (cached) return cached.data;
			throw new Error(`Offline mode (FAN_OFFLINE). No cached index for ${repoUrl}`);
		}

		const cached = this.indexCache.get(repoUrl);
		if (cached && Date.now() - cached.fetchedAt < INDEX_CACHE_TTL_MS) {
			return cached.data;
		}

		const indexUrl = repoUrl.endsWith("/") ? `${repoUrl}index.json` : `${repoUrl}/index.json`;

		let data: RepoIndex;

		if (isFile) {
			const filePath = fileURLToPath(indexUrl);
			const raw = readFileSync(filePath, "utf-8");
			try {
				data = JSON.parse(raw) as RepoIndex;
			} catch {
				throw new Error(`Failed to parse repo index JSON from ${filePath}`);
			}
		} else {
			const response = await fetch(indexUrl, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { Accept: "application/json" },
			});

			if (!response.ok) {
				throw new Error(
					`Failed to fetch repo index from ${indexUrl}: ${response.status} ${response.statusText}`,
				);
			}

			data = (await response.json()) as RepoIndex;
		}

		// Validate minimal structure
		if (!data.repository || !Array.isArray(data.packages)) {
			throw new Error(
				`Invalid repo index format from ${indexUrl}: missing 'repository' or 'packages'`,
			);
		}

		this.indexCache.set(repoUrl, { data, fetchedAt: Date.now() });
		return data;
	}

	/**
	 * Search across all configured repositories.
	 * Returns packages matching query (case-insensitive substring match on name and description).
	 */
	async searchPackages(query: string, repos: RepoEntry[], typeFilter?: string): Promise<RepoPackage[]> {
		const enabledRepos = repos.filter((r) => r.enabled);
		const lowerQuery = query.toLowerCase();
		const results: RepoPackage[] = [];

		for (const repo of enabledRepos) {
			try {
				const index = await this.fetchIndex(repo.url);
				for (const pkg of index.packages) {
					if (typeFilter && pkg.type !== typeFilter) continue;
					const matchesName = pkg.name.toLowerCase().includes(lowerQuery);
					const matchesDesc = pkg.description.toLowerCase().includes(lowerQuery);
					if (matchesName || matchesDesc) {
						// Enrich with repo metadata
						results.push({
							...pkg,
							source: "repo",
							repoName: repo.name,
							repoUrl: repo.url,
						});
					}
				}
			} catch {
				// Fault tolerance — one bad repo shouldn't block others
			}
		}

		// Sort by relevance: exact name match first, then name prefix, then substring
		results.sort((a, b) => {
			const aExact = a.name.toLowerCase() === lowerQuery ? 0 : 1;
			const bExact = b.name.toLowerCase() === lowerQuery ? 0 : 1;
			if (aExact !== bExact) return aExact - bExact;
			const aPrefix = a.name.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
			const bPrefix = b.name.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
			if (aPrefix !== bPrefix) return aPrefix - bPrefix;
			return a.name.localeCompare(b.name);
		});

		return results;
	}

	/**
	 * Get all packages across all configured repositories.
	 * Priority: repos with lower priority number first (first seen wins).
	 */
	async getAllPackages(repos: RepoEntry[], typeFilter?: string): Promise<RepoPackage[]> {
		const enabledRepos = repos
			.filter(r => r.enabled)
			.sort((a, b) => a.priority - b.priority);

		const allPackages: RepoPackage[] = [];
		const seen = new Set<string>();

		for (const repo of enabledRepos) {
			try {
				const index = await this.fetchIndex(repo.url);
				const packages = typeFilter
					? index.packages.filter(p => p.type === typeFilter)
					: index.packages;

				for (const pkg of packages) {
					if (!seen.has(pkg.name)) {
						seen.add(pkg.name);
						allPackages.push({ ...pkg, repoName: repo.name, repoUrl: repo.url });
					}
				}
			} catch (err) {
				// Skip faulty repos silently
			}
		}

		return allPackages;
	}

	/**
	 * Find a specific package by name across all configured repositories.
	 * Priority: repos with lower priority number first.
	 */
	async getPackage(name: string, repos: RepoEntry[]): Promise<RepoPackage | undefined> {
		const enabledRepos = [...repos.filter((r) => r.enabled)].sort((a, b) => a.priority - b.priority);

		for (const repo of enabledRepos) {
			try {
				const index = await this.fetchIndex(repo.url);
				const pkg = index.packages.find((p) => p.name === name);
				if (pkg) {
					return {
						...pkg,
						source: "repo",
						repoName: repo.name,
						repoUrl: repo.url,
					};
				}
			} catch {
				// skip bad repos
			}
		}

		return undefined;
	}

	/**
	 * Download a package archive to a destination path.
	 * Verifies SHA-256 hash if provided.
	 */
	async downloadPackage(pkg: RepoPackage, destPath: string, signal?: AbortSignal): Promise<void> {
		if (!RepoClient.isFileUrl(pkg.downloadUrl) && this.isOffline()) {
			throw new Error(`Offline mode (FAN_OFFLINE). Cannot download ${pkg.name}`);
		}

		mkdirSync(dirname(destPath), { recursive: true });

		if (RepoClient.isFileUrl(pkg.downloadUrl)) {
			const filePath = fileURLToPath(pkg.downloadUrl);
			if (!existsSync(filePath)) {
				throw new Error(`Local package archive not found: ${filePath}`);
			}
			const buffer = readFileSync(filePath);

			if (pkg.hash) {
				const expectedHash = (pkg.hash.startsWith("sha256:") ? pkg.hash.slice(7) : pkg.hash).toLowerCase();
				const actualHash = createHash("sha256").update(buffer).digest("hex");
				if (actualHash !== expectedHash) {
					throw new Error(
						`Hash verification failed for ${pkg.name}: expected ${expectedHash}, got ${actualHash}`,
					);
				}
			}

			await writeFile(destPath, buffer);
			return;
		}

		const response = await fetch(pkg.downloadUrl, {
			signal: signal ?? AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(
				`Failed to download ${pkg.name} from ${pkg.downloadUrl}: ${response.status} ${response.statusText}`,
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		// Verify hash if provided
		if (pkg.hash) {
			const expectedHash = (pkg.hash.startsWith("sha256:") ? pkg.hash.slice(7) : pkg.hash).toLowerCase();
			const actualHash = createHash("sha256").update(buffer).digest("hex");
			if (actualHash !== expectedHash) {
				// Clean up partial download
				if (existsSync(destPath)) unlinkSync(destPath);
				throw new Error(
					`Hash verification failed for ${pkg.name}: expected ${expectedHash}, got ${actualHash}`,
				);
			}
		}

		await writeFile(destPath, buffer);
	}

	/**
	 * Check for updates for all repo-installed packages.
	 * Returns map of packageName -> { current, latest }.
	 */
	async checkUpdates(
		installedPackages: InstalledPackage[],
		repos: RepoEntry[],
	): Promise<
		Map<string, { current: string; latest: string; downloadUrl: string; hash: string }>
	> {
		const updates = new Map<
			string,
			{ current: string; latest: string; downloadUrl: string; hash: string }
		>();
		const repoPackages = installedPackages.filter((p) => p.source === "repo");

		for (const installed of repoPackages) {
			try {
				const latest = await this.getPackage(installed.name, repos);
				if (latest && latest.version !== installed.version) {
					updates.set(installed.name, {
						current: installed.version,
						latest: latest.version,
						downloadUrl: latest.downloadUrl,
						hash: latest.hash,
					});
				}
			} catch {
				// Skip packages whose repos are unreachable
			}
		}

		return updates;
	}
}
