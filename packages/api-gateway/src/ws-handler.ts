import type { IncomingMessage, Server } from "node:http";
import type { WebSocket as WsWebSocket } from "ws";
import { isAuthDisabled, validateToken } from "./auth.js";
import type { SessionAdapter } from "./http-server.js";
import { type DrainableMessageQueue, InMemoryMessageQueue, type QueuedMessage } from "./message-queue.js";
import type { WsIncomingMessage, WsOutgoingMessage, WsQueuesRestored } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface WsHandlerOptions {
	server: Server;
	sessionAdapter: SessionAdapter;
	/** Path prefix for WebSocket connections. Default: "/api/ws/" */
	pathPrefix?: string;
	/** F-2.5: optional shared message queue (default: new InMemoryMessageQueue).
	 *  Injectable for tests — any DrainableMessageQueue works as a drop-in
	 *  (e.g. PersistentMessageQueue, F-5.5). */
	messageQueue?: DrainableMessageQueue<WsSendMessagePayload>;
	/** F-5.6: snapshot of restored persistent queues, computed once at server
	 *  startup via {@link restoreQueuesOnStartup}. When present and
	 *  `restoredCount > 0`, every connecting client receives a
	 *  `queues_restored` frame right after the `connected` welcome frame. */
	restoredQueues?: QueuesRestoredInfo;
}

interface ClientConnection {
	ws: WsWebSocket;
	sessionId: string;
	unsubscribe: () => void;
}

// ============================================================================
// Queue restoration on server startup (F-5.6)
// ============================================================================

/** Snapshot of the persistent queues recovered from disk at server startup
 *  (F-5.6). Computed once during bootstrap and delivered to WS clients on
 *  connect (see {@link restoreQueuesOnStartup} for the delivery decision). */
export interface QueuesRestoredInfo {
	/** Number of session queues with pending messages (=== sessions.length). */
	restoredCount: number;
	/** Session ids with at least one pending message. */
	sessions: string[];
}

/** Persistence capability probed structurally — any queue exposing
 *  `getAllActive()` (PersistentMessageQueue, F-5.5) is restorable; the
 *  in-memory queue is not and yields `null`. */
interface RestorableMessageQueue {
	getAllActive(): Promise<string[]>;
}

/**
 * F-5.6: restore active queues at server startup.
 *
 * Returns the snapshot of sessions with pending messages, or `null` when the
 * queue is not persistent (in-memory) OR when restoration failed. Errors are
 * logged and NON-FATAL — a broken queue store must never prevent the server
 * from starting; it simply boots as if there were nothing to restore.
 *
 * Delivery decision (documented): the restore runs during bootstrap, before
 * any client can connect, so broadcasting at restore time would reach nobody.
 * The snapshot is therefore passed to the WS handlers and sent per-client on
 * connect — simpler and more reliable than broadcast timing. A client that
 * connects later still learns about recovered queues. On an empty start
 * (`restoredCount = 0`) NO `queues_restored` frame is sent at all.
 */
export async function restoreQueuesOnStartup(
	queue: DrainableMessageQueue<unknown>,
): Promise<QueuesRestoredInfo | null> {
	const restorable = queue as Partial<RestorableMessageQueue>;
	if (typeof restorable.getAllActive !== "function") {
		return null; // in-memory queue: nothing persisted, nothing to restore
	}
	try {
		const sessions = await restorable.getAllActive();
		if (sessions.length > 0) {
			console.log(
				`[api-gateway] Restored ${sessions.length} message queue(s) with pending messages: ${sessions.join(", ")}`,
			);
		}
		return { restoredCount: sessions.length, sessions };
	} catch (err) {
		console.error("[api-gateway] Queue restoration failed (continuing without restored queues):", err);
		return null;
	}
}

/** Build the `queues_restored` frame for a connecting client. `sessionId` is
 *  the connection the frame is delivered on (the event is server-wide). */
function queuesRestoredFrame(sessionId: string, info: QueuesRestoredInfo): WsQueuesRestored {
	return {
		type: "queues_restored",
		sessionId,
		timestamp: new Date().toISOString(),
		restoredCount: info.restoredCount,
		sessions: info.sessions,
	};
}

// ============================================================================
// Message Dispatcher — enqueue on busy (F-2.5)
// ============================================================================

