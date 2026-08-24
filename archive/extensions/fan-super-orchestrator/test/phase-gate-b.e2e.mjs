// PHASE-GATE B (этап 2, фаза «Протоколы и учёт»): интеграционный e2e.
//
// Standalone-скрипт (НЕ vitest; vitest включает только test/**/*.test.mjs):
//   node test/phase-gate-b.e2e.mjs
//
// Сценарий 1 — roundtrip (smoke фазы B):
//   tempdir → mission store + aggregator (100000 tok / 10 USD) → mock-узел
//   (порт 7011, Bearer token) → computeChildAllocation(1) → allocate →
//   tree-journal spawn → createWorkPackage → child-node-client sendWorkPackage
//   (реальный fetch + реальный ws) → NodeReport (completed/PASS/usage) →
//   recordUsage + onNodeComplete → tree-journal complete → проверки
//   инвариантов, файлов на диске, reconstructTree, освобождение порта.
//
// Сценарий 2 — бюджет на 3 узлов (без спавна процессов):
//   computeChildAllocation(3) → 26666 каждому → allocate ×3 (Σ = 79998) →
//   node-1 recordUsage 10000 + onNodeComplete → остаток возвращается в пул
//   (canAllocate растёт) → by_branch 3 записи, инвариант Σallocated ≤
//   budget_total после КАЖДОГО шага.
//
// Node не резолвит TS-импорты модулей (`./node-report.js` → .ts), поэтому
// скрипт сначала бандлит нужные модули esbuild'ом во временный каталог
// (подход как в phase-gate-a.e2e.mjs).

import { build } from "esbuild";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startMockNode } from "./helpers/mock-node-server.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(SCRIPT_DIR, "..");

const MOCK_PORT = 7011;
const BUDGET_TOKENS = 100_000;
const BUDGET_USD = 10;
const MOCK_USAGE = { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 };
const MOCK_USAGE_TOKENS = MOCK_USAGE.inputTokens + MOCK_USAGE.outputTokens; // 1500

// ─── хелперы вывода ─────────────────────────────────────────────────────────

const results = [];

function record(step, ok, detail) {
	results.push({ step, ok, detail });
	console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
	return ok;
}

async function getStatus(url, headers) {
	try {
		const res = await fetch(url, { headers });
		await res.arrayBuffer(); // дочитать тело, чтобы соединение закрылось
		return res.status;
	} catch {
		return 0; // сеть недоступна/отказ — не HTTP-статус
	}
}

/** Инвариант фазы B: Σallocated ≤ budget_total по обоим измерениям. */
function invariantHolds(state) {
	return (
		state.allocated.tokens <= state.budgetTotal.tokens && state.allocated.usd <= state.budgetTotal.usd + 1e-9
	);
}

/** WsLike-фабрика поверх реального ws-клиента (пакет `ws`). */
function wsFactory(url) {
	const socket = new WebSocket(url);
	const adapter = {
		close: () => socket.close(),
		send: (data) => socket.send(data),
	};
	socket.on("open", () => adapter.onopen?.());
	socket.on("message", (data) => adapter.onmessage?.({ data: data.toString() }));
	socket.on("close", () => adapter.onclose?.());
	socket.on("error", (err) => adapter.onerror?.(err));
	return adapter;
}

// ─── основной сценарий ──────────────────────────────────────────────────────

