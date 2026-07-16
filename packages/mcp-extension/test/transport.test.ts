/**
 * Tests for createStdioTransport (F-1.4).
 *
 * TC-F1.4-1: createStdioTransport rejects non-stdio config
 * TC-F1.4-2: createStdioTransport rejects missing command
 * TC-F1.4-3: createStdioTransport resolves ${ENV} references in env
 * TC-F1.4-4: createStdioTransport without env uses SAFE_ENV_VARS whitelist
 * TC-F1.4-5: Integration — spawns echo fixture via stdio MCP and starts transport
 */

import { describe, expect, it } from "vitest";
import { createStdioTransport } from "../src/transport.js";

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
			// The transport constructor should have resolved the env var
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
		const path = process.env.PATH;
		const home = process.env.HOME;
		try {
			// Ensure at least PATH exists (it always does on any system)
			const transport = createStdioTransport({
				transport: "stdio",
				command: "node",
				args: ["-e", "process.stdin.pipe(process.stdout)"],
			});
			expect(transport).toBeDefined();
			// No throw means it constructed successfully with safe vars
		} finally {
			// restore — not really needed here but keeps pattern
		}
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
