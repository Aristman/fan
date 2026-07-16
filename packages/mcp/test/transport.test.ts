/**
 * Tests for createStdioTransport (F-1.4) and createHttpTransport (F-1.5).
 *
 * TC-F1.4-1..5: Stdio transport tests
 * TC-F1.5-1..7: StreamableHTTP transport tests
 */

import { describe, expect, it } from "vitest";
import {
	buildHttpParams,
	createHttpTransport,
	createStdioTransport,
	isLoopbackHostname,
	isPrivateAddress,
} from "../src/transport.js";

// ──────────────────────────────────────────────────
// BUG-3: Loopback bypass prevention
// ──────────────────────────────────────────────────

describe("isLoopbackHostname", () => {
	it("localhost is loopback", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
	});

	it("127.0.0.1 is loopback", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
	});

	it("::1 is loopback", () => {
		expect(isLoopbackHostname("::1")).toBe(true);
	});

	it("127.0.0.2 is loopback (127.0.0.0/8)", () => {
		expect(isLoopbackHostname("127.0.0.2")).toBe(true);
	});

	it("127.1 is loopback (127.0.0.0/8 shorthand)", () => {
		expect(isLoopbackHostname("127.1")).toBe(true);
	});

	it("127.255.255.255 is loopback (127.0.0.0/8)", () => {
		expect(isLoopbackHostname("127.255.255.255")).toBe(true);
	});

	it("0.0.0.0 is loopback", () => {
		expect(isLoopbackHostname("0.0.0.0")).toBe(true);
	});

	it("external hostname is not loopback", () => {
		expect(isLoopbackHostname("api.example.com")).toBe(false);
	});

	it("public IP is not loopback", () => {
		expect(isLoopbackHostname("8.8.8.8")).toBe(false);
	});
});

describe("isPrivateAddress", () => {
	it("10.0.0.1 is private", () => {
		expect(isPrivateAddress("10.0.0.1")).toBe(true);
	});

	it("172.16.0.1 is private", () => {
		expect(isPrivateAddress("172.16.0.1")).toBe(true);
	});

	it("172.31.255.255 is private", () => {
		expect(isPrivateAddress("172.31.255.255")).toBe(true);
	});

	it("172.32.0.1 is not private (outside 172.16.0.0/12)", () => {
		expect(isPrivateAddress("172.32.0.1")).toBe(false);
	});

	it("192.168.1.1 is private", () => {
		expect(isPrivateAddress("192.168.1.1")).toBe(true);
	});

	it("192.169.1.1 is not private", () => {
		expect(isPrivateAddress("192.169.1.1")).toBe(false);
	});

	it("8.8.8.8 is not private", () => {
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
	});

	it("hostname is not private (not an IP)", () => {
		expect(isPrivateAddress("internal.corp")).toBe(false);
	});
});

describe("BUG-3: SSRF via loopback bypass in buildHttpParams", () => {
	it("rejects https://127.0.0.2:8080/mcp without allowLocal", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://127.0.0.2:8080/mcp",
			} as any),
		).toThrow(/allowLocal/);
	});

	it("rejects https://127.1/mcp without allowLocal", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://127.1/mcp",
			} as any),
		).toThrow(/allowLocal/);
	});

	it("rejects https://127.0.0.1/mcp without allowLocal", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://127.0.0.1/mcp",
			} as any),
		).toThrow(/allowLocal/);
	});

	it("accepts https://127.0.0.1/mcp with allowLocal: true", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://127.0.0.1/mcp",
				allowLocal: true,
			} as any),
		).not.toThrow();
	});

	it("rejects localhost without allowLocal", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://localhost:3000/mcp",
			} as any),
		).toThrow(/allowLocal/);
	});

	it("accepts https://api.example.com/mcp", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://api.example.com/mcp",
			} as any),
		).not.toThrow();
	});

	it("rejects https://192.168.1.1/mcp by default (private network)", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://192.168.1.1/mcp",
			} as any),
		).toThrow(/private network/);
	});

	it("accepts https://192.168.1.1/mcp with allowPrivate: true", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://192.168.1.1/mcp",
				allowPrivate: true,
			} as any),
		).not.toThrow();
	});

	it("accepts https://192.168.1.1/mcp with allowLocal: true (covers private)", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://192.168.1.1/mcp",
				allowLocal: true,
			} as any),
		).not.toThrow();
	});

	it("rejects https://10.0.0.5/mcp by default (private network)", () => {
		expect(() =>
			buildHttpParams({
				transport: "streamable-http",
				url: "https://10.0.0.5/mcp",
			} as any),
		).toThrow(/private network/);
	});
});

// ──────────────────────────────────────────────────
// F-1.4: Stdio transport
// ──────────────────────────────────────────────────

describe("F-1.4: createStdioTransport", () => {
	// TC-F1.4-1
	it("throws when transport is not 'stdio'", () => {
		expect(() => createStdioTransport({ transport: "streamable-http" } as any)).toThrow(/stdio/);
	});

	// TC-F1.4-2
	it("throws when command is missing", () => {
		expect(() => createStdioTransport({ transport: "stdio" } as any)).toThrow(/command/);
	});

	// TC-F1.4-3
	// biome-ignore lint/suspicious/noTemplateCurlyInString: test description with literal ${ENV}
	it("resolves ${ENV} references in config.env", () => {
		const original = process.env.TEST_TOKEN;
		process.env.TEST_TOKEN = "secret";
		try {
			const transport = createStdioTransport({
				transport: "stdio",
				command: "node",
				args: ["-e", "process.stdin.pipe(process.stdout)"],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal test input
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
		const fixturePath = new URL("./fixtures/stdio-server.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

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
	it("rejects non-streamable-http transport", async () => {
		await expect(createHttpTransport({ transport: "stdio", command: "x" } as any)).rejects.toThrow(/streamable-http/);
	});

	// TC-F1.5-2
	it("rejects missing url", async () => {
		await expect(createHttpTransport({ transport: "streamable-http" } as any)).rejects.toThrow(/url/);
	});

	// TC-F1.5-3
	it("rejects http:// (not https)", async () => {
		await expect(
			createHttpTransport({
				transport: "streamable-http",
				url: "http://api.example.com/mcp",
			} as any),
		).rejects.toThrow(/https/);
	});

	// TC-F1.5-4
	it("rejects localhost without allowLocal", async () => {
		await expect(
			createHttpTransport({
				transport: "streamable-http",
				url: "https://localhost:3000/mcp",
			} as any),
		).rejects.toThrow(/allowLocal/);
	});

	// TC-F1.5-5
	it("accepts localhost with allowLocal: true", async () => {
		await expect(
			createHttpTransport({
				transport: "streamable-http",
				url: "https://127.0.0.1:3000/mcp",
				allowLocal: true,
			} as any),
		).resolves.toBeDefined();
	});

	// TC-F1.5-6
	it("accepts https external URL", async () => {
		await expect(
			createHttpTransport({
				transport: "streamable-http",
				url: "https://api.example.com/mcp",
			} as any),
		).resolves.toBeDefined();
	});

	// TC-F1.5-7
	// biome-ignore lint/suspicious/noTemplateCurlyInString: test description with literal ${ENV}
	it("resolves ${ENV} in headers", async () => {
		await expect(
			createHttpTransport(
				{
					transport: "streamable-http",
					url: "https://api.example.com/mcp",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: literal test input
					headers: { Authorization: "Bearer ${TEST_TOKEN}" },
				} as any,
				{ TEST_TOKEN: "abc" },
			),
		).resolves.toBeDefined();
	});
});
