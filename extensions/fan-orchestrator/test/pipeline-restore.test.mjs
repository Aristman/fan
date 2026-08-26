/**
 * Zombie pipeline auto-restore fix — shouldRestorePipeline + markTerminal.
 */
import { describe, expect, it } from "vitest";
import { shouldRestorePipeline, PipelineState } from "../pipeline-state.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// shouldRestorePipeline — pure function tests
// ---------------------------------------------------------------------------

describe("shouldRestorePipeline", () => {
	it("returns false for null/undefined (no status on disk)", () => {
		expect(shouldRestorePipeline(null)).toBe(false);
		expect(shouldRestorePipeline(undefined)).toBe(false);
	});

	it("restores when globalMetrics.pipelineStatus is missing (old format / in-progress)", () => {
		expect(shouldRestorePipeline({ featureName: "Foo" })).toBe(true);
		expect(shouldRestorePipeline({ featureName: "Foo", globalMetrics: {} })).toBe(true);
		expect(shouldRestorePipeline({ featureName: "Foo", globalMetrics: { pipelineStatus: null } })).toBe(true);
		expect(shouldRestorePipeline({ featureName: "Foo", globalMetrics: { pipelineStatus: undefined } })).toBe(true);
	});

	it("skips restore when pipelineStatus is COMPLETED", () => {
		expect(shouldRestorePipeline({
			featureName: "Foo",
			globalMetrics: { pipelineStatus: "COMPLETED", pipelineCompletedAt: "2026-08-26T10:00:00Z" },
		})).toBe(false);
	});

	it("skips restore when pipelineStatus is FINISHED", () => {
		expect(shouldRestorePipeline({
			featureName: "Foo",
			globalMetrics: { pipelineStatus: "FINISHED" },
		})).toBe(false);
	});

	it("skips restore when pipelineStatus is CANCELLED", () => {
		expect(shouldRestorePipeline({
			featureName: "Foo",
			globalMetrics: { pipelineStatus: "CANCELLED" },
		})).toBe(false);
	});

	it("restores when pipelineStatus is an unknown/active value", () => {
		expect(shouldRestorePipeline({
			featureName: "Foo",
			globalMetrics: { pipelineStatus: "IN_PROGRESS" },
		})).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// markTerminal — integration with PipelineState (uses temp dir)
// ---------------------------------------------------------------------------

describe("PipelineState.markTerminal", () => {
	/** @type {string} */
	let tmpDir;

	it("writes globalMetrics.pipelineStatus = FINISHED to phase-status.json", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fan-pipeline-test-"));
		const ps = new PipelineState(tmpDir, {
			featureName: "Test Feature",
			slug: "test-feature",
			phases: [
				{ id: 1, name: "Phase 1", goal: "goal", features: [], criteria: [] },
				{ id: 2, name: "Phase 2", goal: "goal", features: [], criteria: [] },
			],
		});
		await ps.init();

		await ps.markTerminal("FINISHED");

		const raw = await fs.readFile(path.join(tmpDir, ".fan", "tracking", "phase-status.json"), "utf-8");
		const data = JSON.parse(raw);

		expect(data.globalMetrics).toBeDefined();
		expect(data.globalMetrics.pipelineStatus).toBe("FINISHED");
		expect(data.globalMetrics.pipelineCompletedAt).toBeTruthy();

		// shouldRestorePipeline must now return false
		expect(shouldRestorePipeline(data)).toBe(false);

		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes globalMetrics.pipelineStatus = CANCELLED and restore skips it", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fan-pipeline-test-"));
		const ps = new PipelineState(tmpDir, {
			featureName: "Cancel Test",
			slug: "cancel-test",
			phases: [
				{ id: 1, name: "P1", goal: "g", features: [], criteria: [] },
			],
		});
		await ps.init();

		await ps.markTerminal("CANCELLED");

		const raw = await fs.readFile(path.join(tmpDir, ".fan", "tracking", "phase-status.json"), "utf-8");
		const data = JSON.parse(raw);

		expect(data.globalMetrics.pipelineStatus).toBe("CANCELLED");
		expect(shouldRestorePipeline(data)).toBe(false);

		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("newly initialised pipeline has globalMetrics with null pipelineStatus (restorable)", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fan-pipeline-test-"));
		const ps = new PipelineState(tmpDir, {
			featureName: "Fresh Pipeline",
			slug: "fresh",
			phases: [
				{ id: 1, name: "P1", goal: "g", features: [], criteria: [] },
			],
		});
		await ps.init();

		const raw = await fs.readFile(path.join(tmpDir, ".fan", "tracking", "phase-status.json"), "utf-8");
		const data = JSON.parse(raw);

		expect(data.globalMetrics).toBeDefined();
		expect(data.globalMetrics.pipelineStatus).toBeNull();
		expect(shouldRestorePipeline(data)).toBe(true);

		await fs.rm(tmpDir, { recursive: true, force: true });
	});
});
