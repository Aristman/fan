/**
 * FAN Store — Configuration management.
 *
 * Config file: ~/.fan/agent/store.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@itone/fan-coding-agent";
import { tmpdir } from "node:os";
import type { RepoEntry } from "./types.js";

// ──────────────────────────────────────────────
// Configuration types
// ──────────────────────────────────────────────

export interface StoreConfig {
	repositories: RepoEntry[];
	autoUpdateCheck: boolean;
	autoUpdateCheckIntervalHours: number;
	installScope: "user" | "project";
	archiveTempDir: string;
}

// ──────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────

const DEFAULTS: StoreConfig = {
	repositories: [
		{
			name: "fan-store",
			url: "https://fan.sea-agents.ru/fan-store",
			enabled: true,
			priority: 1,
		},
	],
	autoUpdateCheck: true,
	autoUpdateCheckIntervalHours: 24,
	installScope: "user",
	archiveTempDir: join(tmpdir(), "fan-store"),
};

// ──────────────────────────────────────────────
// Config paths
// ──────────────────────────────────────────────

const CONFIG_PATH = join(getAgentDir(), "store.json");
const CONFIG_DIR = dirname(CONFIG_PATH);

// ──────────────────────────────────────────────
// Config loader/saver
// ──────────────────────────────────────────────

export function saveConfig(config: StoreConfig): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function loadConfig(): StoreConfig {
	if (!existsSync(CONFIG_PATH)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf-8");
		return { ...DEFAULTS };
	}

	const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
	return deepMerge(DEFAULTS as unknown as Record<string, unknown>, raw) as unknown as StoreConfig;
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
	const result = { ...target };
	for (const key in source) {
		if (!Object.hasOwn(source, key)) continue;
		const sv = source[key];
		const tv = target[key];
		if (
			sv !== null &&
			sv !== undefined &&
			typeof sv === "object" &&
			!Array.isArray(sv) &&
			tv !== null &&
			typeof tv === "object" &&
			!Array.isArray(tv)
		) {
			result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>) as T[Extract<
				keyof T,
				string
			>];
		} else if (sv !== undefined && sv !== null) {
			result[key] = sv as T[Extract<keyof T, string>];
		}
	}
	return result;
}
