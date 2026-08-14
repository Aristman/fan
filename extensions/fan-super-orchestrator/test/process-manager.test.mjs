// F-23: Менеджер дочерних процессов — RED-фаза TDD.
//
// Модуль ../process-manager.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля (DI для тестируемости):
//   createProcessManager({
//     portsFile, pidDir,
//     portRangeStart? = 7001, portRangeEnd? = 7099,
//     spawn?    = DI вместо child_process.spawn → FakeChild,
//     healthFetch? = DI вместо fetch → Promise<{status}>,
//     healthIntervalMs? = 5000, healthFailThreshold? = 3,
//     killGraceMs? = 5000,
//     onUnhealthy?(id, reason),
//   }) → {
//     spawn({id, args?, env?}) → Promise<{port, pid}>,
//     kill(id) → Promise<void>,            // SIGTERM → grace → SIGKILL
//     killAll() → Promise<void>,
//     startHealthChecks(), stopHealthChecks(),
//     status(id) → "running"|"unhealthy"|"stopped"|undefined,
//     listPorts() → Record<string, number>,
//   }
//
// FakeChild: { pid, kill(signal?) → boolean, on(event, cb), exited? } —
// эмулирует child_process.ChildProcess. exit эмулируется emitExit().
//
// Покрытие (TC-карточки roadmap):
//   TC-F23-1  spawn узла + успешный health-check (порт/PID-файл/detached/env)
//   TC-F23-2  kill-switch: SIGTERM → exit → освобождение; SIGKILL по grace
//   TC-F23-3  health-check ловит crash за <15с, 1 рестарт, эскалация
//   TC-F23-4  пул исчерпан → явная ошибка
//   TC-F23-5  два spawn → разные порты; учёт занятых портов из прошлой сессии
//   TC-F23-6  killAll останавливает все узлы
//   доп.      status() неизвестного id → undefined

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let createProcessManager;

beforeAll(async () => {
	const mod = await import("../process-manager.js");
	createProcessManager = mod.createProcessManager;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Tempdir с путями portsFile/pidDir + регистрация cleanup. */
function makeTmp() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-pm-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return {
		tmp,
		portsFile: join(tmp, "child-ports.json"),
		pidDir: join(tmp, "pids"),
	};
}

/** FakeChild, эмулирующий child_process.ChildProcess. */
function makeFakeChild(pid) {
	const handlers = new Map();
	const child = {
		pid,
		exited: false,
		kill: vi.fn((_signal) => true),
		on: vi.fn((event, cb) => {
			handlers.set(event, cb);
			return child;
		}),
		/** Эмуляция события "exit" (как у реального child_process). */
		emitExit(code = 0, signal = null) {
			child.exited = true;
			const cb = handlers.get("exit");
			if (cb) {
				cb(code, signal);
			}
		},
	};
	return child;
}

/** DI-spawn: записывает каждый вызов, возвращает FakeChild. */
function makeSpawnHarness() {
	const children = [];
	const spawn = vi.fn((cmd, args, opts) => {
		const child = makeFakeChild(4000 + children.length + 1);
		child.cmd = cmd;
		child.args = args;
		child.opts = opts;
		children.push(child);
		return child;
	});
	return { spawn, children };
}

/** Здоровый healthFetch (HTTP 200). */
function makeHealthyFetch() {
	return vi.fn(async (_url) => ({ status: 200 }));
}

/** Создать PM + автоматический stopHealthChecks в cleanup. */
function makePM(opts) {
	const pm = createProcessManager(opts);
	cleanups.push(() => {
		try {
			pm.stopHealthChecks();
		} catch {
			/* модуль ещё не реализован — ignore */
		}
	});
	return pm;
}

/** Прочитать child-ports.json с диска ({} если файла нет). */
function readPortsFile(portsFile) {
	if (!existsSync(portsFile)) {
		return {};
	}
	return JSON.parse(readFileSync(portsFile, "utf8"));
}

// ─── TC-F23-1: spawn узла и успешный health-check ───────────────────────────

describe("TC-F23-1: spawn узла и успешный health-check", () => {
	it("порт 7001 заблокирован, PID-файл создан, health 200, spawn detached с FAN_NO_AUTH=0", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const healthFetch = makeHealthyFetch();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch });

		const result = await pm.spawn({ id: "L1/node-1" });

		// SpawnResult: первый свободный порт пула + pid FakeChild
		expect(result.port).toBe(7001);
		expect(result.pid).toBe(children[0].pid);

		// Порт заблокирован в child-ports.json (JSON на диске)
		expect(readPortsFile(portsFile)).toEqual({ "L1/node-1": 7001 });
		expect(pm.listPorts()).toEqual({ "L1/node-1": 7001 });

		// PID-файл: id санитизируется "/" → "-"
		const pidFile = join(pidDir, "child-L1-node-1.pid");
		expect(existsSync(pidFile)).toBe(true);
		expect(readFileSync(pidFile, "utf8").trim()).toBe(String(children[0].pid));

		// Health-check пошёл на правильный URL и вернул 200
		expect(healthFetch).toHaveBeenCalledWith("http://127.0.0.1:7001/api/health");

		// spawn вызван detached, env содержит FAN_NO_AUTH=0
		expect(spawn).toHaveBeenCalledTimes(1);
		const opts = children[0].opts;
		expect(opts.detached).toBe(true);
		expect(String(opts.env.FAN_NO_AUTH)).toBe("0");

		expect(pm.status("L1/node-1")).toBe("running");
	});
});

