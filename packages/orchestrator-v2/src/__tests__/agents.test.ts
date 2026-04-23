/**
 * Tests for agents.ts — Coordinator prompt, agent registry, notifications
 */
import { describe, it, expect } from "vitest";
import { buildCoordinatorPrompt, formatTaskNotification, AGENT_DEFINITIONS } from "../agents.js";
import { AGENT_REGISTRY, getAgentTypes, getAgentDefinition, isRegistered, PLANNING_PROMPT } from "../agents/index.js";

describe("Agent Registry", () => {
  it("should have all 8 agent types registered", () => {
    const types = getAgentTypes();
    expect(types).toContain("explore");
    expect(types).toContain("plan");
    expect(types).toContain("implement");
    expect(types).toContain("verify");
    expect(types).toContain("bug-fix");
    expect(types).toContain("code-research");
    expect(types).toContain("tests-impl");
    expect(types).toContain("docs-impl");
    expect(types).toHaveLength(8);
  });

  it("should correctly classify read-only vs write agents", () => {
    const readOnlyAgents = ["explore", "plan", "verify", "code-research"];
    const writeAgents = ["implement", "bug-fix", "tests-impl", "docs-impl"];

    for (const type of readOnlyAgents) {
      const def = getAgentDefinition(type);
      expect(def?.readOnly).toBe(true);
    }

    for (const type of writeAgents) {
      const def = getAgentDefinition(type);
      expect(def?.readOnly).toBe(false);
    }
  });

  it("should return definition for registered type", () => {
    const def = getAgentDefinition("explore");
    expect(def).toBeDefined();
    expect(def?.type).toBe("explore");
    expect(def?.icon).toBe("🔍");
    expect(def?.tools).toContain("read");
    expect(def?.tools).toContain("bash");
  });

  it("should return undefined for unregistered type", () => {
    expect(getAgentDefinition("nonexistent")).toBeUndefined();
  });

  it("should correctly identify registered agents", () => {
    expect(isRegistered("explore")).toBe(true);
    expect(isRegistered("implement")).toBe(true);
    expect(isRegistered("fake")).toBe(false);
  });

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
});

describe("Coordinator Prompt", () => {
  it("should build a non-empty coordinator prompt", () => {
    const prompt = buildCoordinatorPrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("ORCHESTRATOR MODE");
    expect(prompt).toContain("COORDINATOR");
    expect(prompt).toContain("Agent");
    expect(prompt).toContain("TaskCreate");
    expect(prompt).toContain("explore");
    expect(prompt).toContain("implement");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("bug-fix");
  });

  it("should contain worker type table", () => {
    const prompt = buildCoordinatorPrompt();
    expect(prompt).toContain("explore");
    expect(prompt).toContain("plan");
    expect(prompt).toContain("implement");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("bug-fix");
    expect(prompt).toContain("code-research");
    expect(prompt).toContain("tests-impl");
    expect(prompt).toContain("docs-impl");
  });

  it("should contain routing rules", () => {
    const prompt = buildCoordinatorPrompt();
    expect(prompt).toContain("NEVER use implement for fixing bugs");
    expect(prompt).toContain("NEVER use bug-fix for writing new features");
  });

  it("should contain workflow descriptions", () => {
    const prompt = buildCoordinatorPrompt();
    expect(prompt).toContain("Bug Fix Workflow");
    expect(prompt).toContain("Implementation Workflow");
  });
});

describe("PLANNING_PROMPT", () => {
  it("should be exported from plan agent", () => {
    expect(PLANNING_PROMPT).toBeTruthy();
    expect(PLANNING_PROMPT).toContain("PLANNING");
    expect(PLANNING_PROMPT).toContain("READ-ONLY");
  });
});

describe("formatTaskNotification", () => {
  it("should format completed notification as XML", () => {
    const startTime = Date.now() - 5000;
    const result = { text: "Task completed successfully", messageCount: 5 };
    const xml = formatTaskNotification("worker-1", "explore", "model-1", "completed", result, startTime);

    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("<task-id>worker-1</task-id>");
    expect(xml).toContain("<status>completed</status>");
    expect(xml).toContain("<agent-type>explore</agent-type>");
    expect(xml).toContain("<model>model-1</model>");
    expect(xml).toContain("<result>");
    expect(xml).toContain("Task completed successfully");
    expect(xml).toContain("</result>");
    expect(xml).toContain("<message_count>5</message_count>");
    expect(xml).toContain("<duration_ms>");
    expect(xml).toContain("</task-notification>");
  });

  it("should format failed notification", () => {
    const startTime = Date.now() - 3000;
    const result = { text: "Error: something went wrong", messageCount: 1 };
    const xml = formatTaskNotification("worker-2", "implement", "model-2", "failed", result, startTime);

    expect(xml).toContain("<status>failed</status>");
    expect(xml).toContain("Error: something went wrong");
  });

  it("should include summary (first 3 lines)", () => {
    const startTime = Date.now();
    const longText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const result = { text: longText, messageCount: 1 };
    const xml = formatTaskNotification("w1", "plan", "m1", "completed", result, startTime);

    expect(xml).toContain("<summary>Line 1 Line 2 Line 3</summary>");
  });
});

describe("AGENT_DEFINITIONS export", () => {
  it("should be the same as AGENT_REGISTRY", () => {
    expect(AGENT_DEFINITIONS).toBe(AGENT_REGISTRY);
  });
});
