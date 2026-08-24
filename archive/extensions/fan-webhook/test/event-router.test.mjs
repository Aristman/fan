// F-14: Unit-тесты event-router — маршрутизация событий вебхука.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
//
// Тестируем routeWebhookEvent() изолированно от HTTP-слоя (Hono).
// Контракт:
//   routeWebhookEvent(body, actions) → Promise<void>
//   - steer/followUp → actions.sendMessage(message, type)
//   - Invalid body   → throws Error("Invalid JSON")
//   - Missing type   → throws Error("Missing 'type'")
//   - Unknown type   → throws Error("Unknown event type")
//   - Missing message → throws Error("Missing 'message'")
//   - sendMessage errors пробрасываются как есть

import { describe, expect, it, vi } from "vitest";

import { routeWebhookEvent } from "../event-router.js";

// ─── DI-хелперы ──────────────────────────────────────────────────────────────

function makeActions(overrides = {}) {
	const calls = [];
	return {
		calls,
		sendMessage(text, streamingBehavior) {
			calls.push({ text, streamingBehavior });
			if (overrides.sendMessageImpl) {
				return overrides.sendMessageImpl(text, streamingBehavior);
			}
			return undefined;
		},
	};
}

// ─── Успешная маршрутизация ──────────────────────────────────────────────────

describe("F-14 / event-router: успешная маршрутизация", () => {
	it("steer → sendMessage вызван с правильными аргументами", async () => {
		const actions = makeActions();
		await routeWebhookEvent({ type: "steer", message: "fix CI" }, actions);
		expect(actions.calls).toHaveLength(1);
		expect(actions.calls[0]).toEqual({ text: "fix CI", streamingBehavior: "steer" });
	});

	it("followUp → sendMessage вызван с правильными аргументами", async () => {
		const actions = makeActions();
		await routeWebhookEvent({ type: "followUp", message: "PR merged" }, actions);
		expect(actions.calls).toHaveLength(1);
		expect(actions.calls[0]).toEqual({ text: "PR merged", streamingBehavior: "followUp" });
	});

	it("пустая строка message — допустима", async () => {
		const actions = makeActions();
		await routeWebhookEvent({ type: "steer", message: "" }, actions);
		expect(actions.calls).toHaveLength(1);
		expect(actions.calls[0].text).toBe("");
	});

	it("длинный текст с unicode — без модификаций", async () => {
		const actions = makeActions();
		const text = "CI failed: тест №42 — assertion 🚀";
		await routeWebhookEvent({ type: "steer", message: text }, actions);
		expect(actions.calls[0].text).toBe(text);
	});

	it("async sendMessage — ожидается через await", async () => {
		let resolved = false;
		const actions = makeActions({
			sendMessageImpl: async () => {
				await new Promise((r) => setTimeout(r, 10));
				resolved = true;
			},
		});
		await routeWebhookEvent({ type: "steer", message: "async" }, actions);
		expect(resolved).toBe(true);
	});
});

// ─── Ошибки валидации ────────────────────────────────────────────────────────

describe("F-14 / event-router: ошибки валидации", () => {
	it("null body → throws 'Invalid JSON'", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent(null, actions)).rejects.toThrow("Invalid JSON");
		expect(actions.calls).toHaveLength(0);
	});

	it("undefined body → throws 'Invalid JSON'", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent(undefined, actions)).rejects.toThrow("Invalid JSON");
		expect(actions.calls).toHaveLength(0);
	});

	it("string body → throws 'Invalid JSON'", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent("not an object", actions)).rejects.toThrow("Invalid JSON");
		expect(actions.calls).toHaveLength(0);
	});

	it("number body → throws 'Invalid JSON'", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent(42, actions)).rejects.toThrow("Invalid JSON");
		expect(actions.calls).toHaveLength(0);
	});

	it("array body → throws 'Invalid JSON'", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent([1, 2, 3], actions)).rejects.toThrow("Invalid JSON");
		expect(actions.calls).toHaveLength(0);
	});

	it("empty object {} → throws 'Missing \\'type\\''", async () => {
		const actions = makeActions();
		await expect(routeWebhookEvent({}, actions)).rejects.toThrow("Missing 'type'");
		expect(actions.calls).toHaveLength(0);
	});

	it("null type → throws 'Missing \\'type\\''", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: null, message: "hi" }, actions),
		).rejects.toThrow("Missing 'type'");
		expect(actions.calls).toHaveLength(0);
	});

	it("unknown type → throws 'Unknown event type'", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: "unknown", message: "hi" }, actions),
		).rejects.toThrow("Unknown event type");
		expect(actions.calls).toHaveLength(0);
	});

	it("type=number → throws 'Unknown event type'", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: 123, message: "hi" }, actions),
		).rejects.toThrow("Unknown event type");
		expect(actions.calls).toHaveLength(0);
	});

	it("missing message → throws 'Missing \\'message\\''", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: "steer" }, actions),
		).rejects.toThrow("Missing 'message'");
		expect(actions.calls).toHaveLength(0);
	});

	it("message=number → throws 'Missing \\'message\\''", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: "steer", message: 42 }, actions),
		).rejects.toThrow("Missing 'message'");
		expect(actions.calls).toHaveLength(0);
	});

	it("message=null → throws 'Missing \\'message\\''", async () => {
		const actions = makeActions();
		await expect(
			routeWebhookEvent({ type: "steer", message: null }, actions),
		).rejects.toThrow("Missing 'message'");
		expect(actions.calls).toHaveLength(0);
	});
});

// ─── Ошибки sendMessage пробрасываются ───────────────────────────────────────

describe("F-14 / event-router: ошибки sendMessage пробрасываются", () => {
	it("sync throw → пробрасывается оригинальная ошибка", async () => {
		const actions = makeActions({
			sendMessageImpl: () => {
				throw new Error("delivery failed");
			},
		});
		await expect(
			routeWebhookEvent({ type: "steer", message: "boom" }, actions),
		).rejects.toThrow("delivery failed");
	});

	it("async reject → пробрасывается оригинальная ошибка", async () => {
		const actions = makeActions({
			sendMessageImpl: async () => {
				throw new Error("async delivery failed");
			},
		});
		await expect(
			routeWebhookEvent({ type: "followUp", message: "boom" }, actions),
		).rejects.toThrow("async delivery failed");
	});

	it("sendMessage НЕ вызван после ошибки валидации", async () => {
		const sendMessageImpl = vi.fn();
		const actions = makeActions({ sendMessageImpl });
		try {
			await routeWebhookEvent({ type: "bogus" }, actions);
		} catch {
			// expected
		}
		expect(sendMessageImpl).not.toHaveBeenCalled();
	});
});

// ─── Расширяемость (готовность к новым типам) ───────────────────────────────

describe("F-14 / event-router: расширяемость", () => {
	it("только steer и followUp — другие строки отклоняются", async () => {
		const actions = makeActions();
		const candidates = ["Steer", "STEER", "follow", "followup", ""];
		for (const type of candidates) {
			await expect(
				routeWebhookEvent({ type, message: "test" }, actions),
			).rejects.toThrow("Unknown event type");
		}
		expect(actions.calls).toHaveLength(0);
	});
});
