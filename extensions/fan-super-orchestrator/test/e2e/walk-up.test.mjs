// test/e2e/walk-up.test.mjs
// F-H: TC-FH-3 — walk-up + orphan e2e с mock fan servers.
//
// Проверяет:
//   TC-FH-3a: walk-up доставляет отчёт при доступном parent (e2e через mock server)
//   TC-FH-3b: walk-up эскалирует к grandparent при крахе parent
//   TC-FH-3c: orphan-report записывается когда все hops fail
//
// Ожидаемый результат: PASS (walk-up.ts + report-delivery.ts уже реализованы)

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockFanServer } from "../helpers/mock-fan-server.mjs";

describe("walk-up + orphan e2e (TC-FH-3)", () => {
	it("TC-FH-3a: walk-up delivers when parent reachable (real mock server)", async () => {
		const parent = await createMockFanServer({ port: 0, behavior: "respond" });

		const { deliverReport } = await import("../../walk-up.js");

		// Реальный fetch против mock server — true e2e
		const result = await deliverReport({
			report: { correlationId: "child", payload: { result: "done" } },
			lineage: [
				{ correlationId: "parent", url: parent.url, token: "tok", role: "super-orchestrator", profile: "pm" },
				{ correlationId: "child", url: "http://127.0.0.1:1", token: "t", role: "orchestrator" },
			],
			parentReportId: "report-e2e-1",
			fetch: globalThis.fetch,
			hopTimeoutMs: 2000,
		});

		expect(result.delivered).toBe(true);
		expect(result.deliveredTo).toBe("parent");
		expect(result.attempts).toBe(1);

		await parent.stop();
	});

	it("TC-FH-3b: walk-up escalates when parent crashes (mock fetch)", async () => {
		const grandparent = await createMockFanServer({ port: 0, behavior: "respond" });

		// mock fetch: parent (so2) → reject, grandparent (so1) → ok
		const fetchSpy = vi
			.fn()
			.mockRejectedValueOnce(new Error("parent crashed"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const { deliverReport } = await import("../../walk-up.js");

		const result = await deliverReport({
			report: { correlationId: "orch", payload: {} },
			lineage: [
				{ correlationId: "grandparent", url: grandparent.url, token: "tok", role: "coordinator" },
				{ correlationId: "parent", url: "http://127.0.0.1:1", token: "tok", role: "super-orchestrator", profile: "pm" },
				{ correlationId: "orch", url: "http://127.0.0.1:2", token: "t", role: "orchestrator" },
			],
			parentReportId: "report-e2e-2",
			fetch: fetchSpy,
			hopTimeoutMs: 1000,
		});

		expect(result.delivered).toBe(true);
		expect(result.deliveredTo).toBe("grandparent");
		expect(result.attempts).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		await grandparent.stop();
	});

	it("TC-FH-3c: orphan-report written when all hops fail", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "walk-up-e2e-"));
		const orphanPath = join(testDir, "orphan-reports", "orphan-e2e-1.json");

		const fetchSpy = vi.fn().mockRejectedValue(new Error("all hops fail"));

		const { deliverReport } = await import("../../walk-up.js");

		const result = await deliverReport({
			report: { correlationId: "orch", payload: { data: "lost" } },
			lineage: [
				{ correlationId: "coord", url: "http://127.0.0.1:1", token: "t", role: "coordinator" },
				{ correlationId: "so1", url: "http://127.0.0.1:2", token: "t", role: "super-orchestrator" },
				{ correlationId: "orch", url: "http://127.0.0.1:3", token: "t", role: "orchestrator" },
			],
			parentReportId: "orphan-e2e-1",
			fetch: fetchSpy,
			hopTimeoutMs: 100,
			orphanPath,
		});

		expect(result.delivered).toBe(false);
		expect(result.orphanWritten).toBe(true);
		expect(result.attempts).toBe(2); // coord + so1 (orch is self, skipped)
		expect(existsSync(orphanPath)).toBe(true);

		// Verify orphan file content
		const content = JSON.parse(readFileSync(orphanPath, "utf8"));
		expect(content.reportId).toBe("orphan-e2e-1");
		expect(content.payload.correlationId).toBe("orch");
		expect(content.payload.payload).toEqual({ data: "lost" });

		rmSync(testDir, { recursive: true, force: true });
	});
});
