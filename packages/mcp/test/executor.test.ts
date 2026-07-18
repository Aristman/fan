/**
 * Tests for executor.ts: mapCallToolResult & executeMcpTool (F-1.7).
 *
 * TC-F1.7-1: text content → AgentToolResult
 * TC-F1.7-2: image content → image block
 * TC-F1.7-3: isError: true → details.isError = true
 * TC-F1.7-4: structuredContent preserved in details
 * TC-F1.7-5: unsupported content type → fallback text
 * TC-F1.7-6: mixed content (text + unsupported) → text + fallback
 * TC-F1.7-7: empty content
 * TC-F1.7-8: executeMcpTool success path
 * TC-F1.7-9: executeMcpTool error handling
 */

import { describe, expect, it, vi } from "vitest";
import { executeMcpTool, mapCallToolResult } from "../src/executor.js";

// ──────────────────────────────────────────────────
// TC-F1.7-1: text content
// ──────────────────────────────────────────────────

describe("TC-F1.7-1: text content", () => {
	it("maps text content block to AgentToolResult", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "hello" }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({ type: "text", text: "hello" });
		expect(result.details.isError).toBeUndefined();
	});

	it("maps multiple text blocks", () => {
		const result = mapCallToolResult({
			content: [
				{ type: "text", text: "line1" },
				{ type: "text", text: "line2" },
			],
		});

		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "line1" });
		expect(result.content[1]).toEqual({ type: "text", text: "line2" });
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-2: image content
// ──────────────────────────────────────────────────

