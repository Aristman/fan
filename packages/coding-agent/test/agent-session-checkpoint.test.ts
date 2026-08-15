/**
 * F-45 Checkpoint API in agent-session.
 *
 * Source of truth:
 *  - docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-45
 *
 * Spec summary:
 *   checkpoint(label: string) — git commit "checkpoint:<label>" + state JSON at
 *       .fan/checkpoints/<slug>/<label>.json  (sessionId, iteration, timestamp, gitCommit)
 *   restoreCheckpoint(label: string) — git checkout <commit> + state restore from JSON
 *   listCheckpoints() — sorted array of available checkpoints (newest first)
 *
 * Coverage (mapped to TC-F45-* in roadmap.md):
 *  - TC-F45-1:  Checkpoint creates git commit and writes state file
 *  - TC-F45-2:  Restore rolls back to checkpoint
 *  - TC-F45-3:  listCheckpoints returns all checkpoints sorted by timestamp (newest first)
 *
 * Additional tests:
 *  - TC-F45-4:  Checkpoint after restore preserves linearity
 *  - TC-F45-5:  Checkpoint survives AgentSession re-creation (persistence)
 *  - TC-F45-6:  Restore of non-existent label throws
 *  - TC-F45-7:  Checkpoints do not break normal message flow
 *  - TC-F45-8:  Checkpoint with empty label throws
 *  - TC-F45-9:  Duplicate checkpoint label throws or overwrites (implementation-defined)
 *  - TC-F45-10: Checkpoint on empty session (no messages) works
 *  - TC-F45-11: Restore clears messages after the checkpoint point
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@seaagents/fan-agent-core";
import { createAssistantMessageEventStream, type Model } from "@seaagents/fan-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// ============================================================================
// Checkpoint API surface (RED — methods do not exist yet).
// ============================================================================

interface CheckpointInfo {
	label: string;
	timestamp: string;
	gitCommit?: string;
	iteration?: number;
}

interface CheckpointApi {
	checkpoint(label: string): Promise<{ label: string; gitCommit?: string }> | { label: string; gitCommit?: string };
	restoreCheckpoint(label: string): Promise<void> | void;
	listCheckpoints(): Promise<CheckpointInfo[]> | CheckpointInfo[];
}

function asCheckpointApi(session: AgentSession): CheckpointApi {
	return session as unknown as CheckpointApi;
}

// ============================================================================
// Faux model + stream (minimal — no LLM calls in checkpoint tests)
// ============================================================================

const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";
const FAUX_API = "anthropic-messages" as const;

const fauxModel: Model<typeof FAUX_API> = {
	id: FAUX_MODEL_ID,
	name: "Faux Model",
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

// ============================================================================
// Test helpers
// ============================================================================

interface CheckpointHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const dir = join(tmpdir(), `f45-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function initGitRepo(dir: string): void {
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	// Create an initial commit so git log works
	execSync('git commit --allow-empty -m "initial"', { cwd: dir, stdio: "pipe" });
}

function gitLogContains(dir: string, needle: string): boolean {
	try {
		const log = execSync("git log --oneline --all", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
		return log.includes(needle);
	} catch {
		return false;
	}
}

function createCheckpointHarness(): CheckpointHarness {
	const tempDir = createTempDir();
	initGitRepo(tempDir);

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model: fauxModel,
			systemPrompt: "You are a test assistant.",
			tools: [],
		},
		streamFn: (_model, _context) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: {} as any });
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: FAUX_API,
						provider: FAUX_PROVIDER,
						model: FAUX_MODEL_ID,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		},
	});

	// Persistent session (not in-memory) so checkpoint files are testable
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey(FAUX_PROVIDER, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((e) => events.push(e));

	const cleanup = () => {
		try {
			session.dispose();
		} catch {
			/* already disposed */
		}
		try {
			agent.abort();
		} catch {
			/* already disposed */
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}

/** Add a user+assistant message pair to the session via agent.prompt() */
async function addMessagePair(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text);
}

// ============================================================================
// Tests
// ============================================================================

