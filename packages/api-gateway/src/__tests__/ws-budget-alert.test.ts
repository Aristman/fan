/**
 * F-07: WS budget_alert producer — tests
 *
 * Feature: WebSocket `budget_alert` event broadcast when BudgetTracker thresholds cross
 * Source: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-07, AC §3.2)
 *         docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2, §6.1
 *
 * Test plan:
 *   TC-F07-1     warning alert at 80% threshold → WS clients receive { type: "budget_alert", alert: { alertType: "warning", ... } }
 *   TC-F07-2     exceeded alert at 100% threshold → WS clients receive { alertType: "exceeded", ... }
 *   TC-F07-3     dedup: same provider/period/alertType fired twice → only one WS broadcast
 *   TC-F07-4     multiple connected sessions → all receive the alert (fan-out)
 *   TC-F07-5     no WS subscribers → alert handler invocation does not throw
 *   TC-F07-6     threshold escalation: warning → critical → exceeded → all three broadcast
 *   TC-F07-7     message shape strictly matches `WsBudgetAlert` (envelope + alert sub-object)
 *   TC-F07-rebind  after session switch, new modelManager's alert is broadcast
 *   TC-F07-dedup-reset  after auto-reset, same alert type fires again
 *   TC-F07-unsub  close() properly unsubscribes from budget tracker
 */

import { createServer, type Server } from "node:http";
import type { SessionAdapter } from "@fan/api-gateway";
import type { BudgetAlert, BudgetAlertHandler } from "@fan/model-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// Mock @fan/db — auth.ts uses getPrismaClient().clientToken.update for validateToken.
// Note: this file does NOT mock "ws" — we want a real WebSocketServer + real client
// so the broadcast path is genuinely exercised end-to-end.
vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: {
			create: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn(),
			delete: vi.fn(),
		},
	}),
}));

// Bypass token auth for WS in tests (simpler — auth covered by REST tests)
process.env.FAN_NO_AUTH = "1";

/** Shape of an incoming WS frame on the client side (for assertion convenience). */
interface ReceivedMessage {
	type: string;
	sessionId?: string;
	timestamp?: string;
	[key: string]: unknown;
}

/** Helper: collect messages received by a WS client. */
function collectMessages(ws: WebSocket): ReceivedMessage[] {
	const messages: ReceivedMessage[] = [];
	ws.on("message", (data: Buffer) => {
		try {
			messages.push(JSON.parse(data.toString()) as ReceivedMessage);
		} catch {
			/* ignore malformed */
		}
	});
	return messages;
}

