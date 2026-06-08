/**
 * FAN Store — Package manager for extensions, skills, themes from repositories and archives.
 *
 * @packageDocumentation
 */

export type { loadConfig, StoreConfig, saveConfig } from "./config.js";
export type { ProgressCallback } from "./installer.js";
export { ArchiveInstaller } from "./installer.js";
export { ProgressOverlay } from "./progress-overlay.js";
export { RepoClient } from "./repo-client.js";
export { StoreDatabase } from "./storage.js";
export { default, storeExtension } from "./store-extension.js";
export type { InstalledPackage, RepoEntry, RepoIndex, RepoPackage, ResourceType } from "./types.js";
