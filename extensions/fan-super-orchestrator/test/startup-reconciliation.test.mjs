// F-33: Startup-reconciliation (orphan cleanup) — RED-фаза TDD.
//
// Модуль ../startup-reconciliation.js ещё НЕ существует: весь файл обязан
// падать с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После
// реализации (GREEN) тесты должны пройти БЕЗ изменений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-33
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Задача модуля: при старте контура обнаружить и зачистить orphaned
// дочерних процессов прошлой сессии. Источники:
//   • portsFile — формат PortPool (port-pool.ts): JSON-объект {nodeId: port};
//   • PID-файлы — <pidDir>/child-<sanitized-id>.pid, санитизация "/"→"-"
//     (как pidFileFor в process-manager.ts).
//
// Для каждой записи portsFile:
//   • PID-файл отсутствует → cleaned_dead (pid null), запись/порт чистятся;
//   • PID мёртв (processKill(pid, 0) бросает) → cleaned_dead без SIGTERM;
//   • PID жив и isOwnChild(pid) === true → skipped_own_child: запись и
//     PID-файл остаются, SIGTERM не вызывается;
//   • PID жив и НЕ свой ребёнок → orphan: SIGTERM → poll processKill(pid, 0)
//     с шагом через sleepMs → жив после killGraceMs → SIGKILL → запись/порт/
//     PID-файл чистятся → journal.write({event:"orphan_cleanup", nodeId, pid, port}).
//
// Контракт:
//   interface ReconciliationOptions {
//     portsFile: string;
//     pidDir: string;
//     journal?: { write(entry: object): unknown };
//     isOwnChild?: (pid: number) => boolean;   // default () => false
//     killGraceMs?: number;                    // default 5000
//     processKill?: (pid: number, signal?: string | number) => boolean;
//     sleepMs?: (ms: number) => Promise<void>;
//   }
//   interface ReconciledEntry {
//     nodeId: string; pid: number | null; port: number;
//     action: "cleaned_dead" | "killed_orphan" | "skipped_own_child";
//   }
//   interface ReconciliationResult { entries: ReconciledEntry[] }
//   reconcile(opts): Promise<ReconciliationResult>
//
// Реальные процессы НЕ спавнятся: вся жизнь/смерть PID моделируется
// DI-моком processKill (сигнал 0 — проверка жизни).
//
// Покрытие (TC-карточки roadmap):
//   TC-F33-1  orphan (PID жив, isOwnChild false) → SIGTERM, запись удалена,
//             порт освобождён, PID-файл удалён, journal orphan_cleanup {nodeId,pid,port}
//   TC-F33-2  PID жив и isOwnChild true → запись НЕ удалена, SIGTERM не вызван,
//             action skipped_own_child
//   TC-F33-3  пустой/отсутствующий portsFile → {entries: []}, без ошибок,
//             processKill не вызывается
//   Доп.      PID мёртв (signal 0 бросает / false) → cleaned_dead без SIGTERM;
//             SIGTERM игнорируется → SIGKILL после killGraceMs;
//             corrupt portsFile → {entries: []};
//             PID-файл отсутствует → cleaned_dead, pid null;
//             mix dead+orphan+own → portsFile содержит только own;
//             journal не задан → не бросает;
//             default isOwnChild () => false; default killGraceMs;
//             санитизация nodeId "/"→"-".

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let reconcile;

