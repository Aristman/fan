// F-35 helpers: реальный WS-адаптер + выбор свободного порта для mock-узлов.
//
// Используется интеграционными тестами hierarchy-*.test.mjs: НЕ мокаем
// fetch/ws — клиент ходит по настоящему HTTP/WS против mock-node-server.
//
// Порты: диапазон 7021–7030 (gate-скрипты занимают 7001/7011). Если порт
// занят (EADDRINUSE — гонка параллельных vitest-воркеров или забытый
// процесс), startMockOnFreePort берёт следующий из candidates.

import WebSocket from "ws";
import { startMockNode } from "./mock-node-server.mjs";

/** WsLike-фабрика поверх реального ws-клиента (пакет `ws`), как в phase-gate-b. */
export function wsFactory(url) {
	const socket = new WebSocket(url);
	const adapter = {
		close: () => socket.close(),
		send: (data) => socket.send(data),
	};
	socket.on("open", () => adapter.onopen?.());
	socket.on("message", (data) => adapter.onmessage?.({ data: data.toString() }));
	socket.on("close", () => adapter.onclose?.());
	socket.on("error", (err) => adapter.onerror?.(err));
	return adapter;
}

/** Диапазон портов [from..to] включительно. */
export function portRange(from, to) {
	const ports = [];
	for (let port = from; port <= to; port++) {
		ports.push(port);
	}
	return ports;
}

/**
 * Стартует mock-узел на первом свободном порту из candidates.
 * EADDRINUSE → следующий порт; прочие ошибки пробрасываются.
 * Если все порты заняты — бросает последнюю EADDRINUSE.
 */
export async function startMockOnFreePort(opts, candidates) {
	let lastError = null;
	for (const port of candidates) {
		try {
			return await startMockNode({ ...opts, port });
		} catch (error) {
			if (error !== null && typeof error === "object" && error.code === "EADDRINUSE") {
				lastError = error;
				continue;
			}
			throw error;
		}
	}
	throw lastError ?? new Error(`No free port among candidates: ${candidates.join(", ")}`);
}
