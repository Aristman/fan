/**
 * FAN Store — Package manager for extensions, skills, themes from repositories and archives.
 *
 * @packageDocumentation
 */

export { default, storeExtension } from "./store-extension.js";
export type { StoreConfig, saveConfig, loadConfig } from "./config.js";
export { StoreDatabase } from "./storage.js";
export { RepoClient } from "./repo-client.js";
export { ArchiveInstaller } from "./installer.js";
export type { RepoEntry, RepoPackage, RepoIndex, InstalledPackage, ResourceType } from "./types.js";