beforeAll(async () => {
	const mod = await import("../startup-reconciliation.js");
	reconcile = mod.reconcile;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-sr-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Стенд: portsFile + pidDir в свежем tempdir. */
function makeFixture() {
	const tmp = makeTmpDir();
	return {
		portsFile: join(tmp, "child-ports.json"),
		pidDir: join(tmp, "pids"),
	};
}

/**
 * Записать portsFile в формате PortPool (JSON {nodeId: port}).
 * Родительский каталог pidDir создаётся тоже.
 */
function writePortsFile(portsFile, ports) {
	writeFileSync(portsFile, JSON.stringify(ports, null, 2), "utf8");
}

/** Путь PID-файла: санитизация "/"→"-" как в process-manager. */
function pidFileFor(pidDir, nodeId) {
	return join(pidDir, `child-${nodeId.split("/").join("-")}.pid`);
}

/** Записать PID-файл (pidDir создаётся). */
function writePidFile(pidDir, nodeId, pid) {
	mkdirSync(pidDir, { recursive: true });
	const file = pidFileFor(pidDir, nodeId);
	writeFileSync(file, String(pid), "utf8");
	return file;
}

/** Прочитать portsFile как объект. */
function readPorts(portsFile) {
	return JSON.parse(readFileSync(portsFile, "utf8"));
}

/**
 * DI-мок processKill. Живые PID хранятся в alive.
 *  • signal 0/undefined — проверка жизни: мёртв → throw (ESRCH), жив → true;
 *  • SIGTERM — убивает, если termKills (graceful), иначе игнорируется;
 *  • SIGKILL — убивает всегда.
 */
function makeProcessKill({ termKills = true, alivePids = [] } = {}) {
	const alive = new Set(alivePids);
	const calls = [];
	const kill = vi.fn((pid, signal) => {
		calls.push({ pid, signal });
		if (signal === 0 || signal === undefined) {
			if (!alive.has(pid)) {
				throw Object.assign(new Error(`kill ESRCH: no such process ${pid}`), { code: "ESRCH" });
			}
			return true;
		}
		if (signal === "SIGKILL") {
			alive.delete(pid);
			return true;
		}
		if (signal === "SIGTERM" && termKills) {
			alive.delete(pid);
		}
		return true;
	});
	return { kill, alive, calls };
}

/** DI-мок sleepMs: мгновенный, накапливает «проспанное» время. */
function makeSleepMs() {
	const state = { totalMs: 0 };
	const sleepMs = vi.fn(async (ms) => {
		state.totalMs += ms;
	});
	return { sleepMs, state };
}

/** Мок journal (TreeJournal-совместимый). */
function makeJournal() {
	return { write: vi.fn() };
}

// ─── TC-F33-1: orphan — SIGTERM, чистка, journal orphan_cleanup ────────────

describe("TC-F33-1: запись с живым PID (isOwnChild false) → orphan kill + cleanup", () => {
	function setup({ termKills = true } = {}) {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill, calls } = makeProcessKill({ termKills, alivePids: [4321] });
		const { sleepMs, state } = makeSleepMs();
		const journal = makeJournal();
		return { portsFile, pidDir, kill, calls, sleepMs, sleepState: state, journal };
	}

	it("processKill вызван с SIGTERM по PID из PID-файла", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		expect(f.calls).toContainEqual({ pid: 4321, signal: "SIGTERM" });
	});

	it("запись удалена из portsFile (порт освобождён)", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		expect(readPorts(f.portsFile)).toEqual({});
	});

	it("PID-файл удалён", async () => {
		const f = setup();
		const pidFile = pidFileFor(f.pidDir, "L1/node-1");
		expect(existsSync(pidFile)).toBe(true);
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		expect(existsSync(pidFile)).toBe(false);
	});

	it("journal получил orphan_cleanup с nodeId/pid/port", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		expect(f.journal.write).toHaveBeenCalledTimes(1);
		expect(f.journal.write).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "orphan_cleanup",
				nodeId: "L1/node-1",
				pid: 4321,
				port: 7001,
			}),
		);
	});

	it("result.entries: action killed_orphan, nodeId/pid/port записи", async () => {
		const f = setup();
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "killed_orphan" },
		]);
	});

	it("жизнь проверяется через signal 0 ДО SIGTERM", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});
		const probeIdx = f.calls.findIndex((c) => c.pid === 4321 && (c.signal === 0 || c.signal === undefined));
		const termIdx = f.calls.findIndex((c) => c.pid === 4321 && c.signal === "SIGTERM");
		expect(probeIdx).toBeGreaterThanOrEqual(0);
		expect(termIdx).toBeGreaterThan(probeIdx);
	});

	it("default isOwnChild (опущен) → все выжившие — orphans", async () => {
		const f = setup();
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			killGraceMs: 100,
		});
		expect(result.entries[0].action).toBe("killed_orphan");
		expect(f.calls).toContainEqual({ pid: 4321, signal: "SIGTERM" });
	});

	it("default killGraceMs (опущен) → reconcile завершается (SIGTERM убил)", async () => {
		const f = setup();
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => false,
		});
		expect(result.entries[0].action).toBe("killed_orphan");
	});
});

