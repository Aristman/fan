// @vitest-environment jsdom
/**
 * PHASE-GATE B (этап 3 «Визуализация») — E2E.
 *
 * Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md
 *           (секция «Фаза B», E2E-сценарий + Smoke-критерий фазы)
 * Проверяемые функции: F-47 (Mission API endpoints + WS-producer mission_event),
 *   F-39 (<mission-tree>), F-40 (<mission-status> + <mission-log>),
 *   F-41 (<mission-budget>), F-42 (CLI fan mission tree).
 *
 * Проверки:
 *   1. Полный цикл данных: фикстура (tempdir docs/missions/e2e-slug/ с
 *      MISSION.md + tree-journal.jsonl (spawn/complete) + mission-budget.json)
 *      → реальный api-gateway (createApp c missionsDir + @hono/node-server на
 *      случайном порту) → GET status/tree/budget → 200 с корректными данными →
 *      запись в журнал через расширенный createTreeJournal (F-32/F-47: хук
 *      onJournalWrite подключён к missionJournal ws-handler'а) → реальный
 *      WS-клиент получает mission_event, а REST /tree видит новый узел с диска.
 *   2. CLI ↔ API консистентность: один и тот же журнал — `fan mission tree
 *      --format json` (missionTree) и GET /api/missions/:id/tree — дают
 *      одинаковую топологию (узлы, parentId, children, статусы, расход).
 *   3. Dashboard-компоненты против реального API (jsdom): <mission-tree>,
 *      <mission-status>, <mission-budget>, <mission-log> монтируются с РЕАЛЬНЫМ
 *      fetch (ответы НЕ заглушаются — обёртка лишь резолвит относительные URL
 *      против baseUrl, как браузер резолвит их против location.href) и рендерят
 *      реальные данные: nodeId, статусы, бары бюджета. Ключевая интеграционная
 *      проверка: контракты F-47 API ↔ F-39/40/41 компонентов совпадают.
 *   4. WS live: запись в журнал → mission_event на реальном WS-клиенте →
 *      оконный мост (CustomEvent "fan:mission-event" — так это делает
 *      dashboard-app из FanWsClient) → компоненты обновляются за <5 сек
 *      (smoke-критерий фазы B).
 *
 * Примечание: файл выполняется в jsdom-окружении (Lit-компонентам нужен DOM);
 * node-примитивы (fs/http/net/ws) при этом доступны, поэтому HTTP-сервер,
 * fetch и WS-клиент — настоящие.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// Токен-аутентификация выключена: mission-endpoints и WS-upgrade проходят без
// токена (локальный runtime; FAN_NO_AUTH читается динамически на запрос).
process.env.FAN_NO_AUTH = "1";

// @fan/db используется только token-endpoints (CRUD клиентских токенов), которые
// в этом E2E не задействованы. Мок — как в остальных тестах api-gateway (без
// реального Prisma-клиента).
vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({ clientToken: {} }),
}));

import type { SessionAdapter } from "../http-server.js";
import { createApp } from "../http-server.js";
import type { MissionJournalLike } from "../ws-handler.js";
import { attachWebSocketHandler } from "../ws-handler.js";

// F-32/F-47: расширенный tree-journal (createTreeJournal + onJournalWrite) —
// боевой модуль fan-super-orchestrator, не мок.
import type { TreeJournal } from "../../../../extensions/fan-super-orchestrator/tree-journal.js";
import { createTreeJournal } from "../../../../extensions/fan-super-orchestrator/tree-journal.js";
// F-42: CLI `fan mission tree` (боевой модуль coding-agent, не мок).
import { missionTree } from "../../../coding-agent/src/cli/mission-command.js";

// F-39/40/41: Lit-компоненты Dashboard (side-effect импорт регистрирует
// custom elements: <mission-tree>, <mission-status>, <mission-log>, <mission-budget>).
import "../../../dashboard/src/components/mission/mission-tree.js";
import "../../../dashboard/src/components/mission/mission-status.js";
import "../../../dashboard/src/components/mission/mission-log.js";
import "../../../dashboard/src/components/mission/mission-budget.js";

// ============================================================================
// Fixtures
// ============================================================================

const SLUG = "e2e-slug";

/** MISSION.md — формат fan-mission (YAML-подобный frontmatter). */
const MISSION_MD = `---
mission_id: e2e-slug
created: "2026-08-15T10:00:00Z"
status: active
metric_type: command
metric_command: "echo ok"
budget_tokens: 100000
budget_usd: 10.0
max_depth: 3
max_width: 4
iteration: 2
---

# E2E Mission — Phase-gate B (этап 3 «Визуализация»)

Фикстура для packages/api-gateway/src/__tests__/phase-gate-b3.e2e.test.ts.
`;

