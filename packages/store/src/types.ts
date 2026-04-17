/**
 * FAN Store — Type definitions for repository packages and installed packages.
 */

export type ResourceType = "extension" | "skill" | "theme";

export interface RepoEntry {
	name: string;
	url: string;
	enabled: boolean;
	priority: number;
}

export interface RepoPackage {
	name: string;
	version: string;
	description: string;
	type: ResourceType | "bundle";
	author?: string;
	homepage?: string;
	source: "repo";
	repoName: string;
	repoUrl: string;
	downloadUrl: string;
	hash: string;
	installedAt?: number;
	installedVersion?: string;
	installedPath?: string;
	updatedAt?: number;
	updateAvailable?: boolean;
	updateVersion?: string;
}

export interface RepoIndex {
	repository: {
		name: string;
		url: string;
		updatedAt: string;
	};
	packages: RepoPackage[];
}

export interface InstalledPackage {
	name: string;
	version: string;
	type: ResourceType | "bundle";
	source: "repo" | "archive" | "local";
	installedAt: number;
	installedPath: string;
	scope?: "user" | "project";
	repoName?: string;
	repoUrl?: string;
	downloadUrl?: string;
	hash?: string;
	updateAvailable?: boolean;
	updateVersion?: string;
}