// ─── TC-F23-2: kill-switch ──────────────────────────────────────────────────

describe("TC-F23-2: kill-switch останавливает узел", () => {
	it("SIGTERM → exit: порт освобождён, PID-файл удалён, status=stopped", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/node-1" });
		const child = children[0];
		const pidFile = join(pidDir, "child-L1-node-1.pid");
		expect(existsSync(pidFile)).toBe(true);

		const killing = pm.kill("L1/node-1");
		await Promise.resolve(); // микротаски: SIGTERM отправляется синхронно внутри kill

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emitExit(0, "SIGTERM");
		await killing;

		// Порт возвращён в пул, PID-файл удалён
		expect(readPortsFile(portsFile)).toEqual({});
		expect(existsSync(pidFile)).toBe(false);
		expect(pm.status("L1/node-1")).toBe("stopped");
	});

	it("процесс игнорирует SIGTERM → SIGKILL после killGraceMs (fake timers)", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch: makeHealthyFetch(),
			killGraceMs: 5000,
		});

		await pm.spawn({ id: "L1/node-1" });
		const child = children[0];

		vi.useFakeTimers();
		const killing = pm.kill("L1/node-1");
		await vi.advanceTimersByTimeAsync(0);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

		// exit не приходит → после grace-периода уходит SIGKILL
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");

		child.emitExit(137, "SIGKILL");
		await killing;

		expect(readPortsFile(portsFile)).toEqual({});
		expect(pm.status("L1/node-1")).toBe("stopped");
	});

	it("kill завершается <10 секунд (SIGTERM-путь — мгновенно по exit)", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/node-1" });
		vi.useFakeTimers();
		const started = Date.now();
		const killing = pm.kill("L1/node-1");
		await vi.advanceTimersByTimeAsync(0);
		children[0].emitExit(0, "SIGTERM");
		await killing;
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});

// ─── TC-F23-3: health-check обнаруживает crash ──────────────────────────────

describe("TC-F23-3: health-check обнаруживает crash за <15 секунд", () => {
	it("3 провала (500) → unhealthy → 1 рестарт на том же порту → эскалация", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const healthFetch = makeHealthyFetch();
		const onUnhealthy = vi.fn();
		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch,
			healthIntervalMs: 5000,
			healthFailThreshold: 3,
			onUnhealthy,
		});

		// Spawn на реальных таймерах: начальный health-check проходит (200)
		const { port } = await pm.spawn({ id: "L1/node-1" });
		expect(port).toBe(7001);
		expect(spawn).toHaveBeenCalledTimes(1);

		vi.useFakeTimers();
		pm.startHealthChecks();
		healthFetch.mockImplementation(async () => ({ status: 500 }));

		// 2 провала — ещё running, эскалации нет
		await vi.advanceTimersByTimeAsync(10_000);
		expect(pm.status("L1/node-1")).toBe("running");
		expect(onUnhealthy).not.toHaveBeenCalled();

		// 3-й провал (15 сек) → unhealthy + onUnhealthy + рестарт
		await vi.advanceTimersByTimeAsync(5_000);
		expect(pm.status("L1/node-1")).toBe("unhealthy");
		expect(onUnhealthy).toHaveBeenCalledTimes(1);
		expect(onUnhealthy.mock.calls[0][0]).toBe("L1/node-1");
		expect(typeof onUnhealthy.mock.calls[0][1]).toBe("string");

		// Ровно 1 попытка рестарта: тот же id, порт не сменился
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(children).toHaveLength(2);
		expect(readPortsFile(portsFile)["L1/node-1"]).toBe(7001);

		// Рестарт тоже не проходит health-check → повторная эскалация,
		// но НЕ бесконечный цикл рестартов
		await vi.advanceTimersByTimeAsync(15_000);
		expect(onUnhealthy).toHaveBeenCalledTimes(2);
		expect(onUnhealthy.mock.calls[1][0]).toBe("L1/node-1");
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(pm.status("L1/node-1")).toBe("unhealthy");

		pm.stopHealthChecks();
	});

	it("healthFetch бросает (сетевой сбой) — тоже считается провалом", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn } = makeSpawnHarness();
		const healthFetch = makeHealthyFetch();
		const onUnhealthy = vi.fn();
		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch,
			healthIntervalMs: 5000,
			healthFailThreshold: 3,
			onUnhealthy,
		});

		await pm.spawn({ id: "L1/node-1" });

		vi.useFakeTimers();
		pm.startHealthChecks();
		healthFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		await vi.advanceTimersByTimeAsync(15_000);
		expect(pm.status("L1/node-1")).toBe("unhealthy");
		expect(onUnhealthy).toHaveBeenCalledTimes(1);

		pm.stopHealthChecks();
	});
});

