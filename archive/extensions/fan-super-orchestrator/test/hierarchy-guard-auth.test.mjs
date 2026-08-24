// F-35 (доп): depth/width guard в связке с depth2-параметрами + auth roundtrip.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2, §5.4
//
// Guard: canSpawn(depth=12) → max_depth_exceeded; canSpawn(depth=1,
// currentChildren=4) → max_width_exceeded (depth2 использует CHILD_DEPTH=1 и
// дефолтный workingWidth=4); отказ guard'а внутри createDepth2Integration
// обрывает fan-out с max_width_exceeded.
//
// Auth roundtrip (реальные HTTP/WS против mock-узла, БЕЗ моков fetch/ws):
//   • неверный Bearer → discovery GET /api/sessions 401 → клиент падает
//     с ошибкой (не зависает);
//   • неверный WS-токен → 403 на upgrade → reconnect исчерпывается →
//     aborted-отчёт (interrupted), POST пакета так и не отправлен;
//   • санити mock-узла: health публичный, sessions под Bearer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildNodeClient } from "../child-node-client.js";
import { canSpawn } from "../depth-width-guard.js";
import { createDepth2Integration } from "../depth2-integration.js";
import { createWorkPackage, makeCorrelationId } from "../work-package.js";
import { portRange, startMockOnFreePort, wsFactory } from "./helpers/hierarchy-helpers.mjs";

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-f35-ga-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Mock-узел + регистрация stop() в cleanup. */
async function trackMock(opts, candidates) {
	const mock = await startMockOnFreePort(opts, candidates);
	cleanups.push(() => mock.stop());
	return mock;
}

/** Валидный пакет для auth-тестов (щедрый deadline — не должен сработать). */
function makeAuthWorkPackage() {
	return createWorkPackage({
		task: "F-35 auth roundtrip",
		correlationId: makeCorrelationId("mission-f35-auth", 1, 1),
		depth: 1,
		tokenBudget: 26_666,
		deadline: new Date(Date.now() + 30_000).toISOString(),
	});
}

/** GET со статусом (0 — сеть недоступна). */
async function getStatus(url, headers) {
	try {
		const res = await fetch(url, { headers });
		await res.arrayBuffer();
		return res.status;
	} catch {
		return 0;
	}
}

// ─── Depth/width guard ──────────────────────────────────────────────────────

describe("F-35 (доп): canSpawn с depth2-параметрами", () => {
	it("canSpawn(depth=12) → max_depth_exceeded (дефолт maxDepth 12)", () => {
		const decision = canSpawn(12, 0);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("canSpawn(depth=1, currentChildren=4) → max_width_exceeded (дефолт workingWidth 4)", () => {
		const decision = canSpawn(1, 4);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("depth2 fan-out паттерн (CHILD_DEPTH=1): index 0..3 allowed, index 4 → max_width_exceeded", () => {
		for (let index = 0; index < 4; index++) {
			expect(canSpawn(1, index).allowed).toBe(true);
		}
		expect(canSpawn(1, 4)).toEqual({ allowed: false, reason: "max_width_exceeded" });
	});

	it("depth-2 конфиг maxDepth=2: canSpawn(depth=2) → max_depth_exceeded, глубина 1 разрешена", () => {
		const guard = { maxDepth: 2 };
		expect(canSpawn(2, 0, guard)).toEqual({ allowed: false, reason: "max_depth_exceeded" });
		expect(canSpawn(1, 0, guard).allowed).toBe(true);
	});

	it("createDepth2Integration: children=5 при workingWidth=4 → run отклоняется max_width_exceeded", async () => {
		const missionDir = makeTmpDir();
		const handle = createDepth2Integration({
			missionDir,
			missionId: "mission-f35-guard",
			budgetTotal: { tokens: 100_000, usd: 10 },
			guardOptions: { workingWidth: 4 },
			spawnNode: async () => ({ pid: 99_999 }),
			sendPackage: async ({ workPackage }) => ({
				nodeId: workPackage.correlationId.split("/").slice(1).join("/"),
				correlationId: workPackage.correlationId,
				status: "completed",
				verdict: "PASS",
				result: { text: "ok\nVERDICT: PASS" },
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
			}),
			killNode: async () => {},
		});

		await expect(
			handle.run({ task: "guard fan-out", children: 5, deadline: new Date(Date.now() + 30_000).toISOString() }),
		).rejects.toThrow(/max_width_exceeded/);
	});
});

// ─── Auth roundtrip ─────────────────────────────────────────────────────────

describe("F-35 (доп): auth roundtrip — mock-узел отвергает неверный токен", () => {
	it(
		"неверный Bearer: discovery GET /api/sessions → 401 → sendWorkPackage reject (не зависает)",
		async () => {
			const mock = await trackMock({ token: "real-token", delayMs: 50 }, portRange(7021, 7030));
			const client = createChildNodeClient({ wsFactory, connectTimeoutMs: 5000 });
			cleanups.push(() => client.close());

			const startedAt = Date.now();
			await expect(
				client.sendWorkPackage({ port: mock.port, token: "wrong-token", workPackage: makeAuthWorkPackage() }),
			).rejects.toThrow(/Session discovery failed.*401/);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			// Пакет до mock-узла не дошёл.
			expect(mock.receivedWorkPackage()).toBeNull();
		},
		15_000,
	);

	it(
		"неверный WS-токен: 403 на upgrade → reconnect исчерпан → aborted-отчёт (interrupted), POST не отправлен",
		async () => {
			const mock = await trackMock({ token: "real-token", delayMs: 50 }, portRange(7021, 7030));
			const client = createChildNodeClient({
				wsFactory,
				connectTimeoutMs: 5000,
				reconnectDelayMs: 50,
				maxReconnects: 2,
			});
			cleanups.push(() => client.close());

			const startedAt = Date.now();
			// sessionId задан явно — discovery пропускается, идём сразу в WS.
			const report = await client.sendWorkPackage({
				port: mock.port,
				token: "wrong-token",
				sessionId: "sess-main",
				workPackage: makeAuthWorkPackage(),
			});
			const durationMs = Date.now() - startedAt;

			// Клиент НЕ зависает: reconnect исчерпан → aborted + interrupted.
			expect(report.status).toBe("aborted");
			expect(report.interrupted).toBe(true);
			expect(durationMs).toBeLessThan(10_000);
			// WS так и не открылся → POST пакета не отправлялся.
			expect(mock.receivedWorkPackage()).toBeNull();
		},
		20_000,
	);

	it("санити mock-узла: health 200 без токена; sessions 401 без токена, 401 с неверным, 200 с верным", async () => {
		const mock = await trackMock({ token: "real-token", delayMs: 50 }, portRange(7021, 7030));

		expect(await getStatus(`${mock.url}/api/health`)).toBe(200);
		expect(await getStatus(`${mock.url}/api/sessions`)).toBe(401);
		expect(await getStatus(`${mock.url}/api/sessions`, { Authorization: "Bearer wrong-token" })).toBe(401);
		expect(await getStatus(`${mock.url}/api/sessions`, { Authorization: "Bearer real-token" })).toBe(200);
	}, 15_000);
});
