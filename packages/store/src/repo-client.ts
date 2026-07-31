/**
 * FAN Store — Repository client for fetching package indices and downloading archives.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InstalledPackage, RepoEntry, RepoIndex, RepoPackage } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compare two semver strings.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 * Supports major.minor.patch and pre-release tags.
 */
export function semverCompare(a: string, b: string): number {
	const parse = (v: string) => {
		const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
		if (!match) return { major: 0, minor: 0, patch: 0, pre: null };
		return { major: +match[1]!, minor: +match[2]!, patch: +match[3]!, pre: match[4] ?? null };
	};
	const pa = parse(a);
	const pb = parse(b);
	if (pa.major !== pb.major) return pa.major - pb.major;
	if (pa.minor !== pb.minor) return pa.minor - pb.minor;
	if (pa.patch !== pb.patch) return pa.patch - pb.patch;
	// Pre-release: no pre-release > pre-release (e.g. 1.0.0 > 1.0.0-alpha)
	if (pa.pre === null && pb.pre === null) return 0;
	if (pa.pre === null) return 1;
	if (pb.pre === null) return -1;
	return pa.pre.localeCompare(pb.pre);
}

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
		if (url.startsWith("file://")) return true;
		// Windows absolute path: C:\... or C:/...
		if (/^[A-Za-z]:[\\/]/.test(url)) return true;
		// POSIX absolute path: /... (but not //...)
		if (url.startsWith("/") && !url.startsWith("//")) return true;
		try {
			return new URL(url).protocol === "file:";
		} catch {
			return false;
		}
	}

	/**
	 * Convert a raw filesystem path to a file:// URL.
	 * Returns the URL unchanged if it already starts with file://.
	 * Uses pathToFileURL() for proper encoding of special characters (#, ?, etc.).
	 */
	private static toFileUrl(url: string): string {
		if (url.startsWith("file://")) return url;
		// Windows or POSIX absolute path → use pathToFileURL for proper encoding
		if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("/")) {
			return pathToFileURL(url).href;
		}
		return url;
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

		// Normalize raw filesystem paths to file:// URLs for consistent handling
		const normalizedRepoUrl = isFile ? RepoClient.toFileUrl(repoUrl) : repoUrl;
		const indexUrl = normalizedRepoUrl.endsWith("/")
			? `${normalizedRepoUrl}index.json`
			: `${normalizedRepoUrl}/index.json`;

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
				throw new Error(`Failed to fetch repo index from ${indexUrl}: ${response.status} ${response.statusText}`);
			}

			data = (await response.json()) as RepoIndex;
		}

		// Validate minimal structure
		if (!data.repository || !Array.isArray(data.packages)) {
			throw new Error(`Invalid repo index format from ${indexUrl}: missing 'repository' or 'packages'`);
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
	 * Get all packages across all configured repositories (no deduplication).
	 * Returns every package from every repo, enriched with repoName/repoUrl.
	 * Packages are ordered by repo priority (lower number first), so the
	 * caller can deduplicate if needed.
	 */
	async getAllPackages(repos: RepoEntry[], typeFilter?: string): Promise<RepoPackage[]> {
		const enabledRepos = repos.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

		const allPackages: RepoPackage[] = [];

		for (const repo of enabledRepos) {
			try {
				const index = await this.fetchIndex(repo.url);
				const packages = typeFilter ? index.packages.filter((p) => p.type === typeFilter) : index.packages;

				for (const pkg of packages) {
					allPackages.push({ ...pkg, repoName: repo.name, repoUrl: repo.url });
				}
			} catch (_err) {
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
	 * Resolve the effective download URL for a package.
	 * When the repo itself is a local file:// repo, the index.json may still
	 * contain a remote https:// downloadUrl. In that case we resolve the
	 * archive filename relative to the local repo directory:
	 *   {repoUrl}/packages/{filename}
	 */
	private static resolveDownloadUrl(pkg: RepoPackage): string {
		if (pkg.repoUrl && RepoClient.isFileUrl(pkg.repoUrl) && !RepoClient.isFileUrl(pkg.downloadUrl)) {
			// Local repo with remote downloadUrl — resolve locally
			const filename = pkg.downloadUrl.split("/").pop() ?? pkg.downloadUrl;
			const repoBase = RepoClient.toFileUrl(pkg.repoUrl);
			const base = repoBase.endsWith("/") ? repoBase : `${repoBase}/`;
			return `${base}packages/${filename}`;
		}
		return pkg.downloadUrl;
	}

	/**
	 * Download a package archive to a destination path.
	 * Verifies SHA-256 hash if provided.
	 */
	async downloadPackage(pkg: RepoPackage, destPath: string, signal?: AbortSignal): Promise<void> {
		const effectiveUrl = RepoClient.resolveDownloadUrl(pkg);

		if (!RepoClient.isFileUrl(effectiveUrl) && this.isOffline()) {
			throw new Error(`Offline mode (FAN_OFFLINE). Cannot download ${pkg.name}`);
		}

		mkdirSync(dirname(destPath), { recursive: true });

		if (RepoClient.isFileUrl(effectiveUrl)) {
			const filePath = fileURLToPath(RepoClient.toFileUrl(effectiveUrl));
			if (!existsSync(filePath)) {
				throw new Error(`Local package archive not found: ${filePath}`);
			}
			const buffer = readFileSync(filePath);

			if (pkg.hash) {
				const expectedHash = (pkg.hash.startsWith("sha256:") ? pkg.hash.slice(7) : pkg.hash).toLowerCase();
				const actualHash = createHash("sha256").update(buffer).digest("hex");
				if (actualHash !== expectedHash) {
					throw new Error(`Hash verification failed for ${pkg.name}: expected ${expectedHash}, got ${actualHash}`);
				}
			}

			await writeFile(destPath, buffer);
			return;
		}

		const response = await fetch(effectiveUrl, {
			signal: signal ?? AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(
				`Failed to download ${pkg.name} from ${effectiveUrl}: ${response.status} ${response.statusText}`,
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
				throw new Error(`Hash verification failed for ${pkg.name}: expected ${expectedHash}, got ${actualHash}`);
			}
		}

		await writeFile(destPath, buffer);
	}

	/**
	 * Check for updates for all repo-installed packages.
	 * Scans ALL enabled repos and picks the max version available.
	 * Returns map of packageName -> { current, latest, downloadUrl, hash, repoName }.
	 */
	async checkUpdates(
		installedPackages: InstalledPackage[],
		repos: RepoEntry[],
	): Promise<Map<string, { current: string; latest: string; downloadUrl: string; hash: string; repoName: string }>> {
		const updates = new Map<
			string,
			{ current: string; latest: string; downloadUrl: string; hash: string; repoName: string }
		>();
		const repoPackages = installedPackages.filter((p) => p.source === "repo");
		const enabledRepos = repos.filter((r) => r.enabled);

		// Pre-fetch all indexes (cached via indexCache)
		const indexes = new Map<string, RepoIndex>();
		for (const repo of enabledRepos) {
			try {
				indexes.set(repo.name, await this.fetchIndex(repo.url));
			} catch {
				// Skip unreachable repos
			}
		}

		for (const installed of repoPackages) {
			let bestVersion = installed.version;
			let bestPkg: RepoPackage | null = null;
			let bestRepoName = "";

			for (const repo of enabledRepos) {
				const index = indexes.get(repo.name);
				if (!index) continue;
				const pkg = index.packages.find((p) => p.name === installed.name);
				if (!pkg) continue;
				if (semverCompare(pkg.version, bestVersion) > 0) {
					bestVersion = pkg.version;
					bestPkg = pkg;
					bestRepoName = repo.name;
				}
			}

			if (bestPkg && semverCompare(bestPkg.version, installed.version) > 0) {
				updates.set(installed.name, {
					current: installed.version,
					latest: bestPkg.version,
					downloadUrl: bestPkg.downloadUrl,
					hash: bestPkg.hash,
					repoName: bestRepoName,
				});
			}
		}

		return updates;
	}
}
