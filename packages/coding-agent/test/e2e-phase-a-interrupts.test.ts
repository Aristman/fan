/**
 * Phase-gate e2e for super-orchestrator Phase A "Ядро прерываний".
 *
 * Source of truth:
 *   docs/features/super-orchestrator/mission-loop-0/roadmap.md (phase A §E2E)
 *   docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.1, §6.2
 *
 * Phase A wraps the interrupt core: F-01 REST+WS abort, F-03 watchdog,
 * F-05/F-06 drain, F-07 budget_alert. This file exercises the *integration*
 * of those features through the real HTTP+WS stack:
 *
 *   real AgentSession (faux provider) ──▶ real SessionAdapter
 *   ──▶ real createApp + attachWebSocketHandler
 *   ──▶ real node:http server (via @hono/node-server)
 *   ──▶ real fetch (REST) + real `ws` (WebSocket)
 *
 * The point is to verify the wiring — not to re-test per-feature unit
 * coverage, which already exists in:
 *   - packages/api-gateway/src/__tests__/{abort,drain,ws-*}-endpoint.test.ts
 *   - packages/coding-agent/test/{watchdog-timer,loop-detector,
 *                                  agent-session-watchdog,agent-session-drain,
 *                                  agent-session-loop-detector}.test.ts
 *   - packages/agent/test/agent-queue-limits.test.ts
 *
 * E2E scenario from roadmap (Phase A §E2E):
 *   1. Запустить `fan server` → `POST /api/sessions/:id/abort` во время
 *      генерации → генерация остановлена <1 сек, WS-клиент получает
 *      `agent_end` с причиной `aborted`.
 *   2. Генерация с зависшим tool call (нет `tool_execution_end`) → watchdog
 *      прерывает сессию с диагностикой.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAdapter } from "@fan/api-gateway";
import { attachWebSocketHandler, createApp } from "@fan/api-gateway";
import type { ModelManager } from "@fan/model-manager";
import type { AgentTool } from "@seaagents/fan-agent-core";
import { Agent } from "@seaagents/fan-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@seaagents/fan-ai";
import { createAssistantMessageEventStream } from "@seaagents/fan-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { AgentSession as AgentSessionCtor } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// ============================================================================
// Auth bypass — Phase A e2e runs locally; auth covered separately.
// ============================================================================
process.env.FAN_NO_AUTH = "1";

// ============================================================================
// Stream function factory — produces slow assistant responses on demand.
//
// We need to control timing of chunks so that:
//   - the REST abort test can fire while tokens are still being streamed
//   - the watchdog test can leave a tool call hanging without `tool_execution_end`
//
// Each variant pushes the response character-by-character with optional
// spacing so the abort path is observable mid-flight.
// ============================================================================

interface SlowTextResponse {
	kind: "text";
	text: string;
	/** Wait this long before pushing the first byte. */
	delayBeforeStartMs?: number;
	/** Space between successive `text_delta` pushes. */
	chunkIntervalMs?: number;
}

interface ToolCallResponse {
	kind: "toolCall";
	/** Tool name to invoke (e.g. "bash"). */
	toolName: string;
	/** Tool call id (deterministic — needed by watchdog assertions). */
	toolCallId: string;
	/** Arguments to pass to the tool. */
	args?: Record<string, unknown>;
}

interface FinalTextResponse {
	kind: "finalText";
	text: string;
}

type SlowResponse = SlowTextResponse | ToolCallResponse | FinalTextResponse;

