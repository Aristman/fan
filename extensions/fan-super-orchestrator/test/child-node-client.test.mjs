// F-29: Child node client (REST + WS) — RED-фаза TDD.
//
// Модуль ../child-node-client.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-29
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2–3.3.3
//
// Клиент дочернего узла: L0 отправляет work package дочернему узлу L1 через
// HTTP API api-gateway (REST POST сообщения + WS подписка на события) и ждёт
// финальный отчёт (agent_end → parseNodeReport из node-report.js).
//
// Протокол api-gateway:
//   REST: POST http://127.0.0.1:<port>/api/sessions/<id>/messages
//         (Authorization: Bearer <token>, body: {message, streamingBehavior})
//         → {success:true} | 404
//   REST: GET /api/sessions → {sessions: [{id, ...}]}
//   WS:   ws://127.0.0.1:<port>/api/ws/<sessionId>?token=<token>
//         входящие JSON: {type:"connected"},
//         {type:"agent_event", sessionId, event} (event.type === "agent_end" →
//         event.messages: AgentMessage[]), {type:"pong"}
//
// Контракт модуля (всё через DI для моков):
//   interface WsLike {
//       onopen?: () => void; onmessage?: (ev: { data: string }) => void;
//       onclose?: () => void; onerror?: (err: unknown) => void;
//       close(): void; send(data: string): void;
//   }
//   interface ChildNodeClientOptions {
//       fetchFn?: typeof fetch;                 // default global fetch
//       wsFactory?: (url: string) => WsLike;    // default (url) => new WebSocket(url)
//       connectTimeoutMs?: number;              // default 30000
//       reconnectDelayMs?: number;              // default 1000
//       maxReconnects?: number;                 // default 5
//   }
//   interface SendWorkPackageOptions {
//       port: number; token: string; workPackage: WorkPackage; // из work-package.js
//       sessionId?: string;                     // если не задан — GET /api/sessions → первый
//   }
//   interface ChildNodeClient {
//       sendWorkPackage(opts: SendWorkPackageOptions): Promise<NodeReport>;
//       close(): void;
//   }
//   createChildNodeClient(opts?: ChildNodeClientOptions): ChildNodeClient
//
// Поведение sendWorkPackage:
//   1. sessionId ?? GET /api/sessions (Bearer) → sessions[0].id; нет сессий → throw
//   2. WS connect с ?token=; таймаут connectTimeoutMs → throw (сообщение содержит timeout)
//   3. POST пакета: serializeWorkPackage → message; не-2xx → throw
//   4. Ожидание agent_end: deadline из workPackage.deadline → при превышении
//      makeTimeoutReport (interrupted:true) и закрыть WS
//   5. WS onclose до agent_end → reconnect через reconnectDelayMs + переподписка
//      (до maxReconnects; исчерпано → makeAbortedReport interrupted:true)
//   6. agent_end → последнее assistant-сообщение → parseNodeReport(text,
//      {nodeId: correlationId.split("/").slice(1).join("/"), correlationId, usage})
//      — usage последнего assistant-сообщения:
//      {input?, output?, cost?:{total}} → inputTokens/outputTokens/costUsd; absent → 0
//   7. close() — таймеры + ws
//
// Покрытие (TC-карточки roadmap):
//   TC-F29-1  happy path: POST 200 → agent_end "VERDICT: PASS" → completed/PASS;
//             WS URL с ?token=, POST с Bearer
//   TC-F29-2  deadline now+2s (fake timers), agent_end не приходит → timeout-отчёт
//   TC-F29-3  WS обрыв → reconnect (wsFactory 2-й раз, тот же URL) → отчёт получен
//   Доп.      sessionId не задан → GET /api/sessions, первый id; сессий нет → throw;
//             POST 404/500 → throw; connect timeout → throw;
//             reconnect исчерпан → aborted-отчёт (interrupted:true);
//             usage-маппинг (полный/absent); nodeId из correlationId;
//             close() закрывает ws; без VERDICT → status "unknown"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let createChildNodeClient;

