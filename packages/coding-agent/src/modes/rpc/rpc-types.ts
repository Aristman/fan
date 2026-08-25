/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@seaagents/fan-agent-core";
import type { ImageContent, Model } from "@seaagents/fan-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { SourceInfo } from "../../core/source-info.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// FAN Model Management
	| { id?: string; type: "get_routing_rules" }
	| { id?: string; type: "get_budget_status" }
	| { id?: string; type: "get_model_settings" }
	| { id?: string; type: "generate_token"; name: string }
	| { id?: string; type: "list_tokens" }
	| { id?: string; type: "revoke_token"; tokenId: string };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	/** stopReason of the last assistant message (additive, may be undefined) */
	lastStopReason?: string;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// FAN Model Management
	| {
			id?: string;
			type: "response";
			command: "get_routing_rules";
			success: true;
			data: {
				rules: Array<{
					id: string;
					name: string;
					provider: string;
					model: string;
					fallback?: string;
					enabled: boolean;
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_budget_status";
			success: true;
			data: {
				budgets: Array<{
					provider: string;
					period: string;
					tokensUsed: number;
					costUsed: number;
					tokenLimit?: number;
					costLimit?: number;
					exceeded: boolean;
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_model_settings";
			success: true;
			data: {
				settings: Array<{
					id: string;
					provider: string;
					model: string;
					temperature?: number | null;
					maxTokens?: number | null;
					thinking?: string | null;
					isDefault: boolean;
					priority: number;
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "generate_token";
			success: true;
			data: { token: { id: string; name: string; token: string; createdAt: string; lastUsed?: string } };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_tokens";
			success: true;
			data: { tokens: Array<{ id: string; name: string; createdAt: string; lastUsed?: string }> };
	  }
	| { id?: string; type: "response"; command: "revoke_token"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// RPC Remote Tool (bidirectional channel for worker→parent tool proxy)
// ============================================================================

/**
 * Child→Parent request to invoke a remote tool (e.g., MCP tool via parent-side manager).
 * Protocol-neutral: semantics are defined by the orchestrator extension's
 * `RemoteToolBroker` and the corresponding proxy tool registered in the worker.
 */
export interface RpcRemoteToolRequest {
	type: "remote_tool_request";
	/** Correlation id, unique per request */
	id: string;
	/** Normalized tool ID: e.g. "mcp__filesystem__read_file" */
	toolId: string;
	/** Parsed arguments (already validated by worker's local schema) */
	args: Record<string, unknown>;
}

export interface RpcRemoteToolCancel {
	type: "remote_tool_cancel";
	id: string;
}

/**
 * Parent→Child response with the tool's result. Always returned (success or error).
 */
export type RpcRemoteToolResponse =
	| {
			type: "remote_tool_response";
			id: string;
			content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
			isError: false;
	  }
	| {
			type: "remote_tool_response";
			id: string;
			content: Array<{ type: "text"; text: string }>;
			isError: true;
			errorMessage?: string;
	  };

export interface RpcToolDescriptor {
	/** Unique tool ID across all tools proxied via this channel */
	id: string;
	/** Human-readable label for UI */
	label?: string;
	/** Description for the LLM */
	description: string;
	/** JSON Schema for tool inputs */
	inputSchema: Record<string, unknown>;
	/** MCP server name (for debugging / filtering) */
	serverName: string;
	annotations?: {
		readOnly?: boolean;
		destructive?: boolean;
		openWorld?: boolean;
	};
}

export type RpcRemoteToolCatalog = { type: "remote_tool_catalog"; tools: RpcToolDescriptor[] };

// ============================================================================
// Discriminated unions for child→parent bidirectional messaging
// ============================================================================

/** All child→parent request types */
export type RpcChildRequest = RpcRemoteToolRequest | RpcRemoteToolCancel | RpcExtensionUIRequest;

/** All parent→child response types */
export type RpcParentResponse = RpcRemoteToolResponse | RpcExtensionUIResponse;

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