function makeSlowStreamFn(responses: SlowResponse[]) {
	const calls: { context: Context }[] = [];
	const streamFn = (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		calls.push({ context });
		const resp = responses[(calls.length - 1) % responses.length] ?? responses[responses.length - 1];
		const stream = createAssistantMessageEventStream();
		const signal = options?.signal;

		const usage = {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		let aborted = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		signal?.addEventListener(
			"abort",
			() => {
				aborted = true;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				const errMsg: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: "anthropic-messages",
					provider: "faux",
					model: "faux-slow",
					usage,
					stopReason: "aborted",
					errorMessage: "aborted by test",
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "aborted", error: errMsg });
			},
			{ once: true },
		);

		queueMicrotask(() => {
			if (aborted || signal?.aborted) return;

			if (resp.kind === "toolCall") {
				// Single tool-call response: invoke the tool and stop.
				const partial: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: resp.toolCallId, name: resp.toolName, arguments: resp.args ?? {} }],
					api: "anthropic-messages",
					provider: "faux",
					model: "faux-slow",
					usage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: { ...partial } });
				stream.push({
					type: "toolcall_start",
					contentIndex: 0,
					partial: { ...partial },
				});
				stream.push({
					type: "toolcall_delta",
					contentIndex: 0,
					delta: "{}",
					partial: { ...partial },
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: partial.content[0] as AssistantMessage["content"][0] & { type: "toolCall" },
					partial: { ...partial },
				});
				stream.push({ type: "done", reason: "toolUse", message: partial });
				return;
			}

			if (resp.kind === "finalText") {
				const partial: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: resp.text }],
					api: "anthropic-messages",
					provider: "faux",
					model: "faux-slow",
					usage: { ...usage, output: resp.text.length },
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: { ...partial } });
				stream.push({ type: "done", reason: "stop", message: partial });
				return;
			}

			// text: stream character-by-character so abort is observable mid-flight.
			const partial: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: "anthropic-messages",
				provider: "faux",
				model: "faux-slow",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			};

			const start = () => {
				if (aborted || signal?.aborted) return;
				stream.push({ type: "start", partial: { ...partial } });
				const textIdx = 0;
				partial.content = [{ type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex: textIdx, partial: { ...partial } });

				const chars = resp.text.split("");
				let i = 0;
				const pushNext = () => {
					if (aborted || signal?.aborted) return;
					if (i >= chars.length) {
						const finalText = (partial.content[textIdx] as { text: string }).text;
						stream.push({ type: "text_end", contentIndex: textIdx, content: finalText, partial: { ...partial } });
						const finalMessage: AssistantMessage = {
							...partial,
							content: [{ type: "text", text: finalText }],
							usage: { ...usage, output: finalText.length },
						};
						stream.push({ type: "done", reason: "stop", message: finalMessage });
						return;
					}
					const ch = chars[i++];
					(partial.content[textIdx] as { text: string }).text += ch;
					stream.push({
						type: "text_delta",
						contentIndex: textIdx,
						delta: ch,
						partial: { ...partial },
					});
					if (resp.chunkIntervalMs && resp.chunkIntervalMs > 0) {
						timer = setTimeout(pushNext, resp.chunkIntervalMs);
					} else {
						queueMicrotask(pushNext);
					}
				};

				queueMicrotask(pushNext);
			};

			if (resp.delayBeforeStartMs && resp.delayBeforeStartMs > 0) {
				setTimeout(start, resp.delayBeforeStartMs);
			} else {
				queueMicrotask(start);
			}
		});

		return stream;
	};
	return { streamFn, calls };
}

// ============================================================================
// Hang tool — never resolves until aborted. Used for the watchdog scenario.
// ============================================================================

function makeHangTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `tool that hangs forever until aborted (${name})`,
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			return await new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error(`${name} aborted by watchdog`)), { once: true });
			});
		},
	};
}

// ============================================================================
// Minimal real SessionAdapter built on top of a real AgentSession.
//
// Mirrors `createSessionAdapter` in packages/coding-agent/src/main.ts:
//  - subscribeToSession(id, handler) — stores in per-id map, forwards events
//  - abortSession(id) — calls session.abort() on the active session
//  - drainSession(id) — calls session.setDrainAfterCurrentTurn(true)
//  - getActiveSessionId / getActiveModelManager — for budget rebinding
//
// All other adapter methods return inert values sufficient for createApp's
// startup path. We do NOT mock abortSession/drainSession/subscribeToSession
// because those are the very things under test.
// ============================================================================

