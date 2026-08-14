// Standalone spawnable mock-node for e2e tests.
//
// Usage:
//   node mock-node-main.mjs --port <N> [--tools <list>]
//
// Environment:
//   FAN_NODE_TOKEN — required Bearer token for auth (as real fan server reads it)
//
// Behaviour:
//   1. Parses --port (required) and --tools (optional) from argv.
//   2. Reads token from FAN_NODE_TOKEN env var.
//   3. Writes full argv to `<FAN_ARGV_DUMP_DIR || cwd>/argv-<port>.txt` for test-side verification.
//   4. Starts mock-node-server (imported from mock-node-server.mjs) on the
//      given port with configurable delayMs (env MOCK_DELAY_MS, default 500).
//   5. Prints "READY <port>" to stdout (single line, flushed).
//   6. Runs until SIGTERM / SIGINT → graceful stop + exit 0.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMockNode } from "./mock-node-server.mjs";

// ── argv parsing ────────────────────────────────────────────────────────────

let port = null;
let delayMs = Number(process.env.MOCK_DELAY_MS) || 500;
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--port" && i + 1 < argv.length) {
		port = Number(argv[++i]);
	} else if (argv[i] === "--delay" && i + 1 < argv.length) {
		delayMs = Number(argv[++i]);
	}
	// --tools <list> is accepted (part of argv, written to file) but not acted upon
}

// ── token from env ──────────────────────────────────────────────────────────

const token = process.env.FAN_NODE_TOKEN;

if (!port || !token) {
	console.error(`mock-node-main: --port and FAN_NODE_TOKEN required (got port=${port}, token=${token ? "set" : "unset"})`);
	process.exit(1);
}

// ── persist argv for e2e verification ───────────────────────────────────────

try {
	writeFileSync(join(process.env.FAN_ARGV_DUMP_DIR || ".", `argv-${port}.txt`), JSON.stringify(process.argv.slice(2)), "utf8");
} catch {
	/* best-effort */
}

// ── start server ────────────────────────────────────────────────────────────

let mock;
try {
	mock = await startMockNode({
		port,
		token,
		usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 },
		verdict: "PASS",
		delayMs,
	});
} catch (err) {
	console.error(`mock-node-main: failed to start on port ${port}: ${err?.message ?? err}`);
	if (err?.code) console.error(`  code: ${err.code}`);
	process.exit(1);
}

// Catch unhandled errors to keep the process alive for the test.
process.on("uncaughtException", (err) => {
	console.error(`mock-node-main [port ${port}] uncaughtException:`, err?.message ?? err);
});
process.on("unhandledRejection", (err) => {
	console.error(`mock-node-main [port ${port}] unhandledRejection:`, err?.message ?? err);
});

// Signal readiness to parent (single line, immediately flushed).
console.log(`READY ${port}`);

// ── graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
	mock.stop().then(
		() => process.exit(0),
		() => process.exit(0),
	);
	// Fallback: force exit after 2 s if stop() hangs.
	setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