describe("F-45 Checkpoint API in agent-session", () => {
	let harnesses: CheckpointHarness[] = [];

	beforeEach(() => {
		harnesses = [];
	});

	afterEach(() => {
		for (const h of harnesses) {
			try {
				h.session.dispose();
			} catch {
				/* */
			}
		}
		for (const h of harnesses) {
			h.cleanup();
		}
		harnesses = [];
	});

	// ------------------------------------------------------------------------
	// TC-F45-1: Checkpoint creates git commit and writes state file
	// ------------------------------------------------------------------------

	it("TC-F45-1: checkpoint() creates git commit and writes state file", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		// Add a message so session has state
		await addMessagePair(h.session, "hello world");

		const api = asCheckpointApi(h.session);

		// checkpoint() must exist
		expect(typeof api.checkpoint).toBe("function");

		// Create checkpoint
		const result = await api.checkpoint("iteration-5");

		// Result must have label
		expect(result).toBeDefined();
		expect(result.label).toBe("iteration-5");

		// Git commit with message containing "checkpoint:iteration-5" must exist
		expect(gitLogContains(h.tempDir, "checkpoint:iteration-5")).toBe(true);

		// State file must exist at .fan/checkpoints/<slug>/iteration-5.json
		// The slug is typically derived from the session or cwd
		// We search for the file in the .fan/checkpoints tree
		const checkpointsDir = join(h.tempDir, ".fan", "checkpoints");
		expect(existsSync(checkpointsDir)).toBe(true);

		// Find the checkpoint file — it should be named iteration-5.json somewhere under checkpoints/
		const { execSync } = await import("node:child_process");
		const found = execSync(`find "${checkpointsDir}" -name "iteration-5.json"`, {
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		expect(found.length).toBeGreaterThan(0);

		// Read and validate the checkpoint file
		const checkpointFile = found.split("\n")[0]!;
		const data = JSON.parse(readFileSync(checkpointFile, "utf-8"));

		expect(data.sessionId).toBeDefined();
		expect(data.sessionId).toBe(h.session.sessionId);
		expect(data.timestamp).toBeDefined();
		expect(typeof data.timestamp).toBe("string");
		// gitCommit field should be present (may be the commit hash)
		expect(data.gitCommit).toBeDefined();
	});

	// ------------------------------------------------------------------------
	// TC-F45-2: Restore rolls back to checkpoint
	// ------------------------------------------------------------------------

	it("TC-F45-2: restoreCheckpoint() rolls back session state to checkpoint", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		// Build state: 2 messages, checkpoint, then 2 more messages
		await addMessagePair(h.session, "message-1");
		await addMessagePair(h.session, "message-2");

		const api = asCheckpointApi(h.session);

		// Create checkpoint at this point
		await api.checkpoint("save-point");

		// Record message count at checkpoint
		const messagesAtCheckpoint = h.session.messages.length;

		// Add more messages after checkpoint
		await addMessagePair(h.session, "message-3");
		await addMessagePair(h.session, "message-4");

		// Verify we have more messages now
		expect(h.session.messages.length).toBeGreaterThan(messagesAtCheckpoint);

		// restoreCheckpoint() must exist
		expect(typeof api.restoreCheckpoint).toBe("function");

		// Restore to checkpoint
		await api.restoreCheckpoint("save-point");

		// Messages after checkpoint should be discarded
		expect(h.session.messages.length).toBeLessThanOrEqual(messagesAtCheckpoint);

		// Git should be at the checkpoint commit
		// After restore, HEAD should be at the checkpoint commit
		// (The checkpoint commit hash was recorded in the state file)
	});

	// ------------------------------------------------------------------------
	// TC-F45-3: listCheckpoints returns all checkpoints sorted by timestamp
	// ------------------------------------------------------------------------

	it("TC-F45-3: listCheckpoints() returns all checkpoints sorted newest-first", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		await addMessagePair(h.session, "msg-1");

		const api = asCheckpointApi(h.session);

		// Create 3 checkpoints with small delays to ensure distinct timestamps
		await api.checkpoint("iteration-3");
		await new Promise((r) => setTimeout(r, 50));
		await addMessagePair(h.session, "msg-2");
		await api.checkpoint("iteration-4");
		await new Promise((r) => setTimeout(r, 50));
		await addMessagePair(h.session, "msg-3");
		await api.checkpoint("iteration-5");

		// listCheckpoints() must exist
		expect(typeof api.listCheckpoints).toBe("function");

		const list = await api.listCheckpoints();

		// Must return array
		expect(Array.isArray(list)).toBe(true);

		// Must have exactly 3 checkpoints
		expect(list).toHaveLength(3);

		// Labels must all be present
		const labels = list.map((c: CheckpointInfo) => c.label);
		expect(labels).toContain("iteration-3");
		expect(labels).toContain("iteration-4");
		expect(labels).toContain("iteration-5");

		// Sorted by timestamp newest-first
		for (let i = 0; i < list.length - 1; i++) {
			const current = new Date(list[i]!.timestamp).getTime();
			const next = new Date(list[i + 1]!.timestamp).getTime();
			expect(current).toBeGreaterThanOrEqual(next);
		}

		// Each entry must have required fields
		for (const entry of list) {
			expect(entry.label).toBeDefined();
			expect(entry.timestamp).toBeDefined();
			expect(typeof entry.label).toBe("string");
			expect(typeof entry.timestamp).toBe("string");
		}
	});

	// ------------------------------------------------------------------------
	// TC-F45-4: Checkpoint after restore preserves linearity
	// ------------------------------------------------------------------------

	it("TC-F45-4: checkpoint after restore preserves linearity", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		await addMessagePair(h.session, "alpha");
		await api.checkpoint("point-a");

		await addMessagePair(h.session, "beta");
		await api.checkpoint("point-b");

		// Restore to point-a
		await api.restoreCheckpoint("point-a");

		// Create a new checkpoint after restore — this should work
		await addMessagePair(h.session, "gamma");
		const result = await api.checkpoint("point-c");
		expect(result).toBeDefined();
		expect(result.label).toBe("point-c");

		// listCheckpoints should contain all 3 (point-a, point-b, point-c)
		const list = await api.listCheckpoints();
		expect(list.length).toBeGreaterThanOrEqual(3);

		const labels = list.map((c: CheckpointInfo) => c.label);
		expect(labels).toContain("point-a");
		expect(labels).toContain("point-b");
		expect(labels).toContain("point-c");
	});

	// ------------------------------------------------------------------------
	// TC-F45-5: Checkpoint survives AgentSession re-creation (persistence)
	// ------------------------------------------------------------------------

	it("TC-F45-5: checkpoint survives AgentSession re-creation (disk persistence)", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		await addMessagePair(h.session, "persist-test");
		await api.checkpoint("durable");

		// Record state before teardown
		const tempDir = h.tempDir;

		// Tear down the session
		h.session.dispose();

		// Re-create a new AgentSession in the same tempDir
		const agent2 = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model: fauxModel,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			streamFn: (_model, _context) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: {} as any });
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							api: FAUX_API,
							provider: FAUX_PROVIDER,
							model: FAUX_MODEL_ID,
							usage: {
								input: 10,
								output: 5,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 15,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				});
				return stream;
			},
		});

		const sessionManager2 = SessionManager.create(tempDir, tempDir);
		const settingsManager2 = SettingsManager.create(tempDir, tempDir);
		const authStorage2 = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage2.setRuntimeApiKey(FAUX_PROVIDER, "faux-key");
		const modelRegistry2 = ModelRegistry.create(authStorage2, tempDir);

		const session2 = new AgentSession({
			agent: agent2,
			sessionManager: sessionManager2,
			settingsManager: settingsManager2,
			cwd: tempDir,
			modelRegistry: modelRegistry2,
			resourceLoader: createTestResourceLoader(),
		});
		session2.subscribe(() => {});

		// Replace harness entry for cleanup
		harnesses.pop();
		harnesses.push({
			session: session2,
			sessionManager: sessionManager2,
			tempDir,
			cleanup: () => {
				try {
					session2.dispose();
				} catch {
					/* */
				}
				try {
					agent2.abort();
				} catch {
					/* */
				}
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			},
		});

		// listCheckpoints on new session must still see the checkpoint
		const api2 = asCheckpointApi(session2);
		expect(typeof api2.listCheckpoints).toBe("function");

		const list = await api2.listCheckpoints();
		const labels = list.map((c: CheckpointInfo) => c.label);
		expect(labels).toContain("durable");

		// Restore from the persisted checkpoint must work
		await api2.restoreCheckpoint("durable");
	});

	// ------------------------------------------------------------------------
	// TC-F45-6: Restore of non-existent label throws
	// ------------------------------------------------------------------------

	it("TC-F45-6: restoreCheckpoint() with non-existent label throws", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		// restoreCheckpoint() must exist as a function
		expect(typeof api.restoreCheckpoint).toBe("function");

		// Attempt to restore a checkpoint that was never created
		await expect(async () => {
			await api.restoreCheckpoint("does-not-exist");
		}).rejects.toThrow();
	});

	// ------------------------------------------------------------------------
	// TC-F45-7: Checkpoints do not break normal message flow
	// ------------------------------------------------------------------------

	it("TC-F45-7: checkpoints do not break normal message flow", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		// Normal flow: prompt → checkpoint → prompt → checkpoint → prompt
		await addMessagePair(h.session, "first");
		const msgCountBefore = h.session.messages.length;

		await api.checkpoint("cp-1");

		// Session should still be usable after checkpoint
		await addMessagePair(h.session, "second");
		expect(h.session.messages.length).toBeGreaterThan(msgCountBefore);

		await api.checkpoint("cp-2");

		// Session should still be usable
		await addMessagePair(h.session, "third");
		expect(h.session.messages.length).toBeGreaterThan(msgCountBefore + 1);

		// All messages should be present
		const texts = h.session.messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const content = (m as any).content;
				return typeof content === "string" ? content : content?.[0]?.text;
			});
		expect(texts).toContain("first");
		expect(texts).toContain("second");
		expect(texts).toContain("third");
	});

	// ------------------------------------------------------------------------
	// TC-F45-8: Checkpoint with empty label throws
	// ------------------------------------------------------------------------

	it("TC-F45-8: checkpoint() with empty label throws", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		// checkpoint() must exist as a function
		expect(typeof api.checkpoint).toBe("function");

		await expect(async () => {
			await api.checkpoint("");
		}).rejects.toThrow();
	});

	// ------------------------------------------------------------------------
	// TC-F45-9: Duplicate checkpoint label — implementation-defined behavior
	// Either throws or overwrites. We assert one of the two.
	// ------------------------------------------------------------------------

	it("TC-F45-9: duplicate checkpoint label — throws or overwrites (implementation-defined)", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		await addMessagePair(h.session, "first");
		await api.checkpoint("dup-label");

		await addMessagePair(h.session, "second");

		// Second checkpoint with same label: either throws or overwrites
		let threw = false;
		try {
			await api.checkpoint("dup-label");
		} catch {
			threw = true;
		}

		if (threw) {
			// If it throws, that's valid — duplicate labels are rejected
			// The first checkpoint should still be intact
			const list = await api.listCheckpoints();
			const dupEntries = list.filter((c: CheckpointInfo) => c.label === "dup-label");
			expect(dupEntries).toHaveLength(1);
		} else {
			// If it doesn't throw, it should overwrite — listCheckpoints should have
			// exactly one entry for "dup-label" (the newer one)
			const list = await api.listCheckpoints();
			const dupEntries = list.filter((c: CheckpointInfo) => c.label === "dup-label");
			expect(dupEntries).toHaveLength(1);
		}
	});

	// ------------------------------------------------------------------------
	// TC-F45-10: Checkpoint on empty session (no messages) works
	// ------------------------------------------------------------------------

	it("TC-F45-10: checkpoint() on empty session (no messages) works", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		// No messages added — session is empty
		const result = await api.checkpoint("empty-session");
		expect(result).toBeDefined();
		expect(result.label).toBe("empty-session");

		// State file should still be created
		const checkpointsDir = join(h.tempDir, ".fan", "checkpoints");
		expect(existsSync(checkpointsDir)).toBe(true);

		// listCheckpoints should include the empty-session checkpoint
		const list = await api.listCheckpoints();
		expect(list.some((c: CheckpointInfo) => c.label === "empty-session")).toBe(true);
	});

	// ------------------------------------------------------------------------
	// TC-F45-11: Restore clears messages added after the checkpoint
	// ------------------------------------------------------------------------

	it("TC-F45-11: restore clears messages added after the checkpoint", async () => {
		const h = createCheckpointHarness();
		harnesses.push(h);

		const api = asCheckpointApi(h.session);

		await addMessagePair(h.session, "keep-this");
		const messagesAtCheckpoint = h.session.messages.length;

		await api.checkpoint("cut-here");

		await addMessagePair(h.session, "discard-this-1");
		await addMessagePair(h.session, "discard-this-2");

		// Verify messages were added
		expect(h.session.messages.length).toBeGreaterThan(messagesAtCheckpoint);

		// Restore should discard messages added after checkpoint
		await api.restoreCheckpoint("cut-here");

		// Message count should be at or below the checkpoint count
		expect(h.session.messages.length).toBeLessThanOrEqual(messagesAtCheckpoint);

		// The "keep-this" user message should still be present
		const userTexts = h.session.messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const content = (m as any).content;
				return typeof content === "string" ? content : content?.[0]?.text;
			});
		expect(userTexts).toContain("keep-this");

		// The "discard-this-*" messages should NOT be present
		expect(userTexts).not.toContain("discard-this-1");
		expect(userTexts).not.toContain("discard-this-2");
	});
});
