/**
 * FAN Store — Local database for installed packages.
 *
 * Stored at: ~/.fan/agent/store-packages.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@seaagents/fan-agent-core";
import type { InstalledPackage } from "./types.js";

const DB_PATH = join(getAgentDir(), "store-packages.json");
const DB_DIR = dirname(DB_PATH);

interface StoreDatabaseSchema {
	packages: Record<string, InstalledPackage>;
	lastUpdateCheck: number;
}

export class StoreDatabase {
	private data: StoreDatabaseSchema;

	constructor() {
		this.data = this.load();
	}

	private load(): StoreDatabaseSchema {
		if (!existsSync(DB_PATH)) {
			const initial: StoreDatabaseSchema = {
				packages: {},
				lastUpdateCheck: 0,
			};
			mkdirSync(DB_DIR, { recursive: true });
			writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf-8");
			return initial;
		}
		const raw = JSON.parse(readFileSync(DB_PATH, "utf-8")) as StoreDatabaseSchema;
		return raw;
	}

	private persist(): void {
		mkdirSync(DB_DIR, { recursive: true });
		writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), "utf-8");
	}

	getPackages(): InstalledPackage[] {
		return Object.values(this.data.packages);
	}

	getPackage(name: string): InstalledPackage | undefined {
		return this.data.packages[name];
	}

	savePackage(pkg: InstalledPackage): void {
		this.data.packages[pkg.name] = pkg;
		this.persist();
	}

	removePackage(name: string): boolean {
		if (!(name in this.data.packages)) {
			return false;
		}
		delete this.data.packages[name];
		this.persist();
		return true;
	}

	updatePackage(name: string, fields: Partial<InstalledPackage>): boolean {
		const existing = this.data.packages[name];
		if (existing === undefined) {
			return false;
		}
		Object.assign(existing, fields);
		this.persist();
		return true;
	}

	setLastUpdateCheck(timestamp: number): void {
		this.data.lastUpdateCheck = timestamp;
		this.persist();
	}

	getLastUpdateCheck(): number {
		return this.data.lastUpdateCheck;
	}
}
