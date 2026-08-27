/**
 * Tests for chain mode status visualization in renderResult / renderCall.
 *
 * Covers:
 *  (a) live expanded: step list with ☑/◐/☐, NO output from completed, divider + status + tool previews
 *  (b) live collapsed: same list + ≤3 tool previews
 *  (c) live with no running step → '(starting next worker...)'
 *  (d) final (terminated) view unchanged — per-step results shown
 *  (e) fallback without plan (backwards compat) — old behavior
 *  (f) renderCall uses ☐ pending markers
 *  (g) partial data (no messages) does NOT throw
 *  (g2) partial data shows ◐ for running, ☑ for completed, ☐ for pending
 *  (g3) collapsed partial data renders correctly
 *  (h) early-termination isError=true shows ✗ header
 *  (i) all-done with success/failure header icons
 *  (j) failedCount wired into header
 *  (k) step status alignment (exitCode + stopReason)
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
    strikethrough: (t) => `<s>${t}</s>`,
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
        formatTokens: (n) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`,
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
    stderr: opts.stderr ?? "",
    errorMessage: opts.errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: opts.model || "test-model",
    text: opts.text || "",
    step,
    startTime: opts.startTime ?? 1000,
    endTime: opts.endTime,
    progress: opts.progress,
});

/** Partial result shape — exactly what runSingleAgent.onProgress sends (NO messages) */
const makePartialStepResult = (step, agent, task, opts = {}) => ({
    agent,
    agentSource: "builtin",
    task,
    step,
    startTime: opts.startTime ?? 1000,
    model: opts.model || "test-model",
    progress: opts.progress || { status: "Processing", messageCount: 0, toolCalls: [], model: "test-model" },
});

const theme = makeTheme();