beforeAll(async () => {
	const mod = await import("../child-node-client.js");
	createChildNodeClient = mod.createChildNodeClient;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

/** Mock WS: триггеры _open()/_message(obj)/_close(), реестр созданных инстансов. */
class FakeWs {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.closed = false;
		this.onopen = undefined;
		this.onmessage = undefined;
		this.onclose = undefined;
		this.onerror = undefined;
		FakeWs.instances.push(this);
	}

	send(data) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
	}

	/** Триггер: соединение установлено. */
	_open() {
		this.onopen?.();
	}

	/** Триггер: входящее сообщение (объект → JSON). */
	_message(obj) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}

	/** Триггер: обрыв соединения. */
	_close() {
		this.onclose?.();
	}
}
FakeWs.instances = [];

/** wsFactory со списком вызовов (URL) и реестром инстансов FakeWs. */
function makeWsFactory() {
	return vi.fn((url) => new FakeWs(url));
}

/**
 * Мок fetch с маршрутизацией по URL:
 *   GET  /api/sessions                 → {sessions}
 *   POST /api/sessions/<id>/messages   → {success:true} | postStatus
 */
function makeFetchHarness({ sessions = [{ id: "sess-1" }], postStatus = 200 } = {}) {
	const calls = [];
	const fetchFn = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		calls.push({ url: u, opts });
		if (u.includes("/messages")) {
			const ok = postStatus >= 200 && postStatus < 300;
			return {
				ok,
				status: postStatus,
				json: async () => (ok ? { success: true } : { error: "Session not found or unavailable" }),
			};
		}
		if (u.includes("/api/sessions")) {
			return { ok: true, status: 200, json: async () => ({ sessions }) };
		}
		return { ok: false, status: 404, json: async () => ({}) };
	});
	return { fetchFn, calls };
}

/** Флаш микротасков (real timers). */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Валидный WorkPackage (по контракту work-package.js), deadline — далеко впереди. */
function makeWorkPackage(overrides = {}) {
	return {
		task: "Собрать отчёт по рынку",
		correlationId: "m-1/L1/node-3",
		depth: 1,
		spawnBudget: 0,
		tokenBudget: 100_000,
		costBudgetUsd: 0,
		maxRetries: 2,
		toolManifest: [],
		deadline: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

/** Assistant-сообщение в форме AgentMessage (content: TextContent[]). */
function assistantMessage(text, usage) {
	const msg = {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	if (usage !== undefined) {
		msg.usage = usage;
	}
	return msg;
}

/** WS-фрейм agent_event/agent_end. */
function agentEndFrame(messages, sessionId = "sess-1") {
	return {
		type: "agent_event",
		sessionId,
		timestamp: new Date().toISOString(),
		event: { type: "agent_end", messages },
	};
}

const PORT = 7301;
const TOKEN = "child-token-hex";
const SESSION_ID = "sess-1";
const EXPECTED_WS_URL = `ws://127.0.0.1:${PORT}/api/ws/${SESSION_ID}?token=${TOKEN}`;
const EXPECTED_POST_URL = `http://127.0.0.1:${PORT}/api/sessions/${SESSION_ID}/messages`;

function makeClient(harness, clientOpts = {}) {
	return createChildNodeClient({
		fetchFn: harness.fetchFn,
		wsFactory: makeWsFactory(),
		reconnectDelayMs: 20,
		...clientOpts,
	});
}

beforeEach(() => {
	FakeWs.instances.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── TC-F29-1: happy path — POST 200 → agent_end "VERDICT: PASS" ────────────

describe("TC-F29-1: sendWorkPackage → POST 200 → agent_end 'VERDICT: PASS' → completed/PASS", () => {
	it("POST вызван с Bearer-токеном и сериализованным пакетом; отчёт completed/PASS", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const workPackage = makeWorkPackage();

		const promise = client.sendWorkPackage({ port: PORT, token: TOKEN, workPackage, sessionId: SESSION_ID });
		await tick();
		const ws = FakeWs.instances.at(-1);
		ws._open();
		await tick(); // POST завершается
		ws._message(agentEndFrame([assistantMessage("Исследование завершено.\nVERDICT: PASS")]));

		const report = await promise;

		expect(report.status).toBe("completed");
		expect(report.verdict).toBe("PASS");

		// POST /api/sessions/<id>/messages с Bearer-токеном
		const postCall = harness.calls.find((c) => c.url.includes("/messages"));
		expect(postCall).toBeDefined();
		expect(postCall.url).toBe(EXPECTED_POST_URL);
		expect(postCall.opts.method).toBe("POST");
		expect(postCall.opts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });

		// message = JSON.stringify({ work_package: wp }), streamingBehavior = "followUp"
		const body = JSON.parse(postCall.opts.body);
		expect(body.streamingBehavior).toBe("followUp");
		expect(JSON.parse(body.message)).toEqual({ work_package: workPackage });
	});

	it("WS URL содержит ?token=<token>", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		const ws = FakeWs.instances.at(-1);

		expect(ws.url).toContain(`?token=${TOKEN}`);
		expect(ws.url).toBe(EXPECTED_WS_URL);

		ws._open();
		await tick();
		ws._message(agentEndFrame([assistantMessage("VERDICT: PASS")]));
		await promise;
	});

	it("result.text — raw-текст последнего assistant-сообщения", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const text = "Собраны данные по 3 конкурентам.\nVERDICT: PASS";

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage(text)]));

		const report = await promise;
		expect(report.result.text).toBe(text);
	});
});

