// test/helpers/mock-fan-server.mjs
// F-H: Mock fan-server для e2e-тестов (depth-4 chain, walk-up e2e).
//
// Упрощённая версия mock-node-server.mjs: эмулирует базовый fan server
// с /api/health и /api/ws + /api/deliver-report для walk-up тестов.
//
// Экспорт: createMockFanServer({ port?, behavior?, latencyMs? })
//   → Promise<{ port, url, wsUrl, stop() }>
//
// behavior:
//   "respond" — ack на WS-сообщения, 200 на /api/deliver-report
//   "crash"   — WS close(1006) при первом сообщении
//   "reject"  — 500 на /api/deliver-report

import http from "node:http";
import { WebSocketServer } from "ws";

/**
 * @param {{ port?: number, behavior?: string, latencyMs?: number }} opts
 * @returns {Promise<{ port: number, url: string, wsUrl: string, stop: () => Promise<void> }>}
 */
export function createMockFanServer({ port = 0, behavior = "respond", latencyMs = 0 } = {}) {
	const httpServer = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

		// Публичный health-check (без auth).
		if (req.method === "GET" && url.pathname === "/api/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", version: "mock", uptime: 0 }));
			return;
		}

		// Deliver-report endpoint (для walk-up e2e).
		if (req.method === "POST" && url.pathname === "/api/deliver-report") {
			if (behavior === "reject") {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "internal" }));
				return;
			}
			let raw = "";
			req.on("data", (chunk) => { raw += chunk.toString(); });
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, received: JSON.parse(raw || "{}") }));
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });
	wss.on("connection", (ws) => {
		ws.on("message", (raw) => {
			if (latencyMs > 0) {
				setTimeout(() => handleWsMessage(ws, raw, behavior), latencyMs);
			} else {
				handleWsMessage(ws, raw, behavior);
			}
		});
	});

	function handleWsMessage(ws, raw, behavior) {
		if (behavior === "respond") {
			ws.send(JSON.stringify({ type: "ack", received: JSON.parse(raw.toString()) }));
		} else if (behavior === "crash") {
			ws.close(1006, "mock crash");
		}
	}

	return new Promise((resolve) => {
		httpServer.listen(port, "127.0.0.1", () => {
			const boundPort = httpServer.address().port;
			resolve({
				port: boundPort,
				url: `http://127.0.0.1:${boundPort}`,
				wsUrl: `ws://127.0.0.1:${boundPort}/api/ws`,
				stop: () =>
					new Promise((res) => {
						wss.close();
						httpServer.close(() => res());
					}),
			});
		});
	});
}
