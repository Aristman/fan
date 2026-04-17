/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type SessionAdapter, startServer } from "@fan/api-gateway";
import { type ImageContent, modelsAreEqual, supportsXhigh } from "@itone/fan-ai";
import { orchestratorExtension } from "@fan/orchestrator";
import { ProcessTerminal, setKeybindings, TUI } from "@itone/fan-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import { getAgentDir, getModelsPath, isBunBinary, VERSION } from "./config.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.js";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import { KeybindingsManager } from "./core/keybindings.js";
import type { ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import type { CreateAgentSessionOptions } from "./core/sdk.js";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, resetTimings, time } from "./core/timings.js";
import { allTools } from "./core/tools/index.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";
import { isLocalPath } from "./utils/paths.js";

async function handleInitCommand(args: string[]): Promise<boolean> {
	if (!args.includes("init")) return false;
	const { runInitWizard } = await import("./cli/init-wizard.js");
	await runInitWizard();
	return true;
}

async function handleDoctorCommand(args: string[]): Promise<boolean> {
	if (!args.includes("doctor")) return false;
	const { runDiagnostics } = await import("./cli/diagnostics.js");
	const ok = await runDiagnostics();
	process.exit(ok ? 0 : 1);
}

async function handleServerCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "server") return false;

	const subcommand = args[1];

	if (subcommand === "status") {
		const { serverStatus } = await import("./cli/server-command.js");
		serverStatus();
		return true;
	}

	if (subcommand === "stop") {
		const { serverStop } = await import("./cli/server-command.js");
		serverStop();
		return true;
	}

	if (subcommand === "start") {
		// Parse optional --port and --host from remaining args
		let port: number | undefined;
		let host: string | undefined;
		for (let i = 2; i < args.length; i++) {
			if (args[i] === "--port" && args[i + 1]) {
				port = Number(args[++i]);
			} else if (args[i] === "--host" && args[i + 1]) {
				host = args[++i];
			}
		}
		const { serverStart } = await import("./cli/server-command.js");
		await serverStart(port, host);
		return true;
	}

	// "fan server" without subcommand → rewrite to --mode server
	// Remove "server" from args so parseArgs doesn't treat it as a message
	args.splice(0, 1);
	process.env.FAN_FORCE_SERVER_MODE = "1";
	return false; // continue to normal flow
}

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function createSessionAdapter(runtime: AgentSessionRuntime): SessionAdapter {
	// Single source of truth: JSONL files on disk.
	// Runtime is only the execution engine — one active session at a time.

	// --- Disk cache (3s TTL) ---
	let diskCacheTime = 0;
	const DISK_CACHE_TTL = 3_000;
	let cachedDiskSessions: Array<{ id: string; path: string; title: string; modified: Date; messageCount: number }> =
		[];

	// --- WS subscription forwarding ---
	// runtime has ONE AgentSession at a time. When runtime switches session,
	// old AgentSession.subscribe handlers stop receiving events.
	// We maintain a global listener on runtime.session that forwards to
	// per-sessionId handler maps. On switch, we resubscribe.
	const sessionSubscribers = new Map<string, Set<(event: any) => void>>();
	let _unsubscribeRuntime: (() => void) | null = null;

	function ensureRuntimeSubscription() {
		if (_unsubscribeRuntime) return;
		_unsubscribeRuntime = runtime.session.subscribe((event: any) => {
			// Forward to all handlers registered for the current runtime sessionId
			const id = runtime.session.sessionId;
			const handlers = sessionSubscribers.get(id);
			if (handlers) {
				for (const h of handlers) h(event);
			}
		});
	}

	function resubscribeAfterSwitch() {
		// Old subscribe is dead after switchSession — resubscribe
		if (_unsubscribeRuntime) {
			_unsubscribeRuntime();
			_unsubscribeRuntime = null;
		}
		ensureRuntimeSubscription();
	}

	// --- Helpers ---
	function convertMessage(
		msg: any,
		idx: number,
		prefix: string,
	): {
		id: string;
		role: "user" | "assistant" | "tool";
		content: string;
		createdAt: string;
		model?: string;
		tokens?: number;
		cost?: number;
	} {
		const role = msg.role as "user" | "assistant" | "toolResult";
		let text = "";
		if (role === "user") {
			const c = msg.content;
			text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text || "").join("") : "";
		} else if (role === "assistant") {
			const blocks = msg.content || [];
			text = blocks
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text || "")
				.join("");
		} else if (role === "toolResult") {
			const c = msg.content;
			text = Array.isArray(c) ? c.map((b: any) => b.text || "").join("") : String(c || "");
		}
		return {
			id: `${prefix}-${idx}`,
			role: (role === "toolResult" ? "tool" : role) as "user" | "assistant" | "tool",
			content: text,
			model: role === "assistant" ? msg.model : undefined,
			tokens: role === "assistant" ? msg.usage?.totalTokens : undefined,
			cost: role === "assistant" ? msg.usage?.cost?.total : undefined,
			createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
		};
	}

	async function loadDiskSessions(): Promise<typeof cachedDiskSessions> {
		const now = Date.now();
		if (now - diskCacheTime < DISK_CACHE_TTL && cachedDiskSessions.length > 0) {
			return cachedDiskSessions;
		}
		diskCacheTime = now;
		try {
			cachedDiskSessions = (await SessionManager.listAll()).map((s) => ({
				id: s.id,
				path: s.path,
				title: s.name || s.firstMessage || "Untitled",
				modified: s.modified,
				messageCount: s.messageCount,
			}));
			return cachedDiskSessions;
		} catch (err) {
			console.error("[session-adapter] Failed to list disk sessions:", err);
			return cachedDiskSessions;
		}
	}

	function readDiskSessionMessages(
		sessionPath: string,
	): Array<{ id: string; role: "user" | "assistant" | "tool"; content: string; createdAt: string; model?: string }> {
		try {
			const mgr = SessionManager.open(sessionPath);
			return mgr.buildSessionContext().messages.map((msg, idx) => convertMessage(msg, idx, "disk"));
		} catch (err) {
			console.error(`[session-adapter] Failed to read disk session: ${sessionPath}`, err);
			return [];
		}
	}

	// Resolve session path by id (from disk cache)
	async function resolveSessionPath(sessionId: string): Promise<string | null> {
		if (sessionId === runtime.session.sessionId) {
			return runtime.session.sessionFile || null;
		}
		const diskSessions = await loadDiskSessions();
		const info = diskSessions.find((s) => s.id === sessionId);
		return info?.path ?? null;
	}

	// Ensure runtime is on the target session. Returns false if session not found.
	async function ensureSession(sessionId: string): Promise<boolean> {
		if (sessionId === runtime.session.sessionId) return true;
		const path = await resolveSessionPath(sessionId);
		if (!path) return false;
		console.log(`[session-adapter] Switching runtime to session ${sessionId} (${path})`);
		await runtime.switchSession(path);
		diskCacheTime = 0; // invalidate cache after switch
		resubscribeAfterSwitch();
		return true;
	}

	return {
		// --- listSessions: ALL from disk (JSONL files, same as TUI /resume) ---
		async listSessions() {
			const diskSessions = await loadDiskSessions();
			return diskSessions
				.map((s) => ({
					id: s.id,
					title: s.title,
					createdAt: s.modified.toISOString(),
					updatedAt: s.modified.toISOString(),
					messageCount: s.messageCount,
					sessionFile: s.path,
				}))
				.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		},

		// --- getSession: ALWAYS from disk (single source of truth) ---
		async getSession(id: string) {
			// Flush runtime session to disk first if it matches
			if (id === runtime.session.sessionId && runtime.session.sessionFile) {
				return {
					id,
					title: runtime.session.sessionName || "Current Session",
					model: runtime.session.model?.id,
					provider: runtime.session.model?.provider,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					messages: readDiskSessionMessages(runtime.session.sessionFile),
					sessionFile: runtime.session.sessionFile,
				};
			}

			const diskSessions = await loadDiskSessions();
			const diskInfo = diskSessions.find((s) => s.id === id);
			if (!diskInfo) return null;

			return {
				id,
				title: diskInfo.title,
				createdAt: diskInfo.modified.toISOString(),
				updatedAt: diskInfo.modified.toISOString(),
				messages: readDiskSessionMessages(diskInfo.path),
				sessionFile: diskInfo.path,
			};
		},

		// --- createSession: new session on disk via runtime ---
		async createSession(opts?: { title?: string }) {
			await runtime.newSession();
			diskCacheTime = 0;
			resubscribeAfterSwitch();
			return {
				id: runtime.session.sessionId,
				title: opts?.title || runtime.session.sessionName || "New Session",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
		},

		// --- deleteSession: remove JSONL file ---
		async deleteSession(id: string) {
			if (id === runtime.session.sessionId) return false;
			const diskSessions = await loadDiskSessions();
			const info = diskSessions.find((s) => s.id === id);
			if (!info) return false;
			try {
				const { unlinkSync } = await import("fs");
				unlinkSync(info.path);
				diskCacheTime = 0;
				return true;
			} catch {
				return false;
			}
		},

		// --- sendMessage: switch runtime to target session, then prompt ---
		async sendMessage(sessionId: string, message: string, streamingBehavior?: "steer" | "followUp") {
			const switched = await ensureSession(sessionId);
			if (!switched) return false;
			await runtime.session.prompt(message, {
				streamingBehavior: streamingBehavior ?? "followUp",
			});
			return true;
		},

		// --- subscribeToSession: forward events via adapter-level routing ---
		subscribeToSession(sessionId: string, handler: (event: any) => void) {
			ensureRuntimeSubscription();
			let handlers = sessionSubscribers.get(sessionId);
			if (!handlers) {
				handlers = new Set();
				sessionSubscribers.set(sessionId, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
				if (handlers.size === 0) {
					sessionSubscribers.delete(sessionId);
				}
			};
		},

		// --- getAvailableModels ---
		async getAvailableModels() {
			const current = runtime.session.model;
			if (!current) return [];
			return [
				{
					provider: current.provider,
					model: current.id,
					displayName: current.name,
				},
			];
		},
	};
}

type AppMode = "interactive" | "print" | "json" | "rpc" | "server";

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (process.env.FAN_FORCE_SERVER_MODE === "1" || parsed.web || parsed.mode === "server") {
		return "server";
	}
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc" | "server"> {
	return appMode === "json" ? "json" : "text";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	appMode: AppMode,
): Promise<SessionManager> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				SessionManager.listAll,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	// Server mode: continue most recent session (or create new if none exist)
	if (appMode === "server") {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		// --no-tools: start with no built-in tools
		// --tools can still add specific ones back
		if (parsed.tools && parsed.tools.length > 0) {
			options.tools = parsed.tools.map((name) => allTools[name]);
		} else {
			options.tools = [];
		}
	} else if (parsed.tools) {
		options.tools = parsed.tools.map((name) => allTools[name]);
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export async function main(args: string[]) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.FAN_OFFLINE);
	if (offlineMode) {
		process.env.FAN_OFFLINE = "1";
		process.env.FAN_SKIP_VERSION_CHECK = "1";
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleInitCommand(args)) {
		return;
	}

	if (await handleDoctorCommand(args)) {
		return;
	}

	if (await handleServerCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	let appMode = resolveAppMode(parsed, process.stdin.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);

	// Skip heavy initialization for worker subagent mode
	const isWorkerMode = parsed.mode === "json" && parsed.noSession;
	let migratedProviders: string[] = [];
	let deprecationWarnings: string[] = [];

	if (!isWorkerMode) {
		// Run migrations (pass cwd for project-local migrations)
		({ migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd()));
		time("runMigrations");

		// Initialize database schema (create tables if needed)
		try {
			const { initDatabase } = await import("@fan/db");
			await initDatabase();
		} catch (e) {
			console.error("Failed to initialize database:", e);
		}
	} else {
		time("runMigrations (skipped – worker mode)");
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const sessionDir = parsed.sessionDir ?? startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager, appMode);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const authStorage = AuthStorage.create();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: parsed.noOrchestrator ? [] : [orchestratorExtension],
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "warning" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			let effectiveThinking = created.session.thinkingLevel;
			if (!created.session.model.reasoning) {
				effectiveThinking = "off";
			} else if (effectiveThinking === "xhigh" && !supportsXhigh(created.session.model)) {
				effectiveThinking = "high";
			}
			if (effectiveThinking !== created.session.thinkingLevel) {
				created.session.setThinkingLevel(effectiveThinking);
			}
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry, resourceLoader } = services;

	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC and server modes which use stdin differently
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && appMode !== "server") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && appMode !== "server" && !session.model) {
		// Detect which providers have API keys configured
		const providerEnvVars: Record<string, string[]> = {
			OpenAI: ["OPENAI_API_KEY", "OPENAI_API_KEY"],
			Anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
			Google: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
			Groq: ["GROQ_API_KEY"],
			xAI: ["XAI_API_KEY"],
			OpenRouter: ["OPENROUTER_API_KEY"],
			Mistral: ["MISTRAL_API_KEY"],
			Cerebras: ["CEREBRAS_API_KEY"],
			"Z.AI": ["ZAI_API_KEY"],
			"GitHub Copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
			OpenCode: ["OPENCODE_API_KEY"],
			HuggingFace: ["HF_TOKEN"],
		};
		const configuredProviders: string[] = [];
		for (const [provider, envVars] of Object.entries(providerEnvVars)) {
			if (envVars.some((v) => process.env[v])) {
				configuredProviders.push(provider);
			}
		}

		console.error(chalk.red("No models available."));
		if (configuredProviders.length > 0) {
			console.error(chalk.yellow(`\nAPI keys found for: ${configuredProviders.join(", ")}`));
			console.error(chalk.yellow("But no models matched. Check your provider configuration or models.json."));
		} else {
			console.error(chalk.yellow("\nNo API keys configured for any provider."));
		}
		console.error(chalk.yellow("\nTo fix this:"));
		console.error("  1. Set an API key environment variable (see .env.example for available providers)");
		console.error('  2. Run "fan init" to create a default configuration');
		console.error("  3. Or create models.json manually:");
		console.error(chalk.dim(`     ${getModelsPath()}`));
		console.error(
			chalk.yellow(
				"\nAvailable env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, etc.",
			),
		);
		console.error(chalk.dim("See .env.example in the project root for the full list."));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.FAN_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: FAN_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	/** Resolve dashboard dist directory based on runtime mode */
	function getDashboardDir(): string | undefined {
		if (isBunBinary) {
			const pathMod = require("node:path") as {
				dirname: (p: string) => string;
				join: (...args: string[]) => string;
			};
			return pathMod.join(pathMod.dirname(process.execPath), "dashboard");
		}
		// Dev mode: check if dashboard dist exists in the monorepo
		const devPath = resolve(process.cwd(), "packages", "dashboard", "dist");
		if (existsSync(devPath)) return devPath;
		return undefined;
	}

	if (appMode === "server") {
		printTimings();
		const modelManager = runtime.session.modelManager;
		if (!modelManager) {
			console.error("Error: ModelManager is not available. Server mode requires model management to be enabled.");
			process.exit(1);
		}
		const adapter = createSessionAdapter(runtime);
		const { port, stop } = await startServer(modelManager, adapter, {
			port: parsed.port || 3456,
			host: parsed.host || "localhost",
			dashboardDir: getDashboardDir(),
		});

		// Write server info for background management (daemon mode)
		if (process.env.FAN_SERVER_DAEMON === "1") {
			const { writeServerInfo } = await import("./cli/server-command.js");
			const serverInfo = {
				pid: process.pid,
				port,
				host: parsed.host || "localhost",
				startTime: new Date().toISOString(),
				dashboardDir: getDashboardDir(),
			};
			writeServerInfo(serverInfo);
		}

		console.log(`[fan] Server mode active — http://${parsed.host || "localhost"}:${port}`);

		// Auto-open browser if --web flag was used (not in daemon mode)
		if (parsed.web && process.env.FAN_SERVER_DAEMON !== "1") {
			const url = `http://${parsed.host || "localhost"}:${port}`;
			console.log(`[fan] Opening dashboard in browser: ${url}`);
			try {
				const { exec } = await import("node:child_process");
				const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
				exec(`${cmd} "${url}"`);
			} catch {
				console.log(chalk.dim(`[fan] Could not open browser automatically. Open ${url} manually.`));
			}
		}

		// Keep process alive until interrupted
		await new Promise<void>((resolve) => {
			const onSignal = async (signal: string) => {
				console.log(`\n[fan] Received ${signal}, shutting down...`);
				await stop();
				await runtime.dispose();
				resolve();
			};
			process.on("SIGINT", () => onSignal("SIGINT"));
			process.on("SIGTERM", () => onSignal("SIGTERM"));
		});
	} else if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