// ─── TC-F29-2: deadline истекает до agent_end → timeout-отчёт ───────────────

describe("TC-F29-2: deadline = now+2s, agent_end не приходит → timeout-отчёт", () => {
	it("через 2s отчёт {status:'timeout', interrupted:true}, WS закрыт", async () => {
		vi.useFakeTimers();
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const workPackage = makeWorkPackage({ deadline: new Date(Date.now() + 2000).toISOString() });

		const promise = client.sendWorkPackage({ port: PORT, token: TOKEN, workPackage, sessionId: SESSION_ID });
		await vi.advanceTimersByTimeAsync(0);
		const ws = FakeWs.instances.at(-1);
		ws._open();
		await vi.advanceTimersByTimeAsync(0); // POST завершается

		await vi.advanceTimersByTimeAsync(2001);
		const report = await promise;

		expect(report.status).toBe("timeout");
		expect(report.interrupted).toBe(true);
		expect(report.verdict).toBeNull();
		expect(ws.closed).toBe(true);
	});
});

// ─── TC-F29-3: обрыв WS → reconnect → agent_end после reconnect ─────────────

describe("TC-F29-3: WS обрыв (onclose) → reconnect → отчёт получен", () => {
	it("wsFactory вызван 2-й раз с тем же URL; после reconnect agent_end → отчёт", async () => {
		const harness = makeFetchHarness();
		const wsFactory = makeWsFactory();
		const client = createChildNodeClient({
			fetchFn: harness.fetchFn,
			wsFactory,
			reconnectDelayMs: 20,
			maxReconnects: 3,
		});

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		const ws1 = FakeWs.instances[0];
		ws1._open();
		await tick();

		// Обрыв до agent_end
		ws1._close();

		// Reconnect: wsFactory вызван второй раз с тем же URL
		await vi.waitFor(() => expect(wsFactory).toHaveBeenCalledTimes(2));
		const ws2 = FakeWs.instances[1];
		expect(ws2.url).toBe(ws1.url);
		expect(ws2.url).toBe(EXPECTED_WS_URL);

		// После переподписки приходит agent_end
		ws2._open();
		ws2._message(agentEndFrame([assistantMessage("Готово.\nVERDICT: PASS")]));

		const report = await promise;
		expect(report.status).toBe("completed");
		expect(report.verdict).toBe("PASS");
	});
});

// ─── sessionId не задан → GET /api/sessions → первый id ─────────────────────