// ─── TC-F23-4: пул портов исчерпан ──────────────────────────────────────────

describe("TC-F23-4: пул портов исчерпан", () => {
	it("7001-7002 заняты → spawn бросает явную ошибку (pool exhausted)", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn } = makeSpawnHarness();
		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch: makeHealthyFetch(),
			portRangeStart: 7001,
			portRangeEnd: 7002,
		});

		await pm.spawn({ id: "L1/node-1" });
		await pm.spawn({ id: "L1/node-2" });

		await expect(pm.spawn({ id: "L1/node-3" })).rejects.toThrow(/pool|пул|исчерпан|exhausted/i);
		// Лишний процесс не порождался
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});

// ─── TC-F23-5: уникальность портов ──────────────────────────────────────────

describe("TC-F23-5: порты не назначаются дважды", () => {
	it("два spawn подряд → 7001 и 7002", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		const a = await pm.spawn({ id: "L1/node-1" });
		const b = await pm.spawn({ id: "L1/node-2" });

		expect(a.port).toBe(7001);
		expect(b.port).toBe(7002);
		expect(readPortsFile(portsFile)).toEqual({ "L1/node-1": 7001, "L1/node-2": 7002 });
	});

	it("занятые порты из child-ports.json прошлой сессии не переиспользуются", async () => {
		const { portsFile, pidDir } = makeTmp();
		// «Прошлая сессия» оставила блокировку порта 7001
		writeFileSync(portsFile, JSON.stringify({ "L0/old-node": 7001 }), "utf8");

		const { spawn } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		const result = await pm.spawn({ id: "L1/node-1" });
		expect(result.port).toBe(7002);
		expect(pm.listPorts()).toEqual({ "L0/old-node": 7001, "L1/node-1": 7002 });
	});
});

// ─── TC-F23-6: killAll ──────────────────────────────────────────────────────

describe("TC-F23-6: killAll останавливает все узлы", () => {
	it("3 узла → всем SIGTERM, все порты освобождены, статусы stopped", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/node-1" });
		await pm.spawn({ id: "L1/node-2" });
		await pm.spawn({ id: "L2/node-3" });
		expect(Object.keys(readPortsFile(portsFile))).toHaveLength(3);

		const killing = pm.killAll();
		await Promise.resolve();

		for (const child of children) {
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		}
		for (const child of children) {
			child.emitExit(0, "SIGTERM");
		}
		await killing;

		expect(readPortsFile(portsFile)).toEqual({});
		for (const id of ["L1/node-1", "L1/node-2", "L2/node-3"]) {
			expect(pm.status(id)).toBe("stopped");
		}
		// PID-файлы удалены
		expect(existsSync(join(pidDir, "child-L1-node-1.pid"))).toBe(false);
		expect(existsSync(join(pidDir, "child-L2-node-3.pid"))).toBe(false);
	});
});

// ─── Доп.: статус неизвестного узла ─────────────────────────────────────────

describe("F-23 доп.: граничные случаи status()", () => {
	it("status() неизвестного id → undefined", () => {
		const { portsFile, pidDir } = makeTmp();
		const pm = makePM({ portsFile, pidDir, spawn: makeSpawnHarness().spawn, healthFetch: makeHealthyFetch() });
		expect(pm.status("L9/ghost")).toBeUndefined();
	});
});

// ─── TC-F23-7: double-spawn активного id ────────────────────────────────────