/** Начальный журнал: L0 (root) → L1/node-1 (spawn→complete) + L1/node-3 (spawn).
 *  L1/node-2 дописывается «вживую» в проверках 1.5/4.1 через createTreeJournal. */
const INITIAL_JOURNAL: string[] = [
	JSON.stringify({
		timestamp: "2026-08-15T10:01:00Z",
		event: "spawn",
		nodeId: "L0",
		correlationId: "e2e-slug/L0/root",
		depth: 0,
	}),
	JSON.stringify({
		timestamp: "2026-08-15T10:02:00Z",
		event: "spawn",
		nodeId: "L1/node-1",
		parentId: "L0",
		correlationId: "e2e-slug/L1/node-1",
		depth: 1,
	}),
	JSON.stringify({
		timestamp: "2026-08-15T10:03:00Z",
		event: "complete",
		nodeId: "L1/node-1",
		parentId: "L0",
		correlationId: "e2e-slug/L1/node-1",
		depth: 1,
		usage: { tokens: 15000, usd: 0.45 },
	}),
	JSON.stringify({
		timestamp: "2026-08-15T10:04:00Z",
		event: "spawn",
		nodeId: "L1/node-3",
		parentId: "L0",
		correlationId: "e2e-slug/L1/node-3",
		depth: 1,
	}),
];

/** mission-budget.json — формат F-31 (passthrough в GET /budget). */
const BUDGET_JSON = {
	mission_id: SLUG,
	budget_total: 100000,
	budget_usd: 10.0,
	allocated: 60000,
	consumed: 39000,
	peak: 30000,
	by_branch: {
		"L1/node-1": { allocated: 26666, consumed: 15000, cost_usd: 0.45 },
		// 24000/26666 ≈ 90% → порог warning (≥80%) — проверяем окраску бара.
		"L1/node-2": { allocated: 26666, consumed: 24000, cost_usd: 0.3 },
		"L1/node-3": { allocated: 6668, consumed: 0, cost_usd: 0.12 },
	},
};

// ============================================================================
// Types
// ============================================================================

/** Форма ответа GET /api/missions/:id/tree (reconstructTree, F-32/F-47). */
interface ApiTreeNode {
	parentId: string | null;
	children: string[];
	status: string;
	correlationId?: string;
	usage?: { tokens?: number; usd?: number };
}
interface ApiTree {
	nodes: Record<string, ApiTreeNode>;
	roots: string[];
}

/** Форма CLI-вывода `fan mission tree --format json` (F-42). */
interface CliNode {
	nodeId: string;
	parentId: string | null;
	status: string;
	costUsd: number;
	children: CliNode[];
}
interface CliPayload {
	mission: string;
	status: string;
	budgetUsd: number | null;
	root: CliNode | null;
	roots: CliNode[];
	total: { costUsd: number; nodeCount: number };
}

// ============================================================================
// Shared state
// ============================================================================

let tmpRoot: string;
let missionsDir: string;
let missionDir: string;
let journal: TreeJournal;
let httpServer: Server;
let wsHandler: { close: () => void };
let baseUrl = "";
let port = 0;

/** Нативный (undici) fetch — до установки обёртки относительных URL. */
const nativeFetch = globalThis.fetch;

/** DOM-элементы из части 3 — переиспользуются в части 4 (live-обновление). */
let treeEl: HTMLElement;
let statusEl: HTMLElement;
let logEl: HTMLElement;
let budgetEl: HTMLElement;

/** Минимальный SessionAdapter: mission-endpoints и WS-обработчик не используют
 *  сессии; обязательные поля интерфейса заглушены no-op'ами. */