describe("TC-F1.7-2: image content", () => {
	it("maps image content block to ImageContent", () => {
		const result = mapCallToolResult({
			content: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: "BASE64",
		});
	});

	it("handles jpeg mime type", () => {
		const result = mapCallToolResult({
			content: [{ type: "image", data: "abc123", mimeType: "image/jpeg" }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "image",
			mimeType: "image/jpeg",
			data: "abc123",
		});
	});

	it("skips image block missing data field", () => {
		const result = mapCallToolResult({
			content: [{ type: "image", mimeType: "image/png" } as any],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Unsupported");
	});

	it("skips image block missing mimeType field", () => {
		const result = mapCallToolResult({
			content: [{ type: "image", data: "data" } as any],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Unsupported");
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-3: isError passthrough
// ──────────────────────────────────────────────────

describe("TC-F1.7-3: isError passthrough", () => {
	it("maps isError: true to details.isError = true", () => {
		const result = mapCallToolResult({ content: [], isError: true });

		expect(result.details.isError).toBe(true);
	});

	it("omits details.isError when isError is false", () => {
		const result = mapCallToolResult({ content: [], isError: false });

		expect(result.details.isError).toBeUndefined();
	});

	it("omits details.isError when isError is undefined", () => {
		const result = mapCallToolResult({ content: [] });

		expect(result.details.isError).toBeUndefined();
	});

	it("preserves text content alongside isError", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "error message" }],
			isError: true,
		});

		expect(result.content[0]).toHaveProperty("text", "error message");
		expect(result.details.isError).toBe(true);
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-4: structuredContent preservation
// ──────────────────────────────────────────────────

describe("TC-F1.7-4: structuredContent preservation", () => {
	it("preserves structuredContent in details", () => {
		const result = mapCallToolResult({
			content: [],
			structuredContent: { foo: 1, bar: "baz" },
		});

		expect(result.details.structuredContent).toEqual({ foo: 1, bar: "baz" });
	});

	it("omits details.structuredContent when absent", () => {
		const result = mapCallToolResult({ content: [] });

		expect(result.details.structuredContent).toBeUndefined();
	});

	it("combines structuredContent with isError", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "error" }],
			isError: true,
			structuredContent: { code: 400 },
		});

		expect(result.content[0]).toHaveProperty("text", "error");
		expect(result.details.isError).toBe(true);
		expect(result.details.structuredContent).toEqual({ code: 400 });
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-5: unsupported content type
// ──────────────────────────────────────────────────

describe("TC-F1.7-5: unsupported content type", () => {
	it("audio content → fallback text", () => {
		const result = mapCallToolResult({
			content: [{ type: "audio", data: "..." }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Unsupported content types: audio");
	});

	it("resource_link → fallback text", () => {
		const result = mapCallToolResult({
			content: [{ type: "resource_link", text: "some ref" }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Unsupported content types: resource_link");
	});

	it("embedded_resource → fallback text", () => {
		const result = mapCallToolResult({
			content: [{ type: "embedded_resource" }],
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Unsupported content types: embedded_resource");
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-6: mixed content (text + unsupported)
// ──────────────────────────────────────────────────

describe("TC-F1.7-6: mixed content", () => {
	it("text + resource_link → text + fallback", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "ok" }, { type: "resource_link" }],
		});

		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
		expect(result.content[1]).toEqual({
			type: "text",
			text: expect.stringContaining("Unsupported content types: resource_link"),
		});
	});

	it("text + audio + text → supported blocks preserved, fallback appended", () => {
		const result = mapCallToolResult({
			content: [
				{ type: "text", text: "A" },
				{ type: "audio", data: "..." },
				{ type: "text", text: "B" },
			],
		});

		// Unsupported blocks are skipped and a single fallback is appended.
		// So [text, audio, text] → [text("A"), text("B"), fallback]
		expect(result.content).toHaveLength(3);
		expect(result.content[0]).toEqual({ type: "text", text: "A" });
		expect(result.content[1]).toEqual({ type: "text", text: "B" });
		expect(result.content[2]).toEqual({
			type: "text",
			text: expect.stringContaining("Unsupported content types: audio"),
		});
	});

	it("multiple unsupported types listed together", () => {
		const result = mapCallToolResult({
			content: [{ type: "audio" }, { type: "resource_link" }],
		});

		expect(result.content).toHaveLength(1);
		expect((result.content[0] as any).text).toContain("audio");
		expect((result.content[0] as any).text).toContain("resource_link");
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-7: empty content
// ──────────────────────────────────────────────────

describe("TC-F1.7-7: empty content", () => {
	it("returns empty content array when no blocks provided", () => {
		const result = mapCallToolResult({ content: [] });

		expect(result.content).toEqual([]);
		expect(result.details.isError).toBeUndefined();
	});

	it("handles undefined content gracefully", () => {
		const result = mapCallToolResult({});

		expect(result.content).toEqual([]);
		expect(result.details.isError).toBeUndefined();
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-8: executeMcpTool success
// ──────────────────────────────────────────────────

describe("TC-F1.7-8: executeMcpTool success path", () => {
	it("calls callTool and maps result", async () => {
		const fakeClient = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});

		const result = await executeMcpTool(fakeClient, "x", { a: 1 }, undefined);

		expect(fakeClient).toHaveBeenCalledWith(
			{ name: "x", arguments: { a: 1 } },
			expect.objectContaining({ signal: expect.any(Object) }),
		);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("passes signal from caller", async () => {
		const ac = new AbortController();
		const fakeClient = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "done" }],
		});

		await executeMcpTool(fakeClient, "y", {}, ac.signal);

		expect(fakeClient).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(Object) }),
		);
	});

	it("maps image content through executeMcpTool", async () => {
		const fakeClient = vi.fn().mockResolvedValue({
			content: [{ type: "image", data: "imgdata", mimeType: "image/webp" }],
		});

		const result = await executeMcpTool(fakeClient, "img", {}, undefined);

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "image",
			data: "imgdata",
			mimeType: "image/webp",
		});
	});
});

// ──────────────────────────────────────────────────
// TC-F1.7-9: executeMcpTool error handling
// ──────────────────────────────────────────────────

describe("TC-F1.7-9: executeMcpTool error handling", () => {
	it("maps thrown error to isError result", async () => {
		const fakeClient = vi.fn().mockRejectedValue(new Error("transport broke"));

		const result = await executeMcpTool(fakeClient, "x", {}, undefined);

		expect(result.details.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("transport broke");
	});

	it("handles non-Error thrown values", async () => {
		const fakeClient = vi.fn().mockRejectedValue("string error");

		const result = await executeMcpTool(fakeClient, "x", {}, undefined);

		expect(result.details.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("string error");
	});

	it("handles null thrown value", async () => {
		const fakeClient = vi.fn().mockRejectedValue(null);

		const result = await executeMcpTool(fakeClient, "x", {}, undefined);

		expect(result.details.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("null");
	});

	it("timeout produces isError result", async () => {
		// Simulate an MCP client that respects the abort signal
		const fakeClient = vi.fn().mockImplementation(
			(_args: any, opts?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					const signal = opts?.signal;
					if (signal?.aborted) {
						reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
						return;
					}
					const onAbort = () => {
						reject(signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason)));
					};
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
		);

		const result = await executeMcpTool(fakeClient, "x", {}, undefined, undefined, 10);

		expect(result.details.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("timed out");
	}, 10_000);
});