// ─── TC-F33-2: живой PID и isOwnChild true → skipped_own_child ─────────────

describe("TC-F33-2: PID жив и isOwnChild true → skipped_own_child, ничего не трогаем", () => {
	function setup() {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill, calls } = makeProcessKill({ alivePids: [4321] });
		const { sleepMs } = makeSleepMs();
		const journal = makeJournal();
		return { portsFile, pidDir, kill, calls, sleepMs, journal };
	}

	it("processKill с SIGTERM/SIGKILL НЕ вызван", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => true, killGraceMs: 100,
		});
		expect(f.calls.filter((c) => c.signal === "SIGTERM" || c.signal === "SIGKILL")).toEqual([]);
	});

	it("запись остаётся в portsFile (порт НЕ освобождён)", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => true, killGraceMs: 100,
		});
		expect(readPorts(f.portsFile)).toEqual({ "L1/node-1": 7001 });
	});

	it("PID-файл остаётся", async () => {
		const f = setup();
		const pidFile = pidFileFor(f.pidDir, "L1/node-1");
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => true, killGraceMs: 100,
		});
		expect(existsSync(pidFile)).toBe(true);
	});

	it("action skipped_own_child в result.entries; journal не пишется", async () => {
		const f = setup();
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild: () => true, killGraceMs: 100,
		});
		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "skipped_own_child" },
		]);
		expect(f.journal.write).not.toHaveBeenCalled();
	});

	it("isOwnChild вызван с PID из PID-файла", async () => {
		const f = setup();
		const isOwnChild = vi.fn(() => true);
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir,
			journal: f.journal, processKill: f.kill, sleepMs: f.sleepMs,
			isOwnChild, killGraceMs: 100,
		});
		expect(isOwnChild).toHaveBeenCalledWith(4321);
	});
});

// ─── TC-F33-3: пустой/отсутствующий/corrupt portsFile → {entries: []} ──────

describe("TC-F33-3: пустой/отсутствующий portsFile → {entries: []}, без ошибок", () => {
	it("portsFile отсутствует → {entries: []}, processKill не вызывается", async () => {
		const { portsFile, pidDir } = makeFixture();
		expect(existsSync(portsFile)).toBe(false);
		const { kill } = makeProcessKill();
		const journal = makeJournal();

		const result = await reconcile({
			portsFile, pidDir, journal, processKill: kill, sleepMs: makeSleepMs().sleepMs,
		});

		expect(result).toEqual({ entries: [] });
		expect(kill).not.toHaveBeenCalled();
		expect(journal.write).not.toHaveBeenCalled();
	});

	it("portsFile = {} → {entries: []}", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, {});
		const { kill } = makeProcessKill();

		const result = await reconcile({ portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs });

		expect(result).toEqual({ entries: [] });
		expect(kill).not.toHaveBeenCalled();
	});

	it("portsFile пустой файл → {entries: []} (не бросает)", async () => {
		const { portsFile, pidDir } = makeFixture();
		writeFileSync(portsFile, "", "utf8");

		const result = await reconcile({ portsFile, pidDir, processKill: makeProcessKill().kill });

		expect(result).toEqual({ entries: [] });
	});

	it("corrupt portsFile (не JSON) → {entries: []} (не бросает)", async () => {
		const { portsFile, pidDir } = makeFixture();
		writeFileSync(portsFile, "{ not valid json !!!", "utf8");
		const { kill } = makeProcessKill();

		const result = await reconcile({ portsFile, pidDir, processKill: kill });

		expect(result).toEqual({ entries: [] });
		expect(kill).not.toHaveBeenCalled();
	});

	it("corrupt portsFile (JSON, но не объект) → {entries: []}", async () => {
		const { portsFile, pidDir } = makeFixture();
		writeFileSync(portsFile, "[1, 2, 3]", "utf8");

		const result = await reconcile({ portsFile, pidDir, processKill: makeProcessKill().kill });

		expect(result).toEqual({ entries: [] });
	});
});

// ─── Доп: PID мёртв → cleaned_dead без SIGTERM ─────────────────────────────