describe("sessionId не задан → discovery через GET /api/sessions", () => {
	it("GET вызван с Bearer; первый id использован в WS URL и POST URL", async () => {
		const harness = makeFetchHarness({ sessions: [{ id: "sess-A" }, { id: "sess-B" }] });
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({ port: PORT, token: TOKEN, workPackage: makeWorkPackage() });
		await tick();

		const getCall = harness.calls.find((c) => c.url === `http://127.0.0.1:${PORT}/api/sessions`);
		expect(getCall).toBeDefined();
		expect(getCall.opts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });

		const ws = FakeWs.instances.at(-1);
		expect(ws.url).toBe(`ws://127.0.0.1:${PORT}/api/ws/sess-A?token=${TOKEN}`);

		ws._open();
		await tick();
		const postCall = harness.calls.find((c) => c.url.includes("/messages"));
		expect(postCall.url).toBe(`http://127.0.0.1:${PORT}/api/sessions/sess-A/messages`);

		ws._message(agentEndFrame([assistantMessage("VERDICT: PASS")], "sess-A"));
		await promise;
	});

	it("sessionId задан → GET /api/sessions НЕ вызывается", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage("VERDICT: PASS")]));
		await promise;

		const getCalls = harness.calls.filter(
			(c) => c.url.endsWith("/api/sessions") && (c.opts.method ?? "GET") === "GET",
		);
		expect(getCalls).toEqual([]);
	});

	it("сессий нет → throw (отчёт не создаётся)", async () => {
		const harness = makeFetchHarness({ sessions: [] });
		const client = makeClient(harness);

		await expect(
			client.sendWorkPackage({ port: PORT, token: TOKEN, workPackage: makeWorkPackage() }),
		).rejects.toThrow();
		expect(FakeWs.instances).toEqual([]);
	});
});

// ─── POST не-2xx → throw ────────────────────────────────────────────────────

describe("POST пакета вернул не-2xx → throw", () => {
	it.each([404, 500])("POST → %i → sendWorkPackage rejects", async (postStatus) => {
		const harness = makeFetchHarness({ postStatus });
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		promise.catch(() => {}); // подавляем unhandled rejection до await
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();

		await expect(promise).rejects.toThrow();
	});
});

// ─── connect timeout ────────────────────────────────────────────────────────

describe("connect timeout: WS не открылся за connectTimeoutMs → throw", () => {
	it("onopen не вызван → reject с сообщением про timeout", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness, { connectTimeoutMs: 50 });

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		// WS создан, но _open() не вызываем
		await expect(promise).rejects.toThrow(/timeout/i);
	});
});

// ─── reconnect исчерпан → aborted-отчёт ─────────────────────────────────────

describe("reconnect исчерпан (maxReconnects=1, обрывы продолжаются) → aborted", () => {
	it("makeAbortedReport {status:'aborted', interrupted:true}, wsFactory вызван 2 раза", async () => {
		const harness = makeFetchHarness();
		const wsFactory = makeWsFactory();
		const client = createChildNodeClient({
			fetchFn: harness.fetchFn,
			wsFactory,
			reconnectDelayMs: 20,
			maxReconnects: 1,
		});

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances[0]._open();
		await tick();

		// Обрыв №1 → reconnect (последний разрешённый)
		FakeWs.instances[0]._close();
		await vi.waitFor(() => expect(wsFactory).toHaveBeenCalledTimes(2));
		FakeWs.instances[1]._open();

		// Обрыв №2 → reconnects исчерпаны
		FakeWs.instances[1]._close();

		const report = await promise;
		expect(report.status).toBe("aborted");
		expect(report.interrupted).toBe(true);
		expect(report.verdict).toBeNull();
		expect(wsFactory).toHaveBeenCalledTimes(2);
	});
});

// ─── usage из последнего assistant-сообщения ────────────────────────────────

describe("usage из последнего assistant-сообщения → NodeUsage", () => {
	it("{input:100, output:50, cost:{total:0.3}} → 100/50/0.3", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage("VERDICT: PASS", usage)]));

		const report = await promise;
		expect(report.usage.inputTokens).toBe(100);
		expect(report.usage.outputTokens).toBe(50);
		expect(report.usage.costUsd).toBeCloseTo(0.3, 10);
	});

	it("usage отсутствует → нули", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage("VERDICT: PASS")]));

		const report = await promise;
		expect(report.usage.inputTokens).toBe(0);
		expect(report.usage.outputTokens).toBe(0);
		expect(report.usage.costUsd).toBe(0);
	});
});

// ─── nodeId из correlationId ────────────────────────────────────────────────

