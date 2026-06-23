/**
 * Tests for model-downloader.ts (F-3.2)
 *
 * Roadmap test cases:
 *   TC-F-3.2-1: When model is missing, download starts and file appears.
 *   TC-F-3.2-2: If model already exists, no download is performed.
 *   TC-F-3.2-3: On network error, returns error with manual download instructions.
 *
 * Strategy:
 *   Mock globalThis.fetch to simulate HTTP responses.
 *   Mock fs.existsSync, fs.statSync, fs.mkdirSync, fs.createWriteStream,
 *   fs.unlinkSync to control file-system interaction without touching disk.
 */

import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

/**
 * Create a mock ReadableStream<Uint8Array> from a string or Buffer.
 * (The Web Streams API the code uses via `response.body?.getReader()`.)
 */
function mockReadableStream(data: Buffer): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream({
    pull(controller) {
      if (!done) {
        controller.enqueue(new Uint8Array(data));
        done = true;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Create a mock fetch Response.
 */
function mockResponse(
  body: Buffer,
  status: number = 200,
  contentLength?: number,
): Response {
  const headers = new Headers();
  if (contentLength !== undefined) {
    headers.set("content-length", String(contentLength));
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers,
    body: mockReadableStream(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Mock streams for fs.createWriteStream
// ---------------------------------------------------------------------------

class MockWriteStream extends Writable {
  public chunks: Buffer[] = [];
  public closed = false;

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk);
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    this.closed = true;
    callback();
  }
}

/** Minimal mock for `fs.Stats` — we only use `.size`. */
function mockStats(size: number): fs.Stats {
  return { size } as fs.Stats;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MOCK_HOME = "/home/testuser";
const DEFAULT_MODEL_PATH = path.join(
  MOCK_HOME,
  ".fan",
  "models",
  "speech",
  "ggml-base.bin",
);

describe("voice-ollama-tui model-downloader (F-3.2)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockStatSync: ReturnType<typeof vi.fn>;
  let mockMkdirSync: ReturnType<typeof vi.fn>;
  let mockUnlinkSync: ReturnType<typeof vi.fn>;
  let mockCreateWriteStream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fetch mock
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // HOME env
    vi.stubEnv("HOME", MOCK_HOME);

    // fs mocks
    mockExistsSync = vi.fn();
    mockStatSync = vi.fn();
    mockMkdirSync = vi.fn();
    mockUnlinkSync = vi.fn();
    mockCreateWriteStream = vi.fn();

    vi.spyOn(fs, "existsSync").mockImplementation(mockExistsSync);
    vi.spyOn(fs, "statSync").mockImplementation(mockStatSync);
    vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);
    vi.spyOn(fs, "unlinkSync").mockImplementation(mockUnlinkSync);
    vi.spyOn(fs, "createWriteStream").mockImplementation(mockCreateWriteStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── TC-F-3.2-1: Model missing → download starts and file appears ────
  it("TC-F-3.2-1: downloads model when file does not exist", async () => {
    // Model file does not exist
    mockExistsSync.mockReturnValue(false);

    // Mock fetch to return a 142 MB-ish body (we'll use a smaller chunk for speed)
    const modelData = Buffer.alloc(1024, 0xab); // 1 KB of fake model data
    const response = mockResponse(modelData, 200, modelData.byteLength);
    mockFetch.mockResolvedValue(response);

    // Mock write stream
    const ws = new MockWriteStream();
    mockCreateWriteStream.mockReturnValue(ws);

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const progressCalls: Array<[number, number]> = [];
    const result = await ensureWhisperModel({
      onProgress: (downloaded, total) => {
        progressCalls.push([downloaded, total]);
      },
    });

    // Should return the model path
    expect(result).toBe(DEFAULT_MODEL_PATH);

    // Fetch should have been called once with default URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    );

    // Directory should have been created
    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join(MOCK_HOME, ".fan", "models", "speech"),
      { recursive: true },
    );

    // Data should have been written to the stream
    expect(ws.chunks.length).toBeGreaterThan(0);
    expect(ws.closed).toBe(true);

    // Progress should have been reported
    expect(progressCalls.length).toBeGreaterThan(0);
    // Last progress call should have full downloaded amount
    const lastCall = progressCalls[progressCalls.length - 1];
    expect(lastCall[0]).toBe(modelData.byteLength);
  });

  // ── TC-F-3.2-2: Model exists → no download ──────────────────────────
  it("TC-F-3.2-2: returns path immediately when model already exists", async () => {
    // Model file exists and has a non-zero size
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(mockStats(150_000_000)); // ~143 MB

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const result = await ensureWhisperModel();

    // Returns path immediately
    expect(result).toBe(DEFAULT_MODEL_PATH);

    // No network call
    expect(mockFetch).not.toHaveBeenCalled();

    // No directory creation
    expect(mockMkdirSync).not.toHaveBeenCalled();

    // No write stream
    expect(mockCreateWriteStream).not.toHaveBeenCalled();
  });

  // ── TC-F-3.2-2 variant: zero-size file → download triggered ────────
  it("TC-F-3.2-2: triggers download even if file exists but is empty", async () => {
    // File exists but has zero size
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(mockStats(0));

    const modelData = Buffer.alloc(512, 0xcd);
    const response = mockResponse(modelData, 200, modelData.byteLength);
    mockFetch.mockResolvedValue(response);

    const ws = new MockWriteStream();
    mockCreateWriteStream.mockReturnValue(ws);

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const result = await ensureWhisperModel();

    expect(result).toBe(DEFAULT_MODEL_PATH);
    // Fetch is called once for the initial download, and a second time because
    // the downloaded size (512) is smaller than the expected ggml-base size,
    // triggering the corrupt-model re-download check.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── TC-F-3.2-3: Network error → VoiceError with manual instructions ─
  it("TC-F-3.2-3: throws VoiceError with manual download instructions on network error", async () => {
    mockExistsSync.mockReturnValue(false);

    // Network error — fetch rejects
    mockFetch.mockRejectedValue(new Error("fetch failed: ENOTFOUND"));

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const promise = ensureWhisperModel();

    await expect(promise).rejects.toThrow(VoiceError);
    await expect(promise).rejects.toMatchObject({
      name: "VoiceError",
    });

    // Verify error message contains manual download info
    let caught: any;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toContain("huggingface.co");
    expect(caught.message).toContain("ggml-base.bin");
    expect(caught.message).toContain("manual");
    expect(caught.message).toContain("curl");
  });

  // ── TC-F-3.2-3: HTTP error → VoiceError with manual instructions ────
  it("TC-F-3.2-3: throws VoiceError on HTTP 404", async () => {
    mockExistsSync.mockReturnValue(false);

    const response = mockResponse(Buffer.alloc(0), 404);
    mockFetch.mockResolvedValue(response);

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const promise = ensureWhisperModel();

    await expect(promise).rejects.toThrow(VoiceError);
    await expect(promise).rejects.toMatchObject({
      name: "VoiceError",
      message: expect.stringContaining("404"),
    });
  });

  // ── Custom modelPath and modelUrl are respected ──────────────────────
  it("uses custom modelPath and modelUrl when provided", async () => {
    mockExistsSync.mockReturnValue(false);

    const modelData = Buffer.alloc(100, 0xef);
    const response = mockResponse(modelData, 200, modelData.byteLength);
    mockFetch.mockResolvedValue(response);

    const ws = new MockWriteStream();
    mockCreateWriteStream.mockReturnValue(ws);

    const { ensureWhisperModel } = await import("./model-downloader.js");

    const customPath = "/custom/path/model.bin";
    const customUrl = "https://example.com/model.bin";

    const result = await ensureWhisperModel({
      modelPath: customPath,
      modelUrl: customUrl,
    });

    expect(result).toBe(customPath);
    expect(mockFetch).toHaveBeenCalledWith(customUrl);

    // Verify directory creation for custom path
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/custom/path",
      { recursive: true },
    );
  });

  // ── Partial cleanup on failure removes partial download ─────────────
  it("removes partial file on download failure", async () => {
    mockExistsSync.mockReturnValue(false);

    // Build a response whose body reader will throw after 1 chunk
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.alloc(50, 0xaa)));
        controller.error(new Error("Stream corrupt"));
      },
    });

    const badResponse = new Response(brokenBody, {
      status: 200,
      headers: { "content-length": "100" },
    });
    mockFetch.mockResolvedValue(badResponse);

    const ws = new MockWriteStream();
    mockCreateWriteStream.mockReturnValue(ws);

    const { ensureWhisperModel } = await import("./model-downloader.js");

    // After failure, unlinkSync should be called to clean up the partial
    // Note: in our mock, writeStream.end() is called in the finally block
    // but the error propagates, so unlinkSync should be invoked
    mockExistsSync.mockReturnValue(true); // partial file exists for cleanup

    await expect(ensureWhisperModel()).rejects.toThrow(VoiceError);

    expect(mockUnlinkSync).toHaveBeenCalledWith(DEFAULT_MODEL_PATH);
  });
});
