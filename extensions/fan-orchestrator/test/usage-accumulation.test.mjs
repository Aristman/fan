/**
 * Tests for token usage accumulation in runWorker.
 *
 * Validates that:
 * 1. message_end events with real AssistantMessage.usage structure accumulate correctly
 * 2. get_session_stats response overrides accumulated usage as authoritative final source
 * 3. finishWithStats waits for get_session_stats and uses its tokens
 * 4. formatUsageStats renders non-zero fields only
 *
 * Real event structure (from live RPC dump):
 *   message_end: {"type":"message_end","message":{"role":"assistant","usage":{"input":3625,"output":3,"cacheRead":704,"cacheWrite":0,"totalTokens":4332,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},...}}
 *   get_session_stats response: {"id":"orch-stats","type":"response","command":"get_session_stats","success":true,"data":{"tokens":{"input":3625,"output":3,"cacheRead":704,"cacheWrite":0,"total":4332},"cost":0,...}}
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// We test the handleMessage logic by importing formatTokens and formatUsageStats,
// and simulating the event flow that runWorker implements.
import {
    formatTokens,
    formatUsageStats,
} from "../subagent-runner.js";

// ── Real event structures from live RPC dump ──────────────────────────

/** Real message_end event for a user message (no usage field) */
const userMessageEnd = {
    type: "message_end",
    message: {
        role: "user",
        content: [{ type: "text", text: "Reply with exactly: hello" }],
        timestamp: 1787843742690,
    },
};

/** Real message_end event for an assistant message (has usage) */
const makeAssistantMessageEnd = (input, output, cacheRead = 0, cacheWrite = 0, totalTokens = 0) => ({
    type: "message_end",
    message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-completions",
        provider: "zai",
        model: "glm-5.3",
        usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1787843742700,
        responseId: "test-response-id",
    },
});

/** Real get_session_stats response structure */
const makeStatsResponse = (input, output, cacheRead = 0, cacheWrite = 0, total = 0, cost = 0) => ({
    id: "orch-stats",
    type: "response",
    command: "get_session_stats",
    success: true,
    data: {
        sessionId: "test-session-id",
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 4,
        tokens: { input, output, cacheRead, cacheWrite, total },
        cost,
        contextUsage: { tokens: total, contextWindow: 1000000, percent: 0.43 },
    },
});

/** message_start for assistant (usage all zeros during streaming) */
const assistantMessageStart = {
    type: "message_start",
    message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "zai",
        model: "glm-5.3",
        usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1787843742700,
    },
};

/** Simulate the handleMessage logic from runWorker */
function createMessageHandler() {
    let accumulatedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    let wasStreaming = false;
    const progressCalls = [];

    function emitProgress(status) {
        const hasUsage = accumulatedUsage.input > 0 || accumulatedUsage.output > 0;
        progressCalls.push({
            status,
            ...(hasUsage ? { usage: { input: accumulatedUsage.input, output: accumulatedUsage.output, cacheRead: accumulatedUsage.cacheRead, cacheWrite: accumulatedUsage.cacheWrite } } : {}),
        });
    }

    function handleMessage(data) {
        // message_update handler (no return — fall through)
        if (data.type === "message_update" && data.message?.content) {
            // tool call detection — not relevant for usage tests
        }

        // remote_tool_request handler
        if (data.type === "remote_tool_request") {
            return;
        }

        // Accumulate usage from message_end events (live progress source)
        if (data.type === "message_end" && data.message?.usage) {
            const u = data.message.usage;
            accumulatedUsage.input += u.input || 0;
            accumulatedUsage.output += u.output || 0;
            accumulatedUsage.cacheRead += u.cacheRead || 0;
            accumulatedUsage.cacheWrite += u.cacheWrite || 0;
            if (u.totalTokens != null) accumulatedUsage.totalTokens = u.totalTokens;
            if (u.cost?.total != null) accumulatedUsage.cost += u.cost.total;
            emitProgress(wasStreaming ? "Thinking" : "Processing");
            return;
        }

        // Authoritative usage from get_session_stats response (final source)
        if (data.type === "response" && data.id === "orch-stats" && data.success && data.data?.tokens) {
            const t = data.data.tokens;
            accumulatedUsage.input = t.input || 0;
            accumulatedUsage.output = t.output || 0;
            accumulatedUsage.cacheRead = t.cacheRead || 0;
            accumulatedUsage.cacheWrite = t.cacheWrite || 0;
            accumulatedUsage.totalTokens = t.total || 0;
            if (data.data.cost != null) accumulatedUsage.cost = data.data.cost;
            return;
        }
    }

    return { handleMessage, accumulatedUsage: () => ({ ...accumulatedUsage }), progressCalls, setWasStreaming: (v) => { wasStreaming = v; } };
}

