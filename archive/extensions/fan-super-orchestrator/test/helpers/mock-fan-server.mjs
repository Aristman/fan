// test/helpers/mock-fan-server.mjs
// F-H: Mock fan-server для e2e-тестов (depth-4 chain, walk-up e2e).
// F-6: Расширен endpoint POST /api/mission-delegate для recursive-spawn тестов.
// F-6: Добавлен option chainPropagation="auto" для chain-aware behavior.
//
// Упрощённая версия mock-node-server.mjs: эмулирует базовый fan server
// с /api/health и /api/ws + /api/deliver-report для walk-up тестов.
//
// Экспорт: createMockFanServer({ port?, behavior?, latencyMs?, token?, chainPropagation?, nodeId?, parentNodeId? })
//   → Promise<{ port, url, wsUrl, delegations, stop() }>
//
// behavior:
//   "respond" — ack на WS-сообщения, 200 на /api/deliver-report и /api/mission-delegate
//   "crash"   — WS close(1006) при первом сообщении
//   "reject"  — 500 на /api/deliver-report и /api/mission-delegate
//
// chainPropagation:
//   "none" (default) — passthrough: делегации просто записываются, никакой
//     chain-логики. Существующие тесты (depth-4, walk-up) работают как раньше.
//   "auto" — chain-aware behavior:
//     • register в chainManager при старте
//     • на /api/mission-delegate с role=super-orchestrator → forward к
//       следующему node в lineage (по URL lookup)
//     • на /api/mission-delegate с role=worker → process locally
//     • на behavior="crash" → walk-up к parent в lineage (перед 503)
//     • на stop() → broadcast shutdown через chainManager (закрывает WS
//       клиентов и HTTP servers на всех зарегистрированных peers)

import http from "node:http";
import { WebSocketServer } from "ws";

/** F-6: monotonic counter для stopSequence (module-level, shared between mocks). */
let stopSeqCounter = 0;

/**
 * @param {{
 *   port?: number,
 *   behavior?: string,
 *   latencyMs?: number,
 *   token?: string,
 *   chainPropagation?: string,
 *   nodeId?: string,
 *   parentNodeId?: string
 * }} opts
 * @returns {Promise<{
 *   port: number,
 *   url: string,
 *   wsUrl: string,
 *   delegations: Array<Record<string, unknown>>,
 *   stop: () => Promise<void>
 * }>}
 */
