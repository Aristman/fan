// test/e2e/recursive-spawn.test.mjs
// F-6: Integration tests for recursive spawned SO chain (Red phase).
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §F-6
// Спека:    docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-6
//
// Тестирует:
//   TC-F6-1: Depth-4 happy path — chain delegation (Coord → SO → SO → worker)
//   TC-F6-2: Crash mid-chain → walk-up escalation через lineage
//   TC-F6-3: Graceful shutdown всей цепочки
//
// Red-фаза: тесты должны FAIL, потому что:
//   TC-F6-1: recursive chain propagation не реализован (mock не спавнит детей)
//   TC-F6-2: delegation walk-up для SO chain не существует
//   TC-F6-3: graceful shutdown propagation для recursive chain не реализован
//
// Flaky mitigation: retry 2x, timeout 2x (Windows convention).

import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { createMockFanServer } from "../helpers/mock-fan-server.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Отправить делегацию на mock fan server через POST /api/mission-delegate.
 * @param {{ url: string }} server
 * @param {Record<string, unknown>} payload
 * @param {string} token
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
async function sendDelegation(server, payload, token) {
	const response = await fetch(`${server.url}/api/mission-delegate`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(payload),
	});
	const body = await response.json();
	return { status: response.status, body };
}

/**
 * Ожидать появления делегаций на mock server (polling).
 * Возвращает массив делегаций (может быть пустым при таймауте).
 * @param {{ delegations: Array<Record<string, unknown>> }} server
 * @param {number} timeoutMs
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function waitForDelegation(server, timeoutMs = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (server.delegations.length > 0) return [...server.delegations];
		await new Promise((r) => setTimeout(r, 50));
	}
	return [...server.delegations];
}

/**
 * Проверить что mock server отвечает на /api/health.
 * @param {{ url: string }} server
 * @returns {Promise<boolean>}
 */
async function isServerAlive(server) {
	try {
		const r = await fetch(`${server.url}/api/health`, { signal: AbortSignal.timeout(1000) });
		return r.status === 200;
	} catch {
		return false;
	}
}

/**
 * Подключить WS клиент к mock server и дождаться открытия.
 * @param {string} wsUrl
 * @returns {Promise<WebSocket>}
 */
async function connectWs(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
		setTimeout(() => reject(new Error("WS open timeout")), 3000);
	});
	return ws;
}

/**
 * Ожидать WS событие с таймаутом.
 * @param {WebSocket} ws
 * @param {string} eventType
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function waitForWsEvent(ws, eventType, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`WS event timeout: ${eventType}`)), timeoutMs);
		const handler = (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === eventType) {
					clearTimeout(timer);
					ws.removeListener("message", handler);
					resolve(msg);
				}
			} catch {
				/* ignore parse errors */
			}
		};
		ws.on("message", handler);
	});
}

