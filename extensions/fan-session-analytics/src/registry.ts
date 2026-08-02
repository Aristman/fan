import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Registry of known built-in tool names.
// Anything not in this set is considered an extension tool candidate (D7).

export const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
	// Core tools
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	// Orchestrator tools
	"delegate_task",
	"TaskCreate",
	"TaskUpdate",
	"list_tasks",
	"assess_task",
	"classify_task",
	"question",
	"questionnaire",
	"stop_worker",
	"TaskClear",
	"cancel_task",
	// Web tools
	"web_search",
	"web_reader",
	// Memory tools
	"memory_remember",
	"memory_search",
	"memory_forget",
	"memory_list",
	// Sofa / misc tools
	"sofa_search",
	"sofa_read",
	// Store tools
	"store_search",
	"store_install",
	"store_remove",
	"store_update",
	"store_list",
	// Misc
	"lavish",
	"delegate",
	// Session analytics (self-reference)
	"session_analyze",
]);

export const ORCHESTRATOR_TOOLS: ReadonlySet<string> = new Set([
	"delegate_task",
	"TaskCreate",
	"TaskUpdate",
	"list_tasks",
	"assess_task",
	"classify_task",
	"question",
	"questionnaire",
	"stop_worker",
	"TaskClear",
	"cancel_task",
]);

// Known tool names provided by installed extensions.
// Best-effort: scanned from ~/.fan/agent/extensions/<name>/package.json.
// If scanning fails, falls back to empty set (graceful degradation).
let _dynamicExtensionTools: ReadonlySet<string> | null = null;

// Known extension → tool name mappings for common FAN extensions
const KNOWN_EXTENSION_TOOLS: Record<string, string[]> = {
	"fan-orchestrator": [
		"delegate_task",
		"TaskCreate",
		"TaskUpdate",
		"list_tasks",
		"assess_task",
		"classify_task",
		"question",
		"questionnaire",
		"stop_worker",
		"TaskClear",
		"cancel_task",
	],
	"fan-web-search": ["web_search", "web_reader"],
	"fan-persistent-memory": [
		"memory_remember",
		"memory_search",
		"memory_forget",
		"memory_list",
	],
	"fan-lavish": ["lavish"],
	"fan-ask-answer": ["question", "questionnaire"],
	"fan-soul": [],
	"fan-loop": [],
	"fan-session-analytics": ["session_analyze"],
};

// Scan installed extensions for tool names (best-effort, cached).
// Reads ~/.fan/agent/extensions/<name>/package.json to discover extension names,
// then maps them to known tool names.
// Returns empty set if scanning fails — never throws.
function scanExtensionTools(): ReadonlySet<string> {
	if (_dynamicExtensionTools !== null) return _dynamicExtensionTools;

	const toolNames = new Set<string>();

	try {
		const extensionsDir = join(homedir(), ".fan", "agent", "extensions");
		if (!existsSync(extensionsDir)) {
			_dynamicExtensionTools = toolNames;
			return toolNames;
		}

		const dirs = readdirSync(extensionsDir, { withFileTypes: true });
		for (const dirent of dirs) {
			if (!dirent.isDirectory()) continue;

			try {
				const pkgPath = join(extensionsDir, dirent.name, "package.json");
				if (!existsSync(pkgPath)) continue;

				const raw = readFileSync(pkgPath, "utf-8");
				const pkg = JSON.parse(raw);
				const extName = pkg?.fan?.name || pkg?.name || dirent.name;

				// Map known extension tool names
				const knownTools = KNOWN_EXTENSION_TOOLS[extName];
				if (knownTools) {
					for (const tool of knownTools) {
						toolNames.add(tool);
					}
				}
			} catch {
				// Skip unreadable package.json — graceful degradation
			}
		}
	} catch {
		// Extensions directory not readable — graceful degradation
	}

	_dynamicExtensionTools = toolNames;
	return toolNames;
}

/**
 * Get dynamically discovered extension tool names.
 * First call triggers scan; subsequent calls return cached result.
 */
export function getDynamicExtensionTools(): ReadonlySet<string> {
	return scanExtensionTools();
}

export function isBuiltinTool(name: string): boolean {
	return BUILTIN_TOOLS.has(name);
}

export function isOrchestratorTool(name: string): boolean {
	return ORCHESTRATOR_TOOLS.has(name);
}