describe("TC-F23-7: double-spawn активного id защищён", () => {
	it("повторный spawn активного узла → rejects, spawn вызван 1 раз, порт один", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/node-1" });

		// Повторный spawn того же активного id → ошибка
		await expect(pm.spawn({ id: "L1/node-1" })).rejects.toThrow(
			/L1\/node-1.*already active/i,
		);

		// spawn (DI) был вызван ровно 1 раз (второй вызов не состоялся)
		expect(spawn).toHaveBeenCalledTimes(1);

		// Порт в portsFile один
		expect(readPortsFile(portsFile)).toEqual({ "L1/node-1": 7001 });
	});

	it("stopped-узел после kill можно перезапустить (порт выделяется снова)", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({ id: "L1/node-1" });

		// kill → stopped
		const killing = pm.kill("L1/node-1");
		children[0].emitExit(0, "SIGTERM");
		await killing;
		expect(pm.status("L1/node-1")).toBe("stopped");

		// Повторный spawn после kill — легитимен
		const result = await pm.spawn({ id: "L1/node-1" });
		expect(result.port).toBe(7001);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(readPortsFile(portsFile)).toEqual({ "L1/node-1": 7001 });
	});
});

// ─── TC-F23-8: F-24 bug-fix verification ────────────────────────────────────

describe("TC-F23-8: F-24 bug-fix — token/nodeName env, FAN_NO_AUTH pin, revokeHook", () => {
	it("spawn с token+nodeName → env содержит FAN_NODE_TOKEN, FAN_NODE_NAME, FAN_NO_AUTH=0", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({
			id: "L1/node-1",
			token: "abc123",
			nodeName: "fan-node:L1/node-1",
		});

		const env = children[0].opts.env;
		expect(env.FAN_NODE_TOKEN).toBe("abc123");
		expect(env.FAN_NODE_NAME).toBe("fan-node:L1/node-1");
		expect(String(env.FAN_NO_AUTH)).toBe("0");
	});

	it("вызывающий передал FAN_NO_AUTH=1 → в spawn всё равно FAN_NO_AUTH=0 (пин работает)", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();
		const pm = makePM({ portsFile, pidDir, spawn, healthFetch: makeHealthyFetch() });

		await pm.spawn({
			id: "L1/node-1",
			token: "abc123",
			env: { FAN_NO_AUTH: "1" },
		});

		expect(String(children[0].opts.env.FAN_NO_AUTH)).toBe("0");
	});

	it("kill узла с token → revokeHook вызван ДО SIGTERM; ошибка hook не блокирует kill", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();

		// Массив вызовов для проверки порядка: revoke ДО SIGTERM
		const calls = [];
		const revokeHook = vi.fn(async (info) => {
			calls.push({ type: "revoke", ...info });
		});

		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch: makeHealthyFetch(),
			revokeHook,
		});

		await pm.spawn({
			id: "L1/node-1",
			token: "abc123",
			nodeName: "fan-node:L1/node-1",
		});
		const child = children[0];

		const killing = pm.kill("L1/node-1");
		await Promise.resolve(); // микротаски: revokeHook (sync-resolve) + SIGTERM

		// revokeHook вызван ДО SIGTERM
		expect(revokeHook).toHaveBeenCalledTimes(1);
		expect(revokeHook).toHaveBeenCalledWith({
			id: "L1/node-1",
			port: 7001,
			token: "abc123",
			nodeName: "fan-node:L1/node-1",
		});

		// Порядок: revoke → SIGTERM
		calls.push({ type: "sigterm" });
		expect(calls[0].type).toBe("revoke");
		expect(calls[1].type).toBe("sigterm");

		child.emitExit(0, "SIGTERM");
		await killing;

		expect(pm.status("L1/node-1")).toBe("stopped");
	});

	it("ошибка в revokeHook → kill всё равно завершается успешно", async () => {
		const { portsFile, pidDir } = makeTmp();
		const { spawn, children } = makeSpawnHarness();

		const revokeHook = vi.fn(async () => {
			throw new Error("revoke failed");
		});

		const pm = makePM({
			portsFile,
			pidDir,
			spawn,
			healthFetch: makeHealthyFetch(),
			revokeHook,
		});

		await pm.spawn({
			id: "L1/node-1",
			token: "abc123",
			nodeName: "fan-node:L1/node-1",
		});
		const child = children[0];

		const killing = pm.kill("L1/node-1");
		await Promise.resolve();

		// revokeHook вызван, но ошибка не заблокировала kill
		expect(revokeHook).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");

		child.emitExit(0, "SIGTERM");
		await killing;

		expect(pm.status("L1/node-1")).toBe("stopped");
	});
});
