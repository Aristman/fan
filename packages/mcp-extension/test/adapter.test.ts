/**
 * Tests for adapter.ts: jsonSchemaToTypeBox, normalizeToolName, mcpToolToDefinition (F-1.6).
 *
 * TC-F1.6-1: jsonSchemaToTypeBox: object with simple properties
 * TC-F1.6-2: jsonSchemaToTypeBox: array of strings
 * TC-F1.6-3: jsonSchemaToTypeBox: enum
 * TC-F1.6-4: jsonSchemaToTypeBox: $ref → Type.Any() + warning
 * TC-F1.6-5: normalizeToolName
 * TC-F1.6-6: mcpToolToDefinition: name normalisation
 * TC-F1.6-7: mcpToolToDefinition: execute calls client
 */

import { describe, expect, it, vi } from "vitest";
import {
	jsonSchemaToTypeBox,
	normalizeToolName,
	mcpToolToDefinition,
	type McpToolDescriptor,
	type AdapterClient,
} from "../src/adapter.js";

// ──────────────────────────────────────────────────
// TC-F1.6-1: jsonSchemaToTypeBox — object
// ──────────────────────────────────────────────────

describe("TC-F1.6-1: jsonSchemaToTypeBox — object", () => {
	it("converts an object schema with typed properties", () => {
		const result = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "integer" },
			},
			required: ["name"],
		});

		// TypeBox objects have a `type` property set to "object"
		expect((result as any).type).toBe("object");
		// Required field should be present
		expect((result as any).required).toContain("name");
		expect((result as any).required).not.toContain("age");
		// Properties should exist
		expect((result as any).properties).toBeDefined();
		expect((result as any).properties.name.type).toBe("string");
		expect((result as any).properties.age.type).toBe("integer");
	});

	it("converts an object without explicit type", () => {
		// MCP sometimes omits "type": "object" when properties are present
		const result = jsonSchemaToTypeBox({
			properties: { path: { type: "string" } },
			required: ["path"],
		});

		expect((result as any).type).toBe("object");
		expect((result as any).properties.path.type).toBe("string");
	});

	it("handles nested objects", () => {
		const result = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				meta: {
					type: "object",
					properties: {
						version: { type: "integer" },
					},
					required: ["version"],
				},
			},
			required: ["meta"],
		});

		expect((result as any).type).toBe("object");
		expect((result as any).properties.meta.type).toBe("object");
		expect((result as any).properties.meta.properties.version.type).toBe("integer");
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-2: jsonSchemaToTypeBox — array
// ──────────────────────────────────────────────────