describe("cleaned_dead: PID из PID-файла мёртв", () => {
	it("processKill(pid, 0) бросает → cleaned_dead, SIGTERM не вызван", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill, calls } = makeProcessKill({ alivePids: [] }); // 4321 мёртв

		const result = await reconcile({
			portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs, killGraceMs: 100,
		});

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "cleaned_dead" },
		]);
		expect(calls.filter((c) => c.signal === "SIGTERM")).toEqual([]);
	});

	it("запись удалена из portsFile, PID-файл удалён", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		const pidFile = writePidFile(pidDir, "L1/node-1", 4321);
		const { kill } = makeProcessKill({ alivePids: [] });

		await reconcile({ portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs });

		expect(readPorts(portsFile)).toEqual({});
		expect(existsSync(pidFile)).toBe(false);
	});

	it("мёртвый PID НЕ пишет orphan_cleanup в journal", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill } = makeProcessKill({ alivePids: [] });
		const journal = makeJournal();

		await reconcile({ portsFile, pidDir, journal, processKill: kill, sleepMs: makeSleepMs().sleepMs });

		expect(journal.write).not.toHaveBeenCalled();
	});

	it("isOwnChild для мёртвого PID не вызывается", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill } = makeProcessKill({ alivePids: [] });
		const isOwnChild = vi.fn(() => true);

		await reconcile({ portsFile, pidDir, isOwnChild, processKill: kill, sleepMs: makeSleepMs().sleepMs });

		expect(isOwnChild).not.toHaveBeenCalled();
	});
});

// ─── Доп: PID-файл отсутствует → cleaned_dead, pid null ────────────────────

describe("cleaned_dead: PID-файл отсутствует для записи portsFile", () => {
	it("action cleaned_dead, pid null, processKill не вызывается", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		// PID-файл НЕ создаём
		const { kill } = makeProcessKill();

		const result = await reconcile({ portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs });

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: null, port: 7001, action: "cleaned_dead" },
		]);
		expect(kill).not.toHaveBeenCalled();
	});

	it("запись/порт чистятся из portsFile", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });

		await reconcile({ portsFile, pidDir, processKill: makeProcessKill().kill });

		expect(readPorts(portsFile)).toEqual({});
	});
});

// ─── Доп: SIGTERM игнорируется → SIGKILL после killGraceMs ─────────────────

describe("orphan, игнорирующий SIGTERM → SIGKILL после killGraceMs", () => {
	function setup(killGraceMs = 100) {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill, calls } = makeProcessKill({ termKills: false, alivePids: [4321] });
		const { sleepMs, state } = makeSleepMs();
		const journal = makeJournal();
		return { portsFile, pidDir, kill, calls, sleepMs, sleepState: state, journal, killGraceMs };
	}

	it("SIGKILL вызван (после SIGTERM)", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: () => false, killGraceMs: f.killGraceMs,
		});
		const termIdx = f.calls.findIndex((c) => c.signal === "SIGTERM");
		const killIdx = f.calls.findIndex((c) => c.signal === "SIGKILL");
		expect(termIdx).toBeGreaterThanOrEqual(0);
		expect(killIdx).toBeGreaterThan(termIdx);
	});

	it("ожидание идёт через sleepMs и суммарно достигает killGraceMs до SIGKILL", async () => {
		const f = setup(100);
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: () => false, killGraceMs: f.killGraceMs,
		});
		expect(f.sleepMs).toHaveBeenCalled();
		expect(f.sleepState.totalMs).toBeGreaterThanOrEqual(f.killGraceMs);
	});

	it("после SIGKILL: запись удалена, PID-файл удалён, action killed_orphan", async () => {
		const f = setup();
		const pidFile = pidFileFor(f.pidDir, "L1/node-1");
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: () => false, killGraceMs: f.killGraceMs,
		});
		expect(result.entries[0].action).toBe("killed_orphan");
		expect(readPorts(f.portsFile)).toEqual({});
		expect(existsSync(pidFile)).toBe(false);
	});

	it("journal получил orphan_cleanup и после SIGKILL-пути", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: () => false, killGraceMs: f.killGraceMs,
		});
		expect(f.journal.write).toHaveBeenCalledWith(
			expect.objectContaining({ event: "orphan_cleanup", nodeId: "L1/node-1", pid: 4321, port: 7001 }),
		);
	});
});

// ─── Доп: mix-записи dead + orphan + own ────────────────────────────────────

