// F-24: Аутентификация узлов (FAN_NODE_TOKEN) — RED-фаза TDD.
//
// Модуль ../node-auth.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля:
//   generateNodeToken() → string
//     — 64 hex chars (32 байта randomBytes), каждый вызов уникален.
//   buildSpawnEnv(token, extra?) → Record<string,string>
//     — { FAN_NODE_TOKEN: token, FAN_NO_AUTH: "0", ...extra }
//       (extra может переопределять FAN_NODE_TOKEN/FAN_NO_AUTH).
//   revokeNodeToken(baseUrl, adminToken, nodeName) → Promise<boolean>
//     — GET <baseUrl>/api/tokens (Authorization: Bearer <adminToken>)
//       → найти запись с name === nodeName
//       → DELETE <baseUrl>/api/tokens/:id (Bearer) → true
//       — не найден → false (DELETE не вызывается)
//       — сетевая ошибка → false (не бросает)
//
// Покрытие (TC-карточки roadmap):
//   TC-F24-A1  generateNodeToken: формат 64 hex + уникальность
//   TC-F24-A2  buildSpawnEnv: FAN_NODE_TOKEN + FAN_NO_AUTH=0, extra переопределяет
//   TC-F24-A3  revokeNodeToken: найден → DELETE + true; не найден → false без DELETE
//   TC-F24-A4  revokeNodeToken: сетевая ошибка в GET → false (не бросает)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let generateNodeToken;
let buildSpawnEnv;
let revokeNodeToken;