const sessionAdapterStub: SessionAdapter = {
	listSessions: async () => [],
	getSession: async () => null,
	createSession: async () => ({
		id: "e2e-session",
		title: "e2e",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}),
	deleteSession: async () => false,
	sendMessage: async () => true,
	subscribeToSession: () => () => {},
	getAvailableModels: async () => [],
	bindSessionExtensions: async () => {},
	listAnalyticsReports: async () => [],
	readAnalyticsReport: async () => null,
	abortSession: async () => true,
	drainSession: async () => true,
};

// ============================================================================
// Helpers
// ============================================================================

/** GET через реальный fetch; путь может быть относительным (/api/...) или полным. */
async function fetchJson<T>(path: string): Promise<{ status: number; body: T }> {
	const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
	const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
	return { status: res.status, body: (await res.json()) as T };
}

/** Реальный WS-клиент к ws://127.0.0.1:<port>/api/ws/<sessionId> (FAN_NO_AUTH=1).
 *  Сборщик сообщений подключается СРАЗУ при создании (до handshake): welcome
 *  сервер шлёт в том же TCP-сегменте, что и 101 — при поздней подписке он
 *  теряется (гонка). */
function openWsCollecting(sessionId: string): {
	ws: WebSocket;
	received: Array<Record<string, unknown>>;
	opened: Promise<void>;
} {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/${sessionId}`);
	const received: Array<Record<string, unknown>> = [];
	ws.on("message", (data: Buffer) => {
		try {
			received.push(JSON.parse(data.toString()) as Record<string, unknown>);
		} catch {
			/* ignore malformed */
		}
	});
	const opened = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("WS connection timeout")), 5000);
		ws.once("open", () => {
			clearTimeout(timeout);
			resolve();
		});
		ws.once("error", (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
	return { ws, received, opened };
}

/** Ожидание Lit-рендера: cond() проверяется после каждого updateComplete. */
async function waitForRender(el: HTMLElement, cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

/** Монтирует mission-компонент с mission-id=<SLUG>, ждёт первичного рендера и
 *  запрошенного состояния (ready после fetch-загрузки; для <mission-log> —
 *  empty, т.к. лента только из WS). Одного updateComplete мало: getUpdateComplete()
 *  вычисляется до того, как updated() выставит _loadPromise, поэтому готовность
 *  опрашивается по data-state. */
async function mount(tag: string, expectState: "ready" | "empty" = "ready"): Promise<HTMLElement> {
	const el = document.createElement(tag);
	el.setAttribute("mission-id", SLUG);
	document.body.appendChild(el);
	await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
	const settled = await waitForRender(
		el,
		() => el.querySelector(`[data-state='${expectState}']`) !== null,
	);
	if (!settled) {
		throw new Error(
			`${tag}: не дождались data-state='${expectState}' (состояние: ${
				el.querySelector("[data-state]")?.getAttribute("data-state") ?? "нет"}, html: ${el.innerHTML.slice(0, 200)})`,
		);
	}
	return el;
}

/** Захват stdout `fan mission tree` (missionTree печатает через console.log). */
async function captureCli(opts: { format?: string }): Promise<string> {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...cliArgs: unknown[]) => {
		lines.push(cliArgs.map(String).join(" "));
	});
	try {
		await missionTree(missionDir, opts);
	} finally {
		spy.mockRestore();
	}
	return lines.join("\n");
}

/** Рекурсивно разворачивает CLI-дерево в плоскую карту nodeId → узел. */
function flattenCli(
	roots: CliNode[],
): Map<string, { parentId: string | null; status: string; costUsd: number; children: string[] }> {
	const out = new Map<string, { parentId: string | null; status: string; costUsd: number; children: string[] }>();
	const visit = (n: CliNode): void => {
		out.set(n.nodeId, {
			parentId: n.parentId,
			status: n.status,
			costUsd: n.costUsd,
			children: n.children.map((c) => c.nodeId),
		});
		for (const c of n.children) visit(c);
	};
	for (const r of roots) visit(r);
	return out;
}

// ============================================================================
// Setup / teardown: фикстура + реальный api-gateway на случайном порту
// ============================================================================

beforeAll(async () => {
	// Фикстура миссии: tempdir/docs/missions/e2e-slug/ (MISSION.md + журнал + бюджет).
	tmpRoot = mkdtempSync(join(tmpdir(), "fan-phase-gate-b3-"));
	missionsDir = join(tmpRoot, "docs", "missions");
	missionDir = join(missionsDir, SLUG);
	mkdirSync(missionDir, { recursive: true });
	writeFileSync(join(missionDir, "MISSION.md"), MISSION_MD);
	writeFileSync(join(missionDir, "tree-journal.jsonl"), `${INITIAL_JOURNAL.join("\n")}\n`);
	writeFileSync(join(missionDir, "mission-budget.json"), JSON.stringify(BUDGET_JSON));

	// Реальный api-gateway app: createApp c missionsDir (F-47).
	const app = await createApp({} as Parameters<typeof createApp>[0], sessionAdapterStub, {
		missionsDir,
	});

	// Реальный HTTP-сервер на случайном порту (port 0); на нём же WS-upgrade.
	httpServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		if (httpServer.listening) {
			resolve();
		} else {
			httpServer.once("listening", () => resolve());
		}
	});
	const addr = httpServer.address() as AddressInfo;
	port = addr.port;
	baseUrl = `http://127.0.0.1:${port}`;

	// Расширенный журнал (F-32/F-47): дописывает в тот же файл (append, не
	// truncate) и уведомляет onJournalWrite-подписчиков после fsync. Хук
	// подключается к missionJournal ws-handler'а → broadcast mission_event.
	journal = createTreeJournal(join(missionDir, "tree-journal.jsonl"));
	wsHandler = attachWebSocketHandler({
		server: httpServer,
		sessionAdapter: sessionAdapterStub,
		missionJournal: journal as unknown as MissionJournalLike,
	});

	// Компоненты Dashboard используют относительные URL (/api/...). Браузер
	// резолвит их против location.href; jsdom+undici — нет. Обёртка ТОЛЬКО
	// резолвит базовый URL — запросы и ответы настоящие (данные не заглушаются).
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (typeof input === "string" && input.startsWith("/")) {
			input = new URL(input, baseUrl).href;
		}
		return nativeFetch(input, init);
	}) as typeof fetch;
}, 30_000);