describe("несколько записей: dead + orphan + own → все обработаны, остаётся только own", () => {
	function setup() {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, {
			"L1/node-dead": 7001,
			"L1/node-orphan": 7002,
			"L1/node-own": 7003,
			"L1/node-nopid": 7004,
		});
		writePidFile(pidDir, "L1/node-dead", 1111); // мёртв
		writePidFile(pidDir, "L1/node-orphan", 2222); // жив, не свой
		writePidFile(pidDir, "L1/node-own", 3333); // жив, свой
		// node-nopid: PID-файла нет
		const { kill, calls } = makeProcessKill({ alivePids: [2222, 3333] });
		const journal = makeJournal();
		return {
			portsFile, pidDir, kill, calls, journal,
			sleepMs: makeSleepMs().sleepMs,
			isOwnChild: (pid) => pid === 3333,
		};
	}

	it("actions: dead → cleaned_dead, orphan → killed_orphan, own → skipped_own_child, nopid → cleaned_dead(null)", async () => {
		const f = setup();
		const result = await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: f.isOwnChild, killGraceMs: 100,
		});
		const byNode = Object.fromEntries(result.entries.map((e) => [e.nodeId, e]));
		expect(byNode["L1/node-dead"]).toEqual({ nodeId: "L1/node-dead", pid: 1111, port: 7001, action: "cleaned_dead" });
		expect(byNode["L1/node-orphan"]).toEqual({ nodeId: "L1/node-orphan", pid: 2222, port: 7002, action: "killed_orphan" });
		expect(byNode["L1/node-own"]).toEqual({ nodeId: "L1/node-own", pid: 3333, port: 7003, action: "skipped_own_child" });
		expect(byNode["L1/node-nopid"]).toEqual({ nodeId: "L1/node-nopid", pid: null, port: 7004, action: "cleaned_dead" });
	});

	it("portsFile содержит только own-запись", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: f.isOwnChild, killGraceMs: 100,
		});
		expect(readPorts(f.portsFile)).toEqual({ "L1/node-own": 7003 });
	});

	it("SIGTERM только по orphan-PID; PID-файлы dead/orphan/nopid удалены, own — на месте", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: f.isOwnChild, killGraceMs: 100,
		});
		const termPids = f.calls.filter((c) => c.signal === "SIGTERM").map((c) => c.pid);
		expect(termPids).toEqual([2222]);
		expect(existsSync(pidFileFor(f.pidDir, "L1/node-dead"))).toBe(false);
		expect(existsSync(pidFileFor(f.pidDir, "L1/node-orphan"))).toBe(false);
		expect(existsSync(pidFileFor(f.pidDir, "L1/node-own"))).toBe(true);
	});

	it("journal содержит ровно один orphan_cleanup (по orphan-записи)", async () => {
		const f = setup();
		await reconcile({
			portsFile: f.portsFile, pidDir: f.pidDir, journal: f.journal,
			processKill: f.kill, sleepMs: f.sleepMs, isOwnChild: f.isOwnChild, killGraceMs: 100,
		});
		expect(f.journal.write).toHaveBeenCalledTimes(1);
		expect(f.journal.write).toHaveBeenCalledWith(
			expect.objectContaining({ event: "orphan_cleanup", nodeId: "L1/node-orphan", pid: 2222, port: 7002 }),
		);
	});
});

// ─── Доп: journal не задан → не бросает ─────────────────────────────────────

describe("journal опционален", () => {
	it("orphan cleanup без journal → resolve, чистка выполняется", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill } = makeProcessKill({ alivePids: [4321] });

		const result = await reconcile({
			portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});

		expect(result.entries[0].action).toBe("killed_orphan");
		expect(readPorts(portsFile)).toEqual({});
	});
});

// ─── Доп: default processKill/sleepMs — reconcile работает без DI ──────────

describe("defaults: processKill/sleepMs опущены", () => {
	it("мёртвый PID чистится реальным process.kill (несуществующий PID)", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		// PID, которого гарантированно нет: 2^22+… — ESRCH на всех платформах
		writePidFile(pidDir, "L1/node-1", 4_194_299);

		const result = await reconcile({ portsFile, pidDir });

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4_194_299, port: 7001, action: "cleaned_dead" },
		]);
		expect(readPorts(portsFile)).toEqual({});
	});
});

// ─── Доп: санитизация nodeId в имени PID-файла ("/"→"-") ───────────────────

