// @fan/api-gateway — Server bootstrap (F-0 extract)
//
// Extracted from http-server.ts (Phase 1 — F-0 refactor) to separate the
// transport-layer wiring (Hono app + HTTP server + WebSocket upgrade + stop())
// from the route definitions that live in createApp().
//
// Public surface is preserved: http-server.ts re-exports `startServer` from
// this module, so existing imports (`from "./http-server.js"`,
// `@fan/api-gateway` index) keep working unchanged.

import type { ModelManager } from "@fan/model-manager";
import { serve } from "@hono/node-server";
import { isAuthDisabled } from "./auth.js";
import type { ServerOptions, SessionAdapter } from "./http-server.js";
import { createApp } from "./http-server.js";
import { attachWebSocketHandler } from "./ws-handler.js";

// ============================================================================
// Resolved port helper
// ============================================================================

/** Resolve the actual bound port from a node http.Server instance.
 *  Falls back to the requested port if the address is unexpectedly absent
 *  (e.g. unix socket, or already-destroyed server). */
function resolveBoundPort(httpServer: { address(): unknown }, requestedPort: number): number {
	const address = httpServer.address();
	return typeof address === "object" && address !== null && address !== null
		? (address as { port: number }).port
		: requestedPort;
}

// ============================================================================
// Start Server
// ============================================================================

export async function startServer(
	modelManager: ModelManager,
	sessionAdapter: SessionAdapter,
	options: ServerOptions = {},
): Promise<{ port: number; stop: () => Promise<void> }> {
	const { port = 3456, host = "localhost" } = options;
	const app = await createApp(modelManager, sessionAdapter, options);

	// F-0: single transport for both Bun and Node.js — @hono/node-server + 'ws'.
	// The Bun.serve() branch was removed: it had no `websocket` config (no WS upgrade)
	// and its fetch handler broke as soon as @hono/node-server entered the module
	// graph (e.g. via the fan-webhook extension) → "Welcome to Bun!" fallback.

	// serve() returns the raw http.Server (ServerType) which we need for WebSocket upgrade
	const httpServer = serve({ fetch: app.fetch, port, hostname: host });

	// F-07 fix (Blocker A): Proxy budget tracker that delegates to the active session's
	// ModelManager. The ws-handler handles rebinding via sessionAdapter.onSessionChange.
	// This proxy provides the initial subscription target (the startup modelManager).
	const budgetTrackerProxy: { onAlert: (h: import("@fan/model-manager").BudgetAlertHandler) => () => void } = {
		onAlert: (h) => {
			const activeMM = sessionAdapter.getActiveModelManager?.() ?? modelManager;
			if (activeMM) {
				return activeMM.onBudgetAlert(h);
			}
			return () => {};
		},
	};

	// Attach WebSocket handler (requires 'ws' package)
	const wsHandler = attachWebSocketHandler({
		server: httpServer as any,
		sessionAdapter,
		budgetTracker: budgetTrackerProxy,
	});

	// Track upgraded (WebSocket) sockets: they are detached from the HTTP server's
	// connection tracking, so close()/closeAllConnections() cannot reap them.
	const upgradedSockets = new Set<import("node:net").Socket>();
	httpServer.on("upgrade", (_req, socket) => {
		const sock = socket as import("node:net").Socket;
		upgradedSockets.add(sock);
		sock.on("close", () => upgradedSockets.delete(sock));
	});

	const stop = async (): Promise<void> => {
		wsHandler.close();
		// Upgraded WS sockets are detached from the HTTP server's connection tracking,
		// so close()/closeAllConnections() cannot reap them — drop them explicitly.
		for (const sock of upgradedSockets) {
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
		}
		upgradedSockets.clear();
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(guard);
				resolve();
			};
			// Bun's node:http shim does not always fire the close callback once a
			// connection has been upgraded → bound the wait instead of hanging.
			const guard = setTimeout(finish, 500);
			httpServer.close(() => finish());
			// Avoid waiting on idle keep-alive connections (undici fetch pool).
			(httpServer as { closeIdleConnections?: () => void }).closeIdleConnections?.();
		});
	};

	// Wait until the socket is actually bound before returning (listen is async).
	const boundPort = await new Promise<number>((resolve, reject) => {
		const onListening = () => {
			httpServer.removeListener("error", onError);
			resolve(resolveBoundPort(httpServer, port));
		};
		const onError = (err: Error) => {
			httpServer.removeListener("listening", onListening);
			reject(err);
		};
		if (httpServer.listening) {
			onListening();
			return;
		}
		httpServer.once("listening", onListening);
		httpServer.once("error", onError);
	});

	console.log(`[api-gateway] Server running at http://${host}:${boundPort}`);
	console.log(`[api-gateway] Health: http://${host}:${boundPort}/api/health`);
	console.log(`[api-gateway] Docs: http://${host}:${boundPort}/api/health`);
	// Единая проверка с tokenAuth (./auth.ts): иначе warn срабатывает при
	// FAN_NO_AUTH=0 (или любой truthy-строке), хотя auth фактически включён.
	if (isAuthDisabled()) {
		console.warn(`[api-gateway] ⚠️  Auth disabled (FAN_NO_AUTH=${process.env.FAN_NO_AUTH})`);
	}

	return { port: boundPort, stop };
}