afterAll(async () => {
	globalThis.fetch = nativeFetch;
	for (const el of [treeEl, statusEl, logEl, budgetEl]) {
		el?.remove();
	}
	wsHandler?.close();
	if (httpServer) {
		await new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
			// keep-alive-соединения undici не должны мешать закрытию сервера
			(httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		});
	}
	if (tmpRoot && existsSync(tmpRoot)) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}, 30_000);

// ============================================================================
// 1. Полный цикл данных: фикстура → реальный api-gateway (REST) → журнал → WS
// ============================================================================

describe("1. Полный цикл данных: fixture → real api-gateway → WS mission_event", () => {
	it("1.1 GET /api/missions/:id/status → 200: frontmatter + сводка бюджета", async () => {
		const { status, body } = await fetchJson<Record<string, unknown>>(`/api/missions/${SLUG}/status`);
		expect(status).toBe(200);
		expect(body.mission_id).toBe(SLUG);
		expect(body.status).toBe("active");
		expect(body.iteration).toBe(2);
		// Сводка бюджета из mission-budget.json перекрывает frontmatter
		expect(body.budget_total).toBe(100000);
		expect(body.budget_usd).toBe(10.0);
		expect(body.allocated).toBe(60000);
		expect(body.consumed).toBe(39000);
	});

	it("1.2 GET /api/missions/:id/tree → 200: топология из tree-journal.jsonl", async () => {
		const { status, body } = await fetchJson<ApiTree>(`/api/missions/${SLUG}/tree`);
		expect(status).toBe(200);
		expect(body.roots).toEqual(["L0"]);
		expect(Object.keys(body.nodes).sort()).toEqual(["L0", "L1/node-1", "L1/node-3"]);
		expect(body.nodes.L0.children).toEqual(["L1/node-1", "L1/node-3"]);
		expect(body.nodes["L1/node-1"].parentId).toBe("L0");
		expect(body.nodes["L1/node-1"].status).toBe("complete");
		expect(body.nodes["L1/node-1"].usage?.usd).toBe(0.45);
		expect(body.nodes["L1/node-3"].status).toBe("spawn");
	});

	it("1.3 GET /api/missions/:id/budget → 200: passthrough mission-budget.json", async () => {
		const { status, body } = await fetchJson<typeof BUDGET_JSON>(`/api/missions/${SLUG}/budget`);
		expect(status).toBe(200);
		expect(body.mission_id).toBe(SLUG);
		expect(body.budget_total).toBe(100000);
		expect(body.consumed).toBe(39000);
		expect(body.by_branch["L1/node-1"].cost_usd).toBe(0.45);
		expect(body.by_branch["L1/node-2"].consumed).toBe(24000);
		expect(body.by_branch["L1/node-3"].allocated).toBe(6668);
	});

	it("1.4 GET /api/missions/<несуществующий slug>/tree → 404 с явной ошибкой", async () => {
		const { status, body } = await fetchJson<{ error: string }>("/api/missions/no-such-mission/tree");
		expect(status).toBe(404);
		expect(body.error).toBe("Mission 'no-such-mission' not found");
	});

	it("1.5 journal.write (createTreeJournal) → WS-клиент получает mission_event; REST /tree видит новый узел", async () => {
		const { ws, received, opened } = openWsCollecting("e2e-live");
		await opened;

		// Запись в журнал: после fsync onJournalWrite уведомляет ws-handler →
		// broadcast mission_event всем подключённым WS-клиентам (F-47).
		journal.write({
			event: "spawn",
			nodeId: "L1/node-2",
			parentId: "L0",
			correlationId: `${SLUG}/L1/node-2`,
			depth: 1,
		});

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !received.some((m) => m.type === "mission_event")) {
			await new Promise((r) => setTimeout(r, 25));
		}
		// welcome-сообщение сервера тоже доставлено (подписка до handshake)
		expect(received.some((m) => m.type === "connected")).toBe(true);
		const evt = received.find((m) => m.type === "mission_event");
		expect(evt, "WS-клиент должен получить mission_event в течение 5 сек").toBeDefined();
		expect(evt!.type).toBe("mission_event");
		expect(evt!.missionId).toBe(SLUG);
		expect(evt!.event).toBe("spawn");
		expect(evt!.nodeId).toBe("L1/node-2");
		expect(typeof evt!.timestamp).toBe("string");
		expect(evt!.entry).toMatchObject({ event: "spawn", nodeId: "L1/node-2", parentId: "L0", depth: 1 });

		// Полный цикл: журнал на диске — единственный источник правды — REST
		// сразу видит новый узел.
		const { body: tree } = await fetchJson<ApiTree>(`/api/missions/${SLUG}/tree`);
		expect(tree.nodes["L1/node-2"]).toBeDefined();
		expect(tree.nodes["L1/node-2"].status).toBe("spawn");
		expect(tree.nodes.L0.children).toContain("L1/node-2");

		ws.close();
	});
});