/** Payload of a queued `sendMessage` WS request. */
export interface WsSendMessagePayload {
	content: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface WsMessageDispatcherOptions {
	sessionAdapter: SessionAdapter;
	/** Injectable for tests; a fresh InMemoryMessageQueue is created otherwise.
	 *  Any DrainableMessageQueue works as a drop-in (e.g. PersistentMessageQueue, F-5.5). */
	messageQueue?: DrainableMessageQueue<WsSendMessagePayload>;
}

/**
 * WsMessageDispatcher — routes incoming `sendMessage` WS messages (F-2.5).
 *
 * Busy semantics (single-engine runtime — ONE active session at a time):
 * - "Busy" = `sessionAdapter.isExecuting()` (engine streaming a response).
 *   Adapters without `isExecuting()` are treated as always idle → messages
 *   are always dispatched directly (no queueing, backward compatible).
 * - Busy + message for a DIFFERENT session than the active one → enqueue
 *   (switching the engine mid-stream would corrupt the running turn) and
 *   notify the client with `{ type: "queued", position: N }` (1-based
 *   position in the per-session queue).
 * - Queue full (F-2.15): when the session's queue already holds `maxSize`
 *   messages (default 50), `enqueue()` rejects and the client receives
 *   `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit: N }` instead
 *   of `queued`. The message is dropped — nothing is dispatched.
 * - Busy + message for the SAME (active) session → direct dispatch:
 *   `AgentSession.prompt()` already queues it internally via steer/followUp.
 * - Idle → direct dispatch via `sessionAdapter.sendMessage()` (which performs
 *   the switchSession when the target session differs).
 *
 * Dequeue processor strategy (documented decision):
 * - Queues are per-session (F-2.4), but draining is GLOBAL FIFO by enqueue
 *   timestamp across all sessions via `messageQueue.dequeueOldest()` — the
 *   globally oldest message runs first, regardless of which session it
 *   belongs to.
 * - Trigger points: (a) after every dispatched sendMessage completes
 *   (Promise settlement), and (b) on `agent_end` events observed by the
 *   session event subscriptions ({@link notifyIdle}). (b) covers turns that
 *   were started outside the WS path (REST POST /messages, followUp queues).
 * - Serialized by a `draining` flag; never dequeues while the engine is busy.
 */
export class WsMessageDispatcher {
	private readonly sessionAdapter: SessionAdapter;
	private readonly queue: DrainableMessageQueue<WsSendMessagePayload>;
	private draining = false;
	/**
	 * Global in-flight dispatch guard. The single-engine runtime can only
	 * switch/prompt one session at a time; this flag covers the window between
	 * the dispatch decision and the moment the adapter reports busy
	 * (`isExecuting()` true). While true, every incoming `sendMessage` is
	 * queued so that concurrent `switchSession`+`prompt` calls cannot happen.
	 */
	private dispatchPending = false;

	constructor(options: WsMessageDispatcherOptions) {
		this.sessionAdapter = options.sessionAdapter;
		this.queue = options.messageQueue ?? new InMemoryMessageQueue<WsSendMessagePayload>();
	}

	/** Engine busy check — adapters without isExecuting() are always idle. */
	private isBusy(): boolean {
		return this.sessionAdapter.isExecuting?.() ?? false;
	}

	/**
	 * Release the dispatch-pending guard once the adapter reports busy. At
	 * that point the normal `isBusy()` check takes over and future messages
	 * for other sessions will queue.
	 */
	private releaseDispatchGuardIfBusy(): void {
		if (this.dispatchPending && this.isBusy()) {
			this.dispatchPending = false;
		}
	}

	/**
	 * Handle an incoming WS message for `sessionId`. Non-sendMessage types are
	 * ignored (handled elsewhere). `send` delivers protocol frames back to the
	 * originating client (e.g. the `queued` notification).
	 */
	async handleMessage(
		sessionId: string,
		msg: WsIncomingMessage,
		send: (message: WsOutgoingMessage) => void,
	): Promise<void> {
		if (msg.type !== "sendMessage") return;

		const payload: WsSendMessagePayload = {
			content: msg.content,
			streamingBehavior: msg.streamingBehavior,
		};
		const activeSessionId = this.sessionAdapter.getActiveSessionId?.() ?? null;

		this.releaseDispatchGuardIfBusy();

		if (this.dispatchPending || (this.isBusy() && sessionId !== activeSessionId)) {
			// Engine busy with another session, or a dispatch is currently
			// starting → enqueue and notify position.
			try {
				const position = await this.queue.enqueue(sessionId, payload);
				if (position === null) {
					// F-2.15: queue overflow — reject with a queue_full notification.
					send({
						type: "queue_full",
						sessionId,
						timestamp: new Date().toISOString(),
						error: "QUEUE_OVERFLOW",
						limit: this.queue.maxSize,
					});
					return;
				}
				send({ type: "queued", sessionId, timestamp: new Date().toISOString(), position });
			} catch (err) {
				// F-5.5: enqueue can throw after I/O retries. Report a typed error
				// frame instead of letting the rejection escape as unhandled.
				console.error(`[ws-handler] enqueue failed for session ${sessionId}:`, err);
				send({
					type: "error",
					sessionId,
					timestamp: new Date().toISOString(),
					code: "QUEUE_PERSISTENCE_ERROR",
					message: "Failed to persist queued message",
				});
			}
			return;
		}

		// No conflict → direct dispatch (fire-and-forget; the WS handler must
		// not block on a full agent turn).
		this.dispatch(sessionId, payload);
	}