describe("TC-F1.6-2: jsonSchemaToTypeBox — array", () => {
	it("converts array of strings", () => {
		const result = jsonSchemaToTypeBox({
			type: "array",
			items: { type: "string" },
		});

		expect((result as any).type).toBe("array");
		expect((result as any).items).toBeDefined();
		expect((result as any).items.type).toBe("string");
	});

	it("converts array without items (fallback to any)", () => {
		const result = jsonSchemaToTypeBox({ type: "array" });
		expect((result as any).type).toBe("array");
	});

	it("converts array of objects", () => {
		const result = jsonSchemaToTypeBox({
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "integer" },
					label: { type: "string" },
				},
				required: ["id"],
			},
		});

		expect((result as any).type).toBe("array");
		expect((result as any).items.type).toBe("object");
		expect((result as any).items.properties.id.type).toBe("integer");
		expect((result as any).items.properties.label.type).toBe("string");
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-3: jsonSchemaToTypeBox — enum
// ──────────────────────────────────────────────────

describe("TC-F1.6-3: jsonSchemaToTypeBox — enum", () => {
	it("converts string enum to Union of Literals", () => {
		const result = jsonSchemaToTypeBox({ enum: ["read", "write", "execute"] });

		// TypeBox Union produces { anyOf: [...] } without a top-level type
		expect(Array.isArray((result as any).anyOf)).toBe(true);
		expect((result as any).anyOf).toHaveLength(3);
		expect((result as any).anyOf[0].type).toBe("string");
		expect((result as any).anyOf[0].const).toBe("read");
		expect((result as any).anyOf[1].const).toBe("write");
		expect((result as any).anyOf[2].const).toBe("execute");
	});

	it("converts numeric enum", () => {
		const result = jsonSchemaToTypeBox({ enum: [1, 2, 3] });

		expect(Array.isArray((result as any).anyOf)).toBe(true);
		expect((result as any).anyOf).toHaveLength(3);
		expect((result as any).anyOf[0].const).toBe(1);
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-4: jsonSchemaToTypeBox — $ref fallback
// ──────────────────────────────────────────────────

describe("TC-F1.6-4: jsonSchemaToTypeBox — $ref fallback", () => {
	it("falls back to Type.Any() for $ref with warning", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = jsonSchemaToTypeBox({ $ref: "#/definitions/Foo" });

			// Type.Any() produces no type property
			expect((result as any).type).toBeUndefined();
			expect(spy).toHaveBeenCalledWith(
				expect.stringMatching(/\$ref/),
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("falls back to Type.Any() for oneOf with warning", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = jsonSchemaToTypeBox({
				oneOf: [
					{ type: "string" },
					{ type: "integer" },
				],
			});

			expect((result as any).type).toBeUndefined();
			expect(spy).toHaveBeenCalledWith(
				expect.stringMatching(/oneOf/),
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("falls back to Type.Any() for anyOf with warning", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = jsonSchemaToTypeBox({
				anyOf: [
					{ type: "string" },
					{ type: "number" },
				],
			});

			expect((result as any).type).toBeUndefined();
			expect(spy).toHaveBeenCalledWith(
				expect.stringMatching(/anyOf/),
			);
		} finally {
			spy.mockRestore();
		}
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-5: normalizeToolName
// ──────────────────────────────────────────────────

describe("TC-F1.6-5: normalizeToolName", () => {
	it("produces mcp__<serverId>__<toolName>", () => {
		expect(normalizeToolName("fs", "read_file")).toBe("mcp__fs__read_file");
		expect(normalizeToolName("github", "search_repositories")).toBe(
			"mcp__github__search_repositories",
		);
		expect(normalizeToolName("filesystem", "list_directory")).toBe(
			"mcp__filesystem__list_directory",
		);
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-6: mcpToolToDefinition — name and metadata
// ──────────────────────────────────────────────────

describe("TC-F1.6-6: mcpToolToDefinition — metadata", () => {
	it("normalizes the tool name", () => {
		const fakeClient: AdapterClient = { callTool: vi.fn() };
		const def = mcpToolToDefinition("filesystem", {
			name: "read_file",
			description: "Read a file from disk",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		}, fakeClient);

		expect(def.name).toBe("mcp__filesystem__read_file");
		expect(def.description).toBe("Read a file from disk");
		expect(def.label).toBe("read_file");
	});

	it("uses fallback description when not provided", () => {
		const fakeClient: AdapterClient = { callTool: vi.fn() };
		const def = mcpToolToDefinition("fs", {
			name: "x",
			inputSchema: {},
		}, fakeClient);

		expect(def.description).toBe("MCP tool x from server fs");
	});

	it("converts inputSchema to TypeBox parameters", () => {
		const fakeClient: AdapterClient = { callTool: vi.fn() };
		const def = mcpToolToDefinition("fs", {
			name: "write_file",
			description: "Write content to a file",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
		}, fakeClient);

		expect((def.parameters as any).type).toBe("object");
		expect((def.parameters as any).properties.path.type).toBe("string");
		expect((def.parameters as any).properties.content.type).toBe("string");
		expect((def.parameters as any).required).toEqual(["path", "content"]);
	});
});

// ──────────────────────────────────────────────────
// TC-F1.6-7: mcpToolToDefinition — execute delegation
// ──────────────────────────────────────────────────

describe("TC-F1.6-7: mcpToolToDefinition — execute", () => {
	it("calls client.callTool with correct arguments", async () => {
		const mockCallTool = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});

		const fakeClient: AdapterClient = { callTool: mockCallTool };
		const def = mcpToolToDefinition("fs", {
			name: "x",
			inputSchema: {},
		}, fakeClient);

		const result = await def.execute(
			"call-1",
			{ path: "/x" },
			undefined,
			undefined,
			undefined as any,
		);

		expect(mockCallTool).toHaveBeenCalledWith(
			{ name: "x", arguments: { path: "/x" } },
			{ signal: undefined },
		);
		expect(result.content[0].text).toBe("ok");
	});

	it("filters non-text mcp content blocks", async () => {
		const mockCallTool = vi.fn().mockResolvedValue({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "base64...", mimeType: "image/png" },
				{ type: "audio", data: "...", mimeType: "audio/wav" },
			],
			isError: false,
		});

		const fakeClient: AdapterClient = { callTool: mockCallTool };
		const def = mcpToolToDefinition("fs", {
			name: "x",
			inputSchema: {},
		}, fakeClient);

		const result = await def.execute(
			"call-2",
			{},
			undefined,
			undefined,
			undefined as any,
		);

		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toBe("hello");
	});

	it("handles isError: true from the server", async () => {
		const mockCallTool = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "Error: permission denied" }],
			isError: true,
		});

		const fakeClient: AdapterClient = { callTool: mockCallTool };
		const def = mcpToolToDefinition("fs", {
			name: "x",
			inputSchema: {},
		}, fakeClient);

		const result = await def.execute(
			"call-3",
			{},
			undefined,
			undefined,
			undefined as any,
		);

		expect(result.content[0].text).toBe("Error: permission denied");
	});
});
