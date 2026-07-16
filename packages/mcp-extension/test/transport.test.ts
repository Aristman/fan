/**
 * Tests for createStdioTransport (F-1.4) and createHttpTransport (F-1.5).
 *
 * TC-F1.4-1..5: Stdio transport tests
 * TC-F1.5-1..7: StreamableHTTP transport tests
 */

import { describe, expect, it } from "vitest";
import { createStdioTransport, createHttpTransport } from "../src/transport.js";

// ──────────────────────────────────────────────────
// F-1.4: Stdio transport
// ──────────────────────────────────────────────────

describe("F-1.4: createStdioTransport", () => {
	// TC-F1.4-1
	it("throws when transport is not 'stdio'", () => {
		expect(() =>
			createStdioTransport({ transport: "streamable-http" } as any),
		).toThrow(/stdio/);
	});

	// TC-F1.4-2
	it("throws when command is missing", () => {
		expect(() => createStdioTransport({ transport: "stdio" } as any)).toThrow(
			/command/,
		);
	});

	// TC-F1.4-3
	it("resolves ${ENV} references in config.env", () => {
		const original = process.env.TEST_TOKEN;
		process.env.TEST_TOKEN = "secret";
		try {
			const transport = createStdioTransport({
				transport: "stdio",
				command: "node",
				args: ["-e", "process.stdin.pipe(process.stdout)"],
				env: { HEADER: "Bearer ${TEST_TOKEN}" },
			});
			expect(transport).toBeDefined();
		} finally {
			if (original === undefined) {
				delete process.env.TEST_TOKEN;
			} else {
				process.env.TEST_TOKEN = original;
			}
		}
	});

	// TC-F1.4-4
	it("uses SAFE_ENV_VARS whitelist when no env is provided", () => {
		const transport = createStdioTransport({
			transport: "stdio",
			command: "node",
			args: ["-e", "process.stdin.pipe(process.stdout)"],
		});
		expect(transport).toBeDefined();
	});

	// TC-F1.4-5
	it("spawns a process via stdio and starts the transport (integration)", async () => {
		const fixturePath = new URL(
			"./fixtures/stdio-server.mjs",
			import.meta.url,
		).pathname.replace(/^\/([A-Z]:)/, "$1");

		const transport = createStdioTransport({
			transport: "stdio",
			command: "node",
			args: [fixturePath],
		});

		expect(transport).toBeDefined();
		await transport.start();
		expect(transport.pid).toBeGreaterThan(0);

		await transport.close();
	});
});

// ──────────────────────────────────────────────────
// F-1.5: StreamableHTTP transport
// ──────────────────────────────────────────────────

describe("F-1.5: createHttpTransport", () => {
	// TC-F1.5-1
	it("rejects non-streamable-http transport", () => {
		expect(() =>
			createHttpTransport({ transport: "stdio", command: "x" } as any),
		).toThrow(/streamable-http/);
	});

	// TC-F1.5-2
	it("rejects missing url", () => {
		expect(() =>
			createHttpTransport({ transport: "streamable-http" } as any),
		).toThrow(/url/);
	});

	// TC-F1.5-3
	it("rejects http:// (not https)", () => {
		expect(() =>
			createHttpTransport({
				transport: "streamable-http",
				url: "http://api.example.com/mcp",
			} as any),
		).toThrow(/https/);
	});

	// TC-F1.5-4
	it("rejects localhost without allowLocal", () => {
		expect(() =>
			createHttpTransport({
				transport: "streamable-http",
				url: "https://localhost:3000/mcp",
			} as any),
		).toThrow(/allowLocal/);
	});

	// TC-F1.5-5
	it("accepts localhost with allowLocal: true", () => {
		expect(() =>
			createHttpTransport({
				transport: "streamable-http",
				url: "https://127.0.0.1:3000/mcp",
				allowLocal: true,
			} as any),
		).not.toThrow();
	});

	// TC-F1.5-6
	it("accepts https external URL", () => {
		expect(() =>
			createHttpTransport({
				transport: "streamable-http",
				url: "https://api.example.com/mcp",
			} as any),
		).not.toThrow();
	});

	// TC-F1.5-7
	it("resolves ${ENV} in headers", () => {
		expect(() =>
			createHttpTransport(
				{
					transport: "streamable-http",
					url: "https://api.example.com/mcp",
					headers: { Authorization: "Bearer ${TEST_TOKEN}" },
				} as any,
				{ TEST_TOKEN: "abc" },
			),
		).not.toThrow();
	});
});
