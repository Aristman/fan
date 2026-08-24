// F-E: Lineage escalation (walk-up + orphan-reports + recovery) — RED phase tests.
//
// Spec: docs/features/super-orchestrator-v2/architecture.md §6
// Roadmap: docs/features/super-orchestrator-v2/roadmap.md §F-E
//
// Coverage (TC-cards):
//   TC-FE-1  Walk-up protocol (deliverReport)
//     1a  first-hop success (parent reachable)
//     1b  escalation to grandparent on parent timeout
//     1c  exhausted → orphan_report written
//   TC-FE-2  Orphan-report atomic write + _index.json
//     2a  writeOrphanReport atomic via tmp+rename
//     2b  _index.json synchronized with orphan-reports/
//     2c  existing _index.json entries preserved on new write
//   TC-FE-3  Recovery + idempotency
//     3a  recoverOrphanReports delivers pending reports
//     3b  idempotency cache prevents double-processing
//     3c  empty missionDir returns 0
//
// Expected: all 9 tests FAIL (modules not yet implemented).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir, testDirEmpty;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "lineage-escalation-"));
	testDirEmpty = mkdtempSync(join(tmpdir(), "lineage-empty-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	rmSync(testDirEmpty, { recursive: true, force: true });
});

// ─── TC-FE-1: Walk-up protocol ───────────────────────────────────────────────

