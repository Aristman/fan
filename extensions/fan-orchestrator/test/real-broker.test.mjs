import { describe, it, expect, beforeEach } from "vitest";
import { brokerHandler } from "../broker-handler.js";

describe("F-2.4 FIX: brokerHandler.invokeTool", () => {
  beforeEach(() => brokerHandler._reset());

  it("invokeTool with no handler returns error", async () => {
    // No setToolCallHandler called
    await expect(brokerHandler.invokeTool("mcp__fs__read_file", {}))
      .rejects.toThrow(/No MCP tool handler registered/);
  });

  it("invokeTool with handler but empty catalog returns not found error", async () => {
    brokerHandler.setToolCallHandler(async (serverId, toolName, args) => ({
      content: [{ type: "text", text: `${serverId}/${toolName}/${args.path}` }],
    }));

    // Catalog is empty — should get "not found" error
    await expect(brokerHandler.invokeTool("mcp__fs__read_file", { path: "/tmp/test.txt" }))
      .rejects.toThrow(/not found/);
  });

  it("handleRemoteToolInvocation catches handler errors gracefully", async () => {
    brokerHandler.setToolCallHandler(async () => {
      throw new Error("kaboom");
    });
    // Seed catalog with a tool so the handler is actually invoked
    let capturedHandler = null;
    brokerHandler.initialize({
      events: {
        on: (channel, handler) => {
          capturedHandler = handler;
        },
      },
    });
    capturedHandler({
      tools: [
        {
          id: "mcp__test__greet",
          description: "Test tool",
        },
      ],
    });
    const result = await brokerHandler.handleRemoteToolInvocation("mcp__test__greet", { name: "World" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });

  it("handleRemoteToolInvocation with no handler returns error response", async () => {
    const result = await brokerHandler.handleRemoteToolInvocation("any_tool", {});
    expect(result.isError).toBe(true);
  });

  it("setToolCallHandler and getToolCallHandler round-trip", () => {
    const handler = async () => ({ content: [] });
    brokerHandler.setToolCallHandler(handler);
    expect(brokerHandler.getToolCallHandler()).toBe(handler);
  });

  it("invokeTool with seeded catalog calls handler correctly", async () => {
    // Seed the catalog manually via EventBus subscription
    let capturedHandler = null;
    brokerHandler.initialize({
      events: {
        on: (channel, handler) => {
          capturedHandler = handler;
        },
      },
    });

    capturedHandler({
      tools: [
        {
          id: "mcp__fs__read_file",
          description: "Read a file from disk",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    });

    let invoked = false;
    brokerHandler.setToolCallHandler(async (serverId, toolName, args) => {
      invoked = true;
      expect(serverId).toBe("fs");
      expect(toolName).toBe("read_file");
      expect(args.path).toBe("/tmp/test.txt");
      return {
        content: [{ type: "text", text: "file contents" }],
      };
    });

    const result = await brokerHandler.handleRemoteToolInvocation("mcp__fs__read_file", { path: "/tmp/test.txt" });
    expect(invoked).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("file contents");
  });

  it("handleRemoteToolInvocation with non-existent tool returns error", async () => {
    brokerHandler.setToolCallHandler(async () => ({
      content: [{ type: "text", text: "should not be called" }],
    }));
    const result = await brokerHandler.handleRemoteToolInvocation("mcp__nonexistent__tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("_reset clears toolCallHandler", () => {
    brokerHandler.setToolCallHandler(async () => ({ content: [] }));
    expect(brokerHandler.getToolCallHandler()).not.toBeNull();
    brokerHandler._reset();
    expect(brokerHandler.getToolCallHandler()).toBeNull();
  });
});