// ============================================================================
// 2. CLI ↔ API консистентность: fan mission tree vs GET /tree (один журнал)
// ============================================================================

describe("2. CLI ↔ API консистентность: fan mission tree <slug> vs GET /tree", () => {
	it("2.1 --format json: топология идентична API /tree (узлы, parentId, children, статусы, расход)", async () => {
		// Журнал уже содержит live-запись из 1.5 (L1/node-2 spawn).
		const cli = JSON.parse(await captureCli({ format: "json" })) as CliPayload;
		const { status, body: api } = await fetchJson<ApiTree>(`/api/missions/${SLUG}/tree`);
		expect(status).toBe(200);

		expect(cli.mission).toBe(SLUG);
		expect(cli.status).toBe("active");
		expect(cli.budgetUsd).toBe(10.0);

		// Корни и набор узлов совпадают
		expect(cli.roots.map((r) => r.nodeId)).toEqual(api.roots);
		const cliNodes = flattenCli(cli.roots);
		expect([...cliNodes.keys()].sort()).toEqual(Object.keys(api.nodes).sort());

		// Поузловое сравнение: parentId, children, статус, расход
		for (const [id, apiNode] of Object.entries(api.nodes)) {
			const cliNode = cliNodes.get(id);
			expect(cliNode, `узел ${id} отсутствует в CLI-выводе`).toBeDefined();
			expect(cliNode!.parentId, `parentId узла ${id}`).toBe(apiNode.parentId);
			expect([...cliNode!.children].sort(), `children узла ${id}`).toEqual([...apiNode.children].sort());
			expect(cliNode!.status, `статус узла ${id}`).toBe(apiNode.status);
			expect(cliNode!.costUsd, `расход узла ${id}`).toBeCloseTo(apiNode.usage?.usd ?? 0, 2);
		}

		// Итоги: количество узлов и суммарный расход совпадают
		expect(cli.total.nodeCount).toBe(Object.keys(api.nodes).length);
		const apiTotalUsd = Object.values(api.nodes).reduce((sum, n) => sum + (n.usage?.usd ?? 0), 0);
		expect(cli.total.costUsd).toBeCloseTo(apiTotalUsd, 2);
	});

	it("2.2 ASCII-вывод: топология, иконки статусов и итог", async () => {
		const ascii = await captureCli({});
		expect(ascii).toContain(`Mission: ${SLUG}`);
		expect(ascii).toContain("L0 (root)");
		expect(ascii).toContain("L1/node-1 ✓"); // complete → ✓
		expect(ascii).toContain("$0.45");
		expect(ascii).toContain("Total: $0.45"); // только L1/node-1 имеет usage
		expect(ascii).toContain("/ $10.00");
	});
});