describe("TC-FE-1: Walk-up protocol", () => {
	const lineage = [
		{ correlationId: "coord", url: "http://localhost:7000", token: "t0", role: "coordinator" },
		{ correlationId: "so1", url: "http://localhost:7001", token: "t1", role: "super-orchestrator", profile: "pm" },
		{ correlationId: "so2", url: "http://localhost:7002", token: "t2", role: "super-orchestrator", profile: "architect" },
		{ correlationId: "orch", url: "http://localhost:7003", token: "t3", role: "orchestrator", profile: "backend" },
	];

	it("TC-FE-1a: walk-up succeeds on first hop (parent reachable)", async () => {
		const { deliverReport } = await import("../walk-up.js");
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const result = await deliverReport({
			report: { correlationId: "orch", payload: { result: "ok" } },
			lineage,
			parentReportId: "report-123",
			fetch: mockFetch,
			hopTimeoutMs: 100,
		});
		expect(result.delivered).toBe(true);
		expect(result.deliveredTo).toBe("so2");
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("TC-FE-1b: walk-up escalates to grandparent if parent times out", async () => {
		const { deliverReport } = await import("../walk-up.js");
		// parent (so2) timeout, grandparent (so1) success
		const mockFetch = vi
			.fn()
			.mockRejectedValueOnce(new Error("timeout")) // so2 timeout
			.mockResolvedValueOnce({ ok: true, status: 200 }); // so1 success

		const result = await deliverReport({
			report: { correlationId: "orch", payload: {} },
			lineage,
			parentReportId: "report-456",
			fetch: mockFetch,
			hopTimeoutMs: 50,
		});
		expect(result.delivered).toBe(true);
		expect(result.deliveredTo).toBe("so1");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("TC-FE-1c: walk-up exhausted → orphan_report written", async () => {
		const { deliverReport } = await import("../walk-up.js");
		// All ancestors fail
		const mockFetch = vi.fn().mockRejectedValue(new Error("timeout"));
		const orphanPath = join(testDir, "orphan-789.json");
		const result = await deliverReport({
			report: { correlationId: "orch", payload: {} },
			lineage,
			parentReportId: "report-789",
			fetch: mockFetch,
			hopTimeoutMs: 50,
			orphanPath,
		});
		expect(result.delivered).toBe(false);
		expect(result.orphanWritten).toBe(true);
		expect(existsSync(orphanPath)).toBe(true);
	});
});

// ─── TC-FE-2: Orphan-report atomic write + _index.json ───────────────────────

describe("TC-FE-2: Orphan-report atomic write + _index.json", () => {
	it("TC-FE-2a: writeOrphanReport atomic via tmp+rename", async () => {
		const { writeOrphanReport } = await import("../orphan-storage.js");
		const tmpBefore = readdirSync(testDir).filter((f) => f.endsWith(".tmp"));
		writeOrphanReport({
			reportId: "report-aaa",
			missionDir: testDir,
			payload: { correlationId: "orch", payload: { result: "ok" } },
		});
		const tmpAfter = readdirSync(testDir).filter((f) => f.endsWith(".tmp"));
		expect(tmpAfter.length).toBe(0); // tmp file renamed to final

		const orphanPath = join(testDir, "orphan-reports", "report-aaa.json");
		expect(existsSync(orphanPath)).toBe(true);

		const content = JSON.parse(readFileSync(orphanPath, "utf8"));
		expect(content.reportId).toBe("report-aaa");
		expect(content.payload.correlationId).toBe("orch");
	});

	it("TC-FE-2b: _index.json synchronized with orphan-reports/", async () => {
		const { writeOrphanReport, readOrphanReportsIndex } = await import("../orphan-storage.js");
		writeOrphanReport({ reportId: "report-bbb", missionDir: testDir, payload: {} });
		writeOrphanReport({ reportId: "report-ccc", missionDir: testDir, payload: {} });

		const index = readOrphanReportsIndex(testDir);
		expect(index).toContain("report-bbb");
		expect(index).toContain("report-ccc");
	});

	it("TC-FE-2c: existing _index.json entries preserved on new write", async () => {
		const { writeOrphanReport, readOrphanReportsIndex } = await import("../orphan-storage.js");
		writeOrphanReport({ reportId: "report-old", missionDir: testDir, payload: {} });
		writeOrphanReport({ reportId: "report-new", missionDir: testDir, payload: {} });

		const index = readOrphanReportsIndex(testDir);
		expect(index).toContain("report-old"); // preserved
		expect(index).toContain("report-new"); // added
	});
});

// ─── TC-FE-3: Recovery + idempotency ─────────────────────────────────────────

describe("TC-FE-3: Recovery + idempotency", () => {
	it("TC-FE-3a: recoverOrphanReports delivers pending reports", async () => {
		const { writeOrphanReport } = await import("../orphan-storage.js");
		const { recoverOrphanReports } = await import("../orphan-recovery.js");

		writeOrphanReport({
			reportId: "report-recover-1",
			missionDir: testDir,
			payload: { correlationId: "orch", payload: {} },
		});

		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const result = await recoverOrphanReports({
			missionDir: testDir,
			deliveryTarget: {
				correlationId: "coordinator",
				url: "http://localhost:7000",
				token: "t0",
				role: "coordinator",
			},
			fetch: mockFetch,
		});

		expect(result.delivered).toBe(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		// orphan file removed after successful delivery
		expect(existsSync(join(testDir, "orphan-reports", "report-recover-1.json"))).toBe(false);
	});

	it("TC-FE-3b: idempotency cache prevents double-processing", async () => {
		const { writeOrphanReport } = await import("../orphan-storage.js");
		const { recoverOrphanReports } = await import("../orphan-recovery.js");

		// Two reports with same parent_report_id
		writeOrphanReport({
			reportId: "dup-1",
			missionDir: testDir,
			payload: { parentReportId: "same-id" },
		});
		writeOrphanReport({
			reportId: "dup-2",
			missionDir: testDir,
			payload: { parentReportId: "same-id" },
		});

		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const result = await recoverOrphanReports({
			missionDir: testDir,
			deliveryTarget: {
				correlationId: "coord",
				url: "http://localhost:7000",
				token: "t0",
				role: "coordinator",
			},
			fetch: mockFetch,
			idempotencyCache: new Set(["same-id"]), // pre-populate
		});

		expect(result.skipped).toBe(1); // dup-2 skipped due to idempotency
		expect(result.delivered).toBe(0);
	});

	it("TC-FE-3c: orphan recovery on empty missionDir returns 0", async () => {
		const { recoverOrphanReports } = await import("../orphan-recovery.js");

		const result = await recoverOrphanReports({
			missionDir: testDirEmpty,
			deliveryTarget: {
				correlationId: "coord",
				url: "http://localhost:7000",
				token: "t0",
				role: "coordinator",
			},
			fetch: vi.fn(),
		});
		expect(result.delivered).toBe(0);
		expect(result.skipped).toBe(0);
	});
});
