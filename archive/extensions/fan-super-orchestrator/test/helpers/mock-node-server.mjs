// PHASE-GATE B helper: mock-узел (fake `fan server`).
//
// Эмулирует api-gateway дочернего узла — ТОЛЬКО эндпоинты, нужные
// child-node-client (F-29) и health/auth-проверкам:
//   GET  /api/health                     → 200 (публичный, БЕЗ auth)
//   GET  /api/sessions                   → 200 {sessions:[{id:"sess-main"}]} (Bearer, иначе 401)
//   POST /api/sessions/:id/messages      → Bearer (401 без/неверный); парсит body
//                                          {message, streamingBehavior}, запоминает work_package,
//                                          через delayMs эмитит agent_end по WS. 200 {success:true}
//   WS   /api/ws/:sessionId?token=...    → 401 без token / 403 неверный; {type:"connected"},
//                                          после получения work_package → agent_event/agent_end.
//
// Экспорт: startMockNode({ port, token, usage?, verdict?, delayMs? })
//   → { port, url, stop(), receivedWorkPackage() }.
// stop(): закрывает WS-клиентов + http server и ждёт закрытия (порт свободен).

import http from "node:http";
import { WebSocketServer } from "ws";

/** Поведение по умолчанию: usage отчёта, verdict и задержка ответа. */
const DEFAULT_USAGE = { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 };
const DEFAULT_DELAY_MS = 100;

/**
 * @param {{ port: number, token: string, usage?: {inputTokens:number, outputTokens:number, costUsd:number},
 *           verdict?: string, delayMs?: number }} opts
 * @returns {Promise<{ port: number, url: string, receivedWorkPackage: () => unknown, stop: () => Promise<void> }>}
 */
export async function startMockNode(opts) {
	const { port, token } = opts;
	const usage = opts.usage ?? DEFAULT_USAGE;
	const verdict = opts.verdict ?? "PASS";
	const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;

	/** Активные WS-клиенты (для broadcast agent_end и stop()). */
	const clients = new Set();
	/** Последний полученный work_package (body POST /messages). */
	let receivedWorkPackage = null;

	const json = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

		// Публичный health (без auth).
		if (req.method === "GET" && url.pathname === "/api/health") {
			json(res, 200, { status: "ok" });
			return;
		}

		// Всё остальное — под Bearer token.
		if (req.headers.authorization !== `Bearer ${token}`) {
			json(res, 401, { error: "unauthorized" });
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			json(res, 200, { sessions: [{ id: "sess-main" }] });
			return;
		}

		const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
		if (req.method === "POST" && messagesMatch) {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk.toString();
			});
			req.on("end", () => {
				let body = null;
				try {
					body = JSON.parse(raw);
				} catch {
					json(res, 400, { error: "invalid json" });
					return;
				}
				receivedWorkPackage = body;
				json(res, 200, { success: true });

				// Через delayMs — финальный отчёт agent_end всем WS-клиентам.
				setTimeout(() => {
					const reportText = `Задача выполнена.\nVERDICT: ${verdict}\nИзменено: 3 файлов.`;
					const frame = JSON.stringify({
						type: "agent_event",
						sessionId: messagesMatch[1],
						event: {
							type: "agent_end",
							messages: [
								{
									role: "assistant",
									content: [{ type: "text", text: reportText }],
									usage: {
										input: usage.inputTokens,
										output: usage.outputTokens,
										cost: { total: usage.costUsd },
									},
								},
							],
						},
					});
					for (const ws of clients) {
						try {
							ws.send(frame);
						} catch {
							// Клиент уже отключился — игнорируем.
						}
					}
				}, delayMs);
			});
			return;
		}

		json(res, 404, { error: "not found" });
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		if (!url.pathname.startsWith("/api/ws/")) {
			socket.destroy();
			return;
		}
		const reqToken = url.searchParams.get("token");
		if (reqToken === null) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (reqToken !== token) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			clients.add(ws);
			ws.on("close", () => clients.delete(ws));
			ws.send(JSON.stringify({ type: "connected" }));
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		port,
		url: `http://127.0.0.1:${port}`,
		receivedWorkPackage: () => receivedWorkPackage,
		async stop() {
			for (const ws of clients) {
				try {
					ws.terminate();
				} catch {
					// Уже закрыт — не критично.
				}
			}
			clients.clear();
			await new Promise((resolve) => wss.close(() => resolve()));
			await new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}