export function createMockFanServer({
	port = 0,
	behavior = "respond",
	latencyMs = 0,
	token = "mock-token",
	chainPropagation = "none",
	nodeId = null,
	parentNodeId = null,
} = {}) {
	/** F-6: трекинг полученных делегаций для тестовой верификации. */
	const delegations = [];
	/** Активные WS-клиенты (для broadcast mission_delegate_result и cleanup). */
	const wsClients = new Set();
	/** F-6: bound URL/port (известны после httpServer.listen). */
	let boundUrl = null;
	let boundPort = 0;
	/** F-6: chain-manager reference (lazy import, загружается при первом использовании). */
	let chainManagerMod = null;
	/** F-6: nodeId в chain (для registerNode/unregisterNode). */
	let myChainNodeId = nodeId;
	/** F-6: флаг, зарегистрирован ли mock в chain manager. */
	let chainRegistered = false;
	/** F-6: timestamp когда actualStop был вызван (для leaf-first verification). */
	let stoppedAt = null;
	/** F-6: monotonic sequence number actualStop (точный порядок остановки). */
	let stopSequence = null;

	/** F-6: helper для получения chainManager singleton. */
	async function getChainManager() {
		if (!chainManagerMod) {
			const mod = await import("../../chain-manager.js");
			chainManagerMod = mod;
		}
		return chainManagerMod.chainManager;
	}

	/** F-6: закрыть все WS connections без остановки HTTP server. */
	function closeAllWs() {
		for (const ws of wsClients) {
			try { ws.terminate(); } catch { /* ignore */ }
		}
		wsClients.clear();
	}

	/** F-6: реальный stop (для chainManager registration). */
	async function actualStop() {
		// F-6: record stop timestamp + monotonic sequence (для leaf-first
		// verification в e2e). Используем sequence вместо Date.now(),
		// потому что Date.now() имеет ms precision и при быстром
		// post-order shutdown соседние ноды могут получить одинаковый
		// timestamp, ломая проверку порядка.
		stoppedAt = Date.now();
		stopSequence = ++stopSeqCounter;
		// F-6: cleanup WS clients before closing server.
		for (const ws of wsClients) {
			try { ws.terminate(); } catch { /* ignore */ }
		}
		wsClients.clear();
		wss.close();
		httpServer.close(() => {});
		// F-6: unregister from chain manager.
		if (chainRegistered && myChainNodeId) {
			try {
				const cm = await getChainManager();
				cm.unregisterNode(myChainNodeId);
			} catch { /* ignore */ }
			chainRegistered = false;
		}
	}

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

		// F-6: Mission-delegate endpoint (для recursive-spawn e2e).
		// Авторизация через Bearer token (имитация FAN_NODE_TOKEN).
		// Поведение:
		//   "respond" → 200 { status: "queued", parentReportId } + WS broadcast
		//     + chainPropagation="auto" → forward к next in lineage
		//   "reject"  → 500 { error: "internal" }
		//   "crash"   → 400 + WS close(1006) для активных клиентов
		//     + chainPropagation="auto" → walk-up к parent in lineage
		if (req.method === "POST" && url.pathname === "/api/mission-delegate") {
			// Auth check: Bearer <token>
			const authHeader = req.headers.authorization;
			if (!authHeader || authHeader !== `Bearer ${token}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: authHeader ? "invalid_token" : "missing_token" }));
				return;
			}

			if (behavior === "reject") {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "internal" }));
				return;
			}

			if (behavior === "crash") {
				// F-6: chain walk-up ПЕРЕД закрытием WS/отдачей 503.
				// Читаем body async, walk-up POST к parent в lineage,
				// затем existing crash response.
				let raw = "";
				req.on("data", (chunk) => { raw += chunk.toString(); });
				req.on("end", async () => {
					let body = {};
					try {
						body = JSON.parse(raw || "{}");
					} catch { /* ignore */ }

					// F-6 chain walk-up (если включено).
					// Используем lineage из payload для поиска parent
					// (real-world scenario: parent URL/token передаются
					// в delegation payload, не хранятся в chain manager).
					if (chainPropagation === "auto") {
						try {
							await walkUpViaLineage(body);
						} catch { /* best-effort */ }
					}

					// Эмуляция краха: закрываем WS и возвращаем ошибку.
					for (const ws of wsClients) {
						try { ws.close(1006, "mock crash"); } catch { /* ignore */ }
					}
					wsClients.clear();
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "service_unavailable" }));
				});
				return;
			}

			let raw = "";
			req.on("data", (chunk) => { raw += chunk.toString(); });
			req.on("end", async () => {
				try {
					const body = JSON.parse(raw || "{}");
					delegations.push(body);

					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ status: "queued", parentReportId: body.parentReportId ?? null }));

					// F-6: broadcast WS event mission_delegate_result
					const wsEvent = JSON.stringify({
						type: "mission_delegate_result",
						parentReportId: body.parentReportId ?? null,
						fromCorrelationId: body.parentCorrelationId ?? null,
						status: "queued",
					});
					for (const ws of wsClients) {
						try { ws.send(wsEvent); } catch { /* client disconnected */ }
					}

					// F-6: chain propagation (async, после response).
					// Для role=super-orchestrator — forward к next в lineage.
					// Для role=worker — process locally (уже сделано выше).
					if (chainPropagation === "auto") {
						// Запускаем async, не блокируем response.
						setImmediate(() => {
							propagateAsync(body).catch(() => { /* best-effort */ });
						});
						// F-6: walk-up cascade — если получена walk-up делегация,
						// узел должен также walk-up'нуть дальше к root (coord).
						// Это гарантирует что coord получает notification при
						// crash любого descendant node в chain.
						if (body.walkUpFrom) {
							setImmediate(() => {
								walkUpViaLineage(body).catch(() => { /* best-effort */ });
							});
						}
					}
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_json" }));
				}
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	/**
	 * F-6: walk-up через lineage из payload к ближайшему живому предку.
	 * Используется в crash-сценарии: SO2 crash → walk-up к SO1.
	 *
	 * Алгоритм:
	 *   • Найти self в lineage (по URL).
	 *   • POST делегацию к immediate parent (lineage[selfIdx - 1]).
	 *   • Если fail → POST к grandparent и т.д. до coordinator.
	 *   • Если все fail → orphan (no-op для теста; just log).
	 */
	async function walkUpViaLineage(body) {
		const lineage = body.lineage;
		if (!Array.isArray(lineage) || !boundUrl) return;

		const myIdx = lineage.findIndex((e) => e.url === boundUrl);
		if (myIdx <= 0) return; // нет parent.

		// Walk-up от immediate parent вверх до coordinator (index 0).
		for (let i = myIdx - 1; i >= 0; i--) {
			const ancestor = lineage[i];
			if (!ancestor?.url) continue;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			try {
				const response = await globalThis.fetch(`${ancestor.url}/api/mission-delegate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${ancestor.token}`,
					},
					body: JSON.stringify({ ...body, walkUpFrom: myChainNodeId ?? `mock-${boundPort}` }),
					signal: controller.signal,
				});
				if (response.ok) return; // успешно доставлено.
			} catch { /* try next ancestor */ }
			finally {
				clearTimeout(timer);
			}
		}
	}

	/** F-6: async chain propagation к next в lineage. */
	async function propagateAsync(body) {
		const role = body.role;
		const lineage = body.lineage;
		if (!Array.isArray(lineage) || !boundUrl) return;

		// Найти self в lineage.
		const myIdx = lineage.findIndex((e) => e.url === boundUrl);
		if (myIdx < 0) return;

		const nextIdx = myIdx + 1;
		if (nextIdx >= lineage.length) return; // No next.

		// role=super-orchestrator → forward к next.
		// role=worker → process locally (ничего не делаем).
		if (role !== "super-orchestrator") return;

		const next = lineage[nextIdx];
		if (!next?.url) return;

		// Real HTTP POST к next node в chain.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		try {
			await globalThis.fetch(`${next.url}/api/mission-delegate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${next.token}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch { /* best-effort */ }
		finally {
			clearTimeout(timer);
		}
	}

	const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });
	wss.on("connection", (ws) => {
		wsClients.add(ws);
		ws.on("close", () => wsClients.delete(ws));
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
			boundPort = httpServer.address().port;
			boundUrl = `http://127.0.0.1:${boundPort}`;

			// F-6: register в chain manager (если chainPropagation="auto").
			if (chainPropagation === "auto") {
				if (!myChainNodeId) {
					myChainNodeId = `mock-${boundPort}`;
				}
				// Async registration; не блокирует resolve().
				getChainManager()
					.then((cm) => {
						cm.registerNode({
							nodeId: myChainNodeId,
							port: boundPort,
							url: boundUrl,
							token,
							role: "super-orchestrator", // initial; уточняется per delegation
							parentNodeId,
							mockServer: { stop: actualStop, closeWs: closeAllWs },
						});
						chainRegistered = true;
					})
					.catch(() => { /* chain-manager import failed */ });
			}

			resolve({
				port: boundPort,
				url: boundUrl,
				wsUrl: `ws://127.0.0.1:${boundPort}/api/ws`,
				/** F-6: полученные делегации (для тестовой верификации). */
				delegations,
				/** F-6: timestamp когда actualStop был вызван (leaf-first verification). */
				get stoppedAt() { return stoppedAt; },
				/** F-6: monotonic sequence actualStop (точный порядок leaf-first shutdown). */
				get stopSequence() { return stopSequence; },
				stop: () =>
					new Promise(async (res) => {
						// F-6: graceful shutdown chain (broadcast к peers).
						// Полностью останавливает HTTP server и WS на всех
						// зарегистрированных peers (recursive chain stop).
						if (chainRegistered) {
							try {
								const cm = await getChainManager();
								// Получить список других зарегистрированных nodes
								// и полностью остановить их через chainManager.
								// Это рекурсивно закрывает всю chain (leaf-first).
								const otherIds = cm.getAllNodeIds().filter((id) => id !== myChainNodeId);
								for (const otherId of otherIds) {
									try {
										await cm.shutdownChain(1000);
										break; // shutdownChain обрабатывает все nodes.
									} catch { /* ignore */ }
								}
								// unregister self (chainManager.shutdownChain уже
								// снял остальных; мы снимаем себя).
								cm.unregisterNode(myChainNodeId);
								chainRegistered = false;
							} catch { /* ignore */ }
						}
						// Cleanup WS clients + close server.
						for (const ws of wsClients) {
							try { ws.terminate(); } catch { /* ignore */ }
						}
						wsClients.clear();
						wss.close();
						httpServer.close(() => res());
					}),
			});
		});
	});
}
