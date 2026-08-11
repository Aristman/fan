import type { IncomingMessage, Server } from "node:http";
import type { WebSocket as WsWebSocket } from "ws";
import { isAuthDisabled, validateToken } from "./auth.js";
import type { SessionAdapter } from "./http-server.js";
import type { WsIncomingMessage, WsOutgoingMessage } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface WsHandlerOptions {
	server: Server;
	sessionAdapter: SessionAdapter;
	/** Path prefix for WebSocket connections. Default: "/api/ws/" */
	pathPrefix?: string;
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
	const { server, sessionAdapter, pathPrefix = "/api/ws/" } = options;

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