async function main() {
	console.log("PHASE-GATE B e2e: протоколы и учёт (super-orchestrator, этап 2)");

	// Временный каталог: mission-budget.json + tree-journal.jsonl + esbuild-бандлы
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-gate-b-"));
	const budgetFile = join(tmp, "mission-budget.json");
	const journalFile = join(tmp, "tree-journal.jsonl");
	console.log(`tmp dir   : ${tmp}\n`);

	const buildDir = join(tmp, "build");
	await build({
		entryPoints: [
			join(EXT_DIR, "node-auth.ts"),
			join(EXT_DIR, "work-package.ts"),
			join(EXT_DIR, "node-report.ts"),
			join(EXT_DIR, "child-node-client.ts"),
			join(EXT_DIR, "budget-aggregator.ts"),
			join(EXT_DIR, "budget-coordinator.ts"),
			join(EXT_DIR, "tree-journal.ts"),
			join(EXT_DIR, "depth-width-guard.ts"),
		],
		outdir: buildDir,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
	});
	writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n', "utf8");
	const load = (name) => import(pathToFileURL(join(buildDir, `${name}.js`)));
	const { generateNodeToken } = await load("node-auth");
	const { createWorkPackage, makeCorrelationId } = await load("work-package");
	const { createChildNodeClient } = await load("child-node-client");
	const { createBudgetAggregator, emptyBudgetState } = await load("budget-aggregator");
	const { createMissionBudgetStore, computeChildAllocation, readMissionBudgetFile } =
		await load("budget-coordinator");
	const { createTreeJournal, reconstructTree } = await load("tree-journal");

	/** @type {Array<{ stop: () => Promise<void> }>} */
	const mockNodes = [];
	let client = null;
	try {
		// ═══ Сценарий 1: roundtrip ═══════════════════════════════════════════
		console.log("── Сценарий 1: roundtrip (smoke фазы B) ──");

		// 2. coordinator store + aggregator: 100000 токенов / 10 USD
		const store = createMissionBudgetStore(budgetFile, "mission-b", emptyBudgetState(BUDGET_TOKENS, BUDGET_USD));
		const aggregator = createBudgetAggregator(store);

		// 3. token + mock-узел на порту 7011
		const token = generateNodeToken();
		const mock = await startMockNode({ port: MOCK_PORT, token, usage: MOCK_USAGE, delayMs: 150 });
		mockNodes.push(mock);
		record("mock-узел стартовал", true, mock.url);

		// auth-проверки mock-узла (как в gate A, но против мока)
		record("mock: GET /api/health без токена → 200", (await getStatus(`${mock.url}/api/health`)) === 200);
		record("mock: GET /api/sessions без токена → 401", (await getStatus(`${mock.url}/api/sessions`)) === 401);
		record(
			"mock: GET /api/sessions с Bearer → 200",
			(await getStatus(`${mock.url}/api/sessions`, { Authorization: `Bearer ${token}` })) === 200,
		);

		// 4. L0 выделяет бюджет 1 ребёнку
		const allocation = computeChildAllocation(aggregator.state(), 1);
		record(
			"computeChildAllocation(planned=1) → ceiling 30000 tok / 8 USD",
			allocation.tokens === 30_000 && allocation.usd === 8,
			JSON.stringify(allocation),
		);
		const allocOk = aggregator.allocate("L1/node-1", allocation);
		record("allocate(L1/node-1) → true", allocOk);
		record(
			"инвариант после allocate: Σallocated ≤ budget_total",
			invariantHolds(aggregator.state()),
			JSON.stringify(aggregator.state().allocated),
		);

		// 5. tree-journal: spawn L1/node-1
		const journal = createTreeJournal(journalFile);
		const correlationId = makeCorrelationId("mission-b", 1, 1);
		journal.write({
			event: "spawn",
			nodeId: "L1/node-1",
			correlationId,
			task: "e2e roundtrip",
			depth: 1,
			port: MOCK_PORT,
		});

		// 6. workPackage + sendWorkPackage (реальный fetch + ws к mock-узлу)
		const workPackage = createWorkPackage({
			task: "e2e roundtrip: протоколы и учёт",
			correlationId,
			depth: 1,
			tokenBudget: allocation.tokens,
			costBudgetUsd: allocation.usd,
			deadline: new Date(Date.now() + 30_000).toISOString(),
			toolManifest: ["read", "write"],
		});
		client = createChildNodeClient({ wsFactory });
		const report = await client.sendWorkPackage({ port: MOCK_PORT, token, workPackage });

		// mock реально получил пакет (SendMessageRequest-форма)
		const received = mock.receivedWorkPackage();
		let receivedWp = null;
		try {
			receivedWp = JSON.parse(received?.message ?? "{}").work_package;
		} catch {
			/* невалидный JSON — assert ниже упадёт */
		}
		record(
			"mock получил work_package (correlationId, followUp)",
			receivedWp?.correlationId === correlationId && received?.streamingBehavior === "followUp",
			receivedWp?.correlationId,
		);

		// 7. NodeReport из клиента
		record(
			"report: status completed + verdict PASS",
			report.status === "completed" && report.verdict === "PASS",
			`status=${report.status} verdict=${report.verdict}`,
		);
		record(
			"report: usage из mock-узла",
			report.usage.inputTokens === MOCK_USAGE.inputTokens &&
				report.usage.outputTokens === MOCK_USAGE.outputTokens &&
				report.usage.costUsd === MOCK_USAGE.costUsd,
			JSON.stringify(report.usage),
		);
		record(
			"report: nodeId/correlationId",
			report.nodeId === "L1/node-1" && report.correlationId === correlationId,
			`${report.nodeId} / ${report.correlationId}`,
		);

		// 8. Учёт: recordUsage + onNodeComplete + journal complete
		aggregator.recordUsage("L1/node-1", report.usage);
		aggregator.onNodeComplete("L1/node-1", allocation);
		journal.write({
			event: "complete",
			nodeId: "L1/node-1",
			correlationId,
			usage: { tokens: MOCK_USAGE_TOKENS, usd: MOCK_USAGE.costUsd },
		});

		// 9. Asserts
		const state1 = aggregator.state();
		record(
			"Σallocated ≤ budget_total после complete (allocated=0)",
			state1.allocated.tokens === 0 && state1.allocated.usd === 0 && invariantHolds(state1),
			JSON.stringify(state1.allocated),
		);
		record(
			"consumed = usage из mock (1500 tok / 0.05 USD)",
			state1.consumed.tokens === MOCK_USAGE_TOKENS && state1.consumed.usd === MOCK_USAGE.costUsd,
			JSON.stringify(state1.consumed),
		);
		const branch1 = state1.byBranch["L1/node-1"];
		record(
			'by_branch["L1/node-1"] = usage',
			branch1?.tokens === MOCK_USAGE_TOKENS && branch1?.usd === MOCK_USAGE.costUsd,
			JSON.stringify(branch1),
		);

		const onDisk = readMissionBudgetFile(budgetFile);
		const diskMission = onDisk?.missions["mission-b"];
		record(
			"mission-budget.json на диске содержит миссию",
			diskMission?.consumed?.tokens === MOCK_USAGE_TOKENS && existsSync(budgetFile),
			existsSync(budgetFile) ? `consumed.tokens=${diskMission?.consumed?.tokens}` : "файл отсутствует",
		);

		const entries = journal.readAll();
		record(
			"tree-journal ≥2 записи (spawn+complete)",
			entries.length >= 2 && entries[0].event === "spawn" && entries.some((e) => e.event === "complete"),
			`${entries.length} записей`,
		);
		const tree = reconstructTree(entries);
		const treeNode = tree.nodes["L1/node-1"];
		record(
			"reconstructTree: L1/node-1 status=complete, usage, в roots",
			treeNode?.status === "complete" &&
				treeNode?.usage?.tokens === MOCK_USAGE_TOKENS &&
				tree.roots.includes("L1/node-1"),
			`status=${treeNode?.status} roots=[${tree.roots}]`,
		);

		// stop → порт освобождён
		await mock.stop();
		mockNodes.splice(mockNodes.indexOf(mock), 1);
		record("порт освобождён после stop", (await getStatus(`${mock.url}/api/health`)) === 0);

		// ═══ Сценарий 2: бюджет на 3 узлов ═══════════════════════════════════
		console.log("\n── Сценарий 2: бюджет на 3 узлов ──");

		// 1. Свежая миссия в том же файле: budget_total 100000
		const store3 = createMissionBudgetStore(budgetFile, "mission-b-3nodes", emptyBudgetState(BUDGET_TOKENS, BUDGET_USD));
		const agg3 = createBudgetAggregator(store3);

		// 2. computeChildAllocation(3) → 26666 каждому; allocate ×3
		const alloc3 = computeChildAllocation(agg3.state(), 3);
		record(
			"computeChildAllocation(planned=3) → 26666 tok",
			alloc3.tokens === 26_666,
			JSON.stringify(alloc3),
		);
		const invariantSteps = [];
		const nodeIds = ["L1/node-1", "L1/node-2", "L1/node-3"];
		let allAllocated = true;
		for (const nodeId of nodeIds) {
			allAllocated = agg3.allocate(nodeId, alloc3) && allAllocated;
			invariantSteps.push(invariantHolds(agg3.state()));
		}
		const sum3 = agg3.state().allocated.tokens;
		record(
			"allocate ×3 → Σallocated = 79998 ≤ 100000",
			allAllocated && sum3 === 79_998 && invariantHolds(agg3.state()),
			`Σallocated=${sum3}`,
		);

		// До complete: пул почти исчерпан — 20003 сверх остатка (20002) не проходит
		const blockedBefore = !agg3.canAllocate({ tokens: 20_003, usd: 0 });

		// 3. node-1: recordUsage 10000 → onNodeComplete → allocated падает, пул растёт
		agg3.recordUsage("L1/node-1", { inputTokens: 10_000 });
		invariantSteps.push(invariantHolds(agg3.state()));
		agg3.onNodeComplete("L1/node-1", alloc3);
		invariantSteps.push(invariantHolds(agg3.state()));
		const afterComplete = agg3.state().allocated.tokens;
		record(
			"onNodeComplete(node-1): allocated 79998 → 53332",
			afterComplete === 53_332,
			`allocated=${afterComplete}`,
		);
		record(
			"canAllocate растёт после возврата (остаток в пуле)",
			blockedBefore && agg3.canAllocate({ tokens: 20_003, usd: 0 }),
			`до: 20003 заблокировано=${blockedBefore}; после: разрешено=${agg3.canAllocate({ tokens: 20_003, usd: 0 })}`,
		);

		// usage для node-2/node-3 → by_branch 3 записи
		agg3.recordUsage("L1/node-2", { inputTokens: 4_000, outputTokens: 1_000, costUsd: 0.1 });
		invariantSteps.push(invariantHolds(agg3.state()));
		agg3.recordUsage("L1/node-3", {});
		invariantSteps.push(invariantHolds(agg3.state()));

		// 4. Asserts
		const state3 = agg3.state();
		record(
			"by_branch: 3 записи (node-1..3)",
			Object.keys(state3.byBranch).length === 3 &&
				state3.byBranch["L1/node-1"].tokens === 10_000 &&
				state3.byBranch["L1/node-2"].tokens === 5_000 &&
				state3.byBranch["L1/node-3"].tokens === 0,
			JSON.stringify(state3.byBranch),
		);
		record(
			"инвариант Σallocated ≤ budget_total на КАЖДОМ шаге",
			invariantSteps.every(Boolean),
			`${invariantSteps.filter(Boolean).length}/${invariantSteps.length} шагов`,
		);
		record(
			"consumed Σ = 15000 tok / 0.1 USD (3 узла)",
			state3.consumed.tokens === 15_000 && Math.abs(state3.consumed.usd - 0.1) < 1e-9,
			JSON.stringify(state3.consumed),
		);
		const diskBoth = readMissionBudgetFile(budgetFile);
		record(
			"mission-budget.json: обе миссии сосуществуют",
			diskBoth?.missions["mission-b"] !== undefined && diskBoth?.missions["mission-b-3nodes"] !== undefined,
			Object.keys(diskBoth?.missions ?? {}).join(", "),
		);
	} finally {
		try {
			client?.close();
		} catch {
			/* ignore */
		}
		for (const node of mockNodes.splice(0)) {
			try {
				await node.stop();
			} catch {
				/* ignore */
			}
		}
		rmSync(tmp, { recursive: true, force: true });
	}

	// Итоговая таблица
	console.log("\n┌──────────────────────────────────────────────────────────────┬────────┐");
	for (const r of results) {
		console.log(`│ ${r.step.padEnd(60)} │ ${r.ok ? "PASS  " : "FAIL  "} │`);
	}
	console.log("└──────────────────────────────────────────────────────────────┴────────┘");

	const failed = results.filter((r) => !r.ok).length;
	console.log(`\nИТОГ: ${results.length - failed}/${results.length} зелёные${failed ? ` — ${failed} провал(а)` : ""}`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("\nFATAL:", err);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`ИТОГ: ${results.length - failed}/${results.length} зелёные (аварийное завершение)`);
	process.exit(1);
});
