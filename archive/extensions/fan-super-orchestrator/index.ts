// F-SO-INDEX: Расширение fan-super-orchestrator — entry-point (F-48.5 wiring).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23..§F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3, §3.5, §8
//
// F-48.5 «Wiring mission-loop → super-orchestrator»:
//   1. session_start + активная миссия (self-contained детектор: скан
//      <cwd>/docs/missions/*/MISSION.md frontmatter status, подход
//      fan-scheduler findActiveMission — БЕЗ импорта fan-mission) → init
//      контура: tree-journal.jsonl в missionDir (createTreeJournal),
//      бюджет миссии из frontmatter, startup-reconciliation (best-effort),
//      подписка fan.events.on("mission_delegate", handler);
//   2. mission_delegate → guard canSpawnBatch (depth из FAN_ORCHESTRATOR_DEPTH,
//      batch = packages.length) → depth2-integration.run (journal/budget/
//      port-pool/node-auth — реальные модули; spawn/send — DI, см. ниже) →
//      emit replyEvent { results[], totalUsage } либо { error };
//   3. correlationId: каждый запрос обрабатывается отдельным depth2-handle —
//      параллельные запросы не пересекаются;
//   4. session_shutdown → abort всех активных depth2-handle (kill-switch
//      узлов) + отписка от mission_delegate. Идемпотентно; без session_start
//      — no-op.
//
// Формат событий (EventBus):
//   ВХОДЯЩЕЕ mission_delegate:
//     { missionDir: string, correlationId: string,
//       packages: [{ task: string, tokenBudget?: number, toolManifest?: string[] }],
//       replyEvent: "mission_delegate_result:<correlationId>" }
//   ИСХОДЯЩЕЕ mission_delegate_result:<correlationId>:
//     success: { results: [{ status, resultText }], totalUsage: { tokens, usd } }
//     error:   { error: string }
//
// Закреплённое решение (FIX F-48.5, дефект «ложный COMPLETE»): дефолтный
// исполнитель узлов — РЕАЛЬНЫЙ spawn дочерних fan server через
// process-manager (launch/terminate) и отправка пакетов через
// child-node-client (sendWorkPackage) — как в адаптерах
// test/phase-gate-c.e2e.mjs (включая проброс onValidationFailed → journal
// через depth2-integration). Никаких in-process фабрикаций completed: если
// реальный контур невозможен (нет активной миссии/missionDir, авария
// spawn/send), handler отвечает {error: "..."}. DI (opts.spawnNode/
// opts.sendPackage/opts.killNode либо opts.createDepth2) переопределяет
// дефолты — в тестах и нестандартных окружениях.
//
// Граница L1→L0 (FIX F-48.5, дефект «resultText без санитизации»): текст
// отчёта узла — недоверенный ввод; mapDepth2ResultToReply пропускает
// resultText через clean() (message-sanitizer) ДО emit replyEvent, поэтому
// promise-теги/prompt-injection дочерних узлов не попадают в контур L0 raw.

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

// F-Diag (REFACTOR, depth-2): подключение chat-logger / extension-health ─────
//
// Статус на этой фазе: GREEN (модули chat-logger.ts и extension-health.ts
// реализованы и покрыты 9 unit-тестами в test/diagnostics.test.mjs), но
// WIRING в этот index.ts НЕ выполнен — нет подходящих точек замены.
//
// Что проверялось (audit 2026-08-21):
//   1. session_start hook (ниже): нет console.log/error на happy path,
//      только console.warn в catch для провала session_start hook.
//   2. handleDelegate entry (ниже): нет console.log/error при входе;
//      console.warn только в catch для ошибок emit/sub-handler.
//   3. error reply: использует emitReply(replyEvent, {error: <msg>}) —
//      event-bus, не console.error.
//
// Существующие console.* в файле — только console.warn в 4 catch-блоках
// (reply emit fail, startup reconciliation fail, depth2 abort fail,
// session_start hook fail). Это best-effort warning, не diagnostic
// event в формате SPEC §14. Заменять их на sendSessionStartMessage /
// logHandlerEntry / formatErrorReply — нарушение контракта (те
// вызываются в success-path, а здесь — fail-path).
//
// TODO(F-Diag-INTEG): когда green существующей инфраструктуры вырастет
// до явных console.log в session_start/handler entry/error reply —
// подключить хелперы:
//   - session_start → sendSessionStartMessage({ correlationId, role:
//     "super-orchestrator", roleProfile, depth, lineageLen, chatEmitter });
//   - handleDelegate → logHandlerEntry({ correlationId, packages,
//     roleProfile, chatEmitter });
//   - error reply → formatErrorReply({ correlationId, error,
//     attemptedEscalationTo });
// Контракт см. в chat-logger.ts / extension-health.ts.
import { createChildNodeClient } from "./child-node-client.js";
import { canSpawnBatch, currentDepthFromEnv, type DepthWidthGuardOptions } from "./depth-width-guard.js";
import {
	createDepth2Integration,
	type Depth2Handle,
	type Depth2Options,
	type Depth2SendOpts,
	type Depth2SpawnOpts,
	type WaitForReady,
} from "./depth2-integration.js";
import { clean } from "./message-sanitizer.js";
import type { NodeReport } from "./node-report.js";
import { createProcessManager } from "./process-manager.js";
import type { RoleProfile } from "./role-loader.js";
import { reconcile } from "./startup-reconciliation.js";
import { createTreeJournal, type TreeJournal } from "./tree-journal.js";
import {
	initRecursiveCircuit,
	type RecursiveCircuit,
	ROLE_SUPER_ORCHESTRATOR,
	shutdownRecursiveCircuit,
} from "./wiring/spawned-orchestrator.js";

