// test/e2e/transport-regression.test.mjs
// F-H: TC-FH-REG-1 — регрессионный тест для transport-фикса F-0.
//
// Цель: убедиться, что mock fan server корректно отдаёт JSON на
// /api/health (а не "Welcome to Bun!" / HTML) и принимает WS-upgrade
// на /api/ws. Это предохраняет от регрессий при миграции Bun → @hono/node-server.
//
// Reuses: test/helpers/mock-fan-server.mjs (createMockFanServer)
//
// Ожидаемый результат: PASS (mock infra + transport корректны).

import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { createMockFanServer } from "../helpers/mock-fan-server.mjs";

describe("transport regression (F-0 fix)", () => {
	it("TC-FH-REG-1a: /api/health returns JSON, not Bun welcome page", async () => {
		const server = await createMockFanServer({ port: 0, behavior: "respond" });

		const response = await fetch(`${server.url}/api/health`);
		const text = await response.text();

		expect(response.status).toBe(200);
		// Регрессионные ассерты: проверяем, что ответ НЕ дефолтная страница
		// "Welcome to Bun!" (была до F-0 фикса).
		expect(text).not.toContain("Welcome to Bun");
		expect(text).not.toContain("<!DOCTYPE");
		expect(text).not.toContain("<html");

		const body = JSON.parse(text);
		expect(body.status).toBe("ok");

		await server.stop();
	});

	it("TC-FH-REG-1b: WS upgrade path is /api/ws and connection opens", async () => {
		const server = await createMockFanServer({ port: 0, behavior: "respond" });

		const ws = new WebSocket(server.wsUrl);

		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
			// Timeout guard.
			setTimeout(() => reject(new Error("WS open timeout")), 2000);
		});

		// WebSocket.OPEN === 1
		expect(ws.readyState).toBe(1);

		ws.close();

		// Дать серверу время закрыть соединение.
		await new Promise((r) => setTimeout(r, 50));

		await server.stop();
	});
});