	/** Signal that the engine may have become idle (e.g. on `agent_end`). */
	notifyIdle(): void {
		void this.drainQueue();
	}

	/** Direct dispatch; triggers the dequeue processor on completion. */
	private dispatch(sessionId: string, payload: WsSendMessagePayload): void {
		this.dispatchPending = true;
		void Promise.resolve()
			.then(() => this.sessionAdapter.sendMessage(sessionId, payload.content, payload.streamingBehavior))
			.catch((err) => {
				console.error(`[ws-handler] sendMessage failed for session ${sessionId}:`, err);
			})
			.finally(() => {
				this.dispatchPending = false;
				void this.drainQueue();
			});
	}

	/**
	 * Background dequeue processor. Picks the globally-oldest queued message,
	 * awaits its full execution, then continues with the next one while the
	 * engine stays idle. Re-entrant calls no-op via the `draining` flag.
	 */
	private async drainQueue(): Promise<void> {
		this.releaseDispatchGuardIfBusy();
		if (this.draining || this.dispatchPending) return;
		this.draining = true;
		try {
			while (!this.isBusy()) {
				let next: { sessionId: string; item: QueuedMessage<WsSendMessagePayload> } | null;
				try {
					next = await this.queue.dequeueOldest();
				} catch (err) {
					// F-5.5: persistent queue I/O failure — stop draining safely.
					console.error("[ws-handler] dequeueOldest failed:", err);
					break;
				}
				if (!next) break;
				try {
					await this.sessionAdapter.sendMessage(
						next.sessionId,
						next.item.message.content,
						next.item.message.streamingBehavior,
					);
				} catch (err) {
					console.error(`[ws-handler] queued sendMessage failed for session ${next.sessionId}:`, err);
				}
			}
		} finally {
			this.draining = false;
		}
		// Race guard: a message may have been enqueued between the last
		// dequeueOldest() and the flag release above. One extra scan is cheap.
		if (!this.isBusy()) {
			let pending: { sessionId: string; item: QueuedMessage<WsSendMessagePayload> } | null = null;
			try {
				pending = await this.queue.dequeueOldest();
			} catch (err) {
				console.error("[ws-handler] dequeueOldest failed in race guard:", err);
			}
			if (pending) {
				// Put it back at the head is not possible — dispatch it directly
				// instead: the engine is idle, so ordering is preserved.
				this.dispatch(pending.sessionId, pending.item.message);
			}
		}
	}
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function attachWebSocketHandler(options: WsHandlerOptions): { close: () => void } {
	const { server, sessionAdapter, pathPrefix = "/api/ws/" } = options;

	// F-2.5: enqueue-on-busy dispatcher (shared queue across all connections)
	const dispatcher = new WsMessageDispatcher({ sessionAdapter, messageQueue: options.messageQueue });

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
					// F-2.5: a finished turn may free the engine → drain queued messages
					if (event?.type === "agent_end") {
						dispatcher.notifyIdle();
					}
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

				// F-5.6: notify about queues restored at server startup (only
				// when there is something to report — empty starts stay silent).
				if (options.restoredQueues && options.restoredQueues.restoredCount > 0) {
					ws.send(JSON.stringify(queuesRestoredFrame(connSessionId, options.restoredQueues)));
				}

				// Handle incoming messages
				ws.on("message", (data: Buffer) => {
					try {
						const msg = JSON.parse(data.toString()) as WsIncomingMessage;

						if (msg.type === "ping") {
							ws.send(
								JSON.stringify({ type: "pong", sessionId: connSessionId, timestamp: new Date().toISOString() }),
							);
						} else if (msg.type === "sendMessage") {
							// F-2.5: enqueue when the engine is busy with another session
							void dispatcher.handleMessage(connSessionId, msg, (out) => {
								if (ws.readyState === 1) {
									ws.send(JSON.stringify(out));
								}
							});
						}
						// Other message types can be handled here in the future
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

// ============================================================================
// Bun-native WebSocket bridge
// ============================================================================
//
// attachWebSocketHandler() hooks the raw Node http.Server "upgrade" event
// (ws package). Under Bun.serve there is no http.Server — upgrades go
// through server.upgrade() + the `websocket` serve option. The Docker image
// runs the gateway under Bun (`bun packages/coding-agent/dist/cli.js server`),
// so without this bridge WebSocket connections never upgraded and fell
// through to the SPA fallback (HTTP 200 HTML instead of 101).
//
// The bridge mirrors the same protocol as the ws-based handler:
//   ws://host/api/ws/<sessionId>?token=<token>
//   → welcome frame { type: "connected" }, ping → pong, agent_event frames.

interface BunWebSocketData {
	sessionId: string;
}

interface BunWebSocket {
	data: BunWebSocketData;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface BunServerLike {
	upgrade(req: Request, options: { data: BunWebSocketData }): boolean;
}

export interface BunWebSocketBridge {
	/** Route handler for /api/ws/* — returns a Response to send, or undefined
	 *  when the upgrade succeeded (Bun then answers 101 Switching Protocols). */
	handleFetch(req: Request, server: BunServerLike, url: URL): Promise<Response | undefined>;
	/** Value for the `websocket` option of Bun.serve(). */
	websocket: {
		open(ws: BunWebSocket): void;
		message(ws: BunWebSocket, message: string | Buffer): void;
		close(ws: BunWebSocket): void;
	};
}

export function createBunWebSocketBridge(
	sessionAdapter: SessionAdapter,
	pathPrefix = "/api/ws/",
	messageQueue?: DrainableMessageQueue<WsSendMessagePayload>,
	/** F-5.6: snapshot of queues restored at server startup — delivered to
	 *  each client on connect when `restoredCount > 0`. */
	restoredQueues?: QueuesRestoredInfo,
): BunWebSocketBridge {
	const unsubscribes = new Map<BunWebSocket, () => void>();
	// F-2.5: enqueue-on-busy dispatcher (shared queue across all connections)
	const dispatcher = new WsMessageDispatcher({ sessionAdapter, messageQueue });

	return {
		async handleFetch(req, server, url) {
			const sessionId = url.pathname.slice(pathPrefix.length);
			if (!sessionId) {
				return new Response("Not Found", { status: 404 });
			}

			// Same auth policy as the ws-based handler: ?token= query param,
			// skipped entirely when auth is disabled (never in public mode).
			const queryToken = url.searchParams.get("token");
			if (!isAuthDisabled() && !queryToken) {
				return new Response("Unauthorized", { status: 401 });
			}
			if (queryToken) {
				const clientToken = await validateToken(queryToken);
				if (!clientToken) {
					return new Response("Forbidden", { status: 403 });
				}
			}

			const upgraded = server.upgrade(req, { data: { sessionId } });
			return upgraded ? undefined : new Response("Expected a WebSocket upgrade request", { status: 426 });
		},
		websocket: {
			open(ws) {
				const { sessionId } = ws.data;
				const unsubscribe = sessionAdapter.subscribeToSession(sessionId, (event: any) => {
					const message: WsOutgoingMessage = {
						type: "agent_event",
						sessionId,
						timestamp: new Date().toISOString(),
						event,
					};
					ws.send(JSON.stringify(message));
					// F-2.5: a finished turn may free the engine → drain queued messages
					if (event?.type === "agent_end") {
						dispatcher.notifyIdle();
					}
				});
				unsubscribes.set(ws, unsubscribe);
				// Welcome frame — same shape as the ws-based handler.
				ws.send(
					JSON.stringify({
						type: "connected",
						sessionId,
						timestamp: new Date().toISOString(),
					}),
				);
				// F-5.6: notify about queues restored at server startup (only when
				// there is something to report — empty starts stay silent).
				if (restoredQueues && restoredQueues.restoredCount > 0) {
					ws.send(JSON.stringify(queuesRestoredFrame(sessionId, restoredQueues)));
				}
			},
			message(ws, message) {
				try {
					const msg = JSON.parse(message.toString()) as WsIncomingMessage;
					if (msg.type === "ping") {
						ws.send(
							JSON.stringify({
								type: "pong",
								sessionId: ws.data.sessionId,
								timestamp: new Date().toISOString(),
							}),
						);
					} else if (msg.type === "sendMessage") {
						// F-2.5: enqueue when the engine is busy with another session
						void dispatcher.handleMessage(ws.data.sessionId, msg, (out) => {
							ws.send(JSON.stringify(out));
						});
					}
				} catch {
					// Ignore malformed messages
				}
			},
			close(ws) {
				unsubscribes.get(ws)?.();
				unsubscribes.delete(ws);
			},
		},
	};
}