// ============================================================================
// 3. Dashboard-компоненты против реального API (jsdom, реальный fetch)
// ============================================================================

describe("3. Dashboard-компоненты против реального API (контракты F-47 ↔ F-39/40/41)", () => {
	it("3.1 <mission-tree> рендерит реальные узлы, статусы и расход", async () => {
		treeEl = await mount("mission-tree");
		expect(treeEl.querySelector("[data-state='ready']")).not.toBeNull();

		const nodeEls = treeEl.querySelectorAll<HTMLElement>("[data-node-id]");
		expect(nodeEls.length).toBe(4); // L0, L1/node-1, L1/node-3, L1/node-2 (live из 1.5)
		const ids = new Set(Array.from(nodeEls).map((n) => n.dataset.nodeId));
		expect(ids).toEqual(new Set(["L0", "L1/node-1", "L1/node-3", "L1/node-2"]));

		// Завершённый узел: статус complete + расход $0.45 + иконка ✓
		const completed = treeEl.querySelector<HTMLElement>("[data-node-id='L1/node-1']");
		expect(completed?.dataset.status).toBe("complete");
		expect(completed?.textContent).toContain("✓");
		expect(treeEl.textContent).toContain("$0.45");

		// Активный (spawn) узел: иконка ●
		const active = treeEl.querySelector<HTMLElement>("[data-node-id='L1/node-3']");
		expect(active?.dataset.status).toBe("spawn");
		expect(active?.textContent).toContain("●");
	});

	it("3.2 <mission-status> рендерит статус, итерацию и расход бюджета", async () => {
		statusEl = await mount("mission-status");
		expect(statusEl.querySelector("[data-state='ready']")).not.toBeNull();
		expect(statusEl.querySelector("[data-status='active']")).not.toBeNull();

		const text = statusEl.textContent ?? "";
		expect(text).toMatch(/Iteration\s*2/);
		// consumed 39000 / budget_total 100000 → 39.0%
		expect(text).toContain("39000.00");
		expect(text).toContain("100000.00");
		expect(text).toContain("(39.0%)");
	});

	it("3.3 <mission-budget> рендерит сводку и бары по веткам с порогами", async () => {
		budgetEl = await mount("mission-budget");
		expect(budgetEl.querySelector("[data-state='ready']")).not.toBeNull();

		// Сводка: 39000/100000 = 39% → normal
		const summary = budgetEl.querySelector<HTMLElement>("[data-summary]");
		expect(summary).not.toBeNull();
		expect(summary?.dataset.threshold).toBe("normal");
		expect(summary?.textContent).toContain("39000.00");
		expect(summary?.textContent).toContain("100000.00");

		// Три бара по веткам из by_branch
		expect(budgetEl.querySelectorAll("[data-branch]").length).toBe(3);

		// L1/node-1: 15000/26666 ≈ 56.3% → normal
		const b1 = budgetEl.querySelector<HTMLElement>("[data-branch='L1/node-1']");
		expect(b1?.dataset.threshold).toBe("normal");
		expect(b1?.textContent).toContain("$0.45");
		expect(b1?.querySelector<HTMLElement>(".mission-budget-fill")?.style.width).toBe("56.3%");

		// L1/node-2: 24000/26666 ≈ 90% → warning (порог ≥80%)
		const b2 = budgetEl.querySelector<HTMLElement>("[data-branch='L1/node-2']");
		expect(b2?.dataset.threshold).toBe("warning");
		expect(b2?.textContent).toContain("$0.30");
		// jsdom нормализует "90.0%" → "90%" в style.width — проверяем атрибут
		expect(b2?.querySelector(".mission-budget-fill")?.getAttribute("style")).toContain("90.0%");
	});

	it("3.4 <mission-log> изначально пуст (лента только из WS-событий)", async () => {
		logEl = await mount("mission-log", "empty");
		expect(logEl.querySelector("[data-state='empty']")).not.toBeNull();
		expect(logEl.querySelectorAll("[data-log-entry]").length).toBe(0);
	});
});

