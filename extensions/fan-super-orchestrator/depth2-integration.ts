// F-34: MVP глубины 2 (L0 → 3–4×L1) — сквозная интеграция модулей фаз A/B.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-34
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Сквозной контур: reconcile (F-33) → цикл по children: canSpawn (F-25) →
// computeChildAllocation + allocate (F-31/F-30) → generateNodeToken (F-24) →
// spawnNode (DI, прод: process-manager F-23) → journal spawn (F-32) →
// createWorkPackage (F-27) + sendPackage (F-29 DI) → NodeReport (F-28) →
// recordUsage + journal complete + onNodeComplete (F-30).
// Kill-switch: abort() останавливает всё дерево (killNode DI + journal abort).
//
// Закреплённые решения (judgment calls RED-фазы):
//   • Аллокация единообразная: computeChildAllocation от состояния на старт
//     run с plannedChildren = children — все дети получают одинаковую долю;
//   • Fan-out конкурентный: все дети порождаются и пакеты отправляются без
//     ожидания отчётов друг друга (Promise.all); порядок journal-записей
//     spawn перед complete выдерживается внутри узла;
//   • Ошибка spawnNode: аллокация НЕ возвращается (потрачена на попытку),
//     run бросает; аллокации успешно порождённых узлов удерживаются;
//   • Аллокация при abort между allocate и spawn НЕ возвращается
//     (политика «потрачено на попытку», консистентно с ошибкой spawn);
//   • Отказ sendPackage (сеть/таймаут): журнал fail-запись, порт
//     освобождается, узел удаляется из activeNodes, аллокация возвращается
//     (узел ничего не потребил), killNode (catch), run бросает;
//   • abort(): флаг + ожидание pending-spawn промисов + killNode всех
//     активных узлов + journal abort + освобождение портов; отчёты,
//     пришедшие после abort, как complete не записываются; идемпотентен.
//     Узел, чей spawnNode разрешился во время abort, убивается
//     самопроверкой флага aborted в launchChild (до добавления в
//     activeNodes) или второй волной killNode в abort().

import { join } from "node:path";
import {
	type BudgetAggregator,
	type BudgetAmount,
	createBudgetAggregator,
	emptyBudgetState,
} from "./budget-aggregator.js";
import { computeChildAllocation, createMissionBudgetStore } from "./budget-coordinator.js";
import { canSpawn, type DepthWidthGuardOptions } from "./depth-width-guard.js";
import { generateNodeToken } from "./node-auth.js";
import { type NodeReport, totalUsage } from "./node-report.js";
import { PortPool } from "./port-pool.js";
import { reconcile } from "./startup-reconciliation.js";
import { InvalidToolManifestError, validateManifest } from "./tool-manifest.js";
import { createTreeJournal, type TreeJournal } from "./tree-journal.js";
import { buildToolArgs, createWorkPackage, makeCorrelationId, type WorkPackage } from "./work-package.js";

/** Опции запуска depth-2 контура. */
export interface Depth2RunOptions {
	/** Эпик (дефолтные задачи детей: `${task} — часть N`, N с 1). */
	task: string;
	/** Количество детей L1 (3–4). */
	children: number;
	/** Переопределение задач детей (по индексу). */
	childTasks?: string[];
	/** Манифест инструментов → валидация (F-37) → buildToolArgs → --tools в argv spawn. */
	toolManifest?: string[];
	/** ISO-8601 deadline, общий для всех пакетов. */
	deadline: string;
}

/** Параметры spawn-вызова (DI; прод — process-manager F-23). */
export interface Depth2SpawnOpts {
	id: string;
	port: number;
	token: string;
	nodeName: string;
	args: string[];
}

/** Параметры отправки пакета (DI; прод — child-node-client F-29). */
export interface Depth2SendOpts {
	port: number;
	token: string;
	workPackage: WorkPackage;
}

