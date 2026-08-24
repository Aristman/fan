/**
 * Unit tests for the LoopDetector class (F-04).
 *
 * Tests the isolated detector logic: hashing, counter increment,
 * threshold firing, reset on success, and signature differentiation.
 */

import { describe, expect, it } from "vitest";
import {
	hashToolCall,
	LoopDetector,
	type LoopDetectorDiagnostic,
	normalizeErrorText,
} from "../src/core/loop-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDetector(opts?: { threshold?: number; enabled?: boolean }) {
	const diagnostics: LoopDetectorDiagnostic[] = [];
	const threshold = opts?.threshold ?? 2;
	const enabled = opts?.enabled ?? true;

	const detector = new LoopDetector({
		onLoopDetected: (d) => diagnostics.push(d),
		getThreshold: () => threshold,
		isEnabled: () => enabled,
	});

	return { detector, diagnostics };
}

function fireError(detector: LoopDetector, id: string, tool: string, args: unknown, error: string) {
	detector.onToolStart(id, tool, args);
	detector.onToolEnd(id, true, error);
}

function fireSuccess(detector: LoopDetector, id: string, tool: string, args: unknown) {
	detector.onToolStart(id, tool, args);
	detector.onToolEnd(id, false, undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopDetector", () => {
	it("fires when threshold is reached with identical errors", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(0);

		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toEqual({
			reason: "loop_detected",
			tool: "bash",
			error: "EACCES",
			count: 2,
		});
	});

	it("reset on successful call with same tool+args prevents firing", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		// Success with the SAME tool + args resets the series.
		fireSuccess(detector, "tc-2", "bash", { cmd: "npm test" });
		fireError(detector, "tc-3", "bash", { cmd: "npm test" }, "EACCES");

		expect(diagnostics).toHaveLength(0);
	});

	it("success of a DIFFERENT tool does NOT reset the error series", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		// Success with a DIFFERENT tool must not reset bash's series.
		fireSuccess(detector, "tc-2", "edit", { path: "/tmp/foo" });
		fireError(detector, "tc-3", "bash", { cmd: "npm test" }, "EACCES");

		// The counter should NOT have been reset — 2 identical errors → fired.
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].tool).toBe("bash");
	});

	it("different args produce distinct signatures", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "bash", { cmd: "npm test --fix" }, "EACCES");

		expect(diagnostics).toHaveLength(0);
	});

	it("different tools produce distinct signatures", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "lint", { cmd: "npm test" }, "EACCES");

		expect(diagnostics).toHaveLength(0);
	});

	it("different error messages produce distinct signatures", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EPERM");

		expect(diagnostics).toHaveLength(0);
	});

	it("threshold=3 requires three identical errors", () => {
		const { detector, diagnostics } = createDetector({ threshold: 3 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(0);

		fireError(detector, "tc-3", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].count).toBe(3);
	});

	it("disabled detector never fires", () => {
		const { detector, diagnostics } = createDetector({ enabled: false });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-3", "bash", { cmd: "npm test" }, "EACCES");

		expect(diagnostics).toHaveLength(0);
	});

	it("dispose resets internal state", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		detector.dispose();

		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(0);
	});

	it("reset() clears fired state so detector can fire again", () => {
		const { detector, diagnostics } = createDetector({ threshold: 2 });

		fireError(detector, "tc-1", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-2", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(1);

		// After reset, the detector should fire again on the same pattern.
		detector.reset();
		fireError(detector, "tc-3", "bash", { cmd: "npm test" }, "EACCES");
		fireError(detector, "tc-4", "bash", { cmd: "npm test" }, "EACCES");
		expect(diagnostics).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// hashToolCall
// ---------------------------------------------------------------------------

describe("hashToolCall", () => {
	it("produces identical hashes regardless of key order", () => {
		const h1 = hashToolCall("bash", { a: 1, b: 2 });
		const h2 = hashToolCall("bash", { b: 2, a: 1 });
		expect(h1).toBe(h2);
	});

	it("produces different hashes for different args", () => {
		const h1 = hashToolCall("bash", { cmd: "npm test" });
		const h2 = hashToolCall("bash", { cmd: "npm test --fix" });
		expect(h1).not.toBe(h2);
	});

	it("produces different hashes for different tools", () => {
		const h1 = hashToolCall("bash", { cmd: "test" });
		const h2 = hashToolCall("lint", { cmd: "test" });
		expect(h1).not.toBe(h2);
	});

	it("handles null and undefined args", () => {
		expect(() => hashToolCall("bash", null)).not.toThrow();
		expect(() => hashToolCall("bash", undefined)).not.toThrow();
	});

	it("handles nested objects with sorted keys", () => {
		const h1 = hashToolCall("bash", { x: { a: 1, b: 2 }, y: 3 });
		const h2 = hashToolCall("bash", { y: 3, x: { b: 2, a: 1 } });
		expect(h1).toBe(h2);
	});

	it("handles circular references without throwing", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		const result = hashToolCall("bash", circular);
		expect(typeof result).toBe("string");
		expect(result).toContain("bash:");
		// Must NOT produce a generic "[object Object]" collision.
		expect(result).not.toContain("[object Object]");
	});
});

// ---------------------------------------------------------------------------
// normalizeErrorText
// ---------------------------------------------------------------------------

describe("normalizeErrorText", () => {
	it("normalizes /tmp/ paths", () => {
		const text = "Error in /tmp/abc123/file.ts at line 5";
		expect(normalizeErrorText(text)).toBe("Error in <PATH> at line 5");
	});

	it("normalizes PID patterns", () => {
		expect(normalizeErrorText("process pid 12345 crashed")).toBe("process pid <PID> crashed");
		expect(normalizeErrorText("PID=67890 failed")).toBe("PID=<PID> failed");
	});

	it("normalizes line:column references", () => {
		expect(normalizeErrorText("at src/foo.ts:123:45")).toBe("at src/foo.ts:<LINE>:<COL>");
	});

	it("preserves stable text unchanged", () => {
		const text = "EACCES: permission denied";
		expect(normalizeErrorText(text)).toBe("EACCES: permission denied");
	});

	it("normalizes multiple volatile fragments at once", () => {
		const text = "Error at /tmp/test/file.js:10:20 (pid 999)";
		expect(normalizeErrorText(text)).toBe("Error at <PATH>:<LINE>:<COL> (pid <PID>)");
	});
});
