// Tests for <chat-view> queue position indicator (F-2.12) and overflow warning (F-2.15)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/chat-view.js";
import type { ChatView } from "../components/chat-view.js";

const SESSION_ID = "sess-1";

type WsHandler = (msg: unknown) => void;

let wsHandler: WsHandler | null = null;

function createEl(): ChatView {
	wsHandler = null;
	const wsClient = {
		onMessage: vi.fn((cb: WsHandler) => {
			wsHandler = cb;
			return () => {};
		}),
		onStatusChange: vi.fn(() => () => {}),
		send: vi.fn(),
	};
	const apiClient = {
		getSession: vi.fn().mockResolvedValue({ id: SESSION_ID, messages: [] }),
		sendMessage: vi.fn().mockResolvedValue({}),
	};

	const el = document.createElement("chat-view") as ChatView;
	el.sessionId = SESSION_ID;
	// biome-ignore lint/suspicious/noExplicitAny: partial mocks of the real clients
	el.wsClient = wsClient as any;
	// biome-ignore lint/suspicious/noExplicitAny: partial mocks of the real clients
	el.apiClient = apiClient as any;
	document.body.appendChild(el);
	return el;
}

function simulateWs(msg: Record<string, unknown>): void {
	if (!wsHandler) throw new Error("wsHandler not registered");
	wsHandler({ timestamp: new Date().toISOString(), ...msg });
}

function queuedMsg(position: number, sessionId = SESSION_ID) {
	return { type: "queued", sessionId, position };
}

describe("chat-view queue indicator (F-2.12 / F-2.15)", () => {
	let el: ChatView;

	beforeEach(() => {
		el = createEl();
	});

	afterEach(() => {
		el.remove();
	});

	// TC-F-2.12-1: { type: 'queued', position: 2 } → yellow alert "В очереди, позиция 2"
	it("TC-F-2.12-1: shows yellow alert with queue position on queued message", async () => {
		await el.updateComplete;

		simulateWs(queuedMsg(2));
		await el.updateComplete;

		const alert = el.querySelector<HTMLElement>('[data-testid="queue-position-alert"]');
		expect(alert).not.toBeNull();
		expect(alert!.textContent).toContain("В очереди, позиция 2");
		expect(alert!.className).toContain("bg-yellow-500/10");
	});

	it("queue_full shows red warning with the limit", async () => {
		await el.updateComplete;

		simulateWs({ type: "queue_full", sessionId: SESSION_ID, error: "QUEUE_OVERFLOW", limit: 50 });
		await el.updateComplete;

		const alert = el.querySelector<HTMLElement>('[data-testid="queue-full-alert"]');
		expect(alert).not.toBeNull();
		expect(alert!.textContent).toContain("Очередь заполнена (лимит 50)");
		expect(alert!.className).toContain("bg-red-500/10");
	});

	it("hides the indicator when streaming response starts (agent_event message_start)", async () => {
		await el.updateComplete;

		simulateWs(queuedMsg(1));
		await el.updateComplete;
		expect(el.querySelector('[data-testid="queue-position-alert"]')).not.toBeNull();

		simulateWs({
			type: "agent_event",
			sessionId: SESSION_ID,
			event: { type: "message_start", message: { role: "assistant" } },
		});
		await el.updateComplete;

		expect(el.querySelector('[data-testid="queue-position-alert"]')).toBeNull();
	});

	it("hides the indicator when the engine picks up the session (agent_start)", async () => {
		await el.updateComplete;

		simulateWs(queuedMsg(1));
		await el.updateComplete;
		expect(el.querySelector('[data-testid="queue-position-alert"]')).not.toBeNull();

		simulateWs({
			type: "agent_event",
			sessionId: SESSION_ID,
			event: { type: "agent_start" },
		});
		await el.updateComplete;

		expect(el.querySelector('[data-testid="queue-position-alert"]')).toBeNull();
	});

	it("updates the position when multiple queued messages arrive", async () => {
		await el.updateComplete;

		simulateWs(queuedMsg(2));
		await el.updateComplete;
		expect(el.querySelector('[data-testid="queue-position-alert"]')!.textContent).toContain(
			"В очереди, позиция 2",
		);

		simulateWs(queuedMsg(5));
		await el.updateComplete;
		expect(el.querySelector('[data-testid="queue-position-alert"]')!.textContent).toContain(
			"В очереди, позиция 5",
		);
	});

	it("ignores queued messages for other sessions", async () => {
		await el.updateComplete;

		simulateWs(queuedMsg(3, "sess-other"));
		await el.updateComplete;

		expect(el.querySelector('[data-testid="queue-position-alert"]')).toBeNull();
	});

	it("ignores queue_full messages for other sessions", async () => {
		await el.updateComplete;

		simulateWs({ type: "queue_full", sessionId: "sess-other", error: "QUEUE_OVERFLOW", limit: 50 });
		await el.updateComplete;

		expect(el.querySelector('[data-testid="queue-full-alert"]')).toBeNull();
	});

	it("dismisses the queue_full warning via the close button", async () => {
		await el.updateComplete;

		simulateWs({ type: "queue_full", sessionId: SESSION_ID, error: "QUEUE_OVERFLOW", limit: 50 });
		await el.updateComplete;

		const alert = el.querySelector<HTMLElement>('[data-testid="queue-full-alert"]');
		expect(alert).not.toBeNull();

		alert!.querySelector<HTMLButtonElement>("button")!.click();
		await el.updateComplete;

		expect(el.querySelector('[data-testid="queue-full-alert"]')).toBeNull();
	});
});
