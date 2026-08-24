import type { IncomingMessage, Server } from "node:http";
import type { BudgetAlert, BudgetAlertHandler } from "@fan/model-manager";
import type { WebSocket as WsWebSocket } from "ws";
import { isAuthDisabled, validateToken } from "./auth.js";
import type { SessionAdapter } from "./http-server.js";
import type { WsBudgetAlert, WsIncomingMessage, WsMissionEvent, WsOutgoingMessage } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Structural type for budget tracker — accepts BudgetTracker or any compatible object. */
export interface BudgetTrackerLike {
	onAlert(handler: BudgetAlertHandler): () => void;
}

/** Structural type for mission journal write subscription (F-47).
 *  Compatible with TreeJournal.onJournalWrite (fan-super-orchestrator, F-32).
 *  Returns an unsubscribe function. */
export interface MissionJournalLike {
	onJournalWrite(callback: (entry: Record<string, unknown>) => void): () => void;
}

export interface WsHandlerOptions {
	server: Server;
	sessionAdapter: SessionAdapter;
	/** Path prefix for WebSocket connections. Default: "/api/ws/" */
	pathPrefix?: string;
	/** Budget tracker for broadcasting budget_alert events to WS clients (F-07). */
	budgetTracker?: BudgetTrackerLike;
	/** F-47: mission journal hook — every journal write broadcasts mission_event
	 *  to all connected WS clients. */
	missionJournal?: MissionJournalLike;
}

interface ClientConnection {
	ws: WsWebSocket;
	sessionId: string;
	unsubscribe: () => void;
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function attachWebSocketHandler(options: WsHandlerOptions): { close: () => void } {
	const { server, sessionAdapter, pathPrefix = "/api/ws/", budgetTracker, missionJournal } = options;

	// Map: sessionId → Set of connected clients
	const sessionClients = new Map<string, Set<ClientConnection>>();

	let wsServer: import("ws").WebSocketServer | null = null;
	let cleanupDone = false;

	function broadcastToSession(sessionId: string, message: WsOutgoingMessage): void {
		const clients = sessionClients.get(sessionId);
		if (!clients) return;

		const data = JSON.stringify(message);
		for (const client of clients) {
			if (client.ws.readyState === 1) {
				// OPEN
				client.ws.send(data);
			}
		}
	}

	// F-07: Broadcast budget_alert to ALL connected WS clients (system-wide, not per-session)
	function broadcastBudgetAlert(message: WsBudgetAlert): void {
		const data = JSON.stringify(message);
		for (const [, clients] of sessionClients) {
			for (const client of clients) {
				if (client.ws.readyState === 1) {
					client.ws.send(data);
				}
			}
		}
	}

	// F-47: Broadcast mission_event to ALL connected WS clients (system-wide)
	function broadcastMissionEvent(message: WsMissionEvent): void {
		const data = JSON.stringify(message);
		for (const [, clients] of sessionClients) {
			for (const client of clients) {
				if (client.ws.readyState === 1) {
					client.ws.send(data);
				}
			}
		}
	}

	// F-07: Register budget alert handler + dedup with reset detection.
	// Dedup key: provider|period|alertType — but we track usage to detect budget resets.
	// When tokensUsed or costUsed decreases (autoReset), the dedup entry is cleared so
	// alerts in the new budget period can fire again.
	const firedAlerts = new Map<string, { tokensUsed: number; costUsed: number }>();
	let currentAlertHandler: BudgetAlertHandler | undefined;
	let budgetUnsub: (() => void) | undefined;

	function registerBudgetHandler(handler: BudgetAlertHandler) {
		currentAlertHandler = handler;
		if (budgetTracker) {
			budgetUnsub = budgetTracker.onAlert(handler);
		}
	}

	// F-07 (Blocker A): Rebind budget alert subscription to the active session's ModelManager
	// after every newSession/switchSession. Without this, the handler stays subscribed to a
	// dead ModelManager and alerts from new sessions are silently dropped.
	function rebindBudgetAlerts() {
		if (!currentAlertHandler) return;
		budgetUnsub?.();
		budgetUnsub = undefined;
		firedAlerts.clear(); // New session → clean dedup state
		const activeMM = sessionAdapter.getActiveModelManager?.();
		if (activeMM) {
			budgetUnsub = activeMM.onBudgetAlert(currentAlertHandler);
		}
	}

	// Register the session change callback for automatic rebinding
	sessionAdapter.onSessionChange?.(rebindBudgetAlerts);

	// F-47: WS-producer — subscribe to mission journal writes (if provided).
	// missionId: entry.missionId field, else first segment of correlationId.
	let journalUnsub: (() => void) | undefined;
	if (missionJournal) {
		journalUnsub = missionJournal.onJournalWrite((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return;
			}
			const missionId =
				typeof entry.missionId === "string"
					? entry.missionId
					: typeof entry.correlationId === "string"
						? entry.correlationId.split("/")[0]
						: "unknown";
			broadcastMissionEvent({
				type: "mission_event",
				missionId,
				event: typeof entry.event === "string" ? entry.event : "unknown",
				nodeId: typeof entry.nodeId === "string" ? entry.nodeId : "",
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
				entry,
			});
		});
	}

