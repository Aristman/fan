// F-C / TC-FC-2, TC-FC-3: Port registry — RED-фаза TDD.
//
// Модуль ../port-registry.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля (roadmap §F-C, architecture §12.3):
//
//   class PortRegistry {
//     constructor(registryPath: string)
//     async startRegistry(): Promise<void>
//       — создаёт/открывает реестр; при version < 2 → миграция;
//         при orphan_pids → cleanup неживых PID.
//     async tryAllocatePort(opts: {
//       nodeId: string, role: string, profile?: string, depth: number
//     }): Promise<{ allowed: boolean; port?: number; error?: string }>
//       — атомарная проверка cap + выделение порта (race-free).
//     async releasePort(nodeId: string): Promise<void>
//       — освобождает порт, декремент active_nodes.
//     async getState(): Promise<RegistryState>
//       — текущее состояние реестра (для тестов).
//   }
//
// Schema v2 (architecture §12.3):
//   {
//     version: 2,
//     global_caps: { max_nodes_workers: 100, max_ports: 256 },
//     current_state: { active_nodes: 0, active_workers: 0, active_webhooks: 0 },
//     api_pool: { range: { start: 7001, end: 7100 }, allocated: {} },
//     webhook_pool: { range: { start: 9090, end: 9189 }, allocated: {} },
//     orphan_pids: []
//   }
//
// Покрытие (TC-карточки roadmap):
//   TC-FC-2  Atomic cap check (race-free для concurrent spawn)
//   TC-FC-3  Orphan PID cleanup + migration v1 → v2

import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let PortRegistry;