/** Опции фабрики интеграции. */
export interface Depth2Options {
	/** Каталог миссии: mission-budget.json + tree-journal.jsonl в нём. */
	missionDir: string;
	missionId: string;
	budgetTotal: { tokens: number; usd: number };
	/** Потолок токенов на ребёнка (default 30000). */
	perHopCeiling?: number;
	guardOptions?: DepthWidthGuardOptions;
	spawnNode?: (opts: Depth2SpawnOpts) => Promise<{ pid: number }>;
	sendPackage?: (opts: Depth2SendOpts) => Promise<NodeReport>;
	killNode?: (id: string) => Promise<void>;
	/** Default: <missionDir>/child-ports.json. */
	portsFile?: string;
	/** Default: <missionDir>/pids. */
	pidDir?: string;
}

/** Результат depth-2 запуска. */
export interface Depth2Result {
	reports: Array<{ nodeId: string; report: NodeReport }>;
	budget: {
		allocated: BudgetAmount;
		consumed: BudgetAmount;
		byBranch: Record<string, BudgetAmount>;
	};
	journalEntries: number;
	durationMs: number;
}

/** Handle интеграции: запуск контура + kill-switch. */
export interface Depth2Handle {
	run(opts: Depth2RunOptions): Promise<Depth2Result>;
	/** Идемпотентен; kill-switch всего дерева. */
	abort(): Promise<void>;
}

/** Корень дерева depth-2 (L0). */
const ROOT_NODE_ID = "L0";
/** Глубина порождаемых детей. */
const CHILD_DEPTH = 1;