// ─── Константы и типы событий ───────────────────────────────────────────────

/** Канал запроса делегирования (mission-loop → super-orchestrator). */
export const DELEGATE_CHANNEL = "mission_delegate";

/** Канал ответа делегирования для конкретного correlationId. */
export function delegateResultChannel(correlationId: string): string {
	return `mission_delegate_result:${correlationId}`;
}

/** F-5: маркер роли spawned super-orchestrator (см. process-manager.ts buildSpawnEnv).
 *  Re-exported из wiring/spawned-orchestrator.ts (source of truth после F-5 рефакторинга). */
export { ROLE_SUPER_ORCHESTRATOR } from "./wiring/spawned-orchestrator.js";

/** Deadline пакетов по умолчанию (30 минут). */
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

/** Интервал poll готовности дочернего узла (мс). */
const READY_POLL_INTERVAL_MS = 500;
/** Таймаут одного fetch к /api/health (мс). */
const READY_POLL_PER_TRY_MS = 3_000;
/** Общий таймаут readiness-wait по умолчанию (мс). */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Подзадача в составе mission_delegate.packages. */
export interface DelegatePackage {
	task: string;
	tokenBudget?: number;
	toolManifest?: string[];
}

/** Входящее событие mission_delegate. */
export interface MissionDelegatePayload {
	missionDir: string;
	correlationId: string;
	packages: DelegatePackage[];
	replyEvent: string;
}

/** Успешный ответ делегирования. */
export interface DelegateSuccessReply {
	results: Array<{ status: string; resultText: string }>;
	totalUsage: { tokens: number; usd: number };
}

// ─── Детектор активной миссии (самодостаточный, без импорта fan-mission) ────

/** Не-терминальные статусы миссии: при них контур супер-оркестратора активен. */
const NON_TERMINAL = new Set(["active", "paused", "awaiting_decision"]);

/** Читает строковое поле frontmatter MISSION.md (между --- маркерами). */
function readMissionFrontmatterField(missionDir: string, field: string): string | null {
	try {
		const text = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) return null;
		const line = fm[1].split(/\r?\n/).find((l) => new RegExp(`^${field}\\s*:`).test(l));
		if (!line) return null;
		return line.replace(new RegExp(`^${field}\\s*:\\s*`), "").trim();
	} catch {
		return null;
	}
}

/** Status миссии из frontmatter MISSION.md (null — файла/поля нет). */
export function readMissionStatus(missionDir: string): string | null {
	return readMissionFrontmatterField(missionDir, "status");
}

/** Находит первую не-терминальную миссию в <cwd>/docs/missions/. */
export function findActiveMission(cwd: string): { dir: string; status: string } | null {
	const root = join(cwd, "docs", "missions");
	if (!existsSync(root)) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const status = readMissionStatus(dir);
		if (status && NON_TERMINAL.has(status)) return { dir, status };
	}
	return null;
}

/** Бюджет миссии из frontmatter (budget_tokens/budget_usd; absent → 0). */
function readMissionBudget(missionDir: string): { tokens: number; usd: number } {
	const tokens = Number(readMissionFrontmatterField(missionDir, "budget_tokens"));
	const usd = Number(readMissionFrontmatterField(missionDir, "budget_usd"));
	return {
		tokens: Number.isFinite(tokens) ? tokens : 0,
		usd: Number.isFinite(usd) ? usd : 0,
	};
}

