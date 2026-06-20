/**
 * Tests for voice-ollama-tui ollama-service module (F-4.1)
 *
 * Roadmap test cases:
 *   TC-F-4.1-1: With Ollama running, returns a list of model names.
 *   TC-F-4.1-2: With Ollama unreachable, returns empty array + connection error.
 *
 * Strategy:
 *   Mock global fetch to simulate Ollama responses or network failures.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock response that looks like an Ollama /api/tags reply */
function makeOllamaTagsResponse(models: Array<{ name: string }>): Response {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create an error response (non-200) */
function makeErrorResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * Create a mock response that looks like an Ollama /api/chat reply.
 */
function makeOllamaChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { role: "assistant", content } }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// F-4.1: listOllamaModels
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui ollama-service (F-4.1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-F-4.1-1: returns list of model names ──────────────────────────
  it("TC-F-4.1-1: returns list of model names when Ollama is running", async () => {
    const mockModels = [
      { name: "llama3.2:latest" },
      { name: "qwen2.5:7b" },
      { name: "mistral:7b-instruct" },
    ];

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOllamaTagsResponse(mockModels),
    );

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result.models).toEqual(["llama3.2:latest", "qwen2.5:7b", "mistral:7b-instruct"]);
    expect(result.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );

    fetchMock.mockRestore();
  });

  // ── TC-F-4.1-2: empty array on connection error ──────────────────────
  it("TC-F-4.1-2: returns empty array when Ollama is unreachable (network error)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result.models).toEqual([]);
    expect(result.reachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ollama unreachable"),
      "fetch failed",
    );

    fetchMock.mockRestore();
    consoleWarn.mockRestore();
  });

  // ── returns empty array on HTTP error (non-200) ──────────────────────
  it("returns empty array on HTTP error status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(500),
    );

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result.models).toEqual([]);
    expect(result.reachable).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ollama /api/tags returned 500"),
    );

    fetchMock.mockRestore();
    consoleWarn.mockRestore();
  });

  // ── handles trailing slash in base URL ───────────────────────────────
  it("normalises trailing slash in ollamaBaseUrl", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOllamaTagsResponse([{ name: "llama3.2:latest" }]),
    );

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434/" });

    expect(result.models).toEqual(["llama3.2:latest"]);
    expect(result.reachable).toBe(true);
    // Should have been stripped to avoid double slash
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );

    fetchMock.mockRestore();
  });

  // ── returns empty array when response has no models ──────────────────
  it("returns empty array when response has no models field", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result.models).toEqual([]);
    expect(result.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRestore();
  });

  // ── handles timeout ──────────────────────────────────────────────────
  it("returns empty array on timeout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { listOllamaModels } = await import("./ollama-service.js");

    const result = await listOllamaModels({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result.models).toEqual([]);
    expect(result.reachable).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ollama unreachable"),
      expect.stringContaining("aborted"),
    );

    fetchMock.mockRestore();
    consoleWarn.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isOllamaReachable
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui isOllamaReachable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when Ollama responds with 200", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOllamaTagsResponse([{ name: "llama3.2:latest" }]),
    );

    const { isOllamaReachable } = await import("./ollama-service.js");

    const result = await isOllamaReachable({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRestore();
  });

  it("returns false on network error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );

    const { isOllamaReachable } = await import("./ollama-service.js");

    const result = await isOllamaReachable({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result).toBe(false);

    fetchMock.mockRestore();
  });

  it("returns false on non-200 response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(503),
    );

    const { isOllamaReachable } = await import("./ollama-service.js");

    const result = await isOllamaReachable({ ollamaBaseUrl: "http://localhost:11434" });

    expect(result).toBe(false);

    fetchMock.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F-4.2: improveText
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui ollama-service (F-4.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const defaultConfig = {
    ollamaBaseUrl: "http://localhost:11434",
    ollamaEnabled: true,
    ollamaModel: "llama3.2",
    ollamaSystemPrompt:
      "You are a helpful assistant. Fix punctuation and typos. Return ONLY the corrected text.",
  };

  // ── TC-F-4.2-1: Ollama returns improved text with punctuation ──────
  it("TC-F-4.2-1: returns improved text with punctuation from Ollama", async () => {
    // First call for isOllamaReachable (GET /api/tags)
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(
        makeOllamaChatResponse("Привет, мир! Как дела?"),
      );

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(defaultConfig, "привет мир как дела");

    expect(result.text).toBe("Привет, мир! Как дела?");
    expect(result.usedOllama).toBe(true);

    // Verify the POST request to /api/chat with correct body
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: isOllamaReachable → GET /api/tags
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");

    // Second call: improveText → POST /api/chat
    const secondCallUrl = fetchMock.mock.calls[1][0];
    const secondCallOpts = fetchMock.mock.calls[1][1];
    expect(secondCallUrl).toBe("http://localhost:11434/api/chat");
    expect(secondCallOpts).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    // Verify the POST body
    const body = JSON.parse(secondCallOpts!.body as string);
    expect(body).toMatchObject({
      model: "llama3.2",
      stream: false,
      options: { temperature: 0.3 },
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(defaultConfig.ollamaSystemPrompt);
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("привет мир как дела");

    fetchMock.mockRestore();
  });

  // ── TC-F-4.2-2: Unreachable Ollama returns original text ────────────
  it("TC-F-4.2-2: returns original text when Ollama is unreachable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed"));

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(defaultConfig, "привет мир");

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);

    // Should only have called once (isOllamaReachable), no /api/chat call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );

    consoleWarn.mockRestore();
    fetchMock.mockRestore();
  });

  // ── TC-F-4.2-2: ensure onFallback is called when unreachable ────────
  it("TC-F-4.2-2: calls onFallback when Ollama is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { improveText } = await import("./ollama-service.js");

    const onFallback = vi.fn();
    const result = await improveText(defaultConfig, "привет мир", {
      onFallback,
    });

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  // ── TC-F-4.2-3: ollamaEnabled=false returns original text ───────────
  it("TC-F-4.2-3: returns original text when ollamaEnabled is false", async () => {
    // No fetch mock needed — no network call should happen
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      { ...defaultConfig, ollamaEnabled: false },
      "привет мир",
    );

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);

    // fetch must NOT be called at all
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  // ── ollamaEnabled explicitly false even with reachable server ───────
  it("TC-F-4.2-3: does not call Ollama API when ollamaEnabled is false, even if reachable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOllamaTagsResponse([{ name: "llama3.2" }]));

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      { ...defaultConfig, ollamaEnabled: false },
      "привет мир",
    );

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);

    // fetch should NOT have been called (we skip early)
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  // ── Falls back on HTTP error ────────────────────────────────────────
  it("falls back to original text when Ollama returns non-200", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(makeErrorResponse(500));

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { improveText } = await import("./ollama-service.js");

    const onFallback = vi.fn();
    const result = await improveText(defaultConfig, "привет мир", {
      onFallback,
    });

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat returned 500"),
    );

    consoleWarn.mockRestore();
    fetchMock.mockRestore();
  });

  // ── Falls back on empty response content ────────────────────────────
  it("falls back to original text when Ollama returns empty content", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { role: "assistant", content: "   " } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(defaultConfig, "привет мир");

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("empty content"),
    );

    consoleWarn.mockRestore();
    fetchMock.mockRestore();
  });

  // ── Falls back on network error during /api/chat ────────────────────
  it("falls back to original text when /api/chat request fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockRejectedValueOnce(new TypeError("network error"));

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { improveText } = await import("./ollama-service.js");

    const onFallback = vi.fn();
    const result = await improveText(defaultConfig, "привет мир", {
      onFallback,
    });

    expect(result.text).toBe("привет мир");
    expect(result.usedOllama).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ollama request failed"),
      expect.any(String),
    );

    consoleWarn.mockRestore();
    fetchMock.mockRestore();
  });

  // ── Uses default model when config model is not set ─────────────────
  it("uses default model 'llama3.2' when no model specified in config", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(makeOllamaChatResponse("Hello!"));

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      {
        ollamaBaseUrl: "http://localhost:11434",
        ollamaEnabled: true,
        // no ollamaModel specified
      },
      "hello",
    );

    expect(result.text).toBe("Hello!");
    expect(result.usedOllama).toBe(true);

    // Verify default model was used
    const callBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(callBody.model).toBe("llama3.2");

    fetchMock.mockRestore();
  });

  // ── Uses default system prompt when none specified ──────────────────
  it("uses default system prompt when ollamaSystemPrompt is not set", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(makeOllamaChatResponse("Improved!"));

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      {
        ollamaBaseUrl: "http://localhost:11434",
        ollamaEnabled: true,
        ollamaModel: "qwen2.5",
        // no ollamaSystemPrompt specified
      },
      "hello",
    );

    expect(result.text).toBe("Improved!");
    expect(result.usedOllama).toBe(true);

    // Verify default system prompt was used
    const callBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(callBody.messages[0].role).toBe("system");
    expect(callBody.messages[0].content).toContain("Fix punctuation");

    fetchMock.mockRestore();
  });

  // ── Handles trailing slash in base URL ──────────────────────────────
  it("normalises trailing slash in ollamaBaseUrl for /api/chat", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(makeOllamaChatResponse("Fixed!"));

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      {
        ollamaBaseUrl: "http://localhost:11434/",
        ollamaEnabled: true,
        ollamaModel: "llama3.2",
      },
      "hello",
    );

    expect(result.usedOllama).toBe(true);

    // isOllamaReachable URL should be normalised
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
    // /api/chat URL should be normalised
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:11434/api/chat");

    fetchMock.mockRestore();
  });

  // ── Passes AbortSignal from options ─────────────────────────────────
  it("passes AbortSignal to the fetch call", async () => {
    const abortController = new AbortController();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOllamaTagsResponse([{ name: "llama3.2" }]))
      .mockResolvedValueOnce(makeOllamaChatResponse("Fixed!"));

    const { improveText } = await import("./ollama-service.js");

    const result = await improveText(
      {
        ollamaBaseUrl: "http://localhost:11434",
        ollamaEnabled: true,
        ollamaModel: "llama3.2",
      },
      "hello",
      { signal: abortController.signal },
    );

    expect(result.usedOllama).toBe(true);

    // The second fetch call (/api/chat) should include the signal
    const secondCallOpts = fetchMock.mock.calls[1][1] as RequestInit;
    expect(secondCallOpts.signal).toBe(abortController.signal);

    fetchMock.mockRestore();
  });
});
