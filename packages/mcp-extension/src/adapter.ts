/**
 * MCP tool-to-FAN adapter (F-1.6).
 *
 * Converts MCP Tool descriptors (from tools/list) into FAN ToolDefinition
 * objects that can be registered with the extension system.
 *
 * Key exports:
 * - jsonSchemaToTypeBox(schema) — converts MCP JSON Schema to TypeBox TSchema
 * - normalizeToolName(serverId, toolName) — generates mcp__<serverId>__<toolName>
 * - mcpToolToDefinition(serverId, mcpTool, client) — full ToolDefinition wrapper
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { ExtensionContext } from "@seaagents/fan-coding-agent";
import type { ToolDefinition } from "@seaagents/fan-coding-agent";
import type { AgentToolResult } from "@seaagents/fan-agent-core";
import { executeMcpTool } from "./executor.js";
import { withLogging } from "./logger.js";

// ──────────────────────────────────────────────────
// JSON Schema → TypeBox
// ──────────────────────────────────────────────────

/**
 * Convert a JSON Schema (subset used by MCP inputSchema) to a TypeBox TSchema.
 *
 * Supports the following constructs:
 * - object (with properties/required)
 * - string, number, integer, boolean
 * - array (with items)
 * - enum (converted to Type.Union of Type.Literal)
 * - nested objects
 * - optional fields (not in required array → Type.Optional)
 *
 * Unsupported constructs ($ref, oneOf, anyOf) fall back to Type.Any() with
 * a console.warn diagnostic.
 */
export function jsonSchemaToTypeBox(schema: any): TSchema {
	if (!schema || typeof schema !== "object") {
		return Type.Any();
	}

	// Unsupported constructs — fall back gracefully
	if (schema.$ref) {
		console.warn(
			`jsonSchemaToTypeBox: $ref not supported (${schema.$ref}), using Type.Any()`,
		);
		return Type.Any();
	}
	if (schema.oneOf) {
		console.warn(
			`jsonSchemaToTypeBox: oneOf not supported, using Type.Any()`,
		);
		return Type.Any();
	}
	if (schema.anyOf) {
		console.warn(
			`jsonSchemaToTypeBox: anyOf not supported, using Type.Any()`,
		);
		return Type.Any();
	}

	const type = schema.type;

	// Object (either explicit type:"object" or presence of properties)
	if (type === "object" || schema.properties) {
		const properties: Record<string, TSchema> = {};
		const required = new Set<string>(schema.required ?? []);
		for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
			const ts = jsonSchemaToTypeBox(propSchema);
			properties[key] = required.has(key) ? ts : Type.Optional(ts);
		}
		return Type.Object(properties);
	}

	// Array
	if (type === "array") {
		const items = schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Any();
		return Type.Array(items);
	}

	// Enum → Type.Union of Type.Literal
	if (Array.isArray(schema.enum)) {
		const literals = schema.enum.map((v: any) => {
			// Type.Literal accepts string | number | boolean
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				return Type.Literal(v);
			}
			// Fallback for null, objects, etc.
			console.warn(
				`jsonSchemaToTypeBox: unsupported enum value type (${typeof v}), skipping literal`,
			);
			return Type.String();
		});
		return Type.Union(literals as [TSchema, ...TSchema[]]);
	}

	// Primitives
	if (type === "string") return Type.String();
	if (type === "integer") return Type.Integer();
	if (type === "number") return Type.Number();
	if (type === "boolean") return Type.Boolean();

	// Fallback
	return Type.Any();
}

// ──────────────────────────────────────────────────
// Name normalisation
// ──────────────────────────────────────────────────

/**
 * Normalize an MCP tool name to the FAN namespace convention.
 *
 * Pattern: `mcp__<serverId>__<toolName>`
 *
 * This avoids collisions between tools from different MCP servers
 * and clearly identifies the tool's origin.
 */
export function normalizeToolName(serverId: string, toolName: string): string {
	return `mcp__${serverId}__${toolName}`;
}

// ──────────────────────────────────────────────────
// MCP Tool descriptor
// ──────────────────────────────────────────────────

/**
 * Lightweight descriptor matching the MCP Tool shape returned by tools/list.
 */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: any;
	outputSchema?: any;
}

// ──────────────────────────────────────────────────
// Adapter client interface
// ──────────────────────────────────────────────────

/**
 * Minimal client interface for calling MCP tools.
 *
 * This abstraction allows mcpToolToDefinition to work with both real
 * MCP Client instances and test doubles.
 *
 * The content block shape mirrors the MCP SDK CallToolResult content union.
 */
export interface AdapterClient {
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		options?: { signal?: AbortSignal; onprogress?: (progress: any) => void },
	): Promise<{
		content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	}>;
}

// ──────────────────────────────────────────────────
// ToolDefinition factory
// ──────────────────────────────────────────────────

/**
 * Convert an MCP tool descriptor (from tools/list) into a FAN ToolDefinition.
 *
 * The resulting ToolDefinition:
 * - name: normalized as `mcp__<serverId>__<toolName>` (via normalizeToolName)
 * - description: from mcpTool.description (or a fallback)
 * - parameters: MCP inputSchema converted to TypeBox (via jsonSchemaToTypeBox)
 * - execute: delegates to executeMcpTool (text/image mapping, timeout, error handling)
 */
export function mcpToolToDefinition(
	serverId: string,
	mcpTool: McpToolDescriptor,
	client: AdapterClient,
): ToolDefinition {
	return {
		name: normalizeToolName(serverId, mcpTool.name),
		label: mcpTool.name,
		description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverId}`,
		parameters: jsonSchemaToTypeBox(mcpTool.inputSchema) as any,
		execute: async (
			_toolCallId: string,
			params: any,
			signal?: AbortSignal,
			onUpdate?: any,
			_ctx?: ExtensionContext,
		) => {
			return withLogging(
				serverId,
				mcpTool.name,
				() =>
					executeMcpTool(
						(args, opts) => client.callTool(args, opts),
						mcpTool.name,
						params as Record<string, unknown>,
						signal,
						onUpdate,
					),
			);
		},
	};
}
