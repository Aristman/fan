import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

let _client: PrismaClient | null = null;

/** Map Node.js platform/arch to Prisma binary target engine filename */
function getLibraryEngineName(): string {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "win32") return "query_engine-windows.dll.node";
	if (platform === "darwin" && arch === "arm64") return "libquery_engine-darwin-arm64.dylib.node";
	if (platform === "darwin") return "libquery_engine-darwin.dylib.node";
	if (platform === "linux" && arch === "arm64") return "libquery_engine-linux-arm64-openssl-3.0.x.so.node";
	// linux x64 (also debian)
	return "libquery_engine-debian-openssl-3.0.x.so.node";
}

/**
 * Resolve the Prisma query engine path for standalone binaries.
 *
 * In a bun-compiled binary, process.execPath and import.meta.dir point
 * inside Bun's virtual filesystem (e.g. "B:/~BUN/root/fan.exe"), so
 * neither can be used to locate real files on disk. Also, existsSync()
 * may not see real filesystem files in bun compile.
 *
 * Instead, we unconditionally set the engine path based on well-known
 * install directories. install.ps1 and install.sh always put files in
 * deterministic locations.
 */
function resolvePrismaEngine(): string | undefined {
	const engineName = getLibraryEngineName();
	const platform = process.platform;

	// 1. Well-known install directories
	//    Windows: %LOCALAPPDATA%\fan\  (install.ps1 default)
	//    Unix:    ~/.local/share/fan/    (install.sh default)
	if (platform === "win32") {
		if (process.env.LOCALAPPDATA) {
			return join(process.env.LOCALAPPDATA, "fan", "node_modules", ".prisma", "client", engineName);
		}
		if (process.env.APPDATA) {
			return join(process.env.APPDATA, "fan", "node_modules", ".prisma", "client", engineName);
		}
	} else {
		return join(homedir(), ".local", "share", "fan", "node_modules", ".prisma", "client", engineName);
	}

	// 2. FAN_INSTALL_DIR override (from install scripts)
	if (process.env.FAN_INSTALL_DIR) {
		return join(process.env.FAN_INSTALL_DIR, "node_modules", ".prisma", "client", engineName);
	}

	// 3. process.execPath — works for dev mode (non-compiled)
	return join(dirname(process.execPath), "node_modules", ".prisma", "client", engineName);
}

/** DDL statements for the initial schema (one per table/index) */
const DDL_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT 'New Session',
    "model" TEXT,
    "provider" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" TEXT,
    "model" TEXT,
    "tokens" INTEGER,
    "cost" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
	`CREATE TABLE IF NOT EXISTS "ModelSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" REAL DEFAULT 0.7,
    "maxTokens" INTEGER,
    "thinking" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT 0,
    "priority" INTEGER DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS "RoutingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fallback" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT 1
)`,
	`CREATE TABLE IF NOT EXISTS "Budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT,
    "period" TEXT NOT NULL,
    "tokenLimit" INTEGER,
    "costLimit" REAL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costUsed" REAL NOT NULL DEFAULT 0,
    "resetAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
	`CREATE TABLE IF NOT EXISTS "ClientToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsed" DATETIME
)`,
	`CREATE INDEX IF NOT EXISTS "Message_sessionId_idx" ON "Message"("sessionId")`,
	`CREATE INDEX IF NOT EXISTS "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt")`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "ModelSetting_provider_model_key" ON "ModelSetting"("provider", "model")`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "RoutingRule_name_key" ON "RoutingRule"("name")`,
	`CREATE INDEX IF NOT EXISTS "Budget_provider_period_idx" ON "Budget"("provider", "period")`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "ClientToken_token_key" ON "ClientToken"("token")`,
];

/**
 * Get the singleton PrismaClient. Sync — no schema migration, just instantiation.
 * Call initDatabase() separately to ensure tables exist.
 */
export function getPrismaClient(): PrismaClient {
	if (!_client) {
		// Ensure Prisma can find the native engine library in standalone binaries
		if (!process.env.PRISMA_QUERY_ENGINE_LIBRARY) {
			const enginePath = resolvePrismaEngine();
			if (enginePath) {
				process.env.PRISMA_QUERY_ENGINE_LIBRARY = enginePath;
			}
		}

		// Set default DATABASE_URL if not set by .env or environment
		if (!process.env.DATABASE_URL) {
			const agentDir = process.env.FAN_AGENT_DIR ?? join(homedir(), ".fan", "agent");
			const dbPath = resolve(agentDir, "filin.db");
			// Ensure the database directory exists (needed for first-run)
			mkdirSync(dirname(dbPath), { recursive: true });
			process.env.DATABASE_URL = `file:${dbPath}`;
		}

		const logLevel = process.env.FAN_DB_LOG ?? ["error"];
		_client = new PrismaClient({
			log: Array.isArray(logLevel)
				? (logLevel as Array<"query" | "info" | "warn" | "error">)
				: [logLevel as "query" | "info" | "warn" | "error"],
		});
	}

	return _client;
}

/**
 * Initialize database schema — creates tables if they don't exist.
 * Safe to call multiple times; checks for _prisma_migrations first.
 */
export async function initDatabase(prisma?: PrismaClient): Promise<void> {
	const client = prisma ?? getPrismaClient();

	// Check if schema is already initialized
	try {
		const result: Array<{ count: number }> = await client.$queryRawUnsafe(
			`SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`,
		);
		if (result[0]?.count > 0) {
			return; // Already initialized
		}
	} catch {
		// Table doesn't exist yet — proceed with DDL
	}

	// Apply each DDL statement individually for better error reporting
	for (const sql of DDL_STATEMENTS) {
		try {
			await client.$executeRawUnsafe(sql);
		} catch (err) {
			console.error(`[db] Failed to execute DDL statement:`, sql);
			console.error(`[db] Error:`, err);
		}
	}

	// Create migration tracking table and record
	try {
		await client.$executeRawUnsafe(`
			CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
				"id" TEXT NOT NULL PRIMARY KEY,
				"checksum" TEXT NOT NULL,
				"finished_at" DATETIME NOT NULL,
				"migration_name" TEXT NOT NULL,
				"logs" TEXT,
				"rolled_back_at" DATETIME,
				"started_at" DATETIME NOT NULL,
				"applied_steps_count" INTEGER NOT NULL DEFAULT 0
			)
		`);
	} catch (err) {
		console.error(`[db] Failed to create _prisma_migrations table:`, err);
	}

	try {
		await client.$executeRawUnsafe(`
			INSERT OR IGNORE INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
			VALUES ('init', 'standalone', CURRENT_TIMESTAMP, 'init', CURRENT_TIMESTAMP, 1)
		`);
	} catch (err) {
		console.error(`[db] Failed to insert migration record:`, err);
	}
}

/** Close the Prisma connection */
export async function closePrismaClient(): Promise<void> {
	if (_client) {
		const client = _client;
		_client = null;
		return client.$disconnect();
	}
	return Promise.resolve();
}