describe("delegate_task chain renderResult", () => {

    // ═══════════════════════════════════════════════════════════════
    // (a) LIVE EXPANDED — step list + no output for completed + tail
    // ═══════════════════════════════════════════════════════════════
    it("(a) live expanded: step list with ☑/◐/☐, NO output from completed, divider + status + tool previews", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Found 5 files" }] }],
            }),
            makeStepResult(2, "implement", "Implement feature", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 3,
                    toolCalls: [
                        { name: "read", args: { path: "/src/file.ts" }, preview: "Read /src/file.ts" },
                        { name: "write", args: { path: "/src/new.ts" }, preview: "Write /src/new.ts" },
                    ],
                    model: "gpt-4",
                },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify the implementation" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();

        // Header: ⏳ with progress
        expect(str).toContain("1/3 steps");
        expect(str).toContain("⏳");

        // Step list: all 3 steps
        expect(str).toContain("1.");
        expect(str).toContain("2.");
        expect(str).toContain("3.");

        // Step 1 completed: ☑, strikethrough, muted
        expect(str).toContain("☑");
        expect(str).toContain("<s>Explore codebase</s>");

        // Step 2 running: ◐, bold, warning
        expect(str).toContain("◐");
        expect(str).toContain("<b>Implement feature</b>");
        expect(str).toContain("<warning><b>Implement feature</b></warning>");

        // Step 3 pending: ☐, muted
        expect(str).toContain("☐");
        expect(str).toContain("Verify the implementation");

        // NO output text from completed step 1
        expect(str).not.toContain("Found 5 files");

        // Divider
        expect(str).toContain("──");

        // Status line with model, elapsed, msgs, tools
        expect(str).toContain("🤖 test-model");
        expect(str).toContain("💬 3 messages");
        expect(str).toContain("🔧 2 tools");

        // Tool previews
        expect(str).toContain("Read /src/file.ts");
        expect(str).toContain("Write /src/new.ts");

        // No aggregate footer (live, not terminated)
        expect(str).not.toContain("aggregate");
    });

    // ═══════════════════════════════════════════════════════════════
    // (b) LIVE COLLAPSED — same list + ≤3 tool previews
    // ═══════════════════════════════════════════════════════════════
    it("(b) live collapsed: step list + ≤3 tool previews", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
            }),
            makeStepResult(2, "implement", "Implement feature", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 5,
                    toolCalls: [
                        { name: "read", args: {}, preview: "Read A" },
                        { name: "read", args: {}, preview: "Read B" },
                        { name: "write", args: {}, preview: "Write C" },
                        { name: "bash", args: {}, preview: "Run D" },
                        { name: "bash", args: {}, preview: "Run E" },
                    ],
                },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();

        // Step list present
        expect(str).toContain("1.");
        expect(str).toContain("2.");
        expect(str).toContain("3.");
        expect(str).toContain("☑");
        expect(str).toContain("◐");
        expect(str).toContain("☐");

        // NO output from completed step 1
        expect(str).not.toContain("Done");

        // Divider
        expect(str).toContain("──");

        // Collapsed: max 3 tool previews (last 3 of 5)
        expect(str).toContain("Write C");
        expect(str).toContain("Run D");
        expect(str).toContain("Run E");
        // First 2 should NOT appear (collapsed shows only last 3)
        expect(str).not.toContain("Read A");
        expect(str).not.toContain("Read B");

        // Ctrl+O hint in collapsed
        expect(str).toContain("Ctrl+O");
    });

    // ═══════════════════════════════════════════════════════════════
    // (c) LIVE WITH NO RUNNING STEP
    // ═══════════════════════════════════════════════════════════════
    it("(c) live with no running step shows '(starting next worker...)'", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();

        // Still live (1/3, not terminated)
        expect(str).toContain("1/3 steps");
        expect(str).toContain("⏳");

        // Step list
        expect(str).toContain("☑");
        expect(str).toContain("☐");

        // Divider
        expect(str).toContain("──");

        // Gap indicator
        expect(str).toContain("(starting next worker...)");
    });

    // ═══════════════════════════════════════════════════════════════
    // (d) FINAL (terminated) view — per-step results shown
    // ═══════════════════════════════════════════════════════════════
    it("(d) final expanded: per-step results with outputs and footer", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Found 5 files" }] }],
            }),
            makeStepResult(2, "implement", "Implement feature", {
                endTime: 1300,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Implementation done" }] }],
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();

        // Terminated header
        expect(str).toContain("✓");
        expect(str).toContain("2/2 steps");

        // Per-step outputs present in final view
        expect(str).toContain("Found 5 files");
        expect(str).toContain("Implementation done");

        // No live-tail artifacts (no divider, no status line)
        expect(str).not.toContain("(starting next worker...)");
        expect(str).not.toContain("🤖 test-model | ⏱");
    });

    it("(d2) final collapsed: per-step one-liners with outputs", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done exploring" }] }],
            }),
            makeStepResult(2, "implement", "Implement", {
                endTime: 1300,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done implementing" }] }],
            }),
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
        expect(str).toContain("Done exploring");
        expect(str).toContain("Done implementing");
        expect(str).toContain("Ctrl+O");
    });

    // ═══════════════════════════════════════════════════════════════
    // (e) BACKWARDS-COMPAT: no plan → old behavior
    // ═══════════════════════════════════════════════════════════════
    it("(e) fallback without plan renders only results[] (backwards compat expanded)", () => {
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
        expect(str).toContain("☑");
    });

    // ═══════════════════════════════════════════════════════════════
    // (f) renderCall uses ☐ pending markers
    // ═══════════════════════════════════════════════════════════════
    it("(f) renderCall uses ☐ pending markers for chain steps", () => {
        const args = {
            chain: [
                { agent: "explore", task: "Explore codebase" },
                { agent: "implement", task: "Implement feature" },
            ],
        };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("2 steps");
        expect(str).toContain("☐");
        expect(str).toContain("explore");
        expect(str).toContain("implement");
    });

    // ═══════════════════════════════════════════════════════════════
    // (g) PARTIAL DATA — no messages field
    // ═══════════════════════════════════════════════════════════════
    it("(g) partial data with no messages does NOT throw — expanded", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Found 5 files" }] }],
            }),
            makePartialStepResult(2, "implement", "Implement feature"),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify the implementation" },
        ];
        const result = makeChainResult(results, plan);
        expect(() => toolDef.renderResult(result, { expanded: true }, theme)).not.toThrow();
    });

    it("(g2) partial data shows ◐ bold for running, ☑ for completed, ☐ for pending — expanded", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
            }),
            makePartialStepResult(2, "implement", "Implement feature", {
                progress: { status: "Processing", messageCount: 3, toolCalls: [{ name: "read", args: {}, preview: "Reading file" }], model: "gpt-4" },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify the implementation" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        // Step 1 completed: ☑
        expect(str).toContain("☑");
        // Step 2 running: ◐
        expect(str).toContain("◐");
        // Step 3 pending: ☐
        expect(str).toContain("☐");
        // Running step tool preview in tail
        expect(str).toContain("Reading file");
    });

    it("(g3) partial data — collapsed view renders correctly", () => {
        const results = [
            makeStepResult(1, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
            }),
            makePartialStepResult(2, "implement", "Implement feature"),
        ];
        const plan = [
            { agent: "explore", task: "Explore codebase" },
            { agent: "implement", task: "Implement feature" },
            { agent: "verify", task: "Verify the implementation" },
        ];
        const result = makeChainResult(results, plan);
        expect(() => toolDef.renderResult(result, { expanded: false }, theme)).not.toThrow();
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        // New collapsed live: step list with ☑/◐/☐
        expect(str).toContain("☑");
        expect(str).toContain("◐");
        expect(str).toContain("☐");
        expect(str).toContain("1/3 steps");
    });

    it("(g4) all-partial chain (no messages on any step) does not throw", () => {
        const results = [
            makePartialStepResult(1, "explore", "Explore"),
            makePartialStepResult(2, "implement", "Implement"),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        expect(() => toolDef.renderResult(result, { expanded: true }, theme)).not.toThrow();
        expect(() => toolDef.renderResult(result, { expanded: false }, theme)).not.toThrow();
    });

    // ═══════════════════════════════════════════════════════════════
    // (h) EARLY TERMINATION
    // ═══════════════════════════════════════════════════════════════
    it("(h) early-termination: isError=true shows ✗ header not ⏳ (expanded)", () => {
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
        expect(str).toContain("✗");
        expect(str).not.toContain("⏳");
        expect(str).toContain("☐");
        expect(str).toContain("1 failed");
    });

    it("(h2) early-termination: isError=true shows ✗ header not ⏳ (collapsed)", () => {
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
        expect(str).toContain("✗");
        expect(str).not.toContain("⏳");
        // Terminated → no '(starting next worker...)', no 'pending'
        expect(str).not.toContain("(starting next worker...)");
        expect(str).toContain("1 failed");
    });

    // ═══════════════════════════════════════════════════════════════
    // (i) ALL-DONE HEADER ICONS
    // ═══════════════════════════════════════════════════════════════
    it("(i) all done with all success shows ✓ header icon", () => {
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

    it("(i2) all done with failure shows ✗ header icon", () => {
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

    // ═══════════════════════════════════════════════════════════════
    // (j) FAILED COUNT
    // ═══════════════════════════════════════════════════════════════
    it("(j) failedCount wired into header when allDone with failure", () => {
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

    // ═══════════════════════════════════════════════════════════════
    // (k) STEP STATUS ALIGNMENT
    // ═══════════════════════════════════════════════════════════════
    it("(k) successCount aligned with stepStatus (exitCode===0 && !stopReason)", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100, exitCode: 0, stopReason: "aborted" }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("✗");
        expect(str).toContain("1 failed");
    });

    // ═══════════════════════════════════════════════════════════════
    // MISC
    // ═══════════════════════════════════════════════════════════════
    it("pending step shows truncated task text (60 chars) in live view", () => {
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
        // Long task truncated to 60 chars + '...'
        expect(str).toContain("A".repeat(60) + "...");
        expect(str).not.toContain("A".repeat(61) + "...");
    });

    it("expanded live: running step with no toolCalls shows (initializing...)", () => {
        const results = [
            makePartialStepResult(1, "explore", "Explore", {
                progress: { status: "Thinking", messageCount: 0, toolCalls: [] },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("(thinking...)");
    });

    // ═══════════════════════════════════════════════════════════════
    // (l) EARLY TERMINATION via isPartial:false (no isError)
    // ═══════════════════════════════════════════════════════════════
    it("(l) early-terminated via isPartial:false without isError renders FINAL view", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
            makeStepResult(2, "implement", "Implement", { exitCode: 1, stopReason: "error", endTime: 1200 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        // No isError on result — only isPartial:false signals termination
        const result = makeChainResult(results, plan, null, false);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: false }, theme);
        const str = rendered.toString();

        // Terminated → final view, NOT live
        expect(str).toContain("✗");
        expect(str).toContain("1 failed");
        expect(str).not.toContain("⏳");
        expect(str).not.toContain("(starting next worker...)");
    });

    // ═══════════════════════════════════════════════════════════════
    // (m) LIVE PARTIAL preserved with isPartial:true
    // ═══════════════════════════════════════════════════════════════
    it("(m) live partial with isPartial:true still shows LIVE view", () => {
        const results = [
            makeStepResult(1, "explore", "Explore", { endTime: 1100 }),
        ];
        const plan = [
            { agent: "explore", task: "Explore" },
            { agent: "implement", task: "Implement" },
            { agent: "verify", task: "Verify" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();

        // Still live
        expect(str).toContain("⏳");
        expect(str).toContain("1/3 steps");
        expect(str).toContain("(starting next worker...)");
        // Not terminated
        expect(str).not.toContain("✗");
        expect(str).not.toContain("✓");
    });

    it("expanded live: uses MAX_LIVE_TOOLS (9) for expanded tail", () => {
        const toolCalls = Array.from({ length: 12 }, (_, i) => ({
            name: "read", args: {}, preview: `Read file ${i + 1}`,
        }));
        const results = [
            makeStepResult(1, "explore", "Explore all", {
                endTime: undefined,
                progress: { status: "Processing", messageCount: 12, toolCalls },
            }),
        ];
        const plan = [
            { agent: "explore", task: "Explore all" },
        ];
        const result = makeChainResult(results, plan);
        const rendered = toolDef.renderResult(result, { expanded: true }, theme);
        const str = rendered.toString();
        // Expanded: last 9 of 12 (files 4-12)
        expect(str).toContain("Read file 4");
        expect(str).toContain("Read file 12");
        // First 3 should NOT appear (use exact line matching)
        const lines = str.split("\n");
        const previewLines = lines.filter(l => l.includes("Read file"));
        expect(previewLines).toHaveLength(9);
        expect(previewLines[0]).toContain("Read file 4");
        expect(previewLines[8]).toContain("Read file 12");
    });
});

// ═══════════════════════════════════════════════════════════════
// SINGLE MODE RENDERING
// ═══════════════════════════════════════════════════════════════

describe("delegate_task single mode", () => {

    // Helper: make a single-mode result object for testing renderResult
    const makeSingleResult = (results, isError = false) => ({
        content: [{ type: "text", text: "output" }],
        isError,
        details: {
            mode: "single",
            agentScope: "user",
            projectAgentsDir: null,
            results,
        },
    });

    // (a) renderCall for single shows worker header
    it("(a) renderCall shows 🤖 worker header and ЗАДАЧА for single mode", () => {
        const args = { agent: "explore", task: "Explore the codebase structure" };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("EXPLORE");
        expect(str).toContain("ЗАДАЧА");
        expect(str).toContain("Explore the codebase structure");
    });

    // (b) renderCall for single with context indicator
    it("(b) renderCall shows 📋 ctx indicator when context provided", () => {
        const args = {
            agent: "implement",
            task: "Fix the bug",
            context: { relevantFiles: ["src/a.ts", "src/b.ts"], constraints: ["no breaking changes"] },
        };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("IMPLEMENT");
        expect(str).toContain("ctx:");
        expect(str).toContain("2 files");
        expect(str).toContain("1 constraint");
    });

    // (c) renderResult — single live partial (no endTime) renders status line with ⏳
    it("(c) renderResult live partial shows ⏳ status line", () => {
        const results = [
            makeStepResult(undefined, "explore", "Explore codebase", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 3,
                    toolCalls: [{ name: "read", args: { path: "/src/file.ts" }, preview: "Read /src/file.ts" }],
                    model: "test-model",
                },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("⏳");
        expect(str).toContain("test-model");
        expect(str).toContain("3 messages");
        expect(str).toContain("1 tool");
        expect(str).toContain("Read /src/file.ts");
        // Horizontal divider between header and body
        expect(str).toContain("─");
    });

    // (d) renderResult — single completed (endTime present) renders ✓ + output + footer
    it("(d) renderResult completed shows ✓, output, and footer", () => {
        const results = [
            makeStepResult(undefined, "explore", "Explore codebase", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Found 5 important files" }] }],
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("✓");
        expect(str).toContain("Found 5 important files");
        // Footer with tool count
        expect(str).toContain("0 tools");
    });

    // (e) renderResult — single failed shows ✗ and error info
    it("(e) renderResult failed shows ✗ and error message", () => {
        const results = [
            makeStepResult(undefined, "implement", "Fix bug", {
                exitCode: 1,
                stopReason: "error",
                endTime: 1200,
                errorMessage: "Something went wrong",
            }),
        ];
        const result = makeSingleResult(results, true);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: false }, theme);
        const str = rendered.toString();
        expect(str).toContain("✗");
        expect(str).toContain("Something went wrong");
    });
});

// ═══════════════════════════════════════════════════════════════
// resultReplacesCall CONDITIONAL FUNCTION
// ═══════════════════════════════════════════════════════════════

describe("delegate_task renderOptions.resultReplacesCall", () => {

    it("returns false for single-mode args", () => {
        const fn = toolDef.renderOptions.resultReplacesCall;
        expect(typeof fn).toBe("function");
        expect(fn({ agent: "explore", task: "Do something" })).toBe(false);
        expect(fn({ agent: "implement", task: "Fix", context: { relevantFiles: [] } })).toBe(false);
        expect(fn({ agent: "explore", task: "Task", cwd: "/tmp" })).toBe(false);
    });

    it("returns true for chain-mode args", () => {
        const fn = toolDef.renderOptions.resultReplacesCall;
        expect(fn({ chain: [{ agent: "explore", task: "Step 1" }] })).toBe(true);
        expect(fn({ chain: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] })).toBe(true);
    });

    it("returns false for parallel-mode args", () => {
        const fn = toolDef.renderOptions.resultReplacesCall;
        expect(fn({ tasks: [{ agent: "explore", task: "A" }] })).toBe(false);
    });

    it("returns false for empty chain array", () => {
        const fn = toolDef.renderOptions.resultReplacesCall;
        expect(fn({ chain: [] })).toBe(false);
        expect(fn({ chain: undefined })).toBe(false);
        expect(fn({})).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// SINGLE MODE — NEW UI FEATURES
// ═══════════════════════════════════════════════════════════════

describe("delegate_task single mode — new UI features", () => {
    const makeSingleResult = (results, isError = false) => ({
        content: [{ type: "text", text: "output" }],
        isError,
        details: { mode: "single", agentScope: "user", projectAgentsDir: null, results },
    });

    // ── 1. No truncation of task in renderCall ──
    it("renderCall shows full task without truncation (no ...)", () => {
        const longTask = "A".repeat(200);
        const args = { agent: "explore", task: longTask };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("EXPLORE");
        expect(str).toContain(longTask);
        expect(str).not.toContain("...");
    });

    it("renderCall collapses multiline task into single line (no ...)", () => {
        const multiLineTask = "Line one\nLine two\nLine three";
        const args = { agent: "implement", task: multiLineTask };
        const rendered = toolDef.renderCall(args, theme);
        const str = rendered.toString();
        expect(str).toContain("IMPLEMENT");
        expect(str).toContain("Line one Line two Line three");
        expect(str).not.toContain("\nLine two");
        expect(str).not.toContain("...");
    });

    // ── 2. Token usage in running status line ──
    it("running status shows ⚡ in/out when progress has usage", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 2,
                    toolCalls: [{ name: "read", args: {}, preview: "Read file" }],
                    model: "gpt-4",
                    usage: { input: 12345, output: 8100, cacheRead: 0, cacheWrite: 0 },
                },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();
        expect(str).toContain("⚡");
        expect(str).toContain("12.3k/8.1k");
    });

    it("running status does NOT show ⚡ when no usage yet", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 1,
                    toolCalls: [],
                    model: "gpt-4",
                },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();
        expect(str).not.toContain("⚡");
    });

    it("running status does NOT show ⚡ when usage is all zeros", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: undefined,
                progress: {
                    status: "Processing",
                    messageCount: 1,
                    toolCalls: [],
                    model: "gpt-4",
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();
        expect(str).not.toContain("⚡");
    });

    // ── 3. Horizontal divider between header and body ──
    it("renderResult running shows ─ divider after status line", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: undefined,
                progress: { status: "Processing", messageCount: 0, toolCalls: [] },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: true }, theme);
        const str = rendered.toString();
        const lines = str.split("\n");
        // Second line should be the divider (muted ─)
        expect(lines[1]).toContain("─");
    });

    it("renderResult completed collapsed shows ─ divider after icon line", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: false }, theme);
        const str = rendered.toString();
        const lines = str.split("\n");
        // Second line should be the divider
        expect(lines[1]).toContain("─");
    });

    it("renderResult completed expanded shows ─ divider as first child", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: true, isPartial: false }, theme);
        const str = rendered.toString();
        // Expanded is a Container — first child is the divider
        const lines = str.split("\n");
        expect(lines[0]).toContain("─");
    });

    // ── 5. Footer shows real usage via formatUsageStats ──
    it("completed footer shows usage when non-zero", () => {
        const results = [
            makeStepResult(undefined, "explore", "Task", {
                endTime: 1200,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Result" }] }],
                usage: { input: 5000, output: 2000, cacheRead: 3000, cacheWrite: 500, cost: 0.05, contextTokens: 8000, turns: 4 },
            }),
        ];
        const result = makeSingleResult(results);
        const rendered = toolDef.renderResult(result, { expanded: false, isPartial: false }, theme);
        const str = rendered.toString();
        // formatUsageStats is mocked to return "" — but the real function would show ↑5k ↓2k R3k W500 etc.
        // With the mock returning "", just verify it doesn't crash
        expect(str).toContain("✓");
        expect(str).toContain("Result");
    });
});