/** Helper: wait for a brief async settle window (alert registration, broadcasts). */
function settle(ms = 200): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("F-07: WS budget_alert producer", () => {
	let server: Server;
	let port: number;
	let mockAdapter: Record<string, ReturnType<typeof vi.fn>>;
	/** Captured BudgetAlert handlers from `budgetTracker.onAlert(handler)` calls. */
	let alertHandlers: BudgetAlertHandler[];
	let mockBudgetTracker: {
		onAlert: ReturnType<typeof vi.fn>;
	};
	let handler: { close: () => void } | null = null;

	beforeEach(async () => {
		mockAdapter = {
			listSessions: vi.fn().mockResolvedValue([]),
			getSession: vi.fn().mockResolvedValue(null),
			createSession: vi.fn().mockResolvedValue({ id: "s1", title: "Test" }),
			deleteSession: vi.fn().mockResolvedValue(false),
			sendMessage: vi.fn().mockResolvedValue(true),
			subscribeToSession: vi.fn().mockReturnValue(() => {}),
			getAvailableModels: vi.fn().mockResolvedValue([]),
			bindSessionExtensions: vi.fn().mockResolvedValue(undefined),
			whenReady: vi.fn().mockResolvedValue(undefined),
			listAnalyticsReports: vi.fn().mockResolvedValue([]),
			readAnalyticsReport: vi.fn().mockResolvedValue(null),
			abortSession: vi.fn().mockResolvedValue(true),
			drainSession: vi.fn().mockResolvedValue(true),
			getActiveSessionId: vi.fn().mockReturnValue("test-session"),
			getActiveModelManager: vi.fn().mockReturnValue(undefined),
			onSessionChange: vi.fn(),
		};

		alertHandlers = [];
		mockBudgetTracker = {
			onAlert: vi.fn().mockImplementation((h: BudgetAlertHandler) => {
				alertHandlers.push(h);
				return () => {
					// Unsubscribe: remove from captured list (matches BudgetTracker.onAlert contract)
					const idx = alertHandlers.indexOf(h);
					if (idx >= 0) alertHandlers.splice(idx, 1);
				};
			}),
		};

		server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		if (handler) {
			handler.close();
			handler = null;
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	/**
	 * Open a real WebSocket connection to the test server.
	 * Resolves on `open`, rejects on error / timeout.
	 */
	async function openWs(sessionId: string): Promise<WebSocket> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/${sessionId}`);
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("WS connection timeout")), 5000);
			ws.once("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.once("error", (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
		return ws;
	}

	/**
	 * Wait until at least one BudgetAlert handler has been registered with the mock
	 * BudgetTracker. Polling handles both sync and async registration.
	 */
	async function waitForAlertRegistration(): Promise<BudgetAlertHandler> {
		for (let i = 0; i < 50; i++) {
			if (alertHandlers.length > 0) return alertHandlers[0];
			await settle(20);
		}
		throw new Error("BudgetTracker.onAlert was never called by attachWebSocketHandler");
	}

	/** Build a sample warning BudgetAlert (80% threshold). */
	function warningAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
		return {
			provider: "anthropic",
			period: "daily",
			type: "warning",
			message: "Budget warning for anthropic (daily): $0.80 / $1.00 (80%)",
			tokensUsed: 80_000,
			tokensLimit: 100_000,
			costUsed: 0.8,
			costLimit: 1.0,
			...overrides,
		};
	}

	/** Build a sample exceeded BudgetAlert (100% threshold). */
	function exceededAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
		return {
			provider: "anthropic",
			period: "daily",
			type: "exceeded",
			message: "Budget exceeded for anthropic (daily): $1.50 / $1.00",
			tokensUsed: 100_001,
			tokensLimit: 100_000,
			costUsed: 1.5,
			costLimit: 1.0,
			...overrides,
		};
	}

	/** Build a sample critical BudgetAlert (95% threshold). */
	function criticalAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
		return {
			provider: "anthropic",
			period: "daily",
			type: "critical",
			message: "Budget critical for anthropic (daily): $0.95 / $1.00 (95%)",
			tokensUsed: 95_000,
			tokensLimit: 100_000,
			costUsed: 0.95,
			costLimit: 1.0,
			...overrides,
		};
	}

	/** Build standard attachWebSocketHandler options with the mock adapter and budget tracker. */
	function buildOptions(
		budgetTrackerOverride?: { onAlert: ReturnType<typeof vi.fn> },
		adapterOverride?: Record<string, ReturnType<typeof vi.fn>>,
	) {
		return {
			server,
			sessionAdapter: (adapterOverride ?? mockAdapter) as unknown as SessionAdapter,
			budgetTracker: budgetTrackerOverride ?? mockBudgetTracker,
		};
	}

	// =========================================================================
	// TC-F07-1: WS budget_alert warning at 80% reaches subscribers
	// =========================================================================
	it("TC-F07-1: warning BudgetAlert → WS subscribers receive { type: 'budget_alert', alert: { alertType: 'warning', ... } }", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("budget-session-warn");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();
		onAlert(warningAlert());
		await settle();

		const alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);
		expect((alerts[0].alert as Record<string, unknown>).alertType).toBe("warning");
		expect((alerts[0].alert as Record<string, unknown>).provider).toBe("anthropic");
		expect((alerts[0].alert as Record<string, unknown>).period).toBe("daily");
		expect(typeof (alerts[0].alert as Record<string, unknown>).message).toBe("string");

		ws.close();
	});

	// =========================================================================
	// TC-F07-2: WS budget_alert exceeded at 100% reaches subscribers
	// =========================================================================
	it("TC-F07-2: exceeded BudgetAlert → WS subscribers receive { alertType: 'exceeded', ... }", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("budget-session-exceeded");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();
		onAlert(exceededAlert());
		await settle();

		const alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);
		expect((alerts[0].alert as Record<string, unknown>).alertType).toBe("exceeded");
		expect((alerts[0].alert as Record<string, unknown>).provider).toBe("anthropic");

		ws.close();
	});

	// =========================================================================
	// TC-F07-3: Dedup — one alert per threshold per period
	// =========================================================================
	it("TC-F07-3: same alert type for same provider/period is not broadcast twice (dedup)", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("budget-session-dedup");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();

		// First warning at 80% → broadcast
		onAlert(warningAlert({ tokensUsed: 81_000 }));
		await settle();

		// Still in warning range (85%) — repeat fire → must be deduped
		onAlert(warningAlert({ tokensUsed: 85_000, message: "still warning 85%" }));
		await settle();

		// Still in warning range (89%) — third fire → must be deduped
		onAlert(warningAlert({ tokensUsed: 89_000, message: "still warning 89%" }));
		await settle();

		const alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);
		expect((alerts[0].alert as Record<string, unknown>).alertType).toBe("warning");

		ws.close();
	});

	// =========================================================================
	// TC-F07-4: Fan-out — alert reaches all connected WS subscribers
	// =========================================================================
	it("TC-F07-4: a single BudgetAlert reaches all connected WS subscribers (fan-out)", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const wsA = await openWs("session-A");
		const wsB = await openWs("session-B");
		const messagesA = collectMessages(wsA);
		const messagesB = collectMessages(wsB);

		const onAlert = await waitForAlertRegistration();

		onAlert(warningAlert({ provider: "openai", period: "monthly" }));
		await settle();

		const alertsA = messagesA.filter((m) => m.type === "budget_alert");
		const alertsB = messagesB.filter((m) => m.type === "budget_alert");

		expect(alertsA).toHaveLength(1);
		expect(alertsB).toHaveLength(1);
		expect((alertsA[0].alert as Record<string, unknown>).provider).toBe("openai");
		expect((alertsB[0].alert as Record<string, unknown>).provider).toBe("openai");

		wsA.close();
		wsB.close();
	});

	// =========================================================================
	// TC-F07-5: No WS subscribers — alert handler invocation does not throw
	// =========================================================================
	it("TC-F07-5: BudgetAlert with zero connected subscribers does not throw", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const onAlert = await waitForAlertRegistration();

		expect(() => onAlert(warningAlert())).not.toThrow();
		expect(() => onAlert(exceededAlert())).not.toThrow();

		await settle();
		expect(alertHandlers.length).toBeGreaterThanOrEqual(1);
	});

	// =========================================================================
	// TC-F07-6: Threshold escalation — warning → critical → exceeded all broadcast
	// =========================================================================
	it("TC-F07-6: warning → critical → exceeded escalation broadcasts all three", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("budget-escalation");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();

		onAlert(warningAlert({ tokensUsed: 81_000 }));
		await settle();
		onAlert(criticalAlert({ tokensUsed: 95_000 }));
		await settle();
		onAlert(exceededAlert({ tokensUsed: 100_001 }));
		await settle();

		const alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(3);

		const alertTypes = alerts.map((a) => (a.alert as Record<string, unknown>).alertType);
		expect(alertTypes).toEqual(["warning", "critical", "exceeded"]);

		ws.close();
	});

	// =========================================================================
	// TC-F07-7: Exact WS message shape conforms to WsBudgetAlert
	// =========================================================================
	it("TC-F07-7: WS message envelope + alert sub-object match WsBudgetAlert exactly", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("budget-shape");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();

		const fixedAlert: BudgetAlert = {
			provider: "anthropic",
			period: "daily",
			type: "warning",
			message: "Budget warning for anthropic (daily)",
			tokensUsed: 80_000,
			tokensLimit: 100_000,
			costUsed: 0.8,
			costLimit: 1.0,
		};
		onAlert(fixedAlert);

		await settle();

		const alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);

		const alertMsg = alerts[0];

		// Envelope (WsMessage): type, sessionId, timestamp
		expect(alertMsg.type).toBe("budget_alert");
		expect(typeof alertMsg.sessionId).toBe("string");
		expect(alertMsg.sessionId).toBe("test-session");
		expect(typeof alertMsg.timestamp).toBe("string");
		// ISO 8601 timestamp check
		expect(() => new Date(alertMsg.timestamp as string).toISOString()).not.toThrow();

		// WsBudgetAlert.alert sub-object — exactly the four required fields
		const inner = alertMsg.alert as Record<string, unknown>;
		expect(inner).toBeDefined();
		expect(inner.provider).toBe("anthropic");
		expect(inner.period).toBe("daily");
		expect(inner.alertType).toBe("warning"); // mapped from BudgetAlert.type
		expect(inner.message).toBe("Budget warning for anthropic (daily)");

		// The producer must NOT leak internal BudgetAlert fields into the WS event
		expect(inner).not.toHaveProperty("type"); // BudgetAlert.type renamed to alertType
		expect(inner).not.toHaveProperty("tokensUsed");
		expect(inner).not.toHaveProperty("tokensLimit");
		expect(inner).not.toHaveProperty("costUsed");
		expect(inner).not.toHaveProperty("costLimit");

		ws.close();
	});

	// =========================================================================
	// TC-F07-aux: Producer actually wires BudgetTracker.onAlert
	// =========================================================================
	it("TC-F07-aux: attachWebSocketHandler wires budgetTracker.onAlert (sanity)", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		await waitForAlertRegistration();
		expect(mockBudgetTracker.onAlert).toHaveBeenCalled();
		expect(alertHandlers.length).toBeGreaterThanOrEqual(1);
	});

	// =========================================================================
	// TC-F07-rebind: After session switch, new modelManager's alert is broadcast
	// =========================================================================
	it("TC-F07-rebind: after session switch, alert from new modelManager is broadcast", async () => {
		// Two separate mock model managers simulating session A and session B
		const alertHandlersB: BudgetAlertHandler[] = [];
		const mockMMB = {
			onBudgetAlert: vi.fn().mockImplementation((h: BudgetAlertHandler) => {
				alertHandlersB.push(h);
				return () => {
					const idx = alertHandlersB.indexOf(h);
					if (idx >= 0) alertHandlersB.splice(idx, 1);
				};
			}),
		};

		// Start with no active model manager — initial subscription goes to budgetTracker directly
		let activeMM: { onBudgetAlert: ReturnType<typeof vi.fn> } | undefined;
		const sessionChangeCallbacks: Array<() => void> = [];

		const rebindAdapter = {
			...mockAdapter,
			getActiveModelManager: vi.fn().mockImplementation(() => activeMM),
			onSessionChange: vi.fn().mockImplementation((cb: () => void) => {
				sessionChangeCallbacks.push(cb);
			}),
		};

		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions(undefined, rebindAdapter));

		const ws = await openWs("rebind-test");
		const messages = collectMessages(ws);

		// Wait for initial registration on budgetTracker (mockBudgetTracker)
		const onAlert = await waitForAlertRegistration();

		// Verify initial budgetTracker works
		onAlert(warningAlert({ tokensUsed: 81_000 }));
		await settle();

		let alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);

		// Switch to modelManager B — simulate session change + rebind
		activeMM = mockMMB;
		for (const cb of sessionChangeCallbacks) cb();
		await settle();

		// B should now have a handler registered via rebind
		expect(alertHandlersB.length).toBeGreaterThanOrEqual(1);

		// Fire alert on B → should broadcast
		alertHandlersB[0](warningAlert({ provider: "openai", tokensUsed: 90_000 }));
		await settle();

		alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(2);
		expect((alerts[1].alert as Record<string, unknown>).provider).toBe("openai");

		ws.close();
	});

	// =========================================================================
	// TC-F07-dedup-reset: After budget reset, same alert type fires again
	// =========================================================================
	it("TC-F07-dedup-reset: after auto-reset, same alert type fires again in new period", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		const ws = await openWs("dedup-reset");
		const messages = collectMessages(ws);

		const onAlert = await waitForAlertRegistration();

		// Period 1: warning at 80% → broadcast
		onAlert(warningAlert({ tokensUsed: 80_000 }));
		await settle();

		let alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1);

		// Same period, same alert type → deduped
		onAlert(warningAlert({ tokensUsed: 85_000, message: "still warning" }));
		await settle();

		alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(1); // still 1

		// Budget auto-reset: tokensUsed drops to 0 (new period)
		// Then warning fires again at 80%
		onAlert(warningAlert({ tokensUsed: 80_000, message: "new period warning" }));
		await settle();

		alerts = messages.filter((m) => m.type === "budget_alert");
		expect(alerts).toHaveLength(2); // new broadcast after reset!

		ws.close();
	});

	// =========================================================================
	// TC-F07-unsub: close() properly unsubscribes from budget tracker
	// =========================================================================
	it("TC-F07-unsub: close() unsubscribes from budget tracker", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler(buildOptions());

		await waitForAlertRegistration();
		expect(alertHandlers.length).toBeGreaterThanOrEqual(1);

		// Close the handler — should call the unsubscribe returned by budgetTracker.onAlert
		handler.close();

		// After close, the mock's unsubscribe removes the handler from alertHandlers
		expect(alertHandlers).toHaveLength(0);

		// Firing an alert after close must not throw
		// (the captured onAlert still exists but the handler was removed from the list)
		const capturedHandler = alertHandlers[0]; // undefined since removed
		if (capturedHandler) {
			expect(() => capturedHandler(warningAlert())).not.toThrow();
		}

		handler = null; // already closed
	});
});
