// F-SO-PP-TEST: юнит-тесты port-pool.ts (выделен из process-manager в REFACTOR-фазе).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23
//
// Покрытие:
//   • allocate последовательно — первый свободный порт диапазона;
//   • release возвращает порт в пул (повторный allocate переиспользует);
//   • занятые порты из файла прошлой сессии учитываются;
//   • исчерпание пула → явная ошибка.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let PortPool;

beforeAll(async () => {
	const mod = await import("../port-pool.js");
	PortPool = mod.PortPool;
});

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
});

/** Tempdir с путём portsFile + регистрация cleanup. */
function makeTmp() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-pp-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return join(tmp, "child-ports.json");
}

describe("PortPool: allocate/release", () => {
	it("allocate последовательно → первый свободный порт, блокировка в файле", () => {
		const portsFile = makeTmp();
		const pool = new PortPool(portsFile, { start: 7001, end: 7003 });

		expect(pool.allocate("L1/a")).toBe(7001);
		expect(pool.allocate("L1/b")).toBe(7002);
		expect(JSON.parse(readFileSync(portsFile, "utf8"))).toEqual({
			"L1/a": 7001,
			"L1/b": 7002,
		});
		expect(pool.list()).toEqual({ "L1/a": 7001, "L1/b": 7002 });
	});

	it("release возвращает порт в пул (повторный allocate переиспользует)", () => {
		const portsFile = makeTmp();
		const pool = new PortPool(portsFile, { start: 7001, end: 7003 });

		expect(pool.allocate("L1/a")).toBe(7001);
		pool.release("L1/a");
		expect(pool.list()).toEqual({});
		expect(pool.allocate("L1/b")).toBe(7001);
	});

	it("занятые порты из файла прошлой сессии учитываются", () => {
		const portsFile = makeTmp();
		writeFileSync(portsFile, JSON.stringify({ "L0/old": 7001 }), "utf8");
		const pool = new PortPool(portsFile, { start: 7001, end: 7003 });

		expect(pool.allocate("L1/a")).toBe(7002);
		expect(pool.list()).toEqual({ "L0/old": 7001, "L1/a": 7002 });
	});

	it("исчерпание пула → явная ошибка", () => {
		const portsFile = makeTmp();
		const pool = new PortPool(portsFile, { start: 7001, end: 7002 });

		pool.allocate("L1/a");
		pool.allocate("L1/b");
		expect(() => pool.allocate("L1/c")).toThrow(/pool|пул|исчерпан|exhausted/i);
	});
});