describe("nodeId из correlationId", () => {
	it("correlationId 'm-1/L1/node-3' → nodeId 'L1/node-3', correlationId сохранён", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage({ correlationId: "m-1/L1/node-3" }),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage("VERDICT: PASS")]));

		const report = await promise;
		expect(report.nodeId).toBe("L1/node-3");
		expect(report.correlationId).toBe("m-1/L1/node-3");
	});
});

// ─── agent_end: выбор последнего assistant-сообщения ────────────────────────

describe("agent_end: отчёт парсится из последнего assistant-сообщения", () => {
	it("несколько сообщений: берётся текст и usage последнего assistant", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const messages = [
			{ role: "user", content: "go", timestamp: Date.now() },
			assistantMessage("Промежуточный итог.\nVERDICT: FAIL", { input: 1, output: 1, cost: { total: 0.01 } }),
			{ role: "user", content: "continue", timestamp: Date.now() },
			assistantMessage("Финальный итог.\nVERDICT: PASS", { input: 200, output: 60, cost: { total: 0.5 } }),
		];

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame(messages));

		const report = await promise;
		expect(report.status).toBe("completed");
		expect(report.verdict).toBe("PASS");
		expect(report.result.text).toBe("Финальный итог.\nVERDICT: PASS");
		expect(report.usage.inputTokens).toBe(200);
		expect(report.usage.costUsd).toBeCloseTo(0.5, 10);
	});
});

// ─── сообщение без VERDICT → unknown ────────────────────────────────────────

describe("agent_end без VERDICT в тексте → parseNodeReport → unknown", () => {
	it("status 'unknown', verdict null, raw-текст сохранён", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		const text = "Я что-то сделал, но не отчитался по протоколу.";

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();
		FakeWs.instances.at(-1)._message(agentEndFrame([assistantMessage(text)]));

		const report = await promise;
		expect(report.status).toBe("unknown");
		expect(report.verdict).toBeNull();
		expect(report.result.text).toBe(text);
	});
});

// ─── close() ────────────────────────────────────────────────────────────────

describe("close(): закрывает ws и таймеры", () => {
	it("close() во время ожидания agent_end → ws.close() вызван", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		promise.catch(() => {}); // возможный reject после close — не проверяем
		await tick();
		const ws = FakeWs.instances.at(-1);
		ws._open();
		await tick();

		expect(ws.closed).toBe(false);
		client.close();
		expect(ws.closed).toBe(true);
	});

	it("close() до создания ws — не бросает", () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness);
		expect(() => client.close()).not.toThrow();
	});
});

// ─── F-29 security: token не попадает в error-сообщения ────────────────────

describe("F-29 security: токены не утекают в error-сообщения", () => {
	it("connect timeout: reject message НЕ содержит значение токена, содержит token=***", async () => {
		const harness = makeFetchHarness();
		const client = makeClient(harness, { connectTimeoutMs: 50 });

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});

		try {
			await promise;
			expect.unreachable("должен был быть reject");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toContain(TOKEN);
			expect(msg).toContain("token=***");
			expect(msg).toMatch(/timeout/i);
		}
	});

	it("пустой список сессий: reject message НЕ содержит значение токена", async () => {
		const harness = makeFetchHarness({ sessions: [] });
		const client = makeClient(harness);

		try {
			await client.sendWorkPackage({
				port: PORT,
				token: TOKEN,
				workPackage: makeWorkPackage(),
			});
			expect.unreachable("должен был быть reject");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toContain(TOKEN);
			expect(msg).not.toContain("token=***"); // URL не формировался — маска не нужна
		}
	});

	it("POST ошибка: reject message НЕ содержит значение токена", async () => {
		const harness = makeFetchHarness({ postStatus: 500 });
		const client = makeClient(harness);

		const promise = client.sendWorkPackage({
			port: PORT,
			token: TOKEN,
			workPackage: makeWorkPackage(),
			sessionId: SESSION_ID,
		});
		promise.catch(() => {});
		await tick();
		FakeWs.instances.at(-1)._open();
		await tick();

		try {
			await promise;
			expect.unreachable("должен был быть reject");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toContain(TOKEN);
		}
	});
});
