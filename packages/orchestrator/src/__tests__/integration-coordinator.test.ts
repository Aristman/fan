import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules that orchestrator-extension imports
vi.mock("@itone/fan-coding-agent", () => ({
    getMarkdownTheme: vi.fn(() => ({})),
    getAgentDir: vi.fn(() => "/home/user/.fan/agent"),
    parseFrontmatter: vi.fn((content: string) => ({
        frontmatter: {},
        body: content,
    })),
}));

vi.mock("@itone/fan-tui", () => ({
    Container: vi.fn(),
    Markdown: vi.fn(),
    Spacer: vi.fn(),
    Text: vi.fn(),
}));

vi.mock("@sinclair/typebox", () => ({
    Type: {
        Object: (props: any) => props,
        String: (opts: any) => opts,
        Optional: (type: any) => ({ optional: true, ...type }),
        Array: (type: any) => ({ array: true, ...type }),
        Boolean: (opts: any) => opts,
    },
}));

vi.mock("@itone/fan-ai", () => ({
    StringEnum: (values: any, opts: any) => ({ values, ...opts }),
}));

vi.mock("../subagent-runner.js", () => ({
    runSingleAgent: vi.fn(),
    getFinalOutput: vi.fn(),
}));

vi.mock("../config.js", () => ({
    loadConfig: vi.fn(() => ({
        cloud: { model: "test/cloud" },
        local: { model: "test/local" },
        providerMode: "cloud",
        parallelWorkers: 3,
        workerTimeout: 300_000,
        maxRetries: 2,
        planTimeout: 300_000,
        agentTimeouts: { explore: 120_000, plan: 180_000, implement: 300_000, verify: 180_000 },
        dangerousCommands: [],
    })),
}));

vi.mock("../permissions.js", () => ({
    isDangerousCommand: vi.fn(() => null),
}));

vi.mock("../workers.js", () => ({
    genWorkerId: vi.fn(() => "test-worker-id"),
    registerWorker: vi.fn(),
    getWorker: vi.fn(),
    activeWorkers: vi.fn(() => []),
    updateWorker: vi.fn(),
    _resetRegistry: vi.fn(),
}));

vi.mock("../agents.js", () => ({
    discoverAgents: vi.fn(() => ({ agents: [], projectAgentsDir: null })),
    COORDINATOR_PROMPT: "test coordinator prompt",
}));

function createMockPi() {
    const tools: any[] = [];
    const commands: any[] = [];
    const shortcuts: any[] = [];
    const eventHandlers: Record<string, Function[]> = {};

    return {
        tools,
        commands,
        shortcuts,
        eventHandlers,
        registerTool: (tool: any) => tools.push(tool),
        registerCommand: (name: string, opts: any) => commands.push({ name, ...opts }),
        registerShortcut: (key: string, opts: any) => shortcuts.push({ key, ...opts }),
        on: (event: string, handler: any) => {
            if (!eventHandlers[event]) eventHandlers[event] = [];
            eventHandlers[event].push(handler);
        },
        sendUserMessage: vi.fn(),
    };
}

describe("orchestrator extension integration", () => {
    let mockPi: ReturnType<typeof createMockPi>;

    beforeEach(() => {
        mockPi = createMockPi();
    });

    it("extension factory creates without errors", async () => {
        const { orchestratorExtension } = await import("../orchestrator-extension.js");
        expect(() => orchestratorExtension(mockPi as any)).not.toThrow();
    });

    it("extension registers expected tools", async () => {
        const { orchestratorExtension } = await import("../orchestrator-extension.js");
        orchestratorExtension(mockPi as any);

        const toolNames = mockPi.tools.map((t: any) => t.name);
        expect(toolNames).toContain("delegate_task");
        expect(toolNames).toContain("list_tasks");
        expect(toolNames).toContain("cancel_task");
        expect(toolNames).toContain("classify_task");
        expect(toolNames).toContain("TaskCreate");
        expect(toolNames).toContain("TaskUpdate");
    });

    it("extension registers expected commands", async () => {
        const { orchestratorExtension } = await import("../orchestrator-extension.js");
        orchestratorExtension(mockPi as any);

        const commandNames = mockPi.commands.map((c: any) => c.name);
        expect(commandNames).toContain("orchestrator");
        expect(commandNames).toContain("plan");
        expect(commandNames).toContain("tasks");
        expect(commandNames).toContain("agents");
        expect(commandNames).toContain("delegate");
    });

    it("extension registers shortcuts", async () => {
        const { orchestratorExtension } = await import("../orchestrator-extension.js");
        orchestratorExtension(mockPi as any);

        const shortcutKeys = mockPi.shortcuts.map((s: any) => s.key);
        expect(shortcutKeys).toContain("alt+o");
        expect(shortcutKeys).toContain("alt+t");
    });
});