// ─── Production-адаптеры узлов (реальный контур, FIX F-48.5) ─────────────

/** Потолок дедупликации correlationId: FIFO-очистка старейших записей
 *  против роста памяти (Set сохраняет порядок вставки). */
const MAX_PROCESSED_CORRELATIONS = 1000;

/** Production-дефолты spawn/send/kill на реальных модулях:
 *  process-manager (launch/terminate дочернего `fan server`) +
 *  child-node-client (sendWorkPackage с onValidationFailed → journal через
 *  depth2-integration) — как в адаптерах test/phase-gate-c.e2e.mjs.
 *  ProcessManager делит portsFile с PortPool depth2-integration: запись id
 *  уже создана его пулом, поэтому pm.spawn переиспользует тот же порт.
 *  waitForReady — fetch-poll /api/health (READY_POLL_INTERVAL_MS) с
 *  per-try таймаутом READY_POLL_PER_TRY_MS; общий потолок — readyTimeoutMs.
 *  Без ожидания WS-коннект sendPackage мгновенно упадёт «Unable to
 *  connect» — boot ~10s (расширения, провайдеры). */
function createProductionNodeAdapters(
	missionDir: string,
	readyTimeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): {
	spawnNode: (opts: Depth2SpawnOpts) => Promise<{ pid: number }>;
	waitForReady: WaitForReady;
	sendPackage: (opts: Depth2SendOpts) => Promise<NodeReport>;
	killNode: (id: string) => Promise<void>;
} {
	const pm = createProcessManager({
		portsFile: join(missionDir, "child-ports.json"),
		pidDir: join(missionDir, "pids"),
	});
	const waitForReady: WaitForReady = async (port: number) => {
		const deadline = Date.now() + readyTimeoutMs;
		const url = `http://127.0.0.1:${port}/api/health`;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(READY_POLL_PER_TRY_MS) });
				if (res.ok) {
					return;
				}
			} catch {
				/* ещё не слушает / connect refused / таймаут одной попытки */
			}
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
		}
		throw new Error(`child node not ready on port ${port} within ${readyTimeoutMs}ms`);
	};
	return {
		spawnNode: async (spawnOpts: Depth2SpawnOpts) => {
			const { pid } = await pm.spawn({
				id: spawnOpts.id,
				args: spawnOpts.args,
				token: spawnOpts.token,
				nodeName: spawnOpts.nodeName,
			});
			return { pid };
		},
		waitForReady,
		sendPackage: async (sendOpts: Depth2SendOpts) => {
			const client = createChildNodeClient({ onValidationFailed: sendOpts.onValidationFailed });
			try {
				return await client.sendWorkPackage({
					port: sendOpts.port,
					token: sendOpts.token,
					workPackage: sendOpts.workPackage,
				});
			} finally {
				client.close();
			}
		},
		killNode: (id: string) => pm.kill(id),
	};
}

// ─── Опции wiring ───────────────────────────────────────────────────────────

export interface SuperOrchestratorWireOptions {
	/** DI: фабрика depth2-handle целиком (приоритет над spawn/send/kill). */
	createDepth2?: (opts: Depth2Options) => Depth2Handle;
	/** DI: spawn узла (продакшн — process-manager). */
	spawnNode?: (opts: Depth2SpawnOpts) => Promise<{ pid: number }>;
	/** DI: ожидание готовности узла (продакшн — fetch-poll /api/health). */
	waitForReady?: WaitForReady;
	/** DI: отправка пакета узлу (продакшн — child-node-client). */
	sendPackage?: (opts: Depth2SendOpts) => Promise<NodeReport>;
	/** DI: kill узла (продакшн — process-manager). */
	killNode?: (id: string) => Promise<void>;
	/** Переопределение depth/width guard. */
	guardOptions?: DepthWidthGuardOptions;
	/** Deadline пакетов, мс (default 30 мин). */
	deadlineMs?: number;
	/** Общий таймаут readiness-wait для production-дефолта, мс (default 60с). */
	readyTimeoutMs?: number;
}

