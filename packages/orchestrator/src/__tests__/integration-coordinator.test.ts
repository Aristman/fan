/**
 * Integration test for FAN Orchestrator v2 — Extension registration, tool/command
 * registration, agent registry, and task management.
 *
 * Verifies the extension factory correctly wires up the coordinator extension
 * with all expected tools, commands, shortcuts, and event handlers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Test subjects ──────────────────────────────────────────────────────────

import orchestratorExtension from "../index.js";
import { AGENT_REGISTRY, getAgentTypes, getAgentDefinition, isRegistered } from "../agents/index.js";
import { createTask, updateTask, listTasks, taskCount, clearTasks, __resetTaskRegistry } from "../tasks.js";
import { __resetWorkerRegistry, __resetSlotPool } from "../workers.js";

// ============================================================================
// Mock ExtensionAPI
// ============================================================================

function createMockExtensionAPI() {
  const registeredTools: Array<{ name: string; config: any }> = [];
  const registeredCommands: Array<{ name: string; config: any }> = [];
  const registeredShortcuts: Array<{ keys: string; config: any }> = [];
  const eventHandlers: Array<{ event: string; handler: any }> = [];

  const mockApi: any = {
    registerTool(config: any) {
      registeredTools.push({ name: config.name, config });
    },
    registerCommand(name: string, config: any) {
      registeredCommands.push({ name, config });
    },
    registerShortcut(keys: string, config: any) {
      registeredShortcuts.push({ keys, config });
    },
    on(event: string, handler: any) {
      eventHandlers.push({ event, handler });
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };

  // Call the extension factory to register all tools/commands/events
  orchestratorExtension(mockApi);

  return {
    api: mockApi,
    registeredTools,
    registeredCommands,
    registeredShortcuts,
    eventHandlers,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Integration: FAN Orchestrator v2 Coordinator Extension", () => {
  beforeEach(() => {
    __resetTaskRegistry();
    __resetWorkerRegistry();
    __resetSlotPool();
  });

  // ── 1. Extension registration ──────────────────────────────────────────

  describe("Extension registration", () => {
    it("default export should be a function (ExtensionFactory)", () => {
      expect(typeof orchestratorExtension).toBe("function");
    });

    it("should execute without throwing when called with mock ExtensionAPI", () => {
      const { api } = createMockExtensionAPI();
      expect(() => orchestratorExtension(api)).not.toThrow();
    });
  });

  // ── 2. Tool registration ───────────────────────────────────────────────

  describe("Tool registration", () => {
    const expectedTools = ["TaskCreate", "TaskUpdate", "TaskList", "Agent", "SendMessage", "StopAgent"];

    it(`should register exactly ${expectedTools.length} tools`, () => {
      const { registeredTools } = createMockExtensionAPI();
      expect(registeredTools).toHaveLength(expectedTools.length);
    });

    for (const toolName of expectedTools) {
      it(`should register "${toolName}" tool`, () => {
        const { registeredTools } = createMockExtensionAPI();
        const tool = registeredTools.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool!.name).toBe(toolName);
      });
    }

    it("should register tools with execute handlers", () => {
      const { registeredTools } = createMockExtensionAPI();
      for (const tool of registeredTools) {
        expect(typeof tool.config.execute).toBe("function");
      }
    });

    it("should register tools with TypeBox parameter schemas", () => {
      const { registeredTools } = createMockExtensionAPI();
      for (const tool of registeredTools) {
        // TypeBox schemas have a specific shape
        expect(tool.config.parameters).toBeDefined();
        expect(typeof tool.config.parameters).toBe("object");
      }
    });

    it("TaskCreate should accept subject parameter", () => {
      const { registeredTools } = createMockExtensionAPI();
      const taskCreate = registeredTools.find((t) => t.name === "TaskCreate")!;
      expect(taskCreate.config.parameters.properties.subject).toBeDefined();
    });

    it("TaskUpdate should accept taskId and status parameters", () => {
      const { registeredTools } = createMockExtensionAPI();
      const taskUpdate = registeredTools.find((t) => t.name === "TaskUpdate")!;
      expect(taskUpdate.config.parameters.properties.taskId).toBeDefined();
      expect(taskUpdate.config.parameters.properties.status).toBeDefined();
    });

    it("TaskList should accept optional status and owner parameters", () => {
      const { registeredTools } = createMockExtensionAPI();
      const taskList = registeredTools.find((t) => t.name === "TaskList")!;
      const props = taskList.config.parameters.properties;
      expect(props.status).toBeDefined();
      expect(props.owner).toBeDefined();
    });

    it("Agent should accept agentType and task parameters", () => {
      const { registeredTools } = createMockExtensionAPI();
      const agent = registeredTools.find((t) => t.name === "Agent")!;
      const props = agent.config.parameters.properties;
      expect(props.agentType).toBeDefined();
      expect(props.task).toBeDefined();
    });

    it("Agent should have renderCall and renderResult renderers", () => {
      const { registeredTools } = createMockExtensionAPI();
      const agent = registeredTools.find((t) => t.name === "Agent")!;
      expect(typeof agent.config.renderCall).toBe("function");
      expect(typeof agent.config.renderResult).toBe("function");
    });

    it("SendMessage should accept workerId and message parameters", () => {
      const { registeredTools } = createMockExtensionAPI();
      const sendMsg = registeredTools.find((t) => t.name === "SendMessage")!;
      const props = sendMsg.config.parameters.properties;
      expect(props.workerId).toBeDefined();
      expect(props.message).toBeDefined();
    });

    it("StopAgent should accept workerId parameter", () => {
      const { registeredTools } = createMockExtensionAPI();
      const stopAgent = registeredTools.find((t) => t.name === "StopAgent")!;
      expect(stopAgent.config.parameters.properties.workerId).toBeDefined();
    });
  });

  // ── 3. Command registration ─────────────────────────────────────────────

  describe("Command registration", () => {
    const expectedCommands = ["orchestrator", "plan"];

    it(`should register exactly ${expectedCommands.length} commands`, () => {
      const { registeredCommands } = createMockExtensionAPI();
      expect(registeredCommands).toHaveLength(expectedCommands.length);
    });

    for (const cmdName of expectedCommands) {
      it(`should register "/${cmdName}" command`, () => {
        const { registeredCommands } = createMockExtensionAPI();
        const cmd = registeredCommands.find((c) => c.name === cmdName);
        expect(cmd).toBeDefined();
        expect(cmd!.name).toBe(cmdName);
      });
    }

    it("each command should have a handler and description", () => {
      const { registeredCommands } = createMockExtensionAPI();
      for (const cmd of registeredCommands) {
        expect(typeof cmd.config.handler).toBe("function");
        expect(cmd.config.description).toBeTruthy();
      }
    });
  });

  // ── 4. Shortcut registration ────────────────────────────────────────────

  describe("Shortcut registration", () => {
    it("should register shortcuts", () => {
      const { registeredShortcuts } = createMockExtensionAPI();
      expect(registeredShortcuts.length).toBeGreaterThanOrEqual(2);
    });

    it("should register alt+o shortcut (toggle coordinator)", () => {
      const { registeredShortcuts } = createMockExtensionAPI();
      const shortcut = registeredShortcuts.find((s) => s.keys === "alt+o");
      expect(shortcut).toBeDefined();
      expect(typeof shortcut!.config.handler).toBe("function");
    });

    it("should register alt+t shortcut (toggle task list collapse)", () => {
      const { registeredShortcuts } = createMockExtensionAPI();
      const shortcut = registeredShortcuts.find((s) => s.keys === "alt+t");
      expect(shortcut).toBeDefined();
    });
  });

  // ── 5. Event handler registration ───────────────────────────────────────

  describe("Event handler registration", () => {
    it("should register before_agent_start event handler", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "before_agent_start");
      expect(handler).toBeDefined();
      expect(typeof handler!.handler).toBe("function");
    });

    it("should register turn_end event handler", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "turn_end");
      expect(handler).toBeDefined();
    });

    it("should register session_start event handler", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "session_start");
      expect(handler).toBeDefined();
    });

    it("should register session_shutdown event handler", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "session_shutdown");
      expect(handler).toBeDefined();
    });

    it("should register tool_call event handler", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "tool_call");
      expect(handler).toBeDefined();
      expect(typeof handler!.handler).toBe("function");
    });
  });

  // ── 6. Agent types (AGENT_REGISTRY) ────────────────────────────────────

  describe("Agent types", () => {
    const expectedAgentTypes = [
      "explore", "plan", "implement", "verify",
      "bug-fix", "code-research", "tests-impl", "docs-impl",
    ];

    it("should have exactly 8 agent types registered", () => {
      const types = getAgentTypes();
      expect(types).toHaveLength(expectedAgentTypes.length);
    });

    for (const agentType of expectedAgentTypes) {
      it(`should have "${agentType}" agent type`, () => {
        expect(isRegistered(agentType)).toBe(true);
        expect(getAgentDefinition(agentType)).toBeDefined();
        expect(AGENT_REGISTRY[agentType]).toBeDefined();
      });
    }

    it("each agent should have required fields", () => {
      for (const [type, def] of Object.entries(AGENT_REGISTRY)) {
        expect(def.type).toBe(type);
        expect(def.label).toBeTruthy();
        expect(def.prompt.length).toBeGreaterThan(50);
        expect(def.tools.length).toBeGreaterThan(0);
        expect(typeof def.readOnly).toBe("boolean");
        expect(def.description).toBeTruthy();
        expect(def.useFor).toBeTruthy();
        expect(def.icon).toBeTruthy();
      }
    });

    it("should classify read-only agents correctly", () => {
      const readOnlyAgents = ["explore", "plan", "verify", "code-research"];
      for (const type of readOnlyAgents) {
        expect(getAgentDefinition(type)?.readOnly).toBe(true);
      }
    });

    it("should classify write agents correctly", () => {
      const writeAgents = ["implement", "bug-fix", "tests-impl", "docs-impl"];
      for (const type of writeAgents) {
        expect(getAgentDefinition(type)?.readOnly).toBe(false);
      }
    });

    it("should return undefined for unregistered agent type", () => {
      expect(getAgentDefinition("nonexistent")).toBeUndefined();
      expect(isRegistered("nonexistent")).toBe(false);
    });
  });

  // ── 7. Task management ─────────────────────────────────────────────────

  describe("Task management", () => {
    beforeEach(() => {
      __resetTaskRegistry();
    });

    describe("createTask", () => {
      it("should create a task with pending status", () => {
        const task = createTask({ subject: "Test task" });
        expect(task.id).toMatch(/^task-/);
        expect(task.subject).toBe("Test task");
        expect(task.status).toBe("pending");
        expect(task.blocks).toEqual([]);
        expect(task.blockedBy).toEqual([]);
        expect(task.createdAt).toBeGreaterThan(0);
        expect(task.updatedAt).toBeGreaterThan(0);
      });

      it("should create a task with description and owner", () => {
        const task = createTask({ subject: "Test", description: "Details", owner: "worker-1" });
        expect(task.description).toBe("Details");
        expect(task.owner).toBe("worker-1");
      });

      it("should increment task count", () => {
        createTask({ subject: "Task 1" });
        createTask({ subject: "Task 2" });
        expect(taskCount()).toBe(2);
      });

      it("should generate unique IDs", () => {
        const t1 = createTask({ subject: "A" });
        const t2 = createTask({ subject: "B" });
        expect(t1.id).not.toBe(t2.id);
      });
    });

    describe("updateTask", () => {
      it("should update status to completed", () => {
        const task = createTask({ subject: "Test" });
        const updated = updateTask(task.id, { status: "completed" });
        expect(updated).not.toBeNull();
        expect(updated!.status).toBe("completed");
      });

      it("should update status to in_progress", () => {
        const task = createTask({ subject: "Test" });
        const updated = updateTask(task.id, { status: "in_progress" });
        expect(updated!.status).toBe("in_progress");
      });

      it("should update status to failed", () => {
        const task = createTask({ subject: "Test" });
        const updated = updateTask(task.id, { status: "failed" });
        expect(updated!.status).toBe("failed");
      });

      it("should return null for non-existent task", () => {
        const updated = updateTask("nonexistent", { status: "completed" });
        expect(updated).toBeNull();
      });

      it("should update subject and description", () => {
        const task = createTask({ subject: "Old", description: "Old desc" });
        const updated = updateTask(task.id, { subject: "New subject", description: "New desc" });
        expect(updated!.subject).toBe("New subject");
        expect(updated!.description).toBe("New desc");
      });
    });

    describe("listTasks", () => {
      it("should return all tasks", () => {
        createTask({ subject: "A" });
        createTask({ subject: "B" });
        createTask({ subject: "C" });
        const tasks = listTasks();
        expect(tasks).toHaveLength(3);
      });

      it("should return empty array when no tasks exist", () => {
        const tasks = listTasks();
        expect(tasks).toHaveLength(0);
      });

      it("should filter by status", () => {
        const t1 = createTask({ subject: "A" });
        createTask({ subject: "B" });
        updateTask(t1.id, { status: "completed" });
        expect(listTasks({ status: "completed" })).toHaveLength(1);
        expect(listTasks({ status: "pending" })).toHaveLength(1);
      });

      it("should filter by owner", () => {
        createTask({ subject: "A", owner: "w1" });
        createTask({ subject: "B", owner: "w2" });
        expect(listTasks({ owner: "w1" })).toHaveLength(1);
        expect(listTasks({ owner: "w2" })).toHaveLength(1);
      });

      it("should sort by creation time (oldest first)", () => {
        const t1 = createTask({ subject: "First" });
        const t2 = createTask({ subject: "Second" });
        const tasks = listTasks();
        expect(tasks[0].id).toBe(t1.id);
        expect(tasks[1].id).toBe(t2.id);
      });
    });

    describe("clearTasks", () => {
      it("should clear all tasks", () => {
        createTask({ subject: "A" });
        createTask({ subject: "B" });
        expect(taskCount()).toBe(2);
        clearTasks();
        expect(taskCount()).toBe(0);
      });
    });
  });

  // ── 8. Tool execute: TaskCreate via registered tool ─────────────────────

  describe("Tool execution: TaskCreate", () => {
    beforeEach(() => {
      __resetTaskRegistry();
    });

    it("should create a task via execute handler", async () => {
      const { api, registeredTools } = createMockExtensionAPI();
      const tool = registeredTools.find((t) => t.name === "TaskCreate")!;
      const result = await tool.config.execute("call-1", { subject: "Integration test task" });
      expect(result.details.taskId).toMatch(/^task-/);
      expect(result.content[0].text).toContain("✅ Task created");
      expect(result.content[0].text).toContain("Integration test task");
      expect(result.content[0].text).toContain("[pending]");
      expect(taskCount()).toBe(1);
    });

    it("should create task with description and owner", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const tool = registeredTools.find((t) => t.name === "TaskCreate")!;
      const result = await tool.config.execute("call-2", {
        subject: "Task with details",
        description: "Detailed description here",
        owner: "worker-xyz",
      });
      expect(result.content[0].text).toContain("Task with details");
      expect(result.details.taskId).toMatch(/^task-/);
      expect(listTasks()[0].owner).toBe("worker-xyz");
      expect(listTasks()[0].description).toBe("Detailed description here");
    });
  });

  // ── 9. Tool execute: TaskUpdate via registered tool ─────────────────────

  describe("Tool execution: TaskUpdate", () => {
    beforeEach(() => {
      __resetTaskRegistry();
    });

    it("should update task status via execute handler", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const task = createTask({ subject: "Update me" });

      const tool = registeredTools.find((t) => t.name === "TaskUpdate")!;
      const result = await tool.config.execute("call-3", {
        taskId: task.id,
        status: "completed",
      });

      expect(result.content[0].text).toContain("completed");
      expect(result.content[0].text).toContain("Update me");
      expect(listTasks({ status: "completed" })).toHaveLength(1);
    });

    it("should return not found for non-existent task", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const tool = registeredTools.find((t) => t.name === "TaskUpdate")!;
      const result = await tool.config.execute("call-4", {
        taskId: "nonexistent",
        status: "completed",
      });

      expect(result.content[0].text).toContain("not found");
    });
  });

  // ── 10. Tool execute: TaskList via registered tool ──────────────────────

  describe("Tool execution: TaskList", () => {
    beforeEach(() => {
      __resetTaskRegistry();
    });

    it("should list tasks via execute handler", async () => {
      const { registeredTools } = createMockExtensionAPI();
      createTask({ subject: "Task A" });
      createTask({ subject: "Task B" });

      const tool = registeredTools.find((t) => t.name === "TaskList")!;
      const result = await tool.config.execute("call-5", {});

      expect(result.content[0].text).toContain("Task A");
      expect(result.content[0].text).toContain("Task B");
      expect(result.content[0].text).toContain("Total: 2");
    });

    it("should filter by status via execute handler", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const t1 = createTask({ subject: "Done task" });
      createTask({ subject: "Pending task" });
      updateTask(t1.id, { status: "completed" });

      const tool = registeredTools.find((t) => t.name === "TaskList")!;
      const result = await tool.config.execute("call-6", { status: "completed" });

      expect(result.content[0].text).toContain("Done task");
      expect(result.content[0].text).not.toContain("Pending task");
      expect(result.content[0].text).toContain("Showing: 1");
    });
  });

  // ── 11. Tool execute: SendMessage (worker not found) ────────────────────

  describe("Tool execution: SendMessage", () => {
    it("should return 'worker not found' for unknown worker", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const tool = registeredTools.find((t) => t.name === "SendMessage")!;
      const result = await tool.config.execute("call-7", {
        workerId: "nonexistent",
        message: "hello",
      });

      expect(result.content[0].text).toContain("Worker not found");
    });
  });

  // ── 12. Tool execute: StopAgent (worker not found) ──────────────────────

  describe("Tool execution: StopAgent", () => {
    it("should return 'worker not found' for unknown worker", async () => {
      const { registeredTools } = createMockExtensionAPI();
      const tool = registeredTools.find((t) => t.name === "StopAgent")!;
      const result = await tool.config.execute("call-8", {
        workerId: "nonexistent",
      });

      expect(result.content[0].text).toContain("not found");
    });
  });

  // ── 13. before_agent_start event — coordinator prompt injection ─────────

  describe("before_agent_start event", () => {
    it("should inject coordinator prompt when coordinator is active", () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "before_agent_start")!;

      const result = handler.handler({
        systemPrompt: "You are a helpful assistant.",
      });

      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain("You are a helpful assistant.");
      expect(result.systemPrompt).toContain("ORCHESTRATOR MODE");
    });
  });

  // ── 14. tool_call event — permission gate ───────────────────────────────

  describe("tool_call event", () => {
    it("should not block TaskCreate/TaskUpdate calls", async () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "tool_call")!;

      // These events should resolve without blocking (they trigger widget update, not a block)
      const result1 = await handler.handler(
        { toolName: "TaskCreate", input: {} },
        { ui: { setWidget: vi.fn() } },
      );
      expect(result1).toBeUndefined();

      const result2 = await handler.handler(
        { toolName: "TaskUpdate", input: {} },
        { ui: { setWidget: vi.fn() } },
      );
      expect(result2).toBeUndefined();
    });

    it("should not block safe bash commands", async () => {
      const { eventHandlers } = createMockExtensionAPI();
      const handler = eventHandlers.find((e) => e.event === "tool_call")!;

      const result = await handler.handler(
        { toolName: "bash", input: { command: "ls -la" } },
        { ui: {} },
      );
      expect(result).toBeUndefined();
    });
  });
});
