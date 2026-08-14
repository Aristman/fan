// F-35 / TC-F35-2: полнота tree-journal после выполнения дерева (3 mock-узла).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.5
//
// Те же 3 mock-узла (реальные HTTP/WS через child-node-client), что в
// TC-F35-1, но фокус — журнал: tree-journal.jsonl содержит ≥6 записей
// (3 spawn + 3 complete), correlationId сквозной (один missionId),
// reconstructTree восстанавливает топологию (3 ребёнка у L0).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildNodeClient } from "../child-node-client.js";
import { totalUsage } from "../node-report.js";
import { createTreeJournal, reconstructTree } from "../tree-journal.js";
import { createWorkPackage, makeCorrelationId } from "../work-package.js";
import { portRange, startMockOnFreePort, wsFactory } from "./helpers/hierarchy-helpers.mjs";

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-f35-journal-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Mock-узел + регистрация stop() в cleanup. */
async function trackMock(opts, candidates) {
	const mock = await startMockOnFreePort(opts, candidates);
	cleanups.push(() => mock.stop());
	return mock;
}

const TOKEN = "f35-journal-token";
const MISSION = "mission-f35-journal";

// ─── TC-F35-2 ───────────────────────────────────────────────────────────────

describe("TC-F35-2: tree-journal полон после выполнения дерева (3 узла)", () => {
	it(
		"≥6 записей (3 spawn + 3 complete), correlationId сквозной, reconstructTree → 3 ребёнка L0",
		async () => {
			const tmp = makeTmpDir();
			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));

			const specs = [
				{ nodeId: "L1/node-1", usage: { inputTokens: 20_000, outputTokens: 10_000, costUsd: 3 } },
				{ nodeId: "L1/node-2", usage: { inputTokens: 15_000, outputTokens: 10_000, costUsd: 2.5 } },
				{ nodeId: "L1/node-3", usage: { inputTokens: 15_000, outputTokens: 5_000, costUsd: 2 } },
			];
			const candidates = portRange(7024, 7030);
			const mocks = [];
			for (const spec of specs) {
				mocks.push(await trackMock({ token: TOKEN, usage: spec.usage, delayMs: 80 }, candidates));
			}

			const client = createChildNodeClient({ wsFactory });
			cleanups.push(() => client.close());
			const deadline = new Date(Date.now() + 30_000).toISOString();

			// Полный цикл: spawn-запись → пакет → отчёт → complete-запись.
			await Promise.all(
				specs.map(async (spec, index) => {
					const correlationId = makeCorrelationId(MISSION, 1, index + 1);
					journal.write({
						event: "spawn",
						nodeId: spec.nodeId,
						parentId: "L0",
						correlationId,
						task: `TC-F35-2: часть ${index + 1}`,
						depth: 1,
						port: mocks[index].port,
					});
					const workPackage = createWorkPackage({
						task: `TC-F35-2: часть ${index + 1}`,
						correlationId,
						depth: 1,
						tokenBudget: 26_666,
						deadline,
					});
					const report = await client.sendWorkPackage({
						port: mocks[index].port,
						token: TOKEN,
						workPackage,
					});
					expect(report.status).toBe("completed");
					const usage = totalUsage(report);
					journal.write({
						event: "complete",
						nodeId: spec.nodeId,
						parentId: "L0",
						correlationId,
						depth: 1,
						usage: { tokens: usage.inputTokens + usage.outputTokens, usd: usage.costUsd },
					});
				}),
			);

			// ── Полнота: ≥6 записей, ровно 3 spawn + 3 complete ──
			const entries = journal.readAll();
			expect(entries.length).toBeGreaterThanOrEqual(6);
			const spawns = entries.filter((e) => e.event === "spawn");
			const completes = entries.filter((e) => e.event === "complete");
			expect(spawns).toHaveLength(3);
			expect(completes).toHaveLength(3);

			// correlationId сквозной: один missionId во всех записях.
			for (const entry of entries) {
				expect(entry.correlationId).toMatch(new RegExp(`^${MISSION}/L1/node-\\d+$`));
			}
			expect(new Set(entries.map((e) => e.correlationId.split("/")[0])).size).toBe(1);

			// У каждого узла spawn раньше complete; complete несёт usage.
			for (const spec of specs) {
				const nodeEntries = entries.filter((e) => e.nodeId === spec.nodeId);
				expect(nodeEntries.map((e) => e.event)).toEqual(["spawn", "complete"]);
				const expectedTokens = spec.usage.inputTokens + spec.usage.outputTokens;
				expect(nodeEntries[1].usage).toEqual({ tokens: expectedTokens, usd: spec.usage.costUsd });
				expect(nodeEntries[0].parentId).toBe("L0");
			}

			// ── reconstructTree: топология — 3 ребёнка у L0 ──
			const tree = reconstructTree(entries);
			expect(tree.roots).toEqual(["L0"]);
			expect(tree.nodes.L0.children).toEqual(["L1/node-1", "L1/node-2", "L1/node-3"]);
			for (const [index, spec] of specs.entries()) {
				const node = tree.nodes[spec.nodeId];
				expect(node.parentId).toBe("L0");
				expect(node.status).toBe("complete");
				expect(node.correlationId).toBe(makeCorrelationId(MISSION, 1, index + 1));
				const expectedTokens = spec.usage.inputTokens + spec.usage.outputTokens;
				expect(node.usage).toEqual({ tokens: expectedTokens, usd: spec.usage.costUsd });
			}
		},
		30_000,
	);
});
