// F-4 Refactor: role-aware launchChild extracted to routes/launch-child.ts.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §Этап 4, F-4
// Спека: docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-4
//
// Цель extract:
//   • Лучшая тестируемость — launchChildForRole/launchWorkerChild/launchSoChild
//     можно тестировать без depth2-integration setup (минимум deps).
//   • Разделение concerns — depth2-integration = orchestration (allocation,
//     journal coordination, abort handling), routes/launch-child = role-specific
//     launch logic (worker spawn pipeline vs SO HTTP delegation).
//
// Запрещено менять семантику. Только extract + cleanup. Минимальный refactor:
//   • HttpDelegate type — перемещён сюда из depth2-integration.ts (re-export
//     там для back-compat).
//   • globalFetchDelegate — перемещён сюда (внутренний, не экспортируется).
//   • launchChildForRole(ctx) — switch по childRole → worker или SO.
//   • launchWorkerChild(ctx) — worker pipeline (spawn → wait → send → report).
//   • launchSoChild(ctx) — SO HTTP delegation.
//   • LaunchChildContext — общий контекст: runOpts, opts, mutableRunState,
//     child (per-launch params), constants (ROOT_*, CHILD_DEPTH).
//
// Скоупы ссылок на дереве:
//   • ROOT_NODE_ID = "L0" (глубина 0). Константа depth-2 корня.
//   • CHILD_DEPTH = 1. Глубина порождаемых L1 детей.
//   • Используются и для role-routing, и для журнальных записей, и для
//     validateDepth (F-38) на границе приёма отчёта.

import { join } from "node:path";
import { type DepthWidthGuardOptions } from "../depth-width-guard.js";
import type { ValidationFailureInfo } from "../child-node-client.js";
import { validateDepth } from "../message-sanitizer.js";
import { generateNodeToken } from "../node-auth.js";
import type { NodeReport } from "../node-report.js";
import { totalUsage } from "../node-report.js";
import type { BudgetAggregator, BudgetAmount } from "../budget-aggregator.js";
import type { TreeJournal } from "../tree-journal.js";
import type { PortPool } from "../port-pool.js";
import { createWorkPackage, type WorkPackage } from "../work-package.js";

// ────────────────────────────────────────────────────────────────────────────
// F-4: HTTP delegation contract (DI для role=super-orchestrator).
// ────────────────────────────────────────────────────────────────────────────

/** F-4: контракт HTTP-делегата для super-orchestrator role. По умолчанию
 *  используется globalThis.fetch (NODE 18+). DI нужен для тестов: тест
 *  мокает fetch через vi.spyOn(globalThis, "fetch"); альтернативный
 *  вариант — замокать этот колбэк явно. */
export type HttpDelegate = (
	url: string,
	payload: unknown,
	authHeader: string,
) => Promise<{ ok: boolean; status?: number }>;

/** F-4: default HTTP-делегат (NODE 18+ globalThis.fetch). Применяется,
 *  когда opts.httpDelegate не задан (DI-обход). Контракт: POST JSON с
 *  Authorization: Bearer <authHeader>; возвращает { ok, status }. Тело
 *  ответа не парсится — только флаги успеха/статуса. */
const globalFetchDelegate: HttpDelegate = async (url, payload, authHeader) => {
	const fetcher = globalThis.fetch;
	if (typeof fetcher !== "function") {
		throw new Error("globalThis.fetch is not available (NODE 18+ required)");
	}
	const response = await fetcher(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: authHeader,
		},
		body: JSON.stringify(payload),
	});
	return { ok: response.ok, status: response.status };
};

// ────────────────────────────────────────────────────────────────────────────
// Constants (mirror depth2-integration.ts для корректной маршрутизации).
// ────────────────────────────────────────────────────────────────────────────

/** Корень дерева depth-2 (L0). */
export const ROOT_NODE_ID = "L0";
/** Глубина корня (L0). */
export const ROOT_DEPTH = 0;
/** Глубина порождаемых детей. */
export const CHILD_DEPTH = 1;

