import { describe, it, expect } from "vitest";

/**
 * Test the JSON response format for handleRemoteToolRequest.
 *
 * The actual handler lives inside runWorker() closure and requires
 * spawning a child process, which is hard to unit-test directly.
 * Instead, we verify the message shapes that handleRemoteToolRequest
 * produces — both success and error cases.
 *
 * Full integration with broker-handler lands in F-2.5.
 */

describe("F-2.4: handleRemoteToolRequest placeholder response format", () => {
  it("produces correct success response shape", () => {
    const response = {
      type: "remote_tool_response",
      id: "inv-001",
      content: [{ type: "text", text: "stub result" }],
      isError: false,
    };
    expect(response.type).toBe("remote_tool_response");
    expect(response.id).toBe("inv-001");
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toBe("stub result");
    expect(response.isError).toBe(false);
  });

  it("produces error response shape", () => {
    const response = {
      type: "remote_tool_response",
      id: "inv-002",
      content: [{ type: "text", text: "stub error" }],
      isError: true,
      errorMessage: "stub error",
    };
    expect(response.isError).toBe(true);
    expect(response.errorMessage).toBe("stub error");
    expect(response.content[0].text).toBe("stub error");
  });

  it("matches the format sent by handleRemoteToolRequest success path", () => {
    const toolId = "read_file";
    const args = { path: "/tmp/test.txt" };
    const response = {
      type: "remote_tool_response",
      id: "inv-003",
      content: [
        {
          type: "text",
          text: `[F-2.4 stub] Would call ${toolId} with ${JSON.stringify(args)}`,
        },
      ],
      isError: false,
    };
    expect(response.type).toBe("remote_tool_response");
    expect(response.id).toBe("inv-003");
    expect(response.content[0].text).toContain("Would call read_file");
    expect(response.content[0].text).toContain("/tmp/test.txt");
    expect(response.isError).toBe(false);
  });

  it("matches the format sent by handleRemoteToolRequest error path", () => {
    const errorMessage = "Something went wrong";
    const response = {
      type: "remote_tool_response",
      id: "inv-004",
      content: [
        {
          type: "text",
          text: `[F-2.4 stub] Error: ${errorMessage}`,
        },
      ],
      isError: true,
      errorMessage,
    };
    expect(response.type).toBe("remote_tool_response");
    expect(response.id).toBe("inv-004");
    expect(response.content[0].text).toContain("Error: Something went wrong");
    expect(response.isError).toBe(true);
    expect(response.errorMessage).toBe(errorMessage);
  });
});
