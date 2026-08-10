/**
 * Tests for feature F-02: Message queue limits.
 *
 * Spec: docs/features/super-orchestrator/mission-loop-0/roadmap.md, F-02 card.
 *       docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.1, §3.2.
 */

import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@seaagents/fan-ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "../src/index.js";

// ---------- helpers ----------

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createSteerMessage(seq: number): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: `steer-${seq}`, timestamp: Date.now() + seq };
}

function createFollowUpMessage(seq: number): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: `followUp-${seq}`, timestamp: Date.now() + seq };
}

function makeAgentWithLimit(limit?: number): Agent {
	const opts: AgentOptions = {};
	if (limit !== undefined) opts.messageQueueLimit = limit;
	return new Agent(opts);
}

function fillSteeringQueue(agent: Agent, count: number): void {
	for (let i = 1; i <= count; i++) {
		agent.steer(createSteerMessage(i));
	}
}

function fillFollowUpQueue(agent: Agent, count: number): void {
	for (let i = 1; i <= count; i++) {
		agent.followUp(createFollowUpMessage(i));
	}
}

// ---------- tests ----------

describe("Agent queue limits (F-02)", () => {
	describe("TC-F02-1: default limit on steering queue", () => {
		it("accepts the first 50 steering messages and rejects the 51st with QueueOverflowError", () => {
			const agent = new Agent();

			// Boundary: messages 1..50 must be accepted without throwing.
			for (let i = 1; i <= 50; i++) {
				expect(() => agent.steer(createSteerMessage(i))).not.toThrow();
			}

			// 51st message must be rejected with QueueOverflowError.
			// The card specifies the message format: "steering queue full (50/50)".
			let thrown: unknown = undefined;
			try {
				agent.steer(createSteerMessage(51));
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeDefined();
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).name).toBe("QueueOverflowError");
			expect((thrown as Error).message).toMatch(/steering queue full \(50\/50\)/);
		});
	});

	describe("TC-F02-2: configurable limit", () => {
		it("honours a custom messageQueueLimit (10) — 10 ok, 11th rejected", () => {
			const agent = makeAgentWithLimit(10);

			// 1..10 must be accepted.
			for (let i = 1; i <= 10; i++) {
				expect(() => agent.steer(createSteerMessage(i))).not.toThrow();
			}

			// 11th must be rejected.
			let thrown: unknown = undefined;
			try {
				agent.steer(createSteerMessage(11));
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeDefined();
			expect((thrown as Error).name).toBe("QueueOverflowError");
			expect((thrown as Error).message).toMatch(/steering queue full \(10\/10\)/);
		});

		it("honours a custom messageQueueLimit (5) — 5 ok, 6th rejected", () => {
			const agent = makeAgentWithLimit(5);

			for (let i = 1; i <= 5; i++) {
				expect(() => agent.steer(createSteerMessage(i))).not.toThrow();
			}

			expect(() => agent.steer(createSteerMessage(6))).toThrow(/QueueOverflowError/);
		});

		it("default limit is 50 when no messageQueueLimit option is supplied", () => {
			// The card: "Дефолт: 50 сообщений".
			const agent = new Agent();

			// Push exactly 50 — none of them must throw.
			fillSteeringQueue(agent, 50);
			expect(agent.hasQueuedMessages()).toBe(true);

			// 51st is the first rejection.
			expect(() => agent.steer(createSteerMessage(51))).toThrow(/QueueOverflowError/);
		});
	});

	describe("TC-F02-3: follow-up queue has its own independent limit", () => {
		it("rejects the 51st followUp message even when the steering queue is empty", () => {
			const agent = new Agent();

			// 1..50 follow-ups: accepted.
			for (let i = 1; i <= 50; i++) {
				expect(() => agent.followUp(createFollowUpMessage(i))).not.toThrow();
			}

			// 51st follow-up must be rejected.
			let thrown: unknown = undefined;
			try {
				agent.followUp(createFollowUpMessage(51));
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeDefined();
			expect((thrown as Error).name).toBe("QueueOverflowError");
			expect((thrown as Error).message).toMatch(/followUp queue full \(50\/50\)/);
		});

		it("does not cross-contaminate limits — steer full does not block followUp", () => {
			const agent = new Agent();

			fillSteeringQueue(agent, 50);

			// Steering is now full.
			expect(() => agent.steer(createSteerMessage(51))).toThrow(/QueueOverflowError/);

			// FollowUp queue is independent and must still accept new messages.
			expect(() => agent.followUp(createFollowUpMessage(1))).not.toThrow();
		});

		it("does not cross-contaminate limits — followUp full does not block steer", () => {
			const agent = new Agent();

			fillFollowUpQueue(agent, 50);

			// FollowUp is now full.
			expect(() => agent.followUp(createFollowUpMessage(51))).toThrow(/QueueOverflowError/);

			// Steering queue is independent and must still accept new messages.
			expect(() => agent.steer(createSteerMessage(1))).not.toThrow();
		});
	});

	describe("Boundary semantics (N-1 ok, N ok, N+1 fails)", () => {
		it("boundary for default limit: N-1=49 ok, N=50 ok, N+1=51 rejected", () => {
			const agent = new Agent();

			// Fill to 49.
			fillSteeringQueue(agent, 49);

			// N-1 = 49 is fine; the 50th (N) must also be accepted.
			expect(() => agent.steer(createSteerMessage(50))).not.toThrow();

			// N+1 = 51 must be rejected.
			expect(() => agent.steer(createSteerMessage(51))).toThrow(/QueueOverflowError/);
		});

		it("boundary for followUp: N-1=49 ok, N=50 ok, N+1=51 rejected", () => {
			const agent = new Agent();

			fillFollowUpQueue(agent, 49);
			expect(() => agent.followUp(createFollowUpMessage(50))).not.toThrow();
			expect(() => agent.followUp(createFollowUpMessage(51))).toThrow(/QueueOverflowError/);
		});
	});

	describe("Slot recovery after drain", () => {
		it("after draining the steering queue via continue(), a new steer() is accepted again", async () => {
			const agent = new Agent({
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
					});
					return stream;
				},
			});

			// Seed transcript so `continue()` is allowed.
			agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
				createAssistantMessage("Initial response"),
			];

			// Fill steering queue to the limit.
			fillSteeringQueue(agent, 50);
			expect(() => agent.steer(createSteerMessage(51))).toThrow(/QueueOverflowError/);

			// Drain the steering queue via continue() (one-at-a-time mode pulls 1 msg).
			// We must drain all 50 to free slots; keep calling continue() until empty.
			while (agent.hasQueuedMessages()) {
				await agent.continue();
			}

			// After draining, the queue is empty — new steers must succeed.
			expect(() => agent.steer(createSteerMessage(100))).not.toThrow();
		});

		it("after draining the followUp queue via continue(), a new followUp() is accepted again", async () => {
			const agent = new Agent({
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
					});
					return stream;
				},
			});

			agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
				createAssistantMessage("Initial response"),
			];

			// Fill followUp queue to the limit.
			fillFollowUpQueue(agent, 50);
			expect(() => agent.followUp(createFollowUpMessage(51))).toThrow(/QueueOverflowError/);

			// Drain the followUp queue via continue() (default mode is "all" for followUp).
			while (agent.hasQueuedMessages()) {
				await agent.continue();
			}

			// After draining, a new followUp must succeed.
			expect(() => agent.followUp(createFollowUpMessage(100))).not.toThrow();
		});

		it("clearSteeringQueue() releases the limit and lets new steers through", () => {
			const agent = new Agent();

			fillSteeringQueue(agent, 50);
			expect(() => agent.steer(createSteerMessage(51))).toThrow(/QueueOverflowError/);

			agent.clearSteeringQueue();

			expect(() => agent.steer(createSteerMessage(52))).not.toThrow();
		});

		it("clearFollowUpQueue() releases the limit and lets new followUps through", () => {
			const agent = new Agent();

			fillFollowUpQueue(agent, 50);
			expect(() => agent.followUp(createFollowUpMessage(51))).toThrow(/QueueOverflowError/);

			agent.clearFollowUpQueue();

			expect(() => agent.followUp(createFollowUpMessage(52))).not.toThrow();
		});
	});

	describe("messageQueueLimit validation", () => {
		it("throws when messageQueueLimit is NaN", () => {
			expect(() => new Agent({ messageQueueLimit: Number.NaN })).toThrow(
				/messageQueueLimit must be a positive integer/,
			);
		});

		it("throws when messageQueueLimit is 0", () => {
			expect(() => new Agent({ messageQueueLimit: 0 })).toThrow(/messageQueueLimit must be a positive integer/);
		});

		it("accepts a valid positive integer messageQueueLimit", () => {
			expect(() => new Agent({ messageQueueLimit: 10 })).not.toThrow();
		});
	});

	describe("Error diagnostics", () => {
		it("QueueOverflowError is a subclass of Error so callers can `instanceof Error`", () => {
			const agent = new Agent();
			fillSteeringQueue(agent, 50);

			let thrown: unknown = undefined;
			try {
				agent.steer(createSteerMessage(51));
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).name).toBe("QueueOverflowError");
		});

		it("rejected messages are NOT silently dropped — they are NOT added to state.messages either way", () => {
			// Spec §3.2: "при переполнении — явная ошибка отправителю, не молчаливая потеря".
			// Whether or not the implementation throws, the message must NOT be
			// silently swallowed into state.messages — the queue must reject.
			const agent = new Agent();

			// Fill to limit.
			fillSteeringQueue(agent, 50);

			// Try to overflow — the 51st message must NOT appear in state.messages.
			try {
				agent.steer(createSteerMessage(51));
			} catch {
				// expected
			}

			const overflowContent = "steer-51";
			const leaked = agent.state.messages.some((m) => {
				if (m.role !== "user") return false;
				if (typeof m.content === "string") return m.content === overflowContent;
				return m.content.some((p) => p.type === "text" && p.text === overflowContent);
			});
			expect(leaked).toBe(false);
		});
	});
});
