// test/e2e/depth-4.test.mjs
// F-H: TC-FH-2 — depth-4 happy path e2e с mock fan servers.
//
// Проверяет:
//   1. Mock fan server отвечает на /api/health
//   2. Mock fan server принимает WebSocket-соединение
//   3. 4 mock server'а поднимаются одновременно (имитация depth-4 chain:
//      Coordinator d=0 → SO pm d=1 → SO architect d=2 → SO backend d=3)
//
// Ожидаемый результат: PASS (mock infra работает)

import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { createMockFanServer } from "../helpers/mock-fan-server.mjs";

describe("depth-4 happy path (TC-FH-2)", () => {
	it("TC-FH-2: mock fan server responds on /api/health", async () => {
		const server = await createMockFanServer({ port: 0, behavior: "respond" });
		expect(server.port).toBeGreaterThan(0);

		const response = await fetch(`${server.url}/api/health`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.status).toBe("ok");
		expect(body.version).toBe("mock");

		await server.stop();
	});

	it("TC-FH-2b: mock fan server accepts WebSocket connection and acks", async () => {
		const server = await createMockFanServer({ port: 0, behavior: "respond" });

		const ws = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});

		ws.send(JSON.stringify({ type: "test", payload: "hello" }));
		const reply = await new Promise((resolve, reject) => {
			ws.on("message", (data) => resolve(JSON.parse(data.toString())));
			ws.on("error", reject);
			// Timeout guard
			setTimeout(() => reject(new Error("WS reply timeout")), 2000);
		});

		expect(reply.type).toBe("ack");
		expect(reply.received.type).toBe("test");

		ws.close();
		await server.stop();
	});

	it("TC-FH-2c: depth-4 chain — 4 mock servers connectable sequentially", async () => {
		// Имитация depth-4: Coordinator (d=0) → SO pm (d=1) → SO architect (d=2) → SO backend (d=3)
		const roles = ["coordinator", "super-orchestrator:pm", "super-orchestrator:architect", "super-orchestrator:backend"];
		const servers = [];

		for (let i = 0; i < 4; i++) {
			const s = await createMockFanServer({ port: 0, behavior: "respond" });
			servers.push({ ...s, role: roles[i], depth: i });
		}

		expect(servers).toHaveLength(4);

		// Все порты уникальны
		const ports = servers.map((s) => s.port);
		expect(new Set(ports).size).toBe(4);

		// Каждый сервер отвечает на health-check
		for (const s of servers) {
			const r = await fetch(`${s.url}/api/health`);
			expect(r.status).toBe(200);
			const body = await r.json();
			expect(body.status).toBe("ok");
		}

		// Cleanup
		for (const s of servers) await s.stop();
	});
});
