// F-4: Role-aware launchChild в depth2-integration — RED-фаза TDD.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §Этап 4, F-4
// Спека: docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-5
//
// Тесты проверяют role-aware routing в launchChild (depth2-integration):
//   • Worker role → process-manager.spawn (existing path), journal via: "spawn"
//   • SO role → HTTP POST /api/mission-delegate (no process spawn), journal via: "http_delegate"
//   • SO role без role_profile → REFUSED (mandatory field)
//
// RED-фаза: все 3 теста должны FAIL, т.к. текущий код:
//   • Depth2RunOptions не имеет полей role/roleProfile/packages
//   • launchChild не проверяет role — всегда вызывает spawnNode (existing path)
//   • launchChild не валидирует role_profile для SO
//   • journal spawn entry не содержит поля via (TreeJournalEntry не поддерживает via)
//
// Ожидаемые причины FAIL:
//   TC-F4-1: spawnNode вызывается (OK), но journal spawn entry НЕ содержит via: "spawn"
//            (TreeJournal.write() не копирует поле via — его нет в интерфейсе)
//   TC-F4-2: fetch НЕ вызван (launchChild не знает про role → идёт в spawn),
//            spawnNode вызван (должен НЕ вызываться для SO)
//   TC-F4-3: run() НЕ бросает (нет валидации role_profile) — spawnNode вызван

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { readMissionBudgetFile } from "../budget-coordinator.js";
import { createTreeJournal } from "../tree-journal.js";

let createDepth2Integration;

beforeAll(async () => {
	const mod = await import("../depth2-integration.js");
	createDepth2Integration = mod.createDepth2Integration;
});

// ─── Хелперы (pattern-matching из depth2-integration.test.mjs) ─────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
	// Восстанавливаем globalThis.fetch после каждого теста.
	vi.restoreAllMocks();
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-f4-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

const DEADLINE = "2026-12-31T23:59:59.000Z";

/** Стенд миссии. */
function makeMission() {
	const missionDir = makeTmpDir();
	return {
		missionDir,
		missionId: "mission-f4",
		budgetTotal: { tokens: 100_000, usd: 10 },
		portsFile: join(missionDir, "child-ports.json"),
		pidDir: join(missionDir, "pids"),
		journalFile: join(missionDir, "tree-journal.jsonl"),
		budgetFile: join(missionDir, "mission-budget.json"),
	};
}

/** Мок spawnNode: «процесс» с pid, производным от порта. */
function makeSpawnMock() {
	return vi.fn(async ({ port }) => ({ pid: 10_000 + port }));
}

/** NodeReport конструктор. */
function makeReport(nodeId, correlationId, { verdict = "PASS", status = "completed", usage = {} } = {}) {
	return {
		nodeId,
		correlationId,
		status,
		verdict,
		result: { text: `Готово.\nVERDICT: ${verdict ?? "PASS"}` },
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ...usage },
	};
}

/** Мок sendPackage: мгновенный PASS-отчёт. */
function makeSendMock() {
	return vi.fn(async ({ port, workPackage }) => {
		const nodeId = workPackage.correlationId.split("/").slice(1).join("/");
		return makeReport(nodeId, workPackage.correlationId, {
			usage: { inputTokens: 1_000, outputTokens: 500, costUsd: 0.1 },
		});
	});
}

/** Handle интеграции с DI-моками. */
function makeHandle(mission, { spawnNode, sendPackage, killNode, ...extra } = {}) {
	return createDepth2Integration({
		missionDir: mission.missionDir,
		missionId: mission.missionId,
		budgetTotal: mission.budgetTotal,
		portsFile: mission.portsFile,
		pidDir: mission.pidDir,
		spawnNode: spawnNode ?? makeSpawnMock(),
		sendPackage: sendPackage ?? makeSendMock(),
		killNode: killNode ?? vi.fn(async () => {}),
		...extra,
	});
}

/** Записи tree-journal миссии. */
function readJournal(mission) {
	return createTreeJournal(mission.journalFile).readAll();
}

/** Мок fetch для HTTP delegation (POST /api/mission-delegate). */
function makeDelegateFetchMock(responseBody = { status: "queued", parentReportId: "rep-1" }) {
	return vi.fn(async (_url, _opts) => ({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => responseBody,
	}));
}

// ─── TC-F4-1: Worker role → process-manager.spawn (existing path) ───────────