// ────────────────────────────────────────────────────────────────────────────
// Type aliases (переиспользуются launch-функциями).
// ────────────────────────────────────────────────────────────────────────────

/** Параметры spawn-вызова (DI; прод — process-manager F-23). */
export interface LaunchChildSpawnOpts {
	id: string;
	port: number;
	token: string;
	nodeName: string;
	args: string[];
}

/** Параметры отправки пакета (DI; прод — child-node-client F-29). */
export interface LaunchChildSendOpts {
	port: number;
	token: string;
	workPackage: WorkPackage;
	/** F-38: колбэк граничной валидации, подключённый к журналу миссии
	 *  (validation_failed). DI-реализация, создающая child-node-client внутри,
	 *  пробрасывает его в createChildNodeClient({ onValidationFailed }). */
	onValidationFailed?: (failure: ValidationFailureInfo) => void;
}

/** Колбэк готовности дочернего узла после успешного spawn: дожидается
 *  момента, когда узел готов принимать пакеты (например, /api/health=200).
 *  Бросает на таймаут — пайплайн трактует отказ как сетевую ошибку
 *  (fail-запись, release порта, kill узла, run бросает). DI: прод —
 *  fetch-poll /api/health в fan-super-orchestrator/index.ts. */
export type WaitForReady = (port: number) => Promise<void>;

/** F-2 fix: exit-инфо ребёнка для диагностики преждевременной смерти.
 *  Возвращает {code, signal} если процесс уже завершился, null если ещё жив.
 *  DI: прод — process-manager.getExitInfo в fan-super-orchestrator/index.ts;
 *  не задан — диагностические diag-события не пишутся (best-effort). */
export type GetNodeExitInfo = (
	id: string,
) => { code: number | null; signal: string | null } | null;

/** F-4: роль дочернего узла. */
export type ChildRole = "worker" | "super-orchestrator";

// ────────────────────────────────────────────────────────────────────────────
// Minimal structural types (mirror Depth2RunOptions / Depth2Options).
// Используем structural-typing, чтобы избежать циклической зависимости
// между routes/launch-child.ts и depth2-integration.ts.
// ────────────────────────────────────────────────────────────────────────────

/** Описывает per-run опции, нужные launch-функциям. Structural mirror
 *  Depth2RunOptions из depth2-integration.ts. */
export interface LaunchChildRunOptionsLike {
	task: string;
	children: number;
	childTasks?: string[];
	deadline: string;
	toolManifest?: string[];
	role?: ChildRole;
	roleProfile?: string;
	parentUrl?: string;
	parentToken?: string;
	packages?: unknown[];
}

/** Описывает module-wide опции, нужные launch-функциям. Structural mirror
 *  Depth2Options из depth2-integration.ts. */
export interface LaunchChildOptionsLike {
	missionDir: string;
	missionId: string;
	httpDelegate?: HttpDelegate;
	spawnNode?: (opts: LaunchChildSpawnOpts) => Promise<{ pid: number }>;
	sendPackage?: (opts: LaunchChildSendOpts) => Promise<NodeReport>;
	killNode?: (id: string) => Promise<void>;
	waitForReady?: WaitForReady;
	/** F-2 fix: узнать exit-инфо ребёнка для diag event. Optional. */
	getNodeExitInfo?: GetNodeExitInfo;
	guardOptions?: DepthWidthGuardOptions;
}

// ────────────────────────────────────────────────────────────────────────────
// LaunchChildContext.
// ────────────────────────────────────────────────────────────────────────────

/** Per-launch информация: индекс и резолв-параметры. */
export interface LaunchChildChildInfo {
	index: number;
	nodeId: string;
	task: string;
	/** Резолв role из runOpts.role ?? "worker". */
	childRole: ChildRole;
}

/** Контекст для одной launch-операции. Инкапсулирует всё состояние, которое
 *  нужно worker-pipeline и SO-delegation. Контейнер mutable-ссылок:
 *  запускающая сторона передаёт ссылки (не копии), функции мутируют их
 *  на месте — поведение 1:1 как до extract. */