	if (budgetTracker) {
		registerBudgetHandler((alert: BudgetAlert) => {
			const alertType = alert.type; // BudgetAlert.type → mapped to alertType in WS envelope
			const dedupKey = `${alert.provider}|${alert.period}|${alertType}`;

			const prev = firedAlerts.get(dedupKey);
			if (prev) {
				// Detect budget reset: usage decreased → new period started
				if (alert.tokensUsed < prev.tokensUsed || alert.costUsed < prev.costUsed) {
					firedAlerts.delete(dedupKey);
				} else {
					// Same period — update to track max usage (needed for future reset detection)
					firedAlerts.set(dedupKey, {
						tokensUsed: Math.max(prev.tokensUsed, alert.tokensUsed),
						costUsed: Math.max(prev.costUsed, alert.costUsed),
					});
					return; // Same period, same alert type → deduplicated
				}
			}
			firedAlerts.set(dedupKey, { tokensUsed: alert.tokensUsed, costUsed: alert.costUsed });

			// Use active session's ID, fall back to "system" for system-wide alerts
			const sessionId = sessionAdapter.getActiveSessionId?.() ?? "system";

			broadcastBudgetAlert({
				type: "budget_alert",
				sessionId,
				timestamp: new Date().toISOString(),
				alert: {
					provider: alert.provider,
					period: alert.period,
					alertType,
					message: alert.message,
				},
			});
		});
	}

	function removeClient(client: ClientConnection): void {
		const clients = sessionClients.get(client.sessionId);
		if (clients) {
			clients.delete(client);
			if (clients.size === 0) {
				sessionClients.delete(client.sessionId);
			}
		}
		// Unsubscribe from session events
		try {
			client.unsubscribe();
		} catch {
			// Ignore unsubscribe errors
		}
	}

	async function handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): Promise<void> {
		// Check path matches prefix
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const pathname = url.pathname;

		if (!pathname.startsWith(pathPrefix)) {
			socket.destroy();
			return;
		}

		// Extract sessionId from path
		const sessionId = pathname.slice(pathPrefix.length);
		if (!sessionId) {
			socket.destroy();
			return;
		}

		// Authenticate via ?token= query param
		const queryToken = url.searchParams.get("token");

		if (!isAuthDisabled() && !queryToken) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}

		if (queryToken) {
			const clientToken = await validateToken(queryToken);
			if (!clientToken) {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
		}

		// Dynamic import of 'ws' — lazy loaded to avoid import if not needed
		let WebSocketServer: typeof import("ws").WebSocketServer;

		try {
			const wsModule = await import("ws");
			WebSocketServer = wsModule.WebSocketServer;
		} catch {
			console.warn("[ws-handler] 'ws' package not installed. WebSocket support disabled.");
			socket.write(
				"HTTP/1.1 501 Not Implemented\r\n\r\nWebSocket support not available (ws package not installed)\r\n",
			);
			socket.destroy();
			return;
		}

		// Create WSS lazily on first connection
		if (!wsServer) {
			const wss = new WebSocketServer({ noServer: true });
			wsServer = wss;

			wss.on("connection", (ws: WsWebSocket, request: IncomingMessage) => {
				const connUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
				const connSessionId = connUrl.pathname.slice(pathPrefix.length);

				// Subscribe to session events
				const unsubscribe = sessionAdapter.subscribeToSession(connSessionId, (event: any) => {
					const message: WsOutgoingMessage = {
						type: "agent_event",
						sessionId: connSessionId,
						timestamp: new Date().toISOString(),
						event,
					};
					broadcastToSession(connSessionId, message);
				});

				const client: ClientConnection = { ws, sessionId: connSessionId, unsubscribe };

				// Track client
				if (!sessionClients.has(connSessionId)) {
					sessionClients.set(connSessionId, new Set());
				}
				sessionClients.get(connSessionId)!.add(client);

				// Send welcome message
				ws.send(
					JSON.stringify({
						type: "connected",
						sessionId: connSessionId,
						timestamp: new Date().toISOString(),
					}),
				);

				// Handle incoming messages
				ws.on("message", (data: Buffer) => {
					try {
						const msg = JSON.parse(data.toString()) as WsIncomingMessage;

						if (msg.type === "ping") {
							ws.send(
								JSON.stringify({ type: "pong", sessionId: connSessionId, timestamp: new Date().toISOString() }),
							);
						} else if (msg.type === "abort") {
							// F-01: abort active generation for the connected session
							sessionAdapter.abortSession(connSessionId).catch((err: unknown) => {
								console.warn(
									`[ws-handler] Abort failed for session ${connSessionId}:`,
									err instanceof Error ? err.message : err,
								);
							});
						} else if (msg.type === "drain") {
							// F-06: drain (graceful stop) for the connected session
							sessionAdapter.drainSession(connSessionId).catch((err: unknown) => {
								console.warn(
									`[ws-handler] Drain failed for session ${connSessionId}:`,
									err instanceof Error ? err.message : err,
								);
							});
						}
					} catch {
						// Ignore malformed messages
					}
				});

				ws.on("close", () => {
					removeClient(client);
				});

				ws.on("error", (err: Error) => {
					console.error(`[ws-handler] WebSocket error for session ${connSessionId}:`, err.message);
					removeClient(client);
				});
			});
		}

		// Handle the upgrade with the WSS
		wsServer.handleUpgrade(req, socket, head, (ws: WsWebSocket) => {
			wsServer!.emit("connection", ws, req);
		});
	}

	server.on("upgrade", handleUpgrade);

	return {
		close: () => {
			if (cleanupDone) return;
			cleanupDone = true;
			server.off("upgrade", handleUpgrade);
			// Unsubscribe from budget alerts
			if (budgetUnsub) {
				try {
					budgetUnsub();
				} catch {
					/* ignore */
				}
			}
			// F-47: Unsubscribe from mission journal
			if (journalUnsub) {
				try {
					journalUnsub();
				} catch {
					/* ignore */
				}
			}
			// Close all client connections
			for (const [, clients] of sessionClients) {
				for (const client of clients) {
					try {
						client.ws.close(1001, "Server shutting down");
					} catch {
						/* ignore */
					}
				}
			}
			sessionClients.clear();
			if (wsServer) {
				wsServer.close();
			}
		},
	};
}