beforeAll(async () => {
	const mod = await import("../node-auth.js");
	generateNodeToken = mod.generateNodeToken;
	buildSpawnEnv = mod.buildSpawnEnv;
	revokeNodeToken = mod.revokeNodeToken;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

/** Мок fetch: GET /api/tokens → список tokens; DELETE → ok. */
function makeFetchHarness(tokens = []) {
	const calls = [];
	const fetchMock = vi.fn(async (url, opts = {}) => {
		calls.push({ url: String(url), opts });
		if (opts.method === "DELETE") {
			return { ok: true, status: 200, json: async () => ({}) };
		}
		return { ok: true, status: 200, json: async () => tokens };
	});
	return { fetchMock, calls };
}

const BASE_URL = "http://127.0.0.1:7001";
const ADMIN_TOKEN = "admin-token-hex";
const NODE_NAME = "fan-node:L1/node-1";

// ─── TC-F24-A1: generateNodeToken ───────────────────────────────────────────

describe("TC-F24-A1: generateNodeToken — формат и уникальность", () => {
	it("возвращает 64-символьный hex (32 байта)", () => {
		const token = generateNodeToken();
		expect(typeof token).toBe("string");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
	});

	it("два вызова → разные токены", () => {
		const t1 = generateNodeToken();
		const t2 = generateNodeToken();
		expect(t1).toMatch(/^[0-9a-f]{64}$/);
		expect(t2).toMatch(/^[0-9a-f]{64}$/);
		expect(t1).not.toBe(t2);
	});
});

// ─── TC-F24-A2: buildSpawnEnv ───────────────────────────────────────────────

describe("TC-F24-A2: buildSpawnEnv — env для дочернего процесса", () => {
	it("FAN_NODE_TOKEN=<token> и FAN_NO_AUTH=0", () => {
		const env = buildSpawnEnv("deadbeef");
		expect(env.FAN_NODE_TOKEN).toBe("deadbeef");
		expect(env.FAN_NO_AUTH).toBe("0");
	});

	it("без extra — ровно два ключа", () => {
		const env = buildSpawnEnv("deadbeef");
		expect(Object.keys(env).sort()).toEqual(["FAN_NODE_TOKEN", "FAN_NO_AUTH"]);
	});

	it("extra добавляет произвольные переменные", () => {
		const env = buildSpawnEnv("deadbeef", { FAN_PORT: "7001", NODE_ENV: "test" });
		expect(env.FAN_PORT).toBe("7001");
		expect(env.NODE_ENV).toBe("test");
		expect(env.FAN_NODE_TOKEN).toBe("deadbeef");
		expect(env.FAN_NO_AUTH).toBe("0");
	});

	it("extra может переопределять FAN_NO_AUTH и FAN_NODE_TOKEN", () => {
		const env = buildSpawnEnv("deadbeef", { FAN_NO_AUTH: "1", FAN_NODE_TOKEN: "override" });
		expect(env.FAN_NO_AUTH).toBe("1");
		expect(env.FAN_NODE_TOKEN).toBe("override");
	});

	it("не мутирует переданный extra-объект", () => {
		const extra = { FAN_PORT: "7001" };
		buildSpawnEnv("deadbeef", extra);
		expect(extra).toEqual({ FAN_PORT: "7001" });
	});
});

// ─── TC-F24-A3: revokeNodeToken — найден / не найден ───────────────────────

describe("TC-F24-A3: revokeNodeToken — поиск по имени и DELETE", () => {
	it("токен найден → DELETE /api/tokens/:id с Bearer → true", async () => {
		const { fetchMock, calls } = makeFetchHarness([
			{ id: "t1", name: "fan-node:L1/node-1", createdAt: "2026-08-14", lastUsed: null },
			{ id: "t2", name: "fan-node:L1/node-2", createdAt: "2026-08-14", lastUsed: null },
		]);
		vi.stubGlobal("fetch", fetchMock);

		const result = await revokeNodeToken(BASE_URL, ADMIN_TOKEN, NODE_NAME);

		expect(result).toBe(true);

		// GET /api/tokens с Bearer adminToken
		expect(calls[0].url).toBe(`${BASE_URL}/api/tokens`);
		expect(calls[0].opts.headers?.Authorization ?? calls[0].opts.headers?.authorization).toBe(
			`Bearer ${ADMIN_TOKEN}`,
		);

		// DELETE вызван ровно один раз, на id найденной записи, с Bearer
		const deleteCalls = calls.filter((c) => c.opts.method === "DELETE");
		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0].url).toBe(`${BASE_URL}/api/tokens/t1`);
		expect(
			deleteCalls[0].opts.headers?.Authorization ?? deleteCalls[0].opts.headers?.authorization,
		).toBe(`Bearer ${ADMIN_TOKEN}`);
	});

	it("имя не найдено → false, DELETE не вызывается", async () => {
		const { fetchMock, calls } = makeFetchHarness([
			{ id: "t2", name: "fan-node:L1/node-2", createdAt: "2026-08-14", lastUsed: null },
		]);
		vi.stubGlobal("fetch", fetchMock);

		const result = await revokeNodeToken(BASE_URL, ADMIN_TOKEN, "fan-node:L9/ghost");

		expect(result).toBe(false);
		expect(calls.filter((c) => c.opts.method === "DELETE")).toHaveLength(0);
	});

	it("пустой список токенов → false, DELETE не вызывается", async () => {
		const { fetchMock, calls } = makeFetchHarness([]);
		vi.stubGlobal("fetch", fetchMock);

		const result = await revokeNodeToken(BASE_URL, ADMIN_TOKEN, NODE_NAME);

		expect(result).toBe(false);
		expect(calls.filter((c) => c.opts.method === "DELETE")).toHaveLength(0);
	});
});

// ─── TC-F24-A4: revokeNodeToken — сетевая ошибка ───────────────────────────

describe("TC-F24-A4: revokeNodeToken — ошибки сети не бросают", () => {
	it("GET /api/tokens бросает (ECONNREFUSED) → resolves false", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		await expect(revokeNodeToken(BASE_URL, ADMIN_TOKEN, NODE_NAME)).resolves.toBe(false);
	});

	it("DELETE бросает → resolves false", async () => {
		const fetchMock = vi.fn(async (url, opts = {}) => {
			if (opts.method === "DELETE") {
				throw new Error("ECONNRESET");
			}
			return {
				ok: true,
				status: 200,
				json: async () => [{ id: "t1", name: NODE_NAME, createdAt: "2026-08-14", lastUsed: null }],
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(revokeNodeToken(BASE_URL, ADMIN_TOKEN, NODE_NAME)).resolves.toBe(false);
	});
});