/** Остановить все mock server'а (безопасный cleanup). */
async function stopAll(...servers) {
	for (const s of servers) {
		try {
			await s.stop();
		} catch {
			/* best-effort */
		}
	}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("recursive-spawn e2e (F-6)", () => {
	// TC-F6-1: Depth-4 happy path: spawned chain (Coord → SO → SO → worker)
	//
	// Условие: 4 mock fan server (auto-ports), роли:
	//   server[0] = super-orchestrator (depth=1, SO1)
	//   server[1] = super-orchestrator (depth=2, SO2)
	//   server[2] = worker (depth=3, W1)
	//   server[3] = coordinator (depth=0, для lineage/walk-up)
	//
	// Шаги:
	//   1. Parent отправляет delegation в server[0] (SO1, depth=1)
	//   2. Ожидание chain propagation: SO1 → SO2 → worker
	//   3. Verify: server[1] и server[2] получили делегации
	//
	// Ожидаемый результат (после Green):
	//   3 spawn entries в tree-journal; 3 complete entries; cost aggregated
	//
	// Почему FAIL (Red):
	//   Mock server[0] принимает делегацию, но НЕ пропагирует её в server[1].
	//   Recursive chain propagation не реализован — нет модуля, который
	//   после получения /api/mission-delegate спавнит следующего SO.
	it("TC-F6-1: depth-4 happy path — spawned chain delegation (Coord → SO → SO → worker)", async () => {
		const TOKEN_SO1 = "tok-so1";
		const TOKEN_SO2 = "tok-so2";
		const TOKEN_W1 = "tok-w1";
		const TOKEN_COORD = "tok-coord";

		// Start 4 mock servers (auto-port) with chainPropagation="auto" so they
		// forward delegation через lineage: SO1 → SO2 → W1.
		const so1 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_SO1, chainPropagation: "auto" });
		const so2 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_SO2, chainPropagation: "auto" });
		const w1 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_W1, chainPropagation: "auto" });
		const coord = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_COORD, chainPropagation: "auto" });

		// Connect WS client для получения mission_delegate_result events
		let wsSo1 = null;

		try {
			wsSo1 = await connectWs(so1.wsUrl);

			// Build lineage (coordinator → SO1 → SO2 → worker)
			const lineage = [
				{ correlationId: "coord", url: coord.url, token: TOKEN_COORD, role: "coordinator" },
				{ correlationId: "so1", url: so1.url, token: TOKEN_SO1, role: "super-orchestrator", profile: "pm" },
				{ correlationId: "so2", url: so2.url, token: TOKEN_SO2, role: "super-orchestrator", profile: "architect" },
				{ correlationId: "w1", url: w1.url, token: TOKEN_W1, role: "worker" },
			];

			// Parent отправляет delegation в SO1 (depth=1)
			const delegationPayload = {
				parentReportId: "rep-f6-1-parent",
				parentCorrelationId: "coord",
				role: "super-orchestrator",
				role_profile: "pm",
				depth: 1,
				packages: [{ task: "EPIC: implement feature X", tokenBudget: 5000 }],
				lineage,
			};

			const result = await sendDelegation(so1, delegationPayload, TOKEN_SO1);
			expect(result.status).toBe(200);
			expect(result.body.status).toBe("queued");
			expect(result.body.parentReportId).toBe("rep-f6-1-parent");

			// Verify SO1 received the delegation
			expect(so1.delegations).toHaveLength(1);
			expect(so1.delegations[0].parentReportId).toBe("rep-f6-1-parent");

			// Verify WS event emitted on SO1
			const wsEvent = await waitForWsEvent(wsSo1, "mission_delegate_result", 2000);
			expect(wsEvent.parentReportId).toBe("rep-f6-1-parent");
			expect(wsEvent.status).toBe("queued");

			// ── Key assertion: chain propagation ──
			// После получения делегации SO1 должен рекурсивно спавнить SO2
			// и отправить делегацию в SO2 через POST /api/mission-delegate.
			// SO2 в свою очередь должен спавнить worker W1.
			//
			// Ожидаем: so2.delegations.length > 0 (SO1 propagated to SO2)
			const so2Delegations = await waitForDelegation(so2, 3000);
			expect(so2Delegations.length).toBeGreaterThan(0);
			// ^^^ FAIL: SO1 — mock server, не имеет recursive spawn логики.
			// Делегация не пропагируется в SO2.

			// Ожидаем: w1.delegations.length > 0 (SO2 propagated to worker)
			const w1Delegations = await waitForDelegation(w1, 3000);
			expect(w1Delegations.length).toBeGreaterThan(0);
			// ^^^ FAIL: SO2 никогда не получает делегацию, поэтому не может
			// пропагировать в worker.
		} finally {
			if (wsSo1) wsSo1.close();
			await stopAll(so1, so2, w1, coord);
		}
	}, 15000); // 2x timeout for Windows flaky mitigation

	// TC-F6-2: Crash mid-chain → walk-up escalation через lineage
	//
	// Условие: chain spawned (Coord → SO1 → SO2); SO2 crashes mid-delegation.
	//
	// Шаги:
	//   1. Parent отправляет delegation в SO2 (depth=2)
	//   2. SO2 crashes (behavior: "crash" → 503 + WS close)
	//   3. Walk-up: делегация должна эскалироваться к SO1 (depth=1)
	//   4. Если SO1 тоже fails → orphan-report written
	//
	// Ожидаемый результат (после Green):
	//   walk-up attempts delivery to depth=1 → 200 OK;
	//   если depth=1 fails → orphan-report written;
	//   recovery на coordinator session_start.
	//
	// Почему FAIL (Red):
	//   Delegation walk-up для SO chain не существует.
	//   Existing walk-up.ts работает только для report delivery (worker chain).
	//   Для SO chain нужен delegation walk-up: при крахе SO2, делегация
	//   должна быть re-routed к SO1 через /api/mission-delegate (не /api/deliver-report).
	//   Нет модуля, который обнаруживает крах SO и инициирует walk-up.
	it("TC-F6-2: crash mid-chain → walk-up escalation via lineage", async () => {
		const TOKEN_SO1 = "tok-so1";
		const TOKEN_SO2 = "tok-so2-crash";
		const TOKEN_COORD = "tok-coord";

		// Start 3 mock servers with chainPropagation="auto" so SO2 при crash
		// walk-up'ит делегацию к SO1 (parent в lineage).
		const coord = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_COORD, chainPropagation: "auto" });
		const so1 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_SO1, chainPropagation: "auto" });
		// SO2 с behavior: "crash" — эмулирует SIGKILL mid-delegation
		const so2 = await createMockFanServer({ port: 0, behavior: "crash", token: TOKEN_SO2, chainPropagation: "auto" });

		try {
			// Build lineage для SO chain
			const lineage = [
				{ correlationId: "coord", url: coord.url, token: TOKEN_COORD, role: "coordinator" },
				{ correlationId: "so1", url: so1.url, token: TOKEN_SO1, role: "super-orchestrator", profile: "pm" },
				{ correlationId: "so2", url: so2.url, token: TOKEN_SO2, role: "super-orchestrator", profile: "architect" },
			];

			const delegationPayload = {
				parentReportId: "rep-f6-2-crash",
				parentCorrelationId: "so1",
				role: "super-orchestrator",
				role_profile: "architect",
				depth: 2,
				packages: [{ task: "sub-EPIC: implement Y", tokenBudget: 3000 }],
				lineage,
			};

			// Шаг 1: Отправить делегацию в SO2 (который crash)
			const crashResult = await sendDelegation(so2, delegationPayload, TOKEN_SO2);
			// SO2 crashes: behavior "crash" → 503 service_unavailable
			expect(crashResult.status).toBe(503);
			expect(so2.delegations).toHaveLength(0); // crash — не записывает делегацию

			// Шаг 2: Walk-up — делегация должна эскалироваться к SO1.
			// В recursive SO chain, когда SO2 crash'ит, parent (SO1) должен
			// обнаружить крах и re-route делегацию. Это требует:
			//   (a) detection: SO1 monitor'ит SO2 health
			//   (b) escalation: SO1 принимает делегацию вместо SO2
			//   (c) recording: tree-journal записывает walk-up event
			//
			// Проверяем: SO1 получил walk-up делегацию (re-route от SO2)
			const so1WalkUpDelegations = await waitForDelegation(so1, 3000);
			expect(so1WalkUpDelegations.length).toBeGreaterThan(0);
			// ^^^ FAIL: нет механизма delegation walk-up для SO chain.
			// SO1 не получает re-routed делегацию после краха SO2.
			// Existing walk-up.ts работает только для report delivery,
			// не для delegation re-routing.

			// Если walk-up достиг SO1, проверяем что coordinator тоже получил
			// notification (для recovery на session_start)
			const coordDelegations = await waitForDelegation(coord, 2000);
			expect(coordDelegations.length).toBeGreaterThan(0);
			// ^^^ FAIL: coordinator не получает notification о walk-up.
		} finally {
			await stopAll(coord, so1, so2);
		}
	}, 15000); // 2x timeout for Windows flaky mitigation

	// TC-F6-3: Graceful shutdown всей цепочки
	//
	// Условие: 4 spawned процесса работают (Coord + SO1 + SO2 + worker).
	//
	// Шаги:
	//   1. Abort parent (coordinator)
	//   2. Дождаться завершения children (SO1, SO2, worker)
	//   3. Verify: все процессы завершились ≤1с
	//   4. Verify: no hanging ports
	//
	// Ожидаемый результат (после Green):
	//   все 4 процесса завершились; journals корректные; no hanging ports.
	//
	// Почему FAIL (Red):
	//   Graceful shutdown propagation для recursive chain не реализован.
	//   Existing shutdownCircuit() в index.ts останавливает только локальный
	//   circuit. Для recursive chain нужно пропагировать shutdown через
	//   HTTP/WS всем дочерним SO узлам. Нет механизма: coordinator abort →
	//   SO1 abort → SO2 abort → worker abort.
	it("TC-F6-3: graceful shutdown of entire recursive chain", async () => {
		const TOKEN_SO1 = "tok-so1";
		const TOKEN_SO2 = "tok-so2";
		const TOKEN_W1 = "tok-w1";
		const TOKEN_COORD = "tok-coord";

		// Start 4 mock servers с chainPropagation="auto" — coord.stop()
		// триггерит WS close на всех peers (graceful shutdown всей chain).
		// parentNodeId wiring: coord ← so1 ← so2 ← w1.
		const coord = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_COORD, chainPropagation: "auto", nodeId: "coord", parentNodeId: null });
		const so1 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_SO1, chainPropagation: "auto", nodeId: "so1", parentNodeId: "coord" });
		const so2 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_SO2, chainPropagation: "auto", nodeId: "so2", parentNodeId: "so1" });
		const w1 = await createMockFanServer({ port: 0, behavior: "respond", token: TOKEN_W1, chainPropagation: "auto", nodeId: "w1", parentNodeId: "so2" });

		// Подключаем WS для мониторинга shutdown events
		const wsSo1 = await connectWs(so1.wsUrl);
		const wsSo2 = await connectWs(so2.wsUrl);
		const wsW1 = await connectWs(w1.wsUrl);

		try {
			// Verify все серверы работают
			expect(await isServerAlive(coord)).toBe(true);
			expect(await isServerAlive(so1)).toBe(true);
			expect(await isServerAlive(so2)).toBe(true);
			expect(await isServerAlive(w1)).toBe(true);

			// ── Abort parent (coordinator) ──
			// В реальной системе: coordinator получает SIGTERM → пропагирует
			// shutdown через HTTP POST /api/shutdown (или WS close) всем
			// дочерним узлам. Для теста: останавливаем coordinator mock.
			await coord.stop();

			// Verify coordinator stopped
			expect(await isServerAlive(coord)).toBe(false);

			// ── Key assertion: shutdown propagation ──
			// После abort coordinator, все дочерние узлы (SO1, SO2, W1)
			// должны получить shutdown notification и завершиться.
			//
			// Ожидаем: WS соединения закроются (shutdown event от parent)
			const shutdownTimeout = 1000; // ≤1с для graceful shutdown

			// Проверяем что WS соединения с детьми закрылись
			// (shutdown propagated from coordinator through the chain)
			const so1Closed = await new Promise((resolve) => {
				if (wsSo1.readyState === WebSocket.CLOSED) return resolve(true);
				const timer = setTimeout(() => resolve(false), shutdownTimeout);
				wsSo1.on("close", () => { clearTimeout(timer); resolve(true); });
			});
			expect(so1Closed).toBe(true);
			// ^^^ FAIL: WS соединение с SO1 не закрывается.
			// Coordinator остановлен, но shutdown не пропагируется к SO1.
			// Нет механизма: coordinator abort → notify SO1 via WS/HTTP.

			const so2Closed = await new Promise((resolve) => {
				if (wsSo2.readyState === WebSocket.CLOSED) return resolve(true);
				const timer = setTimeout(() => resolve(false), shutdownTimeout);
				wsSo2.on("close", () => { clearTimeout(timer); resolve(true); });
			});
			expect(so2Closed).toBe(true);
			// ^^^ FAIL: SO2 тоже не получает shutdown.

			const w1Closed = await new Promise((resolve) => {
				if (wsW1.readyState === WebSocket.CLOSED) return resolve(true);
				const timer = setTimeout(() => resolve(false), shutdownTimeout);
				wsW1.on("close", () => { clearTimeout(timer); resolve(true); });
			});
			expect(w1Closed).toBe(true);
			// ^^^ FAIL: worker тоже не получает shutdown.

			// Verify все серверы остановлены (порты освобождены)
			expect(await isServerAlive(so1)).toBe(false);
			expect(await isServerAlive(so2)).toBe(false);
			expect(await isServerAlive(w1)).toBe(false);
			// ^^^ FAIL: серверы всё ещё работают (no shutdown propagation).

			// ── Leaf-first order verification ──
			// ChainManager.shutdownChain() walks the chain post-order:
			// на каждой итерации останавливает текущие leaves, затем
			// повторяет. С parent-child wiring coord ← so1 ← so2 ← w1
			// ожидаем порядок остановки: w1 (leaf) → so2 → so1 → coord.
			// stopSequence — monotonic counter (в отличие от Date.now()
			// с ms precision, sub-ms интервалы надёжно различимы).
			expect(w1.stopSequence).not.toBeNull();
			expect(so2.stopSequence).not.toBeNull();
			expect(so1.stopSequence).not.toBeNull();
			expect(coord.stopSequence).not.toBeNull();
			expect(w1.stopSequence).toBeLessThan(so2.stopSequence);
			expect(so2.stopSequence).toBeLessThan(so1.stopSequence);
			expect(so1.stopSequence).toBeLessThan(coord.stopSequence);
			// ^^^ FAIL без leaf-first итерации: при отсутствии parent-child
			// wiring все ноды становятся leaves одновременно и останавливаются
			// параллельно — порядок не гарантирован. С parentNodeId выше
			// chainManager.shutdownChain() корректно walk'ает post-order.
		} finally {
			// Cleanup: закрываем WS и оставшиеся серверы
			for (const ws of [wsSo1, wsSo2, wsW1]) {
				try { if (ws.readyState !== WebSocket.CLOSED) ws.close(); } catch { /* ignore */ }
			}
			await stopAll(so1, so2, w1);
			// coord уже остановлен выше
		}
	}, 15000); // 2x timeout for Windows flaky mitigation
});