// ============================================================================
// 4. WS live: запись в журнал → mission_event → компоненты (<5 сек)
// ============================================================================

describe("4. WS live: журнал → реальный WS-клиент → оконный мост → компоненты", () => {
	it("4.1 complete-событие обновляет tree/log/budget за <5 сек", async () => {
		// Реальный WS-клиент (не обязателен для dashboard-моста, но проверяет
		// продюсер F-47 end-to-end). Оконный мост: dashboard-app делает то же
		// самое — FanWsClient диспатчит mission_event как window CustomEvent.
		const { ws, received, opened } = openWsCollecting("e2e-live-2");
		ws.on("message", (data: Buffer) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(data.toString()) as Record<string, unknown>;
			} catch {
				return;
			}
			if (msg.type === "mission_event") {
				window.dispatchEvent(new CustomEvent("fan:mission-event", { detail: msg, bubbles: true }));
			}
		});
		await opened;

		const t0 = Date.now();
		journal.write({
			event: "complete",
			nodeId: "L1/node-2",
			parentId: "L0",
			correlationId: `${SLUG}/L1/node-2`,
			depth: 1,
			usage: { tokens: 5000, usd: 0.3 },
		});

		// <mission-tree>: L1/node-2 → completed + расход $0.30
		const treeUpdated = await waitForRender(treeEl, () => {
			const node = treeEl.querySelector<HTMLElement>("[data-node-id='L1/node-2']");
			return node?.dataset.status === "completed";
		});
		const elapsedTree = Date.now() - t0;
		expect(treeUpdated).toBe(true);
		expect(elapsedTree).toBeLessThan(5000); // smoke-критерий фазы B
		expect(treeEl.textContent).toContain("$0.30");

		// Реальный WS-клиент действительно получил complete-событие
		expect(
			received.some((m) => m.type === "mission_event" && m.event === "complete" && m.nodeId === "L1/node-2"),
		).toBe(true);

		// <mission-log>: запись complete с nodeId в ленте
		const logUpdated = await waitForRender(logEl, () => logEl.querySelector("[data-log-entry]") !== null);
		expect(logUpdated).toBe(true);
		const entry = logEl.querySelector<HTMLElement>("[data-log-entry][data-event='complete']");
		expect(entry).not.toBeNull();
		expect(entry?.textContent).toContain("L1/node-2");

		// <mission-budget>: delta-контракт (F-41) — complete без consumed
		// добавляет инкрементальный расход (usage.usd = 0.30) к ветке:
		// cost_usd 0.30 + 0.30 = $0.60
		const budgetUpdated = await waitForRender(budgetEl, () => {
			const b2 = budgetEl.querySelector<HTMLElement>("[data-branch='L1/node-2']");
			return (b2?.textContent ?? "").includes("$0.60");
		});
		expect(budgetUpdated).toBe(true);
		expect(Date.now() - t0).toBeLessThan(5000);

		ws.close();
	}, 20_000);
});
