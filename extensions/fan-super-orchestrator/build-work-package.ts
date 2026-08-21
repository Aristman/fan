// F-D: Extended SpawnWorkPackage builder + lineage helpers.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-D
//
// Расширение протокола spawn-пакета для fan-super-orchestrator v2:
//   • role, role_profile — каким узлом будет дочерний процесс;
//   • parent_* (correlation_id, url, token, report_id) — для отправки
//     финального отчёта обратно родителю через готовый ReportChannel;
//   • lineage — путь от root coordinator до родителя (для дедупликации
//     и observability).
//
// Идемпотентность: parent_report_id генерируется через randomUUID() и
// используется дочерним узлом как ключ при отправке отчёта родителю.
// Параметры spawnBudget/tokenBudget/costBudgetUsd/maxRetries/toolManifest/deadline
// — pass-through из существующего WorkPackage F-27.

import { randomUUID } from "node:crypto";

/** Запись lineage (узел в иерархии от coordinator до родителя). */
export interface LineageEntry {
	correlationId: string;
	url: string;
	token: string;
	role: "coordinator" | "super-orchestrator" | "orchestrator";
	profile?: string;
}

/** Опции buildWorkPackage. */
export interface BuildWorkPackageOpts {
	/** Узел-родитель, порождающий нового потомка. */
	parent: LineageEntry;
	/** Роль нового (порождаемого) узла. */
	role: "super-orchestrator" | "orchestrator";
	/** Профиль роли (опционально). */
	profile?: string;
	/** Глубина нового узла (1..4). */
	depth: number;
	/** Задание для нового узла. */
	task: { type: string; prompt: string; [key: string]: unknown };
	/** Полная lineage от корня до родителя. */
	lineage: LineageEntry[];
	// Pass-through существующего WorkPackage:
	spawnBudget?: number;
	tokenBudget?: number;
	costBudgetUsd?: number;
	maxRetries?: number;
	toolManifest?: string[];
	deadline?: number;
	correlationId?: string;
}

/** Собранный SpawnWorkPackage (расширенный формат). */
export interface WorkPackage {
	task: { type: string; prompt: string; [key: string]: unknown };
	correlationId: string;
	depth: number;
	/** NEW for depth>0: роль нового узла. */
	role?: "super-orchestrator" | "orchestrator";
	/** NEW: профиль роли. */
	role_profile?: string;
	/** NEW: correlation id родителя (для обратной связи). */
	parent_correlation_id?: string;
	/** NEW: URL родителя (для отправки отчёта). */
	parent_url?: string;
	/** NEW: токен родителя (для аутентификации). */
	parent_token?: string;
	/** NEW: idempotency key (когда родитель ждёт отчёт). */
	parent_report_id?: string;
	/** NEW: полная lineage от coordinator до parent. */
	lineage?: LineageEntry[];
	// Pass-through:
	spawnBudget?: number;
	tokenBudget?: number;
	costBudgetUsd?: number;
	maxRetries?: number;
	toolManifest?: string[];
	deadline?: number;
}

/**
 * Собрать расширенный WorkPackage с parent_* и lineage.
 * parent_report_id генерируется на лету (randomUUID) — это idempotency
 * ключ, по которому родитель ждёт финальный отчёт отосланного узла.
 */
export function buildWorkPackage(opts: BuildWorkPackageOpts): WorkPackage {
	return {
		task: opts.task,
		correlationId: opts.correlationId ?? randomUUID(),
		depth: opts.depth,
		role: opts.role,
		role_profile: opts.profile,
		parent_correlation_id: opts.parent.correlationId,
		parent_url: opts.parent.url,
		parent_token: opts.parent.token,
		parent_report_id: randomUUID(),
		lineage: opts.lineage,
		spawnBudget: opts.spawnBudget,
		tokenBudget: opts.tokenBudget,
		costBudgetUsd: opts.costBudgetUsd,
		maxRetries: opts.maxRetries,
		toolManifest: opts.toolManifest,
		deadline: opts.deadline,
	};
}

/**
 * Валидировать расширенные поля WorkPackage.
 * Для depth>0 требуется role + parent_* + lineage (без них узел не сможет
 * ни породить потомков, ни отправить отчёт родителю).
 */
export function validateWorkPackageFields(pkg: WorkPackage): void {
	if (pkg.depth > 0) {
		if (!pkg.role) throw new Error("WorkPackage.role required for depth>0");
		if (!pkg.parent_correlation_id)
			throw new Error("WorkPackage.parent_correlation_id required for depth>0");
		if (!pkg.parent_url) throw new Error("WorkPackage.parent_url required for depth>0");
		if (!pkg.parent_token) throw new Error("WorkPackage.parent_token required for depth>0");
		if (!pkg.lineage || pkg.lineage.length === 0)
			throw new Error("WorkPackage.lineage required for depth>0");
	}
}

/** Создать начальную lineage из одного coordinator. */
export function buildLineage(coordinator: LineageEntry): LineageEntry[] {
	return [coordinator];
}

/** Append parent (текущий узел) к существующей lineage. */
export function appendToLineage(
	currentLineage: LineageEntry[],
	newEntry: LineageEntry,
): LineageEntry[] {
	return [...currentLineage, newEntry];
}