export interface SuperOrchestratorWiring {
	/** missionDir активного контура либо null (нет активной миссии). */
	getActiveMissionDir(): string | null;
	/** Abort активных depth2-handle + отписка. Идемпотентно. */
	shutdown(): Promise<void>;
	/** F-5: true — circuit инициализирован в recursive-режиме (spawned SO),
	 *  false — worker/legacy flow (initCircuit, без handleDelegateRecursive). */
	isRecursive(): boolean;
	/** F-5: role profile текущего контура (после loadRoleCatalog), либо undefined
	 *  если role profile не загружался (worker flow или нет FAN_NODE_ROLE_PROFILE). */
	getRoleProfile(): RoleProfile | undefined;
}

// ─── Валидация и маппинг ────────────────────────────────────────────────────

/** Минимальная валидация входящего payload; null — невалиден. */
function parseDelegatePayload(raw: unknown): {
	correlationId: string;
	replyEvent: string;
	packages: DelegatePackage[];
	missionDir: string | null;
} | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const payload = raw as Record<string, unknown>;
	if (typeof payload.correlationId !== "string" || payload.correlationId === "") return null;
	if (!Array.isArray(payload.packages) || payload.packages.length === 0) return null;
	const packages: DelegatePackage[] = [];
	for (const entry of payload.packages) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (typeof record.task !== "string" || record.task.trim() === "") return null;
		const pkg: DelegatePackage = { task: record.task };
		if (typeof record.tokenBudget === "number" && Number.isFinite(record.tokenBudget)) {
			pkg.tokenBudget = record.tokenBudget;
		}
		if (Array.isArray(record.toolManifest) && record.toolManifest.every((t) => typeof t === "string")) {
			pkg.toolManifest = [...(record.toolManifest as string[])];
		}
		packages.push(pkg);
	}
	const replyEvent =
		typeof payload.replyEvent === "string" && payload.replyEvent !== ""
			? payload.replyEvent
			: delegateResultChannel(payload.correlationId);
	return {
		correlationId: payload.correlationId,
		replyEvent,
		packages,
		missionDir: typeof payload.missionDir === "string" && payload.missionDir !== "" ? payload.missionDir : null,
	};
}

/** Объединение toolManifest всех пакетов (dedupe, порядок первого появления). */
function mergeToolManifest(packages: DelegatePackage[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const pkg of packages) {
		for (const tool of pkg.toolManifest ?? []) {
			if (!seen.has(tool)) {
				seen.add(tool);
				merged.push(tool);
			}
		}
	}
	return merged;
}

/** Depth2Result → ответ делегирования (results + totalUsage).
 *  Граница L1→L0: resultText — недоверенный ввод от дочерних узлов,
 *  пропускается через clean() (message-sanitizer) ДО emit (FIX F-48.5). */
function mapDepth2ResultToReply(reports: Array<{ nodeId: string; report: NodeReport }>): DelegateSuccessReply {
	let tokens = 0;
	let usd = 0;
	const results = reports.map(({ nodeId, report }) => {
		tokens += (report.usage?.inputTokens ?? 0) + (report.usage?.outputTokens ?? 0);
		usd += report.usage?.costUsd ?? 0;
		return {
			status: report.status,
			resultText: clean(report.result?.text ?? `Узел ${nodeId}: ${report.status}`),
		};
	});
	return { results, totalUsage: { tokens, usd } };
}

// ─── Фабрика расширения ─────────────────────────────────────────────────────

