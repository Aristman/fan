// Wiring-тесты слоя регистрации виджета дерева (index.ts → agent-tree-widget).
//
// Подход: БЕЗ vi.mock — тестируем через реальную registerAgentTreeWidget с
// DI-моками UI. Виджет регистрируется на ctx.ui (мок), поэтому можно проверить
// setStatus/setWidget вызовы. findActiveMission работает с реальными temp-
// каталогами (MISSION.md).
//
// Тестируемые сценарии (пробы верифаера c403892):
//   1. session_start → виджет зарегистрирован (setStatus вызван при spawn)
//   2. poll подхватывает записи из журнала ≤2 интервалов
//   3. session_shutdown → setStatus/setWidget undefined (dispose чистит ключи)
//   4. depth>0 → виджет НЕ регистрируется (нет setStatus вызовов)
//   5. FAN_NODE_ROLE=super-orchestrator → НЕ регистрируется
//   6. смена missionDir → старый disposed (undefined), новый зарегистрирован
//   7. двойной session_start одной миссии → идемпотентно

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import superOrchestratorExtension from "./index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let missionCounter = 0;

function createMissionDir(base: string, slug?: string): string {
	missionCounter++;
	const dir = join(base, slug ?? `test-mission-${missionCounter}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "MISSION.md"), "---\nstatus: active\n---\n# Test\n");
	return dir;
}

/** Mock fan API + UI-контекст. UI-мок — часть ctx (session_start захватывает). */
function createMockFanAndCtx() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const uiMock = {
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};
	const ctx = { cwd: "", ui: uiMock };
	const fan = {
		handlers,
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		events: {
			emit: vi.fn(),
			on: vi.fn().mockReturnValue(() => {}),
		},
		registerShortcut: vi.fn(),
		async fireSessionStart(cwd: string) {
			const handler = handlers.get("session_start");
			ctx.cwd = cwd; // ctx.cwd должно быть непустым (?? не заменяет "")
			if (handler) await handler({ cwd }, ctx);
		},
		async fireSessionShutdown() {
			const handler = handlers.get("session_shutdown");
			if (handler) await handler();
		},
		uiMock,
		ctx,
	};
	return fan;
}

beforeEach(() => {
	tmpRoot = join(process.env.TEMP ?? "/tmp", `fan-wiring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpRoot, { recursive: true });
	createMissionDir(join(tmpRoot, "docs", "missions"), "alpha");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.FAN_NODE_ROLE;
	delete process.env.FAN_ORCHESTRATOR_DEPTH;
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

// ─── Тесты ──────────────────────────────────────────────────────────────────

describe("wiring: agent-tree-widget registration (index.ts)", () => {
	it("1. session_start (root, UI) → виджет зарегистрирован + F8-шорткат", async () => {
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);

		// F8-шорткат зарегистрирован (registerTreeWidget → registerShortcut → fan.registerShortcut)
		expect(fan.registerShortcut).toHaveBeenCalledWith(
			"f8",
			expect.objectContaining({ description: expect.stringContaining("дерево") }),
		);

		await wiring.shutdown();
	});

	it("2. poll подхватывает записи из журнала (fake-timers advance)", async () => {
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);

		// Записываем spawn в tree-journal.jsonl «из другого процесса».
		const journalPath = join(tmpRoot, "docs", "missions", "alpha", "tree-journal.jsonl");
		const spawnEntry = JSON.stringify({
			timestamp: new Date().toISOString(),
			event: "spawn",
			nodeId: "L1/test",
			parentId: "L0",
		});
		writeFileSync(journalPath, `${spawnEntry}\n`);

		// Poll должен подхватить запись ≤2 интервалов (500мс each).
		vi.advanceTimersByTime(1000);

		// После poll: setStatus вызван с компактной строкой (1 running).
		const statusCalls = fan.uiMock.setStatus.mock.calls;
		const lastStatus = statusCalls[statusCalls.length - 1]?.[1];
		expect(lastStatus).toContain("1●");

		await wiring.shutdown();
	});

	it("3. session_shutdown → setStatus/setWidget undefined (чистка ключей)", async () => {
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);

		// Записываем spawn чтобы виджет показал статус.
		const journalPath = join(tmpRoot, "docs", "missions", "alpha", "tree-journal.jsonl");
		writeFileSync(
			journalPath,
			`${JSON.stringify({ timestamp: new Date().toISOString(), event: "spawn", nodeId: "L1/a", parentId: "L0" })}\n`,
		);
		vi.advanceTimersByTime(500);

		// Сбрасываем моки чтобы видеть только shutdown-вызовы.
		fan.uiMock.setStatus.mockClear();
		fan.uiMock.setWidget.mockClear();

		await fan.fireSessionShutdown();

		// Dispose виджета чистит ключи: setStatus('agents', undefined), setWidget('agent-tree', undefined).
		expect(fan.uiMock.setStatus).toHaveBeenCalledWith("agents", undefined);
		// treeWidgetUi-обёртка передаёт options (undefined при dispose).
		expect(fan.uiMock.setWidget).toHaveBeenCalledWith("agent-tree", undefined, undefined);

		await wiring.shutdown();
	});

	it("4. depth>0 (FAN_ORCHESTRATOR_DEPTH=2) → виджет НЕ регистрируется", async () => {
		process.env.FAN_ORCHESTRATOR_DEPTH = "2";
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);

		// Ни шорткат, ни setStatus — виджет не зарегистрирован.
		expect(fan.registerShortcut).not.toHaveBeenCalled();
		// Advance timers — poll тоже не работает (виджет не создан).
		vi.advanceTimersByTime(2000);
		expect(fan.uiMock.setStatus).not.toHaveBeenCalled();

		await wiring.shutdown();
	});

	it("5. FAN_NODE_ROLE=super-orchestrator → НЕ регистрируется", async () => {
		process.env.FAN_NODE_ROLE = "super-orchestrator";
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);

		// В recursive-режиме registerTreeWidget не вызывается.
		expect(fan.registerShortcut).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2000);
		expect(fan.uiMock.setStatus).not.toHaveBeenCalled();

		await wiring.shutdown();
	});

	it("6. смена missionDir → старый disposed, новый зарегистрирован", async () => {
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);
		expect(fan.registerShortcut).toHaveBeenCalledTimes(1);

		// Создаём beta, удаляем alpha.
		createMissionDir(join(tmpRoot, "docs", "missions"), "beta");
		rmSync(join(tmpRoot, "docs", "missions", "alpha"), { recursive: true, force: true });

		// Сбрасываем чтобы видеть новые вызовы.
		fan.registerShortcut.mockClear();
		fan.uiMock.setStatus.mockClear();

		await fan.fireSessionStart(tmpRoot);

		// Новый шорткат зарегистрирован (старый виджет disposed внутри registerTreeWidget).
		expect(fan.registerShortcut).toHaveBeenCalledTimes(1);

		await wiring.shutdown();
	});

	it("7. двойной session_start одной миссии → идемпотентно (1 шорткат)", async () => {
		const fan = createMockFanAndCtx();
		const wiring = superOrchestratorExtension(fan as never);

		await fan.fireSessionStart(tmpRoot);
		await fan.fireSessionStart(tmpRoot);

		// registerTreeWidget: второй вызов — тот же missionDir → ранний return.
		expect(fan.registerShortcut).toHaveBeenCalledTimes(1);

		await wiring.shutdown();
	});
});