describe("TC-F4-1: Worker role launchChild → process-manager.spawn (existing path)", () => {
	it("spawnNode вызван 1 раз; fetch НЕ вызван; journal spawn entry содержит via: 'spawn'", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const fetchMock = makeDelegateFetchMock();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const handle = makeHandle(mission, { spawnNode, sendPackage });

		// role: "worker" — явное указание worker role (default behavior).
		// Текущий код проигнорирует поле role (нет в Depth2RunOptions).
		await handle.run({
			task: "Эпик",
			children: 1,
			deadline: DEADLINE,
			role: "worker",
		});

		// spawnNode вызван 1 раз (existing path для worker).
		expect(spawnNode).toHaveBeenCalledTimes(1);
		expect(spawnNode.mock.calls[0][0].port).toBe(7001);

		// fetch НЕ вызван (worker = process spawn, no HTTP delegation).
		expect(fetchMock).not.toHaveBeenCalled();

		// Journal spawn entry содержит via: "spawn".
		// FAIL: текущий TreeJournal.write() не копирует поле via
		// (его нет в TreeJournalEntry interface), поэтому spawnEntry.via === undefined.
		const entries = readJournal(mission);
		const spawnEntries = entries.filter((e) => e.event === "spawn");
		expect(spawnEntries).toHaveLength(1);
		expect(spawnEntries[0].via).toBe("spawn");

		fetchSpy.mockRestore();
	});
});

// ─── TC-F4-2: SO role → HTTP delegation (no process spawn) ─────────────────

describe("TC-F4-2: SO role launchChild → HTTP delegation (no process spawn)", () => {
	it("fetch вызван 1 раз с POST /api/mission-delegate; spawnNode НЕ вызван; journal via: 'http_delegate'", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const fetchMock = makeDelegateFetchMock();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const handle = makeHandle(mission, { spawnNode, sendPackage });

		// role: "super-orchestrator" + roleProfile + packages.
		// Текущий код проигнорирует эти поля и пойдёт в existing spawn path.
		await handle.run({
			task: "Эпик",
			children: 1,
			deadline: DEADLINE,
			role: "super-orchestrator",
			roleProfile: "pm",
			packages: [{ task: "sub-epic", tokenBudget: 5000, toolManifest: ["read", "write"] }],
		});

		// fetch вызван 1 раз с POST на /api/mission-delegate.
		// FAIL: текущий код НЕ вызывает fetch (не знает про role → идёт в spawnNode).
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Проверка URL и метода fetch.
		const [fetchUrl, fetchOpts] = fetchMock.mock.calls[0];
		expect(String(fetchUrl)).toContain("/api/mission-delegate");
		expect(fetchOpts.method).toBe("POST");

		// Проверка payload.
		const payload = JSON.parse(fetchOpts.body);
		expect(payload.role).toBe("super-orchestrator");
		expect(payload.role_profile).toBe("pm");
		expect(payload.packages).toBeDefined();
		expect(Array.isArray(payload.packages)).toBe(true);

		// Проверка Authorization header (Bearer <token>).
		expect(fetchOpts.headers).toBeDefined();
		expect(fetchOpts.headers.Authorization).toMatch(/^Bearer .+/);

		// spawnNode НЕ вызван (SO = HTTP delegation, no process spawn).
		// FAIL: текущий код вызывает spawnNode (existing path).
		expect(spawnNode).not.toHaveBeenCalled();

		// sendPackage НЕ вызван (SO = HTTP delegation replaces sendPackage too).
		expect(sendPackage).not.toHaveBeenCalled();

		// Journal spawn entry содержит via: "http_delegate".
		// FAIL: текущий код пишет spawn entry без via (или не пишет spawn для SO).
		const entries = readJournal(mission);
		const spawnEntries = entries.filter((e) => e.event === "spawn");
		expect(spawnEntries.length).toBeGreaterThanOrEqual(1);
		expect(spawnEntries[0].via).toBe("http_delegate");

		fetchSpy.mockRestore();
	});
});

// ─── TC-F4-3: SO role без role_profile → REFUSED (mandatory field) ─────────

describe("TC-F4-3: SO role без role_profile → REFUSED (mandatory field)", () => {
	it("throws Error('role_profile required for super-orchestrator'); ни spawn, ни HTTP не вызваны", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const fetchMock = makeDelegateFetchMock();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const handle = makeHandle(mission, { spawnNode, sendPackage });

		// role: "super-orchestrator" БЕЗ roleProfile.
		// Текущий код проигнорирует role и пойдёт в existing spawn path.
		// Ожидаем: throw Error до spawn и до HTTP.
		await expect(
			handle.run({
				task: "Эпик",
				children: 1,
				deadline: DEADLINE,
				role: "super-orchestrator",
				// roleProfile НЕ указан — mandatory для SO!
			}),
		).rejects.toThrow(/role_profile required for super-orchestrator/);

		// Ни spawn, ни HTTP не вызваны (fail-fast валидация).
		// FAIL: текущий код НЕ валидирует role_profile → вызывает spawnNode.
		expect(spawnNode).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();

		// Журнал пуст (ошибка до spawn → нет записей).
		const entries = readJournal(mission);
		expect(entries.filter((e) => e.event === "spawn")).toHaveLength(0);

		fetchSpy.mockRestore();
	});
});
