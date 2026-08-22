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
import type { ValidationFailureInfo } from "./child-node-client.js";
import { canSpawn, type DepthWidthGuardOptions } from "./depth-width-guard.js";
import { type NodeReport } from "./node-report.js";
import { PortPool } from "./port-pool.js";
import { reconcile } from "./startup-reconciliation.js";
import { InvalidToolManifestError, validateManifest } from "./tool-manifest.js";
import { createTreeJournal, type TreeJournal } from "./tree-journal.js";
import { buildToolArgs, makeCorrelationId, type WorkPackage } from "./work-package.js";
import {
	CHILD_DEPTH,
	ROOT_DEPTH,
	ROOT_NODE_ID,
	launchChildForRole,
	type HttpDelegate,
	type LaunchChildContext,
	type LaunchChildChildInfo,
	type LaunchChildSpawnOpts,
	type WaitForReady,
} from "./routes/launch-child.js";

// F-4 Refactor: HttpDelegate переехал в ./routes/launch-child.js. Re-export
// для back-compat внешних импортов (Depth2Options.httpDelegate сохраняет тип).
export type { HttpDelegate };

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
	/** F-4: роль дочернего узла. Default "worker" — process-manager.spawn
	 *  (existing path). "super-orchestrator" — HTTP POST /api/mission-delegate
	 *  в родительский fan server (recursive wiring). */
	role?: "worker" | "super-orchestrator";
	/** F-4: профиль роли (FAN_NODE_ROLE_PROFILE); mandatory при role=super-orchestrator.
	 *  Для worker — игнорируется. */
	roleProfile?: string;
	/** F-4: URL родительского fan server (FAN_PARENT_NODE_URL); используется
	 *  при role=super-orchestrator для HTTP delegation. Default — пустая
	 *  строка + `/api/mission-delegate` (test/dev path). */
	parentUrl?: string;
	/** F-4: Bearer token родителя (FAN_PARENT_NODE_TOKEN); используется при
	 *  role=super-orchestrator для Authorization: Bearer <token>. */
	parentToken?: string;
	/** F-4: work packages для SO delegation (MissionDelegatePayload.packages);
	 *  required при role=super-orchestrator. */
	packages?: unknown[];
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
	/** F-38: колбэк граничной валидации, подключённый к журналу миссии
	 *  (validation_failed). DI-реализация, создающая child-node-client внутри,
	 *  пробрасывает его в createChildNodeClient({ onValidationFailed }). */
	onValidationFailed?: (failure: ValidationFailureInfo) => void;
}

// F-4 Refactor: WaitForReady re-exported из ./routes/launch-child.js
// через `export type { WaitForReady }` ниже (для стабильности публичного API).

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
	/** DI: ожидание готовности дочернего узла после spawn и до sendPackage.
	 *  Контракт: бросает на таймаут/ошибку; не возвращает успех, пока узел
	 *  не примет пакеты. Не задан → пропускается (поведение прежнее). */
	waitForReady?: WaitForReady;
	sendPackage?: (opts: Depth2SendOpts) => Promise<NodeReport>;
	killNode?: (id: string) => Promise<void>;
	/** F-4: HTTP-делегат для role=super-orchestrator. Default — globalThis.fetch
	 *  (NODE 18+). Тесты мокают через vi.spyOn(globalThis, "fetch"). */
	httpDelegate?: HttpDelegate;
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

// F-4 Refactor: константы ROOT_NODE_ID/ROOT_DEPTH/CHILD_DEPTH, функция
// depthFromCorrelationId и globalFetchDelegate переехали в ./routes/launch-child.js
// (нужны только role-routing pipeline). Внешние симптомы не меняются.

// F-4 Refactor: WaitForReady re-export для стабильности публичного API
// (используется в Depth2Options.waitForReady). Изначальный export type
// удалён вместе с переездом в routes/launch-child.ts.
export type { WaitForReady };

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

	let aborted = { value: false };
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

		// F-4 Refactor: role-aware spawn-pipeline (worker spawn → wait → send →
		// report → complete) и SO HTTP delegation переехали в
		// ./routes/launch-child.js. Здесь остаётся только orchestration: guard →
		// role_profile validation → allocate → context-build → launchChildForRole.
		async function launchChild(index: number): Promise<void> {
			const nodeId = `L1/node-${index + 1}`;
			// F-4: резолв role из runOpts. Default "worker" — back-compat с
			// existing path (process-manager.spawn).
			const childRole: LaunchChildChildInfo["childRole"] = runOpts.role ?? "worker";

			const decision = canSpawn(CHILD_DEPTH, index, opts.guardOptions);
			if (!decision.allowed) {
				throw new Error(`${decision.reason}: depth-2 fan-out stopped at ${nodeId}`);
			}
			// F-4: fail-fast валидация role_profile для super-orchestrator.
			// Без roleProfile SO не имеет смысла (нет профиля роли для recursive
			// wiring → spawned узел не сможет инициализировать circuit). Throw
			// ДО allocate/spawn — никаких side-effects на диск/journal/порт.
			if (childRole === "super-orchestrator" && !runOpts.roleProfile) {
				throw new Error("role_profile required for super-orchestrator");
			}
			if (!aggregator.allocate(nodeId, allocation)) {
				throw new Error(
					`Budget exhausted: cannot allocate ${allocation.tokens} tokens / ${allocation.usd} USD for ${nodeId}`,
				);
			}
			if (aborted.value) {
				return;
			}

			const correlationId = makeCorrelationId(opts.missionId, CHILD_DEPTH, index + 1);
			const task = runOpts.childTasks?.[index] ?? `${runOpts.task} — часть ${index + 1}`;
			const child: LaunchChildChildInfo = { index, nodeId, task, childRole };

			// F-4 Refactor: build LaunchChildContext (mutable refs на activeNodes,
			// pendingSpawns, reports, aborted) и delegate role-routing в
			// ./routes/launch-child.js::launchChildForRole. Логика 1:1 как inline.
			const ctx: LaunchChildContext = {
				runOpts,
				opts,
				manifest,
				spawnArgs,
				allocation,
				aggregator,
				journal,
				portPool,
				aborted,
				pendingSpawns,
				activeNodes,
				reports,
				child,
				correlationId,
			};
			await launchChildForRole(ctx);
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
		if (aborted.value) {
			return; // идемпотентность
		}
		aborted.value = true;

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
