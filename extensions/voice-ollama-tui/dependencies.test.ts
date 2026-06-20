/**
 * Tests for voice-ollama-tui dependency checker (F-1.3 + F-2.3)
 *
 * Roadmap test cases:
 *   TC-F-1.3-1: When at least one audio tool (ffmpeg/sox/arecord) and
 *                whisper-cli are present, status is ok
 *   TC-F-1.3-2: When no audio tool is available, missing includes ffmpeg
 *
 * Strategy:
 *   We mock child_process.execSync so no real tools are invoked.
 *   vi.mock is at top level (Vitest requirement).
 *   We control per-test behavior via .mockImplementation().
 *   The cache is reset between tests via resetDependencyCache().
 */

import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock at top level (required by Vitest for proper hoisting)
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// F-1.3: Dependency checks
// ---------------------------------------------------------------------------

describe("voice-ollama-tui dependencies (F-1.3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Fresh import so the cache is fresh
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── TC-F-1.3-1: all tools present → ok ───────────────────────────────
	it("TC-F-1.3-1: returns ok when ffmpeg and whisper-cli are available", async () => {
		vi.mocked(execSync).mockReturnValue(Buffer.from(""));

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.instructions).toEqual([]);

		// ffmpeg -version, sox --version, arecord --version, and whisper-cli -h were called
		const calls = vi.mocked(execSync).mock.calls.map((c) => c[0]);
		expect(calls).toContain("ffmpeg -version");
		expect(calls).toContain("sox --version");
		expect(calls).toContain("arecord --version");
		expect(calls).toContain("whisper-cli -h");
	});

	// ── TC-F-1.3-2: all audio tools missing ──────────────────────────────
	it("TC-F-1.3-2: returns missing ffmpeg when no audio tool is available", async () => {
		// All audio tools fail, whisper-cli succeeds
		vi.mocked(execSync)
			.mockImplementationOnce(() => {
				throw new Error("ffmpeg not found");
			})
			.mockImplementationOnce(() => {
				throw new Error("sox not found");
			})
			.mockImplementationOnce(() => {
				throw new Error("arecord not found");
			})
			.mockImplementationOnce(() => Buffer.from("")); // whisper-cli ok

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(false);
		expect(result.missing).toContain("ffmpeg");
		expect(result.missing).not.toContain("whisper-cli");
		expect(result.instructions.length).toBeGreaterThan(0);
		expect(result.instructions.join(" ").toLowerCase()).toContain("ffmpeg");
	});

	// ── At least one audio tool present → ok (for audio) ────────────────
	it("returns ok when at least sox is available (ffmpeg + arecord missing)", async () => {
		vi.mocked(execSync)
			.mockImplementationOnce(() => {
				throw new Error("ffmpeg not found");
			})
			.mockImplementationOnce(() => Buffer.from("")) // sox ok
			.mockImplementationOnce(() => {
				throw new Error("arecord not found");
			})
			.mockImplementationOnce(() => Buffer.from("")); // whisper-cli ok

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("returns ok when only arecord is available", async () => {
		vi.mocked(execSync)
			.mockImplementationOnce(() => {
				throw new Error("ffmpeg not found");
			})
			.mockImplementationOnce(() => {
				throw new Error("sox not found");
			})
			.mockImplementationOnce(() => Buffer.from("")) // arecord ok
			.mockImplementationOnce(() => Buffer.from("")); // whisper-cli ok

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("returns missing ffmpeg + whisper-cli when no audio tool and no whisper-cli", async () => {
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("command not found");
		});

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(false);
		expect(result.missing).toContain("ffmpeg");
		expect(result.missing).toContain("whisper-cli");
		expect(result.instructions.length).toBeGreaterThan(0);
	});

	// ── whisper-cli missing only ─────────────────────────────────────────
	it("returns missing with whisper-cli when only whisper-cli is missing", async () => {
		vi.mocked(execSync)
			.mockImplementationOnce(() => Buffer.from("")) // ffmpeg ok
			.mockImplementationOnce(() => Buffer.from("")) // sox ok
			.mockImplementationOnce(() => Buffer.from("")) // arecord ok
			.mockImplementationOnce(() => {
				throw new Error("whisper-cli not found");
			}); // whisper-cli fails

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		expect(result.ok).toBe(false);
		expect(result.missing).toEqual(["whisper-cli"]);
		expect(result.instructions.length).toBeGreaterThan(0);
		expect(result.instructions.join(" ").toLowerCase()).toContain("whisper");
	});

	// ── Cache: second call uses cache ────────────────────────────────────
	it("caches result and does not exec tools again", async () => {
		vi.mocked(execSync).mockReturnValue(Buffer.from(""));

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result1 = checkDependencies();
		expect(result1.ok).toBe(true);

		// Reset the mock call history; we'll assert execSync is *not* called again
		vi.mocked(execSync).mockClear();

		const result2 = checkDependencies();
		expect(result2.ok).toBe(true);

		// execSync should not have been called a second time
		expect(vi.mocked(execSync)).not.toHaveBeenCalled();
	});

	// ── Cache: resetDependencyCache forces re-check ──────────────────────
	it("resetDependencyCache forces a fresh check", async () => {
		// 1st check: all ok
		vi.mocked(execSync).mockReturnValue(Buffer.from(""));

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result1 = checkDependencies();
		expect(result1.ok).toBe(true);

		// Reset cache and change mock to fail for all audio tools + whisper
		resetDependencyCache();
		vi.mocked(execSync)
			.mockReset()
			.mockImplementation(() => {
				throw new Error("command not found");
			});

		const result2 = checkDependencies();
		expect(result2.ok).toBe(false);
		expect(result2.missing).toContain("ffmpeg");
		expect(result2.missing).toContain("whisper-cli");
	});

	// ── Instructions are human-readable ──────────────────────────────────
	it("includes human-readable installation instructions for each missing tool", async () => {
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("command not found");
		});

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		const result = checkDependencies();

		// Expect instructions for both audio tools and whisper-cli
		const text = result.instructions.join("\n").toLowerCase();
		expect(text).toContain("ffmpeg");
		expect(text).toContain("sox");
		expect(text).toContain("arecord");
		expect(text).toContain("whisper");
	});

	// ── Config parameter is accepted (type conformance) ──────────────────
	it("accepts optional config parameter", async () => {
		vi.mocked(execSync).mockReturnValue(Buffer.from(""));

		const { checkDependencies, resetDependencyCache } = await import("./dependencies.js");
		resetDependencyCache();

		// Passing a partial config-like object should not break anything
		const result = checkDependencies({} as any);
		expect(result.ok).toBe(true);
	});
});