describe("санитизация nodeId: PID-файл child-<id с - вместо />.pid", () => {
	it("nodeId с несколькими '/' → PID читается из санитизированного файла", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1/worker-2": 7005 });
		writePidFile(pidDir, "L1/node-1/worker-2", 5555);
		const { kill, calls } = makeProcessKill({ alivePids: [5555] });

		const result = await reconcile({
			portsFile, pidDir, processKill: kill, sleepMs: makeSleepMs().sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});

		expect(result.entries[0]).toEqual({
			nodeId: "L1/node-1/worker-2", pid: 5555, port: 7005, action: "killed_orphan",
		});
		expect(calls).toContainEqual({ pid: 5555, signal: "SIGTERM" });
		expect(existsSync(pidFileFor(pidDir, "L1/node-1/worker-2"))).toBe(false);
	});
});

// ─── F-33 Robustness: TOCTOU ESRCH на SIGTERM/SIGKILL ─────────────────────

describe("robustness: SIGTERM бросает ESRCH (процесс умер между probe и сигналом)", () => {
	it("reconcile завершается успешно, запись очищена (killed_orphan)", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);

		// Probe (signal 0) → alive; SIGTERM → ESRCH (процесс умер между probe и kill).
		const alive = new Set([4321]);
		const kill = vi.fn((pid, signal) => {
			if (signal === 0 || signal === undefined) {
				if (!alive.has(pid)) {
					throw Object.assign(new Error(`kill ESRCH: no such process ${pid}`), { code: "ESRCH" });
				}
				return true;
			}
			if (signal === "SIGTERM") {
				// Процесс уже мёртв — ESRCH.
				alive.delete(pid);
				throw Object.assign(new Error(`kill ESRCH: no such process ${pid}`), { code: "ESRCH" });
			}
			if (signal === "SIGKILL") {
				alive.delete(pid);
				return true;
			}
			return true;
		});
		const { sleepMs } = makeSleepMs();
		const journal = makeJournal();

		const result = await reconcile({
			portsFile, pidDir, journal, processKill: kill, sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "killed_orphan" },
		]);
		expect(readPorts(portsFile)).toEqual({});
	});
});

describe("robustness: SIGKILL бросает ESRCH после успешного SIGTERM", () => {
	it("reconcile завершается успешно, чистка выполнена (killed_orphan)", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);

		// Probe → alive; SIGTERM → ok (но процесс не умирает); SIGKILL → ESRCH.
		const alive = new Set([4321]);
		const kill = vi.fn((pid, signal) => {
			if (signal === 0 || signal === undefined) {
				if (!alive.has(pid)) {
					throw Object.assign(new Error(`kill ESRCH: no such process ${pid}`), { code: "ESRCH" });
				}
				return true;
			}
			if (signal === "SIGTERM") {
				// SIGTERM отправлен, но не убил мгновенно.
				return true;
			}
			if (signal === "SIGKILL") {
				// Процесс умер самостоятельно между poll и SIGKILL.
				alive.delete(pid);
				throw Object.assign(new Error(`kill ESRCH: no such process ${pid}`), { code: "ESRCH" });
			}
			return true;
		});
		const { sleepMs } = makeSleepMs();
		const journal = makeJournal();

		const result = await reconcile({
			portsFile, pidDir, journal, processKill: kill, sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "killed_orphan" },
		]);
		expect(readPorts(portsFile)).toEqual({});
	});
});

describe("robustness: journal.write бросает → reconcile не падает", () => {
	it("reconcile завершается, portsFile перезаписан", async () => {
		const { portsFile, pidDir } = makeFixture();
		writePortsFile(portsFile, { "L1/node-1": 7001 });
		writePidFile(pidDir, "L1/node-1", 4321);
		const { kill } = makeProcessKill({ alivePids: [4321] });
		const { sleepMs } = makeSleepMs();
		const journal = { write: vi.fn(() => { throw new Error("journal I/O error"); }) };

		const result = await reconcile({
			portsFile, pidDir, journal, processKill: kill, sleepMs,
			isOwnChild: () => false, killGraceMs: 100,
		});

		expect(result.entries).toEqual([
			{ nodeId: "L1/node-1", pid: 4321, port: 7001, action: "killed_orphan" },
		]);
		expect(readPorts(portsFile)).toEqual({});
	});
});
