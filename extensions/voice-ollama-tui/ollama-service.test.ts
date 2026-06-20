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