beforeAll(async () => {
	const mod = await import("../port-registry.js");
	PortRegistry = mod.PortRegistry;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let testDir;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "port-registry-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function registryPath() {
	return join(testDir, "port-registry.json");
}

/** Записать произвольный JSON-реестр в файл (для подготовки тестовых условий). */
function writeRegistry(data) {
	writeFileSync(registryPath(), JSON.stringify(data, null, 2), "utf8");
}

function readRegistry() {
	return JSON.parse(readFileSync(registryPath(), "utf8"));
}

/** Создать v2-реестр с заданным числом active_nodes (заполняет allocated). */
function makeRegistryWithNodes(activeNodes) {
	const allocated = {};
	for (let i = 0; i < activeNodes; i++) {
		allocated[`node-${i}`] = 7001 + i;
	}
	return {
		version: 2,
		global_caps: { max_nodes_workers: 100, max_ports: 256 },
		current_state: { active_nodes: activeNodes, active_workers: 0, active_webhooks: 0 },
		api_pool: { range: { start: 7001, end: 7100 }, allocated },
		webhook_pool: { range: { start: 9090, end: 9189 }, allocated: {} },
		orphan_pids: [],
	};
}

// ─── TC-FC-2, тест 1: tryAllocatePort → ALLOWED, active_nodes++ ──────────────

describe("TC-FC-2.1: tryAllocatePort — успешное выделение", () => {
	it("tryAllocatePort → ALLOWED, active_nodes инкрементируется", async () => {
		writeRegistry(makeRegistryWithNodes(0));
		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		const result = await registry.tryAllocatePort({
			nodeId: "node-new",
			role: "super-orchestrator",
			profile: "pm",
			depth: 1,
		});

		expect(result.allowed).toBe(true);
		expect(result.port).toBeGreaterThanOrEqual(7001);
		expect(result.port).toBeLessThanOrEqual(7100);

		const state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(1);
	});
});

// ─── TC-FC-2, тест 2: tryAllocatePort at cap → REFUSED ───────────────────────

describe("TC-FC-2.2: tryAllocatePort при cap → REFUSED", () => {
	it("active_nodes=100 (cap) → REFUSED с error=node_cap_exceeded", async () => {
		writeRegistry(makeRegistryWithNodes(100));
		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		const result = await registry.tryAllocatePort({
			nodeId: "node-overflow",
			role: "orchestrator",
			profile: "backend",
			depth: 2,
		});

		expect(result.allowed).toBe(false);
		expect(result.error).toBe("node_cap_exceeded");
	});
});

// ─── TC-FC-2, тест 3: Параллельные allocations — race-free ───────────────────

describe("TC-FC-2.3: Параллельные allocations — только один ALLOWED при cap=1", () => {
	it("Promise.all двух tryAllocatePort при active_nodes=99: один ALLOWED, один REFUSED", async () => {
		writeRegistry(makeRegistryWithNodes(99));
		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		// Два параллельных запроса — без lock оба могли бы пройти (TOCTOU race).
		// С lock — только один должен succeed.
		const [result1, result2] = await Promise.all([
			registry.tryAllocatePort({
				nodeId: "node-A",
				role: "super-orchestrator",
				profile: "pm",
				depth: 1,
			}),
			registry.tryAllocatePort({
				nodeId: "node-B",
				role: "super-orchestrator",
				profile: "architect",
				depth: 1,
			}),
		]);

		const allowed = [result1, result2].filter((r) => r.allowed);
		const refused = [result1, result2].filter((r) => !r.allowed);

		// Ровно один ALLOWED, ровно один REFUSED.
		expect(allowed.length).toBe(1);
		expect(refused.length).toBe(1);
		expect(refused[0].error).toBe("node_cap_exceeded");

		// После завершения: active_nodes = 100 (99 + 1).
		const state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(100);
	});
});

// ─── TC-FC-2, тест 4: releasePort → active_nodes-- ───────────────────────────

describe("TC-FC-2.4: releasePort — декремент active_nodes", () => {
	it("releasePort освобождает порт и декрементирует active_nodes", async () => {
		writeRegistry(makeRegistryWithNodes(1));
		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		// Перед release: active_nodes=1.
		let state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(1);

		await registry.releasePort("node-0");

		// После release: active_nodes=0, порт освобождён.
		state = await registry.getState();
		expect(state.current_state.active_nodes).toBe(0);

		const reg = readRegistry();
		expect(reg.api_pool.allocated["node-0"]).toBeUndefined();
	});
});

// ─── TC-FC-3, тест 5: Orphan PID cleanup ─────────────────────────────────────

describe("TC-FC-3.5: startRegistry — orphan PID cleanup", () => {
	it("startRegistry удаляет non-existent PID из orphan_pids и освобождает порт", async () => {
		// PID 999999 вряд ли существует в системе.
		const regData = makeRegistryWithNodes(1);
		regData.orphan_pids = [999999];
		// Добавляем порт для orphan PID (как будто процесс раньше занимал порт).
		regData.api_pool.allocated["orphan-999999"] = 7050;
		regData.current_state.active_nodes = 2; // node-0 + orphan
		writeRegistry(regData);

		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		// Orphan PID удалён.
		const state = await registry.getState();
		expect(state.orphan_pids).not.toContain(999999);

		// Порт orphan освобождён.
		const reg = readRegistry();
		expect(reg.api_pool.allocated["orphan-999999"]).toBeUndefined();
	});
});

// ─── TC-FC-3, тест 6: Migration v1 → v2 ──────────────────────────────────────

describe("TC-FC-3.6: startRegistry — миграция v1 → v2", () => {
	it("registry с version=1 → миграция на version=2, current_state обнуляется", async () => {
		// v1-реестр (старая схема — без global_caps, current_state).
		writeRegistry({
			version: 1,
			ports: { "old-node": 7001 },
		});

		const registry = new PortRegistry(registryPath());
		await registry.startRegistry();

		const reg = readRegistry();

		// Version обновлён до 2.
		expect(reg.version).toBe(2);

		// current_state инициализирован нулями.
		expect(reg.current_state).toEqual({
			active_nodes: 0,
			active_workers: 0,
			active_webhooks: 0,
		});

		// global_caps присутствует.
		expect(reg.global_caps).toBeDefined();
		expect(reg.global_caps.max_nodes_workers).toBe(100);
		expect(reg.global_caps.max_ports).toBe(256);

		// api_pool и webhook_pool в новом формате.
		expect(reg.api_pool).toBeDefined();
		expect(reg.api_pool.range).toEqual({ start: 7001, end: 7100 });
		expect(reg.webhook_pool).toBeDefined();
		expect(reg.webhook_pool.range).toEqual({ start: 9090, end: 9189 });
	});
});

// ─── TC-FC-3, тест 7: startRegistry idempotent ───────────────────────────────

describe("TC-FC-3.7: startRegistry — идемпотентный (повторный вызов не пересоздаёт)", () => {
	it("повторный startRegistry не модифицирует существующий v2-реестр", async () => {
		// Создаём валидный v2-реестр с данными.
		const regData = makeRegistryWithNodes(5);
		writeRegistry(regData);

		const registry = new PortRegistry(registryPath());

		// Первый вызов.
		await registry.startRegistry();
		const afterFirst = readRegistry();

		// Второй вызов — не должен ничего изменить.
		await registry.startRegistry();
		const afterSecond = readRegistry();

		expect(afterSecond).toEqual(afterFirst);
		expect(afterSecond.current_state.active_nodes).toBe(5);
	});
});
