/**
 * Tests for chain mode status visualization in renderResult / renderCall.
 *
 * Covers:
 *  (a) pending steps shown during running
 *  (b) running step highlighted/marked with ▶
 *  (c) completed marked with ✓
 *  (d) failed marked with ✗
 *  (e) fallback without plan (backwards compat)
 *  (f) renderCall uses ○ pending markers
 *  (g) collapsed view shows running step and pending count
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We test the rendering logic by extracting it directly from the tool definition.
// Since orchestrator-tools.js has heavy deps, we mock the imports and call registerOrchestratorTools.

// TUI component stubs matching fan-tui API
const children = Symbol('children');
class Text {
    constructor(text) { this.text = String(text); this.type = "Text"; }
    toString() { return this.text; }
}
class Container {
    constructor() { this[children] = []; this.type = "Container"; }
    addChild(child) { this[children].push(child); }
    getChildren() { return this[children]; }
    toString() { return this[children].map(c => String(c)).join("\n"); }
}
class Spacer {
    constructor() { this.type = "Spacer"; }
    toString() { return ""; }
}
class Markdown {
    constructor(text) { this.text = String(text); this.type = "Markdown"; }
    toString() { return this.text; }
}

// Minimal theme stub
const makeTheme = () => ({
    fg: (role, text) => `<${role}>${text}</${role}>`,
    bold: (t) => `<b>${t}</b>`,
});

let toolDef;

beforeEach(async () => {
    vi.resetModules();

    // Mock all external deps so we can import orchestrator-tools.js
    vi.mock("node:os", () => ({ homedir: () => "/home/user", platform: () => "win32", cpus: () => [] }));
    vi.mock("@seaagents/fan-ai", () => ({ StringEnum: (vals) => vals[0] }));
    vi.mock("@seaagents/fan-coding-agent", () => ({ getMarkdownTheme: () => ({}) }));
    vi.mock("@seaagents/fan-tui", () => ({ Container, Markdown, Spacer, Text }));
    // Pass-through Type mock — schema validation is not needed for render tests
    vi.mock("@sinclair/typebox", () => {
        const pass = (v) => v;
        return { Type: new Proxy({}, { get: () => pass }) };
    });
    vi.mock("../agents.js", () => ({ discoverAgents: async () => ({ agents: [], projectAgentsDir: null }) }));
    vi.mock("../task-complexity.js", () => ({ classifyComplexity: () => ({}), formatComplexityResult: () => "", DIRECT_TASK_RULES: [], DELEGATE_TASK_RULES: [] }));
    vi.mock("../config.js", () => ({ resolveWorkerModel: () => "model", resolveWorkerTemperature: () => 0.7 }));
    vi.mock("../subagent-runner.js", () => ({
        formatUsageStats: () => "",
        formatToolPreview: (n) => n,
        getDisplayItems: () => [],
        getFinalOutput: (msgs) => {
            for (const m of (msgs || [])) {
                if (m.role === "assistant" && m.content) {
                    for (const c of m.content) {
                        if (c.type === "text" && c.text) return c.text;
                    }
                }
            }
            return "";
        },
        MAX_CONCURRENCY: 5,
        MAX_PARALLEL_TASKS: 10,
        mapWithConcurrencyLimit: async () => [],
        runSingleAgent: async () => ({}),
        getResultToolCalls: () => [],
    }));
    vi.mock("../workers.js", () => ({ acquireSlot: () => {}, releaseSlot: () => {}, getWorker: () => null, updateWorker: () => {} }));
    vi.mock("../context-builder.js", () => ({ collectProjectContext: async () => null, mergeContext: () => null, truncate: (s) => s, PREVIOUS_OUTPUT_LIMIT: 4000 }));

    const { registerOrchestratorTools } = await import("../orchestrator-tools.js");

    const mockFan = {
        registerTool: (def) => { if (def.name === 'delegate_task') toolDef = def; },
        registerCommand: () => {},
        registerAgent: () => {},
    };
    registerOrchestratorTools(mockFan, null, {});
});

// Helper: make a minimal result object for testing renderResult
const makeChainResult = (results, plan = null, totalSteps = null, isError = false) => ({
    content: [{ type: "text", text: "output" }],
    isError,
    details: {
        mode: "chain",
        agentScope: "user",
        projectAgentsDir: null,
        results,
        ...(plan ? { plan, totalSteps: totalSteps ?? plan.length } : {}),
    },
});

const makeStepResult = (step, agent, task, opts = {}) => ({
    agent,
    agentSource: "builtin",
    task,
    exitCode: opts.exitCode ?? 0,
    stopReason: opts.stopReason,
    messages: opts.messages || [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: opts.model || "test-model",
    text: opts.text || "",
    step,
    startTime: opts.startTime ?? 1000,
    endTime: opts.endTime,
    progress: opts.progress,
});

const theme = makeTheme();

describe("delegate_task chain renderResult", () => {
    it("(a) shows pending steps as ○ during running with plan", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", { endTime: 1100, text: "Found 5 files" }),
            makeStepResult(2, "implement", "Implement feature", { endTime: undefined }),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify the implementation" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("Step 3");
        expect(str).toContain("verify");
        expect(str).toContain("○");
        expect(str).toContain("✓");
        expect(str).toContain("▶");
    });

    it("(b) marks running step with ▶ in expanded view", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", {
                endTime: undefined,
                progress: { toolCalls: [{ name: "read", args: {} }], messageCount: 3, status: "Processing" },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("▶");
        expect(str).toContain("read");
    });

    it("(c) marks completed steps with ✓ in expanded view", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100, text: "Done exploring" }),
            makeStepResult(2, "implement", "Implement", { endTime: 1200, text: "Done implementing" }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("✓");
        expect(str).toContain("2/2 steps");
        expect(str).not.toContain("○");
        expect(str).not.toContain("▶");
    });

    it("(d) marks failed steps with ✗ in expanded view", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200, errorMessage: "test error" }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("✗");
        expect(str).toContain("○");
        expect(str).toContain("Step 3");
    });

    it("(e) fallback without plan renders only results[] (backwards compat)", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { endTime: undefined }),
        ];
        const result = makeChainResult(results);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("Step 1");
        expect(str).toContain("Step 2");
        expect(str).not.toContain("Step 3");
        expect(str).not.toContain("○");
        expect(str).toContain("1/2 steps");
    });

    it("(e2) fallback collapsed without plan works correctly", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
        ];
        const result = makeChainResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("1/1 steps");
        expect(str).toContain("✓");
    });

    it("(f) renderCall uses ○ pending markers for chain steps", () => {
        const args = {
            chain: [
                { agent: "explore", task: "Explore codebase" },
                { agent: "implement", task: "Implement feature" },
            ],
        };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("2 steps");
        expect(str).toContain("○");
        expect(str).toContain("explore");
        expect(str).toContain("implement");
    });

    it("(g) collapsed view shows running step and pending count", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { endTime: undefined }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
            { agent: "docs-impl", task: "Write docs" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("▶ step 2");
        expect(str).toContain("implement");
        expect(str).toContain("2 pending");
        expect(str).toContain("1/4 steps");
    });

    it("(g2) collapsed view without plan has no ▶ step indicator", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { endTime: undefined }),
        ];
        const result = makeChainResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).not.toContain("▶ step");
        expect(str).not.toContain("pending");
    });

    it("header uses totalSteps from plan when available", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("1/3 steps");
    });

    it("all done with all success shows ✓ header icon", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("✓");
        expect(str).toContain("2/2 steps");
    });

    it("all done with failure shows ✗ header icon", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("✗");
        expect(str).toContain("2/2 steps");
    });

    it("pending step shows truncated task text (80 chars)", () => {
        const longTask = "A".repeat(120);
        const results = [
            makeStepResult(1, "explore", longTask, { endTime: undefined }),
        ];
        const plan = [
            { agent: "explore", task: longTask },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        // Step 2 (pending) should be shown
        expect(str).toContain("Implement");
    });

    it("early-termination: isError=true shows ✗ header not ⏳ (expanded)", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan, null, true);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        // Header must be ✗ (terminated with error), not ⏳ (still running)
        expect(str).toContain("✗");
        expect(str).not.toContain("⏳");
        // Step 3 is pending ○ but chain is NOT still running
        expect(str).toContain("○");
        expect(str).toContain("Step 3");
        // Header shows 1 failed
        expect(str).toContain("1 failed");
    });

    it("early-termination: isError=true shows ✗ header not ⏳ (collapsed)", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan, null, true);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        // Header must be ✗, not ⏳
        expect(str).toContain("✗");
        expect(str).not.toContain("⏳");
        // Must NOT show misleading '1 pending' — chain is terminated
        expect(str).not.toContain("pending");
        // Header shows 1 failed
        expect(str).toContain("1 failed");
    });

    it("failedCount wired into header when allDone with failure", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("2/2 steps");
        expect(str).toContain("1 failed");
    });

    it("successCount aligned with stepStatus (exitCode===0 && !stopReason)", () => {
        // Step with exitCode=0 but stopReason='aborted' should NOT count as success
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100, exitCode: 0, stopReason: "aborted" }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        // With the aligned logic: failedCount=1, so header is ✗ with '1 failed'
        expect(str).toContain("✗");
        expect(str).toContain("1 failed");
    });

    it("expanded view shows live tool calls for running step", () => {
        const results = [
            makeStepResult(1, "implement", "Write code", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 5,
                    toolCalls: [
                        { name: "read", args: { path: "/src/file.ts" }, preview: "Read /src/file.ts" },
                        { name: "write", args: { path: "/src/new.ts" }, preview: "Write /src/new.ts" },
                        { name: "bash", args: { command: "npm test" }, preview: "Run npm test" },
                    ],
                },
            }),
        ];
        const plan = [
            { agent: "implement", task: "Write code" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("Read /src/file.ts");
        expect(str).toContain("Write /src/new.ts");
        expect(str).toContain("Run npm test");
    });
});