function makeLiveSessionAdapter(session: AgentSession, sessionId: string): SessionAdapter {
	const sessionSubscribers = new Map<string, Set<(event: AgentSessionEvent) => void>>();
	let runtimeUnsub: (() => void) | null = null;

	function ensureRuntimeSubscription() {
		if (runtimeUnsub) return;
		runtimeUnsub = session.subscribe((event: AgentSessionEvent) => {
			const handlers = sessionSubscribers.get(sessionId);
			if (!handlers) return;
			for (const h of handlers) {
				try {
					h(event);
				} catch {
					/* listener errors must not break the broadcast loop */
				}
			}
		});
	}

	return {
		async listSessions() {
			return [
				{
					id: sessionId,
					title: "phase-a-e2e",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					messageCount: 0,
				},
			];
		},
		async getSession(id: string) {
			if (id !== sessionId) return null;
			return {
				id,
				title: "phase-a-e2e",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: [],
			};
		},
		async createSession() {
			return {
				id: sessionId,
				title: "phase-a-e2e",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
		},
		async deleteSession(id: string) {
			return id === sessionId;
		},
		async sendMessage(id: string) {
			if (id !== sessionId) return false;
			// The e2e invokes session.prompt() directly; this is a no-op
			// pass-through kept for shape completeness (matches main.ts:1313).
			return true;
		},
		subscribeToSession(id: string, handler: (event: AgentSessionEvent) => void): () => void {
			if (id !== sessionId) return () => {};
			ensureRuntimeSubscription();
			let set = sessionSubscribers.get(id);
			if (!set) {
				set = new Set();
				sessionSubscribers.set(id, set);
			}
			set.add(handler);
			return () => {
				const s = sessionSubscribers.get(id);
				if (!s) return;
				s.delete(handler);
				if (s.size === 0) sessionSubscribers.delete(id);
			};
		},
		async getAvailableModels() {
			return [];
		},
		async bindSessionExtensions() {
			/* no extensions in the e2e */
		},
		async whenReady() {
			return;
		},
		async listAnalyticsReports() {
			return [];
		},
		async readAnalyticsReport() {
			return null;
		},
		async abortSession(id: string): Promise<boolean> {
			if (id !== sessionId) return false;
			// Fire-and-forget: REST must respond <1s, abort completes asynchronously
			// exactly as the production adapter does (packages/coding-agent/src/main.ts:553).
			session.clearQueue();
			session.abort().catch(() => {
				/* agent may already be idle if abort raced with completion */
			});
			return true;
		},
		async drainSession(id: string): Promise<boolean> {
			if (id !== sessionId) return false;
			(session as unknown as { setDrainAfterCurrentTurn(v: boolean): void }).setDrainAfterCurrentTurn(true);
			return true;
		},
		getActiveSessionId() {
			return sessionId;
		},
		getActiveModelManager() {
			return undefined; // no ModelManager in this e2e; budget_alert is out of scope for the phase-gate
		},
		onSessionChange() {
			/* single-session test — no rebinding */
		},
	};
}

// Minimal ModelManager stub — must satisfy every method startServer / createApp
// call during startup. We do NOT exercise budget logic here (covered by F-07
// unit tests), but the api-gateway wires the WS budget producer to the
// *active* ModelManager from the session, so onBudgetAlert must exist.
const mockModelManager = {
	getAllModelSettings: async () => [],
	setModelSetting: async () => {},
	getModelSetting: () => null,
	getBudgetStatus: async () => [],
	configureBudget: async () => {},
	getRoutingRules: async () => [],
	onBudgetAlert: () => () => {},
} as unknown as ModelManager;

// ============================================================================
// E2E test
// ============================================================================

describe("Phase A e2e — interrupt core (F-01 abort + F-03 watchdog)", () => {
	let harness: {
		session: AgentSession;
		sessionId: string;
		cleanup: () => void;
	} | null = null;
	let _adapter: SessionAdapter | null = null;
	let port = 0;
	let server: Server | null = null;
	let wsHandler: { close: () => void } | null = null;

	afterEach(async () => {
		// Order matters: stop WS upgrade handler, close server, dispose session.
		try {
			wsHandler?.close();
		} catch {
			/* ignore */
		}
		wsHandler = null;
		if (server?.listening) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
		}
		server = null;
		try {
			harness?.cleanup();
		} catch {
			/* ignore */
		}
		harness = null;
		_adapter = null;
	});

	/**
	 * Spin up the full HTTP+WS stack around a real AgentSession.
	 *
	 * `baseToolsOverride` replaces the default built-in tools (read/bash/
	 * edit/write). The watchdog scenario passes `{ bash: hangTool }` so the
	 * default bash is replaced with a tool that hangs until aborted; the
	 * abort scenario passes an empty object to keep the default tool set
	 * but unused.
	 */
	async function bootStack(
		responses: SlowResponse[],
		settingsOverrides: Record<string, unknown> | undefined,
		baseToolsOverride?: Record<string, AgentTool>,
	): Promise<{ session: AgentSession; sessionId: string; port: number }> {
		const { streamFn } = makeSlowStreamFn(responses);

		const tempDir = join(tmpdir(), `phase-a-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const fauxModel: Model<any> = {
			id: "faux-slow",
			name: "Faux Slow",
			api: "anthropic-messages",
			provider: "faux",
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model: fauxModel,
				systemPrompt: "You are a phase-A e2e test assistant.",
				tools: [],
			},
			streamFn,
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		if (settingsOverrides) {
			(settingsManager as unknown as { applyOverrides(o: Record<string, unknown>): void }).applyOverrides(
				settingsOverrides as never,
			);
		}
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("faux", "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		const session = new AgentSessionCtor({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			// CRITICAL: when set, replaces the default tool set. The watchdog
			// scenario injects `{ bash: hangTool }` here; without this the
			// default "bash" would execute real shell commands and return
			// immediately, defeating the test.
			baseToolsOverride,
		});
		// Subscribe internally so the session emits events even without an
		// outside listener — mirrors packages/coding-agent/src/main.ts:1313.
		session.subscribe(() => {});

		const sessionId = session.sessionId;
		const liveAdapter = makeLiveSessionAdapter(session, sessionId);
		_adapter = liveAdapter;

		// Build the real HTTP+WS stack:
		//   1. createApp gives us a Hono app (REST routes).
		//   2. createAdaptorServer from @hono/node-server wraps app.fetch in a
		//      raw node:http server with proper body handling.
		//   3. attachWebSocketHandler hooks the upgrade path for /api/ws/*.
		const app = await createApp(mockModelManager, liveAdapter);
		const { createAdaptorServer } = await import("@hono/node-server");
		const httpServer = createAdaptorServer({
			fetch: app.fetch,
			port: 0,
			hostname: "127.0.0.1",
		});

		await new Promise<void>((resolve, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = httpServer.address();
		if (typeof addr !== "object" || !addr) throw new Error("HTTP server failed to bind");
		port = addr.port;
		server = httpServer as unknown as Server;

		wsHandler = attachWebSocketHandler({
			server: httpServer as unknown as Server,
			sessionAdapter: liveAdapter,
			// The e2e does not exercise budget alerts, but the WS handler
			// insists on `onAlert` — provide an inert no-op to satisfy the
			// shape (matches http-server.ts:454 budgetTrackerProxy).
			budgetTracker: { onAlert: () => () => {} },
		});

		const cleanup = () => {
			try {
				session.dispose();
			} catch {
				/* ignore */
			}
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		};
		harness = { session, sessionId, cleanup };
		return { session, sessionId, port };
	}

	/** Open a real WS connection; resolves on `open`, rejects on error/timeout. */
	function openWs(sessionId: string, timeoutMs = 5000): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/${sessionId}`);
			const t = setTimeout(() => reject(new Error("WS open timeout")), timeoutMs);
			ws.once("open", () => {
				clearTimeout(t);
				resolve(ws);
			});
			ws.once("error", (err: Error) => {
				clearTimeout(t);
				reject(err);
			});
		});
	}

	/** Collect every JSON message received on a WS connection. */
	function collectMessages(ws: WebSocket): {
		type: string;
		event?: {
			type?: string;
			messages?: unknown[];
			reason?: string;
			tool?: string;
			elapsedMs?: number;
			toolCallId?: string;
			stopReason?: string;
		};
	}[] {
		const messages: {
			type: string;
			event?: {
				type?: string;
				messages?: unknown[];
				reason?: string;
				tool?: string;
				elapsedMs?: number;
				toolCallId?: string;
				stopReason?: string;
			};
		}[] = [];
		ws.on("message", (data: Buffer) => {
			try {
				messages.push(JSON.parse(data.toString()));
			} catch {
				/* ignore malformed */
			}
		});
		return messages;
	}

	/** Poll until predicate matches or the timeout elapses. */
	async function waitFor<T>(predicate: () => T | undefined, timeoutMs: number, step = 5): Promise<T> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const v = predicate();
			if (v !== undefined) return v;
			await new Promise((r) => setTimeout(r, step));
		}
		throw new Error(`waitFor: predicate not met within ${timeoutMs} ms`);
	}

	// -------------------------------------------------------------------------
	// Scenario 1 — roadmap §E2E.1: REST abort during streaming.
	// Acceptance:
	//   - POST /api/sessions/:id/abort returns 202 within <1 second
	//   - WS subscriber receives agent_end event with reason "aborted"
	//   - generation actually stops (no further chunks after abort)
	// -------------------------------------------------------------------------
	it("Scenario 1: POST /abort during streaming returns 202 <1s + WS agent_end + no further chunks", async () => {
		const longText = "the quick brown fox jumps over the lazy dog ".repeat(20);
		const { sessionId } = await bootStack(
			[
				{
					kind: "text",
					text: longText,
					delayBeforeStartMs: 50,
					chunkIntervalMs: 5,
				},
			],
			undefined,
		);

		const ws = await openWs(sessionId);
		const messages = collectMessages(ws);

		// Start the generation. session.prompt() returns a promise we don't
		// await — abort races the streaming.
		const promptPromise = harness!.session.prompt("say something long").catch(() => {});

		// Wait for streaming to actually start. The AgentSession forwards the
		// underlying `text_delta` events from the agent as `message_update`
		// envelopes (see packages/coding-agent/src/core/agent-session.ts —
		// the session-level event union is AgentEvent, not the lower-level
		// AssistantMessageEventStream events).
		await waitFor(() => messages.find((m) => m.event?.type === "message_update"), 2000);

		// Fire REST abort, measure timing.
		const t0 = Date.now();
		const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/abort`, {
			method: "POST",
		});
		const elapsedMs = Date.now() - t0;
		const body = (await res.json()) as { status?: string };

		expect(res.status).toBe(202);
		expect(body.status).toBe("aborted");
		expect(elapsedMs).toBeLessThan(1000);

		// WS subscriber must receive an agent_end frame.
		const agentEnd = await waitFor(() => messages.find((m) => m.event?.type === "agent_end"), 2000);
		expect(agentEnd).toBeDefined();

		// agent_end must carry the abort reason (last assistant message has
		// stopReason="aborted" or an errorMessage).
		const agentEndEvent = agentEnd.event as {
			messages?: Array<{ role: string; stopReason?: string; errorMessage?: string }>;
		};
		const lastAssistant = (agentEndEvent.messages ?? [])
			.slice()
			.reverse()
			.find((m) => m.role === "assistant");
		expect(lastAssistant?.stopReason).toBe("aborted");

		// No more streaming chunks should arrive after agent_end. We give the
		// stream enough time to misbehave (200ms) and assert nothing landed.
		const lastEndIdx = messages.lastIndexOf(agentEnd);
		await new Promise((r) => setTimeout(r, 200));
		const afterAbort = messages.slice(lastEndIdx + 1);
		const offending = afterAbort.find((m) => m.event?.type === "message_update");
		expect(offending).toBeUndefined();

		// session is no longer streaming.
		await promptPromise;
		expect(harness!.session.isStreaming).toBe(false);

		ws.close();
	});

	// -------------------------------------------------------------------------
	// Scenario 2 — roadmap §E2E.2: hung tool call → watchdog interrupts session.
	// Acceptance:
	//   - watchdog fires after watchdogTimeoutMs with diagnostic
	//   - session emits agent_end and is no longer streaming
	// -------------------------------------------------------------------------
	it("Scenario 2: hung tool call triggers watchdog_timeout diagnostic and stops the session", async () => {
		const hangTool = makeHangTool("bash");

		const { sessionId } = await bootStack(
			[
				// First response triggers the bash tool call.
				{ kind: "toolCall", toolName: "bash", toolCallId: "tc-bash-1", args: {} },
				// Second response never reached because watchdog aborts first.
				{ kind: "finalText", text: "final" },
			],
			{
				watchdog: { timeoutMs: 200, enabled: true },
				// Disable retry so watchdog_timeout ends the run cleanly.
				retry: { enabled: false },
			},
			{ bash: hangTool },
		);

		const ws = await openWs(sessionId);
		const messages = collectMessages(ws);

		const promptPromise = harness!.session.prompt("run the hanging tool").catch(() => {});

		// tool_execution_start must reach the WS subscriber (proves the tool
		// actually entered the hung state and the watchdog is armed).
		await waitFor(() => messages.find((m) => m.event?.type === "tool_execution_start"), 2000);

		// watchdog_timeout must arrive within watchdogTimeoutMs + slack.
		const wd = await waitFor(() => messages.find((m) => m.event?.type === "watchdog_timeout"), 1500);

		const wdEvent = wd.event as {
			type: string;
			tool?: string;
			reason?: string;
			elapsedMs?: number;
			toolCallId?: string;
		};
		expect(wdEvent.type).toBe("watchdog_timeout");
		expect(wdEvent.reason).toBe("watchdog_timeout");
		expect(wdEvent.tool).toBe("bash");
		expect(typeof wdEvent.toolCallId).toBe("string");
		// elapsedMs >= the configured 200 ms (real timers, not fake).
		expect(typeof wdEvent.elapsedMs).toBe("number");
		expect(wdEvent.elapsedMs).toBeGreaterThanOrEqual(150);

		// The session must terminate: agent_end frame on the WS subscriber.
		await waitFor(() => messages.find((m) => m.event?.type === "agent_end"), 2000);

		// Give the agent a beat to fully unwind.
		await new Promise((r) => setTimeout(r, 50));
		await promptPromise;
		expect(harness!.session.isStreaming).toBe(false);

		ws.close();
	});

	// -------------------------------------------------------------------------
	// Scenario 3 (bonus): WS abort command triggers the same abort path as REST.
	// Verifies the ws-handler routes { type: "abort" } to adapter.abortSession
	// and that the session actually stops.
	// -------------------------------------------------------------------------
	it("Scenario 3: WS {type:'abort'} message also aborts the session and emits agent_end", async () => {
		const { sessionId } = await bootStack(
			[
				{
					kind: "text",
					text: "hello world ",
					delayBeforeStartMs: 50,
					chunkIntervalMs: 20,
				},
			],
			undefined,
		);

		const ws = await openWs(sessionId);
		const messages = collectMessages(ws);

		const promptPromise = harness!.session.prompt("hi").catch(() => {});

		await waitFor(() => messages.find((m) => m.event?.type === "message_update"), 2000);

		// Send WS abort command instead of REST.
		ws.send(JSON.stringify({ type: "abort" }));

		await waitFor(() => messages.find((m) => m.event?.type === "agent_end"), 2000);

		await promptPromise;
		expect(harness!.session.isStreaming).toBe(false);

		ws.close();
	});
});