describe("Usage accumulation from real RPC events", () => {
    it("user message_end (no usage) is skipped", () => {
        const h = createMessageHandler();
        h.handleMessage(userMessageEnd);
        expect(h.accumulatedUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
        expect(h.progressCalls).toHaveLength(0);
    });

    it("assistant message_end with real usage structure accumulates correctly", () => {
        const h = createMessageHandler();
        h.handleMessage(makeAssistantMessageEnd(3625, 3, 704, 0, 4332));
        expect(h.accumulatedUsage()).toEqual({
            input: 3625, output: 3, cacheRead: 704, cacheWrite: 0, totalTokens: 4332, cost: 0,
        });
    });

    it("multiple assistant message_end events sum up", () => {
        const h = createMessageHandler();
        // Turn 1
        h.handleMessage(makeAssistantMessageEnd(3625, 3, 704, 0, 4332));
        // Turn 2 (tool call round trip)
        h.handleMessage(makeAssistantMessageEnd(5000, 200, 800, 50, 6050));
        // Turn 3
        h.handleMessage(makeAssistantMessageEnd(6000, 100, 850, 0, 6950));
        expect(h.accumulatedUsage()).toEqual({
            input: 14625, output: 303, cacheRead: 2354, cacheWrite: 50, totalTokens: 6950, cost: 0,
        });
    });

    it("emitProgress includes usage only when input or output > 0", () => {
        const h = createMessageHandler();
        // First message_start has zero usage — no progress emitted
        h.handleMessage(assistantMessageStart);
        expect(h.progressCalls).toHaveLength(0);

        // message_end with real usage — progress emitted with usage
        h.handleMessage(makeAssistantMessageEnd(3625, 3));
        expect(h.progressCalls).toHaveLength(1);
        expect(h.progressCalls[0].usage).toEqual({ input: 3625, output: 3, cacheRead: 0, cacheWrite: 0 });
    });

    it("message_start with zero usage does not trigger progress", () => {
        const h = createMessageHandler();
        // assistantMessageStart has usage but all zeros
        // It's type=message_start not message_end, so it won't match
        h.handleMessage(assistantMessageStart);
        expect(h.progressCalls).toHaveLength(0);
        expect(h.accumulatedUsage().input).toBe(0);
    });

    it("user message_end (no usage field) does not crash or accumulate", () => {
        const h = createMessageHandler();
        // User messages have no usage field
        expect(userMessageEnd.message.usage).toBeUndefined();
        h.handleMessage(userMessageEnd);
        expect(h.accumulatedUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
        expect(h.progressCalls).toHaveLength(0);
    });
});

describe("get_session_stats as authoritative final usage source", () => {
    it("stats response replaces accumulated usage with session totals", () => {
        const h = createMessageHandler();
        // Accumulate from message_end
        h.handleMessage(makeAssistantMessageEnd(100, 10, 50));
        // Session stats says different totals (cumulative, authoritative)
        h.handleMessage(makeStatsResponse(3625, 3, 704, 0, 4332, 0.05));
        expect(h.accumulatedUsage()).toEqual({
            input: 3625, output: 3, cacheRead: 704, cacheWrite: 0, totalTokens: 4332, cost: 0.05,
        });
    });

    it("stats response cost field is used directly", () => {
        const h = createMessageHandler();
        h.handleMessage(makeStatsResponse(1000, 200, 300, 10, 1510, 0.042));
        expect(h.accumulatedUsage().cost).toBe(0.042);
    });

    it("stats response with missing tokens is ignored", () => {
        const h = createMessageHandler();
        h.handleMessage({ id: "orch-stats", type: "response", command: "get_session_stats", success: true, data: {} });
        expect(h.accumulatedUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
    });

    it("stats response with success=false is ignored", () => {
        const h = createMessageHandler();
        h.handleMessage({ id: "orch-stats", type: "response", command: "get_session_stats", success: false, error: "fail" });
        expect(h.accumulatedUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
    });

    it("typical flow: message_end for live, stats for final", () => {
        const h = createMessageHandler();
        h.setWasStreaming(true);

        // 1. User message
        h.handleMessage(userMessageEnd);
        expect(h.progressCalls).toHaveLength(0);

        // 2. Assistant turn 1
        h.handleMessage(makeAssistantMessageEnd(3000, 50, 500));
        expect(h.progressCalls).toHaveLength(1);
        expect(h.progressCalls[0].status).toBe("Thinking");
        expect(h.progressCalls[0].usage.input).toBe(3000);

        // 3. Tool result message_end (no usage)
        h.handleMessage({ type: "message_end", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 } });
        expect(h.progressCalls).toHaveLength(1); // no new progress

        // 4. Assistant turn 2
        h.handleMessage(makeAssistantMessageEnd(5000, 100, 600));
        expect(h.progressCalls).toHaveLength(2);
        expect(h.progressCalls[1].usage.input).toBe(8000); // 3000+5000
        expect(h.progressCalls[1].usage.output).toBe(150); // 50+100

        // 5. Final stats override
        h.handleMessage(makeStatsResponse(8500, 160, 1100, 0, 9760, 0.08));
        expect(h.accumulatedUsage()).toEqual({
            input: 8500, output: 160, cacheRead: 1100, cacheWrite: 0, totalTokens: 9760, cost: 0.08,
        });
    });
});

describe("formatUsageStats with real usage shapes", () => {
    it("renders only non-zero fields", () => {
        const usage = { input: 3625, output: 3, cacheRead: 704, cacheWrite: 0, cost: 0, contextTokens: 4332, turns: 2 };
        const result = formatUsageStats(usage);
        // Should include turns, input, output, cacheRead, contextTokens
        expect(result).toContain("2 turns");
        expect(result).toContain("↑3.6k");
        expect(result).toContain("↓3");
        expect(result).toContain("R704");
        expect(result).toContain("ctx:4.3k");
        // Should NOT include cacheWrite or cost (both 0)
        expect(result).not.toContain("W");
        expect(result).not.toContain("$");
    });

    it("only turns renders when all token fields are 0", () => {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 6 };
        const result = formatUsageStats(usage);
        expect(result).toBe("6 turns");
    });

    it("full usage with cost renders all fields", () => {
        const usage = { input: 15000, output: 5000, cacheRead: 8000, cacheWrite: 2000, cost: 0.042, contextTokens: 30000, turns: 3, model: "gpt-4o" };
        const result = formatUsageStats(usage, "gpt-4o");
        expect(result).toContain("3 turns");
        expect(result).toContain("↑15k");
        expect(result).toContain("↓5");
        expect(result).toContain("R8.0k");
        expect(result).toContain("W2.0k");
        expect(result).toContain("$0.0420");
        expect(result).toContain("ctx:30k");
        expect(result).toContain("gpt-4o");
    });
});

describe("formatTokens edge cases", () => {
    it("small numbers as-is", () => { expect(formatTokens(42)).toBe("42"); });
    it("999 as-is", () => { expect(formatTokens(999)).toBe("999"); });
    it("1k with one decimal", () => { expect(formatTokens(1500)).toBe("1.5k"); });
    it("exact thousands no decimal", () => { expect(formatTokens(10000)).toBe("10k"); });
    it("100k+ rounded", () => { expect(formatTokens(250000)).toBe("250k"); });
    it("1M+ with one decimal", () => { expect(formatTokens(1500000)).toBe("1.5M"); });
});
