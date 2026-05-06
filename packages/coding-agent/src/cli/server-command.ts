/**
 * Server lifecycle management for `fan server` subcommand.
 *
 * Provides start/stop/status for the background server daemon.
 * PID file:  ~/.fan/agent/server.pid
 * Info file:  ~/.fan/agent/server.json
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { spawn } from "node:child_process";
import process from "node:process";

const SERVER_PID_FILE = () => join(getAgentDir(), "server.pid");
const SERVER_INFO_FILE = () => join(getAgentDir(), "server.json");

export interface ServerInfo {
	pid: number;
	port: number;
	host: string;
	token?: string;
	startTime: string;
	dashboardDir?: string;
}

/** Read server metadata from disk. Returns null if file doesn't exist or is invalid. */
export function readServerInfo(): ServerInfo | null {
	const infoPath = SERVER_INFO_FILE();
	if (!existsSync(infoPath)) return null;
	try {
		return JSON.parse(readFileSync(infoPath, "utf-8"));
	} catch {
		return null;
	}
}

/** Write server metadata to disk. Creates the agent directory if needed. */
export function writeServerInfo(info: ServerInfo): void {
	const agentDir = getAgentDir();
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
	writeFileSync(SERVER_INFO_FILE(), JSON.stringify(info, null, 2));
}

/** Remove server PID and info files. Ignores errors if files don't exist. */
export function removeServerFiles(): void {
	try { unlinkSync(SERVER_PID_FILE()); } catch {}
	try { unlinkSync(SERVER_INFO_FILE()); } catch {}
}

/** Check if a process with the given PID is currently alive. */
export function isProcessAlive(pid: number): boolean {
	try {
		// kill with signal 0 checks if process exists without sending a signal
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** `fan server status` — check if server is running */
export function serverStatus(): void {
	const info = readServerInfo();
	if (!info) {
		console.log("fan server: not running");
		process.exit(1);
	}

	if (!isProcessAlive(info.pid)) {
		console.log("fan server: not running (stale PID file)");
		removeServerFiles();
		process.exit(1);
	}

	const uptime = Date.now() - new Date(info.startTime).getTime();
	const uptimeMin = Math.floor(uptime / 60000);
	const uptimeStr = uptimeMin < 1 ? `${Math.floor(uptime / 1000)}s` : `${uptimeMin}m`;

	console.log("fan server: running");
	console.log(`  PID:      ${info.pid}`);
	console.log(`  URL:      http://${info.host}:${info.port}`);
	console.log(`  Uptime:   ${uptimeStr}`);
	console.log(`  Started:  ${new Date(info.startTime).toLocaleString()}`);
	if (info.dashboardDir) {
		console.log(`  Dashboard: http://${info.host}:${info.port}`);
	}
	// Output as JSON if --json flag passed (for programmatic use by IDE plugin)
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(info));
	}
}

/** `fan server stop` — stop the background server */
export function serverStop(): void {
	const info = readServerInfo();
	if (!info) {
		console.log("fan server: not running");
		process.exit(1);
	}

	if (!isProcessAlive(info.pid)) {
		console.log("fan server: already stopped (cleaning up stale files)");
		removeServerFiles();
		return;
	}

	try {
		process.kill(info.pid, "SIGTERM");
		// Wait up to 5 seconds for graceful shutdown
		let waited = 0;
		const interval = setInterval(() => {
			waited += 200;
			if (!isProcessAlive(info.pid) || waited > 5000) {
				clearInterval(interval);
				if (isProcessAlive(info.pid)) {
					process.kill(info.pid, "SIGKILL");
					console.log("fan server: force stopped");
				} else {
					console.log("fan server: stopped");
				}
				removeServerFiles();
			}
		}, 200);
	} catch (err) {
		console.error(`fan server: failed to stop: ${err}`);
		process.exit(1);
	}
}

/** `fan server start` — start server as background daemon */
export async function serverStart(port?: number, host?: string): Promise<void> {
	// Check if already running
	const info = readServerInfo();
	if (info && isProcessAlive(info.pid)) {
		console.log(`fan server: already running (PID ${info.pid}, http://${info.host}:${info.port})`);
		process.exit(0);
	}

	// Clean up stale files
	removeServerFiles();

	// Spawn detached background process
	const serverPort = port || 3456;
	const serverHost = host || "localhost";

	// We spawn the same binary with a special internal flag to run in background mode
	const args = ["--_server-daemon"];
	if (serverPort !== 3456) args.push("--port", String(serverPort));
	if (serverHost !== "localhost") args.push("--host", serverHost);

	const child = spawn(process.execPath, [process.argv[1], ...args], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: {
			...process.env,
			FAN_SERVER_DAEMON: "1",
			NODE_OPTIONS: [
				process.env.NODE_OPTIONS,
				"--use-system-ca",
			].filter(Boolean).join(" "),
		},
	});

	child.unref();

	// Wait briefly for server to start and write info file
	await new Promise<void>((resolve) => {
		let attempts = 0;
		const maxAttempts = 50; // 5 seconds
		const check = setInterval(() => {
			attempts++;
			const newInfo = readServerInfo();
			if (newInfo && isProcessAlive(newInfo.pid)) {
				clearInterval(check);
				console.log(`fan server: started (PID ${newInfo.pid})`);
				console.log(`  URL: http://${serverHost}:${serverPort}`);
				resolve();
			} else if (attempts >= maxAttempts) {
				clearInterval(check);
				console.error("fan server: failed to start (timeout)");
				resolve();
			}
		}, 100);
	});
}