/** Handle depth-2 интеграции поверх модулей фаз A/B. */
export function createDepth2Integration(opts: Depth2Options): Depth2Handle {
	const portsFile = opts.portsFile ?? join(opts.missionDir, "child-ports.json");
	const pidDir = opts.pidDir ?? join(opts.missionDir, "pids");
	const journal: TreeJournal = createTreeJournal(join(opts.missionDir, "tree-journal.jsonl"));
	const budgetStore = createMissionBudgetStore(
		join(opts.missionDir, "mission-budget.json"),
		opts.missionId,
		emptyBudgetState(opts.budgetTotal.tokens, opts.budgetTotal.usd),
	);
	const aggregator: BudgetAggregator = createBudgetAggregator(budgetStore);
	const portPool = new PortPool(portsFile);

	let aborted = false;
	/** Активные (порождённые, не завершённые) узлы: kill-switch цель. */
	const activeNodes = new Map<string, { correlationId: string }>();
	/** In-flight spawnNode промисы: abort дожидается перед kill-циклом. */
	const pendingSpawns = new Set<Promise<unknown>>();

	async function run(runOpts: Depth2RunOptions): Promise<Depth2Result> {
		const startedAt = Date.now();

		// 1. Стартовая сверка: зачистка orphan-записей portsFile прошлой сессии.
		await reconcile({ portsFile, pidDir, journal });

		// 2. Единообразная аллокация: от состояния на старт, plannedChildren = children.
		const allocation = computeChildAllocation(aggregator.state(), runOpts.children, opts.perHopCeiling);
		// F-37: fail-fast валидация манифеста до allocate/spawn; []/undefined =
		// «не ограничен» (все инструменты родителя, --tools не добавляется).
		// При невалидном манифесте — событие tool_blocked в журнал (diag =
		// причина валидации) и throw ДО порождения любого дочернего процесса.
		const rawManifest = runOpts.toolManifest ?? [];
		let manifest: string[] = [];
		if (rawManifest.length > 0) {
			try {
				manifest = validateManifest(rawManifest);
			} catch (error) {
				if (error instanceof InvalidToolManifestError) {
					journal.write({
						event: "tool_blocked",
						nodeId: ROOT_NODE_ID,
						depth: 0,
						diag: error.message,
					});
				}
				throw error;
			}
		}
		const spawnArgs = buildToolArgs(manifest);
		const reports: Array<{ nodeId: string; report: NodeReport }> = [];

		const spawnNode = opts.spawnNode;
		const sendPackage = opts.sendPackage;

		// Пайплайн одного ребёнка: guard → allocate → spawn → журнал → пакет →
		// отчёт → usage → complete → возврат аллокации. Флаг aborted проверяется
		// между шагами: после abort() новые spawn/send не стартуют, пришедший
		// отчёт как complete не записывается.
		async function launchChild(index: number): Promise<void> {
			const nodeId = `L1/node-${index + 1}`;

			const decision = canSpawn(CHILD_DEPTH, index, opts.guardOptions);
			if (!decision.allowed) {
				throw new Error(`${decision.reason}: depth-2 fan-out stopped at ${nodeId}`);
			}
			if (!aggregator.allocate(nodeId, allocation)) {
				throw new Error(
					`Budget exhausted: cannot allocate ${allocation.tokens} tokens / ${allocation.usd} USD for ${nodeId}`,
				);
			}
			if (aborted) {
				return;
			}
			if (!spawnNode) {
				throw new Error("spawnNode is not configured (DI required)");
			}

			const port = portPool.allocate(nodeId);
			const token = generateNodeToken();
			let pid: number;
			const spawnPromise = spawnNode({ id: nodeId, port, token, nodeName: nodeId, args: spawnArgs });
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
			if (aborted) {
				if (opts.killNode) {
					try {
						await opts.killNode(nodeId);
					} catch {
						/* best-effort */
					}
				}
				const corrId = makeCorrelationId(opts.missionId, CHILD_DEPTH, index + 1);
				journal.write({
					event: "abort",
					nodeId,
					parentId: ROOT_NODE_ID,
					correlationId: corrId,
					depth: CHILD_DEPTH,
				});
				portPool.release(nodeId);
				return;
			}

			const correlationId = makeCorrelationId(opts.missionId, CHILD_DEPTH, index + 1);
			const task = runOpts.childTasks?.[index] ?? `${runOpts.task} — часть ${index + 1}`;
			journal.write({
				event: "spawn",
				nodeId,
				parentId: ROOT_NODE_ID,
				correlationId,
				task,
				depth: CHILD_DEPTH,
				port,
				pid,
			});
			activeNodes.set(nodeId, { correlationId });

			if (aborted || !sendPackage) {
				return;
			}
			const workPackage = createWorkPackage({
				task,
				correlationId,
				depth: CHILD_DEPTH,
				tokenBudget: allocation.tokens,
				costBudgetUsd: allocation.usd,
				toolManifest: manifest,
				deadline: runOpts.deadline,
			});
			let report: NodeReport;
			try {
				report = await sendPackage({ port, token, workPackage });
			} catch (sendError) {
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
			if (aborted) {
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
		}

		// 3. Конкурентный fan-out: все дети стартуют без ожидания отчётов.
		await Promise.all(Array.from({ length: runOpts.children }, (_, index) => launchChild(index)));

		const state = aggregator.state();
		return {
			reports,
			budget: { allocated: state.allocated, consumed: state.consumed, byBranch: state.byBranch },
			journalEntries: journal.readAll().length,
			durationMs: Date.now() - startedAt,
		};
	}

	async function abort(): Promise<void> {
		if (aborted) {
			return; // идемпотентность
		}
		aborted = true;

		// F1: дожидаемся in-flight spawnNode промисов. Узлы, чей spawn
		// разрешился во время abort, либо убиваются самопроверкой флага
		// aborted в launchChild, либо попадают в activeNodes и будут
		// убиты kill-циклом ниже.
		if (pendingSpawns.size > 0) {
			await Promise.allSettled([...pendingSpawns]);
		}

		for (const [nodeId, info] of [...activeNodes]) {
			if (opts.killNode) {
				try {
					await opts.killNode(nodeId);
				} catch (error) {
					console.warn(`[depth2-integration] killNode failed for "${nodeId}":`, error);
				}
			}
			journal.write({
				event: "abort",
				nodeId,
				parentId: ROOT_NODE_ID,
				correlationId: info.correlationId,
				depth: CHILD_DEPTH,
			});
			portPool.release(nodeId);
			activeNodes.delete(nodeId);
		}
	}

	return { run, abort };
}