export interface LaunchChildContext {
	/** Per-run опции (run()). */
	runOpts: LaunchChildRunOptionsLike;
	/** Module-wide опции (createDepth2Integration). */
	opts: LaunchChildOptionsLike;
	/** Resolved manifest → buildToolArgs → spawn args. */
	manifest: string[];
	/** Pre-computed spawn args (buildToolArgs(manifest)). */
	spawnArgs: string[];
	/** Uniform allocation для этого ребёнка (computeChildAllocation на старте run). */
	allocation: BudgetAmount;
	/** Aggregator (mutable: allocate, recordUsage, onNodeComplete). */
	aggregator: BudgetAggregator;
	/** Journal дерева узлов (mutable: write spawn/complete/fail/abort/...). */
	journal: TreeJournal;
	/** Пул портов (mutable: allocate, release). */
	portPool: PortPool;
	/** Mutable флаг aborted — read/write из launch-функций, согласован с abort() outer-scope. */
	aborted: { value: boolean };
	/** In-flight spawnNode промисы (mutable: add/delete). */
	pendingSpawns: Set<Promise<unknown>>;
	/** Активные узлы: kill-switch цель (mutable: set/delete). */
	activeNodes: Map<string, { correlationId: string }>;
	/** Per-launch reports array — worker-pipeline пушит результаты (mutable). */
	reports: Array<{ nodeId: string; report: NodeReport }>;
	/** Per-launch параметры. */
	child: LaunchChildChildInfo;
	/** Pre-computed correlationId для журнальных записей (L0 deterministic). */
	correlationId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Утилита: парсинг глубины из correlationId.
// ────────────────────────────────────────────────────────────────────────────

/** Извлекает глубину узла из correlationId (<mission>/L<N>/node-<M>);
 *  null — correlationId не парсится (глубина неизвестна). */
function depthFromCorrelationId(correlationId: unknown): number | null {
	if (typeof correlationId !== "string") {
		return null;
	}
	const match = /\/L(\d+)\/node-\d+$/.exec(correlationId);
	return match === null ? null : Number(match[1]);
}

// ────────────────────────────────────────────────────────────────────────────
// launchChildForRole — switch по childRole.
// ────────────────────────────────────────────────────────────────────────────

/** F-4: role-aware switch. role=super-orchestrator → launchSoChild.
 *  role=worker (default) → launchWorkerChild (existing process-manager.spawn
 *  pipeline). Семантика идентична inline switch в depth2-integration.ts. */
export async function launchChildForRole(ctx: LaunchChildContext): Promise<void> {
	if (ctx.child.childRole === "super-orchestrator") {
		await launchSoChild(ctx);
		return;
	}
	await launchWorkerChild(ctx);
}

// ────────────────────────────────────────────────────────────────────────────
// F-2 fix: diag event helper + log-path resolver.
// ────────────────────────────────────────────────────────────────────────────

/** F-2 fix: путь к лог-файлу stdout/stderr ребёнка (по конвенции process-manager:
 *  <missionDir>/logs/child-<sanitized-id>.log). Используется launchWorkerChild
 *  для diag event при преждевременной смерти ребёнка. */
function childLogPathFor(missionDir: string, nodeId: string): string {
	return join(missionDir, "logs", `child-${nodeId.split("/").join("-")}.log`);
}

/** F-2 fix: написать diag event в журнал, если ребёнок уже мёртв
 *  (getNodeExitInfo возвращает non-null). Без DI — no-op.
 *  F-26 fix: async — даём событию exit (macrotask) шанс сработать
 *  до чтения exitInfo. При reject sendPackage (microtask) exit handler
 *  ещё не отработал → exitInfo null → diag терялся. Пауза ~100ms
 *  даёт Node.js цикл обработать exit event. */
async function writeDiagIfDead(opts: LaunchChildOptionsLike, journal: TreeJournal, ctx: {
	nodeId: string;
	correlationId: string;
	diag: string;
}): Promise<boolean> {
	// F-26: даём macrotask (child.on('exit')) шанс сработать.
	await new Promise((resolve) => setTimeout(resolve, 100));
	const exitInfo = opts.getNodeExitInfo?.(ctx.nodeId) ?? null;
	if (exitInfo === null) {
		return false;
	}
	journal.write({
		event: "diag",
		nodeId: ctx.nodeId,
		parentId: ROOT_NODE_ID,
		correlationId: ctx.correlationId,
		depth: CHILD_DEPTH,
		diag: `${ctx.diag}: code=${exitInfo.code ?? "null"}, signal=${exitInfo.signal ?? "null"}`,
		exitCode: exitInfo.code,
		signal: exitInfo.signal,
		logPath: childLogPathFor(opts.missionDir, ctx.nodeId),
	});
	return true;
}

// ────────────────────────────────────────────────────────────────────────────
// launchWorkerChild — extracted worker spawn pipeline.
// ────────────────────────────────────────────────────────────────────────────

/** Worker pipeline: spawn → journal spawn → readiness-wait → sendPackage →
 *  boundary validation (F-38) → recordUsage → journal complete → release.
 *  Логика 1:1 как inline launchChild worker-path в depth2-integration.ts:
 *  guard уже отработал, allocator уже allocate()'нул; остальная часть pipeline
 *  (spawn → wait → send → report) переехала сюда без изменений. */
export async function launchWorkerChild(ctx: LaunchChildContext): Promise<void> {
	const { runOpts, opts, aggregator, journal, portPool, activeNodes, reports } = ctx;
	const { spawnArgs, allocation, child, aborted, pendingSpawns, correlationId, manifest } = ctx;
	const spawnNode = opts.spawnNode;
	const sendPackage = opts.sendPackage;
	const { nodeId } = child;

	if (!spawnNode) {
		throw new Error("spawnNode is not configured (DI required)");
	}

	const port = portPool.allocate(nodeId);
	const token = generateNodeToken();
	let pid: number;
	const spawnPromise = spawnNode({
		id: nodeId,
		port,
		token,
		nodeName: nodeId,
		args: spawnArgs,
	});
	pendingSpawns.add(spawnPromise);
	try {
		({ pid } = await spawnPromise);
	} catch (error) {
		// Аллокация НЕ возвращается (потрачена на попытку), порт — освобождаем.
		portPool.release(nodeId);
		throw error;
	} finally {
		pendingSpawns.delete(spawnPromise);
	}

	// F1: abort() вызван во время ожидания spawnNode — узел родился
	// после kill-цикла. Убиваем сразу, не продолжая пайплайн.
	if (aborted.value) {
		if (opts.killNode) {
			try {
				await opts.killNode(nodeId);
			} catch {
				/* best-effort */
			}
		}
		journal.write({
			event: "abort",
			nodeId,
			parentId: ROOT_NODE_ID,
			correlationId,
			depth: CHILD_DEPTH,
		});
		portPool.release(nodeId);
		return;
	}

	journal.write({
		event: "spawn",
		nodeId,
		parentId: ROOT_NODE_ID,
		correlationId,
		task: child.task,
		depth: CHILD_DEPTH,
		port,
		pid,
		via: "spawn",
	});
	activeNodes.set(nodeId, { correlationId });

	// Readiness-wait: узел порождён, но процесс ещё бутается
	// (расширения, провайдеры ~10s). Без паузы WS-коннект
	// sendPackage мгновенно упадёт «Unable to connect». DI-опция;
	// не задана — пропускается (поведение прежнее).
	if (opts.waitForReady) {
		try {
			await opts.waitForReady(port);
		} catch (readyError) {
			// abort() во время ожидания → узел уже убит/журналирован
			// в kill-цикле abort(); если ещё нет — узел всё ещё в
			// activeNodes, abort() подхватит. Без дублирующего
			// journal/kill: иначе двойная запись.
			if (aborted.value) {
				return;
			}
			// F-2 fix: если ребёнок умер до того, как /api/health ответил 200,
			// пишем diag event с exitCode/signal/logPath ДО fail event для
			// постмортемной диагностики (раньше stderr терялся — stdio:"ignore").
			await writeDiagIfDead(opts, journal, {
				nodeId,
				correlationId,
				diag: "child exited before readiness wait completed",
			});
			// Иначе — та же политика что F2 (отказ sendPackage):
			// fail-запись, освобождение порта, возврат аллокации,
			// kill узла, run бросает.
			journal.write({
				event: "fail",
				nodeId,
				parentId: ROOT_NODE_ID,
				correlationId,
				depth: CHILD_DEPTH,
			});
			portPool.release(nodeId);
			activeNodes.delete(nodeId);
			aggregator.onNodeComplete(nodeId, allocation);
			if (opts.killNode) {
				try {
					await opts.killNode(nodeId);
				} catch {
					/* best-effort */
				}
			}
			throw readyError;
		}
		// Повторная проверка aborted после ожидания: kill-switch мог
		// сработать, пока мы ждали готовности узла. Узел остаётся в
		// activeNodes — abort() подхватит в kill-цикле (идемпотентно).
		if (aborted.value) {
			return;
		}
	}

	if (aborted.value || !sendPackage) {
		return;
	}
	const workPackage = createWorkPackage({
		task: child.task,
		correlationId,
		depth: CHILD_DEPTH,
		tokenBudget: allocation.tokens,
		costBudgetUsd: allocation.usd,
		toolManifest: manifest,
		deadline: runOpts.deadline,
	});
	let report: NodeReport;
	try {
		// F-38: колбэк граничной валидации клиента → журнал миссии
		// (validation_failed). DI-реализация sendPackage, создающая
		// child-node-client внутри, пробрасывает колбэк в клиент.
		const onValidationFailed = (failure: ValidationFailureInfo): void => {
			journal.write({
				event: "validation_failed",
				nodeId: failure.nodeId ?? nodeId,
				parentId: ROOT_NODE_ID,
				correlationId: failure.correlationId ?? correlationId,
				depth: CHILD_DEPTH,
				diag: failure.diag,
			});
		};
		report = await sendPackage({ port, token, workPackage, onValidationFailed });
		// F-38: validateDepth на границе приёма отчёта. Зафиксированная точка:
		// здесь известны обе глубины — ожидаемая (ROOT_DEPTH + 1) и фактическая
		// (L<N> в correlationId отчёта, присланного транспортом). В клиенте
		// (child-node-client) проверка была бы мёртвой: отчёт собирается из
		// meta пакета, поэтому его глубина тривиально совпадает с ожидаемой.
		const reportDepth = depthFromCorrelationId(report?.correlationId);
		const depthCheck =
			reportDepth === null
				? {
						valid: false,
						errors: [
							{
								field: "correlationId",
								message: `cannot parse depth from report correlationId: ${String(report?.correlationId)}`,
							},
						],
					}
				: validateDepth(ROOT_DEPTH, reportDepth);
		if (!depthCheck.valid) {
			const diag = depthCheck.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
			journal.write({
				event: "validation_failed",
				nodeId,
				parentId: ROOT_NODE_ID,
				correlationId,
				depth: CHILD_DEPTH,
				diag,
			});
			throw new Error(`Incoming node report rejected by boundary validation: ${diag}`);
		}
	} catch (sendError) {
		// F-2 fix: если ребёнок умер во время/после sendPackage —
		// diag event с exit info ДО fail event.
		await writeDiagIfDead(opts, journal, {
			nodeId,
			correlationId,
			diag: "child exited during sendPackage",
		});
		// F2: отказ sendPackage — fail-запись, очистка, возврат аллокации.
		journal.write({
			event: "fail",
			nodeId,
			parentId: ROOT_NODE_ID,
			correlationId,
			depth: CHILD_DEPTH,
		});
		portPool.release(nodeId);
		activeNodes.delete(nodeId);
		aggregator.onNodeComplete(nodeId, allocation);
		if (opts.killNode) {
			try {
				await opts.killNode(nodeId);
			} catch {
				/* best-effort */
			}
		}
		throw sendError;
	}
	if (aborted.value) {
		return; // kill-switch сработал до отчёта — complete не пишем
	}

	const usage = totalUsage(report);
	aggregator.recordUsage(nodeId, usage);
	journal.write({
		event: "complete",
		nodeId,
		parentId: ROOT_NODE_ID,
		correlationId,
		depth: CHILD_DEPTH,
		usage: { tokens: usage.inputTokens + usage.outputTokens, usd: usage.costUsd },
	});
	aggregator.onNodeComplete(nodeId, allocation);
	activeNodes.delete(nodeId);
	portPool.release(nodeId);
	reports.push({ nodeId, report });
	// Kill worker child after successful completion — prevent orphan processes.
	// Best-effort: node is already removed from activeNodes and port released.
	if (opts.killNode) {
		try {
			await opts.killNode(nodeId);
		} catch {
			/* best-effort */
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// launchSoChild — extracted SO HTTP delegation.
// ────────────────────────────────────────────────────────────────────────────

/** F-4: super-orchestrator launch — HTTP delegation вместо process spawn.
 *  Контракт (минимальный, additive): проверка role_profile (обязательна
 *  — enforced вызывающей стороной в depth2-integration launchChild ДО этого
 *  вызова), один HTTP POST к parent /api/mission-delegate через
 *  opts.httpDelegate (DI) или globalThis.fetch (NODE 18+, default),
 *  запись spawn в журнал с via: "http_delegate". Без sendPackage/
 *  complete — результат SO приходит асинхронно через WS
 *  (mission_delegate_result:<id>), это вне скоупа F-4.
 *  Семантика 1:1 inline launchSoChild в depth2-integration.ts. */
export async function launchSoChild(ctx: LaunchChildContext): Promise<void> {
	const { runOpts, opts, aggregator, journal, child, allocation, correlationId } = ctx;
	const { nodeId } = child;
	// F-4: default parentUrl — пустая строка + "/api/mission-delegate".
	// Прод-вызов передаёт FAN_PARENT_NODE_URL явно через runOpts.parentUrl;
	// default существует только для back-compat и unit-тестов.
	const parentUrl = runOpts.parentUrl ?? "http://127.0.0.1";
	const parentToken = runOpts.parentToken ?? generateNodeToken();
	const url = `${parentUrl}/api/mission-delegate`;
	// F-4: payload — MissionDelegatePayload shape (api-gateway schema).
	// parentReportId синтетический (L0 не имеет upstream report в
	// скоупе depth-2); для idempotency используется nodeId-prefix.
	const payload = {
		parentReportId: `parent-report-${correlationId}`,
		parentCorrelationId: correlationId,
		role: "super-orchestrator",
		role_profile: runOpts.roleProfile,
		depth: CHILD_DEPTH,
		packages: runOpts.packages ?? [],
		lineage: [correlationId],
	};
	const authHeader = `Bearer ${parentToken}`;
	// F-4: DI httpDelegate предпочтителен (testability); иначе — globalThis.fetch.
	const delegate: HttpDelegate = opts.httpDelegate ?? globalFetchDelegate;
	const result = await delegate(url, payload, authHeader);
	if (!result.ok) {
		// Отказ HTTP delegation: fail-запись + возврат аллокации.
		// Без kill — нет child-процесса; без sendPackage/complete —
		// родитель узнает о провале через diag.
		journal.write({
			event: "fail",
			nodeId,
			parentId: ROOT_NODE_ID,
			correlationId,
			depth: CHILD_DEPTH,
			diag: `HTTP delegation failed: status=${result.status ?? "unknown"}`,
		});
		aggregator.onNodeComplete(nodeId, allocation);
		throw new Error(
			`HTTP delegation to ${url} failed: status=${result.status ?? "unknown"}`,
		);
	}
	journal.write({
		event: "spawn",
		nodeId,
		parentId: ROOT_NODE_ID,
		correlationId,
		task: child.task,
		depth: CHILD_DEPTH,
		via: "http_delegate",
	});
}
