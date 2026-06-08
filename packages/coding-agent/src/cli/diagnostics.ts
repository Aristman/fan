// packages/coding-agent/src/cli/diagnostics.ts
// Central diagnostics module for "fan doctor" command

import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getProvidersRegistry } from "@itone/fan-ai";
import { APP_NAME, getAgentDir, getModelsPath, getSessionsDir, getSettingsPath, VERSION } from "../config.js";

interface DiagnosticResult {
	name: string;
	status: "ok" | "warn" | "error";
	message: string;
	detail?: string;
}

export async function runDiagnostics(): Promise<boolean> {
	const results: DiagnosticResult[] = [];
	const require = createRequire(import.meta.url);

	// 1. Node.js version check (>= 20)
	const nodeVersion = process.versions.node;
	const major = parseInt(nodeVersion.split(".")[0], 10);
	results.push({
		name: "Node.js version",
		status: major >= 20 ? "ok" : "error",
		message: major >= 20 ? `v${nodeVersion}` : `v${nodeVersion} (requires >= 20)`,
		detail: major < 20 ? "Please upgrade Node.js to version 20 or later" : undefined,
	});

	// 2. Check if running as binary vs node
	results.push({
		name: "Runtime mode",
		status: "ok",
		message:
			process.argv[0].endsWith("node") || process.argv[0].endsWith("node.exe")
				? "Node.js module"
				: "Standalone binary",
	});

	// 3. Agent directory exists and is writable
	const agentDir = getAgentDir();
	try {
		if (!existsSync(agentDir)) {
			mkdirSync(agentDir, { recursive: true });
		}
		accessSync(agentDir, constants.W_OK);
		results.push({
			name: "Agent directory",
			status: "ok",
			message: agentDir,
		});
	} catch (e: any) {
		results.push({
			name: "Agent directory",
			status: "error",
			message: `Cannot write to ${agentDir}`,
			detail: e.message,
		});
	}

	// 4. Settings file
	const settingsPath = getSettingsPath();
	if (existsSync(settingsPath)) {
		try {
			JSON.parse(readFileSync(settingsPath, "utf-8"));
			results.push({
				name: "Global settings",
				status: "ok",
				message: settingsPath,
			});
		} catch (e: any) {
			results.push({
				name: "Global settings",
				status: "error",
				message: `Invalid JSON in ${settingsPath}`,
				detail: e.message,
			});
		}
	} else {
		results.push({
			name: "Global settings",
			status: "warn",
			message: "No global settings file found",
			detail: "Run 'fan init' to create one",
		});
	}

	// 5. Models configuration
	const modelsPath = getModelsPath();
	if (existsSync(modelsPath)) {
		try {
			const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
			const modelCount = Array.isArray(models) ? models.length : Object.keys(models).length;
			results.push({
				name: "Models config",
				status: modelCount > 0 ? "ok" : "warn",
				message: `${modelsPath} (${modelCount} models)`,
			});
		} catch (e: any) {
			results.push({
				name: "Models config",
				status: "error",
				message: `Invalid JSON in ${modelsPath}`,
				detail: e.message,
			});
		}
	} else {
		results.push({
			name: "Models config",
			status: "warn",
			message: `No models config at ${modelsPath}`,
			detail: "Models will use defaults from provider",
		});
	}

	// 6. API keys check
	const { providers } = getProvidersRegistry();
	const configuredProviders: string[] = [];
	for (const [id, meta] of Object.entries(providers)) {
		if (meta.envVars.some((v) => process.env[v])) {
			configuredProviders.push(meta.displayName);
		}
	}

	results.push({
		name: "API keys",
		status: configuredProviders.length > 0 ? "ok" : "error",
		message:
			configuredProviders.length > 0
				? `${configuredProviders.length} provider(s) configured: ${configuredProviders.join(", ")}`
				: "No API keys found",
		detail:
			configuredProviders.length === 0
				? "Set API keys in .env file or environment variables. See .env.example for available providers."
				: undefined,
	});

	// 7. Database (Prisma/SQLite)
	try {
		const { getPrismaClient, closePrismaClient } = await import("@fan/db");
		const client = getPrismaClient();
		await client.$connect();
		await client.$queryRaw`SELECT 1`;
		await closePrismaClient();
		results.push({
			name: "Database (SQLite)",
			status: "ok",
			message: "Connected successfully",
		});
	} catch (e: any) {
		results.push({
			name: "Database (SQLite)",
			status: "warn",
			message: "Database check failed",
			detail: e.message,
		});
	}

	// 8. Sessions directory
	const sessionsDir = getSessionsDir();
	try {
		if (existsSync(sessionsDir)) {
			const sessions = readdirSync(sessionsDir);
			const jsonlFiles = sessions.filter((f) => f.endsWith(".jsonl"));
			results.push({
				name: "Sessions",
				status: "ok",
				message: `${jsonlFiles.length} session(s) in ${sessionsDir}`,
			});
		} else {
			results.push({
				name: "Sessions",
				status: "ok",
				message: "No sessions directory (will be created on first use)",
			});
		}
	} catch (e: any) {
		results.push({
			name: "Sessions",
			status: "warn",
			message: `Cannot read sessions directory`,
			detail: e.message,
		});
	}

	// 9. Background server status
	const serverInfoPath = join(getAgentDir(), "server.json");
	if (existsSync(serverInfoPath)) {
		try {
			const serverInfo = JSON.parse(readFileSync(serverInfoPath, "utf-8"));
			// Import isProcessAlive from server-command
			const { isProcessAlive } = await import("./server-command.js");
			if (isProcessAlive(serverInfo.pid)) {
				results.push({
					name: "Background server",
					status: "ok",
					message: `Running (PID ${serverInfo.pid}, http://${serverInfo.host}:${serverInfo.port})`,
				});
			} else {
				results.push({
					name: "Background server",
					status: "warn",
					message: "Stale PID file found (server not running)",
					detail: "Run 'fan server stop' or delete ~/.fan/agent/server.json manually",
				});
			}
		} catch {
			// ignore parse errors
		}
	} else {
		results.push({
			name: "Background server",
			status: "ok",
			message: "Not running (no server.json found)",
		});
	}

	// 10. Port availability (3456)
	try {
		const net = await import("node:net");
		const isAvailable = await new Promise<boolean>((resolve) => {
			const server = net.createServer();
			server.once("error", () => resolve(false));
			server.once("listening", () => {
				server.close();
				resolve(true);
			});
			server.listen(3456, "127.0.0.1");
		});
		results.push({
			name: "Server port (3456)",
			status: isAvailable ? "ok" : "warn",
			message: isAvailable ? "Available" : "In use by another process",
			detail: isAvailable ? undefined : "Use --port flag to specify a different port for server mode",
		});
	} catch {
		results.push({
			name: "Server port (3456)",
			status: "warn",
			message: "Could not check port availability",
		});
	}

	// 11. Version
	results.push({
		name: "Version",
		status: "ok",
		message: `${APP_NAME} v${VERSION}`,
	});

	// Print report
	console.log(`\n🔍 ${APP_NAME} Diagnostics Report\n`);

	const icon = (status: DiagnosticResult["status"]) => {
		switch (status) {
			case "ok":
				return "✅";
			case "warn":
				return "⚠️";
			case "error":
				return "❌";
		}
	};

	let hasErrors = false;
	let hasWarnings = false;

	for (const r of results) {
		console.log(`  ${icon(r.status)} ${r.name}: ${r.message}`);
		if (r.detail) {
			console.log(`     ${r.detail}`);
		}
		if (r.status === "error") hasErrors = true;
		if (r.status === "warn") hasWarnings = true;
	}

	console.log();
	if (hasErrors) {
		console.log("  ❌ Issues found. Please fix the errors above.");
	} else if (hasWarnings) {
		console.log("  ⚠️ Some warnings detected. FAN should work but may have limited functionality.");
	} else {
		console.log("  ✅ Everything looks good!");
	}
	console.log();

	return !hasErrors;
}