export default function superOrchestratorExtension(
	fan: ExtensionAPI,
	opts?: SuperOrchestratorWireOptions,
): SuperOrchestratorWiring {
	// Структурное представление fan (допустим mock без on/events — например
	// setup-тесты каркаса: фабрика обязана не падать на пустом объекте).
	const api = fan as unknown as {
		on?: (event: string, handler: (...args: never[]) => unknown) => void;
		events?: {
			emit?: (channel: string, data: unknown) => void;
			on?: (channel: string, handler: (data: unknown) => void) => () => void;
		};
	};

	// Активный контур (один на сессию): создаётся в session_start при
	// обнаружении не-терминальной миссии, снимается в session_shutdown.
	let circuit: {
		missionDir: string;
		journal: TreeJournal;
		unsubDelegate: () => void;
		/** F-5: true — recursive (initRecursiveCircuit), false — worker (initCircuit). */
		isRecursive: boolean;
		/** F-5: role profile (после loadRoleCatalog), undefined если не загружался. */
		roleProfile?: RoleProfile;
	} | null = null;
	// In-flight depth2-handle: цель kill-switch в session_shutdown.
	const activeHandles = new Set<Depth2Handle>();
	// Дедупликация correlationId: production EventBus реплеит последнее
	// событие канала при подписке — повторный запрос не исполняется дважды.
	const processedCorrelations = new Set<string>();

	const emitReply = (replyEvent: string, data: unknown): void => {
		if (typeof api.events?.emit !== "function") {
			return;
		}
		try {
			api.events.emit(replyEvent, data);
		} catch (err) {
			console.warn("[fan-super-orchestrator] reply emit failed:", err);
		}
	};

	/** Создание depth2-handle для missionDir (opts DI → production-дефолты). */
	const createDepth2 = (missionDir: string): Depth2Handle => {
		const budgetTotal = readMissionBudget(missionDir);
		// Production-дефолт: реальный spawn/kill (process-manager),
		// readiness-wait (fetch-poll /api/health) и sendPackage
		// (child-node-client). DI (opts.*) переопределяет дефолты.
		// In-process фабрикации completed НЕТ: при невозможности реального
		// контура run падает, и handler отвечает {error}.
		const production = createProductionNodeAdapters(missionDir, opts?.readyTimeoutMs);
		const depth2Options: Depth2Options = {
			missionDir,
			missionId: basename(missionDir),
			budgetTotal,
			spawnNode: opts?.spawnNode ?? production.spawnNode,
			waitForReady: opts?.waitForReady ?? production.waitForReady,
			sendPackage: opts?.sendPackage ?? production.sendPackage,
			killNode: opts?.killNode ?? production.killNode,
			...(opts?.guardOptions ? { guardOptions: opts.guardOptions } : {}),
		};
		const factory = opts?.createDepth2 ?? createDepth2Integration;
		return factory(depth2Options);
	};

	/** Обработка mission_delegate: guard → depth2.run → reply (TC-3..TC-7). */
	const handleDelegate = async (raw: unknown): Promise<void> => {
		const payload = parseDelegatePayload(raw);
		if (payload === null) {
			// Невалидный запрос: отвечаем на производный канал, если возможен.
			if (typeof raw === "object" && raw !== null) {
				const candidate = (raw as Record<string, unknown>).replyEvent;
				if (typeof candidate === "string" && candidate !== "") {
					emitReply(candidate, { error: "invalid mission_delegate payload" });
				}
			}
			return;
		}
		const { correlationId, replyEvent, packages } = payload;

		if (processedCorrelations.has(correlationId)) {
			return; // уже обработан (в т.ч. реплей EventBus при повторной подписке)
		}
		processedCorrelations.add(correlationId);
		// FIFO-cap против роста памяти: удаляем старейшую запись сверх потолка.
		if (processedCorrelations.size > MAX_PROCESSED_CORRELATIONS) {
			const oldest = processedCorrelations.values().next().value;
			if (oldest !== undefined) {
				processedCorrelations.delete(oldest);
			}
		}

		try {
			// Guard: depth из FAN_ORCHESTRATOR_DEPTH (+1 — глубина детей L1).
			// Batch-семантика: packages.length — размер порождаемой пачки детей,
			// поэтому отказ только при packages.length > workingWidth (> maxWidth).
			const childDepth = currentDepthFromEnv() + 1;
			const decision = canSpawnBatch(childDepth, packages.length, opts?.guardOptions);
			if (!decision.allowed) {
				const error =
					decision.reason === "max_width_exceeded"
						? `max_width_exceeded: ${packages.length} packages exceed the width limit`
						: `max_depth_exceeded: spawn at depth ${childDepth} rejected by depth guard (max depth ${String(decision.maxDepth ?? childDepth)})`;
				emitReply(replyEvent, { error });
				return;
			}

			const missionDir = payload.missionDir ?? circuit?.missionDir;
			if (!missionDir) {
				emitReply(replyEvent, { error: "no active mission: missionDir is not set" });
				return;
			}

			// Каждый запрос — отдельный depth2-handle (TC-7: не пересекаются).
			const handle = createDepth2(missionDir);
			activeHandles.add(handle);
			try {
				const deadlineMs = opts?.deadlineMs ?? DEFAULT_DEADLINE_MS;
				const toolManifest = mergeToolManifest(packages);
				const result = await handle.run({
					task: `EPIC: ${packages.length} подзадач`,
					children: packages.length,
					childTasks: packages.map((pkg) => pkg.task),
					...(toolManifest.length > 0 ? { toolManifest } : {}),
					deadline: new Date(Date.now() + deadlineMs).toISOString(),
				});
				emitReply(replyEvent, mapDepth2ResultToReply(result.reports));
			} finally {
				activeHandles.delete(handle);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			emitReply(replyEvent, { error: message });
		}
	};

	/** Init контура для missionDir (идемпотентен для того же dir). */
	const initCircuit = (missionDir: string): void => {
		if (circuit?.missionDir === missionDir) {
			return; // уже активен — без двойной подписки
		}
		if (circuit) {
			circuit.unsubDelegate();
		}
		// processedCorrelations НЕ очищается: production EventBus реплеит
		// последнее событие канала при повторной подписке — уже исполненный
		// запрос не должен запускаться дважды.

		// Tree-journal миссии (создаёт файл; существующий не усекается).
		const journal = createTreeJournal(join(missionDir, "tree-journal.jsonl"));

		// Startup-reconciliation: зачистка orphan-портов/PID прошлой сессии.
		// Best-effort: ошибки сверки не блокируют подписку на делегирование.
		void reconcile({
			portsFile: join(missionDir, "child-ports.json"),
			pidDir: join(missionDir, "pids"),
			journal,
		}).catch((err) => {
			console.warn("[fan-super-orchestrator] startup reconciliation failed:", err);
		});

		const unsubDelegate =
			typeof api.events?.on === "function"
				? api.events.on(DELEGATE_CHANNEL, async (data) => {
						await handleDelegate(data);
					})
				: () => {}; // нет EventBus (mock) — подписка не создаётся

		circuit = { missionDir, journal, unsubDelegate, isRecursive: false };
	};

	/** Снять контур: отписка + kill-switch всех активных узлов.
	 *  F-5: для recursive circuit ПЕРЕД cleanup пишем abort event в journal
	 *  (graceful shutdown spawned SO — TC-F5-5). Делегирует abort-event
	 *  в wiring/spawned-orchestrator.ts (extract F-5). */
	const shutdownCircuit = async (): Promise<void> => {
		const current = circuit;
		circuit = null;
		if (current) {
			// F-5: recursive circuit → journal abort event (spawned SO graceful shutdown).
			if (current.isRecursive) {
				await shutdownRecursiveCircuit(current as RecursiveCircuit);
			}
			try {
				current.unsubDelegate();
			} catch {
				// best-effort
			}
		}
		// Kill-switch всех in-flight depth2-handle (идемпотентно).
		for (const handle of [...activeHandles]) {
			try {
				await handle.abort();
			} catch (err) {
				console.warn("[fan-super-orchestrator] depth2 abort failed on shutdown:", err);
			}
			activeHandles.delete(handle);
		}
	};

	// Хуки жизненного цикла (guard: mock-fan без on — подписка не создаётся).
	if (typeof api.on === "function") {
		api.on("session_start", async (event: unknown, ctx: unknown) => {
			try {
				const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? (event as { cwd?: string } | undefined)?.cwd;
				if (!cwd) {
					return;
				}
				const mission = findActiveMission(cwd);
				if (!mission) {
					return;
				}
				// F-5: role check — spawned SO (recursive) vs worker (existing).
				// FAN_NODE_ROLE=super-orchestrator → recursive init (separate circuit
				// с handleDelegateRecursive + role profile). Иначе — existing flow.
				if (process.env.FAN_NODE_ROLE === ROLE_SUPER_ORCHESTRATOR) {
					circuit = initRecursiveCircuit({
						api,
						missionDir: mission.dir,
						existingCircuit: circuit as RecursiveCircuit | null,
						onReplace: (old) => {
							try {
								old.unsubDelegate();
							} catch {
								// best-effort: старый unsubscribe может бросить (защита от race).
							}
						},
					});
				} else {
					initCircuit(mission.dir);
				}
			} catch (err) {
				console.warn("[fan-super-orchestrator] session_start hook failed:", err);
			}
		});

		api.on("session_shutdown", async () => {
			await shutdownCircuit();
		});
	}

	return {
		getActiveMissionDir: () => circuit?.missionDir ?? null,
		shutdown: shutdownCircuit,
		// F-5: recursive wiring — true для spawned SO, false для worker / legacy.
		isRecursive: () => circuit?.isRecursive === true,
		// F-5: role profile текущего контура (после loadRoleCatalog),
		// undefined если role profile не загружался (worker flow или
		// FAN_NODE_ROLE_PROFILE не задан / каталог недоступен).
		getRoleProfile: () => circuit?.roleProfile,
	};
}
