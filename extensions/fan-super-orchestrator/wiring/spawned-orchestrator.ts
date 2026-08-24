// F-5: Spawned SO recursive wiring — extracted из index.ts.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §F-5
// Спека:    docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-5
//
// Назначение модуля — изоляция recursive logic (F-5 refactor-цель) от main
// extension entry point: index.ts импортирует функции этого модуля, но сама
// recursive logic (journal + handleDelegateRecursive + role profile +
// shutdown abort event) живёт здесь. Это улучшает читаемость index.ts и
// даёт возможность независимо тестировать recursive init.
//
// Поверхность API:
//   - ROLE_SUPER_ORCHESTRATOR — маркер роли spawned SO.
//   - RecursiveCircuit — circuit инициализированный в recursive-режиме.
//   - initRecursiveCircuit — создаёт/переиспользует recursive circuit.
//   - handleDelegateRecursive — trivial no-op для api.events.on подписки.
//   - shutdownRecursiveCircuit — пишет abort event в journal ДО cleanup.
//   - isRecursiveCircuit — type guard для narrowing circuit.isRecursive.
//
// Семантика 1:1 с inline initRecursiveCircuit/shutdownCircuit в index.ts
// до F-5 рефакторинга: идемпотентность для того же missionDir, замена
// circuit при смене missionDir через onReplace callback, опциональная
// загрузка role profile через loadRoleCatalog при FAN_NODE_ROLE_PROFILE,
// trivial no-op delegate handler, abort event в journal при shutdown.

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getRoleProfile, loadRoleCatalog, type RoleProfile } from "../role-loader.js";
import { createTreeJournal, type TreeJournal } from "../tree-journal.js";

/** Канал запроса делегирования (mission-loop → super-orchestrator).
 *  Внутренний (не экспортируется) — index.ts владеет своим DELEGATE_CHANNEL
 *  для worker-flow подписки в initCircuit. */
const DELEGATE_CHANNEL = "mission_delegate";

/** F-5: маркер роли spawned super-orchestrator (см. process-manager.ts buildSpawnEnv). */
export const ROLE_SUPER_ORCHESTRATOR = "super-orchestrator";

/** Минимальный контракт api для recursive wiring (только events.on). */
export interface RecursiveApi {
	events?: {
		on?: (channel: string, handler: (data: unknown) => void) => () => void;
	};
}

/** Recursive circuit (F-5: isRecursive=true). */
export interface RecursiveCircuit {
	missionDir: string;
	journal: TreeJournal;
	unsubDelegate: () => void;
	/** F-5: всегда true для recursive circuit. */
	isRecursive: true;
	/** F-5: role profile (после loadRoleCatalog), undefined если не загружался. */
	roleProfile?: RoleProfile;
}

/** Аргументы initRecursiveCircuit. */
export interface InitRecursiveCircuitInput {
	api: RecursiveApi;
	missionDir: string;
	existingCircuit: RecursiveCircuit | null;
	/** Callback вызывается ПЕРЕД созданием нового circuit, когда
	 *  existingCircuit существует для другого missionDir (replace path).
	 *  Используется вызывающим (index.ts) для cleanup старой подписки
	 *  (circuit.unsubDelegate() с best-effort try/catch). */
	onReplace?: (oldCircuit: RecursiveCircuit) => void;
}

/** F-5: recursive init для spawned SO (FAN_NODE_ROLE=super-orchestrator).
 *  Создаёт circuit с isRecursive=true, загружает role profile (если задан
 *  FAN_NODE_ROLE_PROFILE) и регистрирует handleDelegateRecursive через
 *  api.events.on (TRIVIAL — НЕ через createDepth2). Отдельная функция от
 *  initCircuit для back-compat с worker flow.
 *
 *  Семантика идемпотентности (1:1 с inline-реализацией):
 *  - existingCircuit.missionDir === missionDir → возврат existingCircuit без
 *     двойной подписки;
 *  - existingCircuit существует с другим missionDir → onReplace callback
 *     (для очистки старой подписки), затем создание нового circuit;
 *  - existingCircuit === null → создание нового circuit без cleanup. */
export function initRecursiveCircuit(input: InitRecursiveCircuitInput): RecursiveCircuit {
	const { api, missionDir, existingCircuit } = input;
	if (existingCircuit && existingCircuit.missionDir === missionDir) {
		return existingCircuit; // уже активен — без двойной подписки
	}
	if (existingCircuit && input.onReplace) {
		input.onReplace(existingCircuit);
	}

	// Tree-journal миссии (создаёт файл; существующий не усекается).
	const journal = createTreeJournal(join(missionDir, "tree-journal.jsonl"));

	// Role profile (опционально: FAN_NODE_ROLE_PROFILE → loadRoleCatalog).
	// Дефолт-каталог ролей: <extension-root>/roles (родитель wiring/ — модуль
	// лежит в fan-super-orchestrator/wiring/, поэтому один уровень вверх).
	// Если FAN_NODE_ROLE_PROFILE не задан или каталог недоступен —
	// roleProfile остаётся undefined (wiring.getRoleProfile() вернёт undefined).
	let roleProfile: RoleProfile | undefined;
	const profileId = process.env.FAN_NODE_ROLE_PROFILE;
	if (profileId !== undefined && profileId !== "") {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const catalog = loadRoleCatalog({ defaultDir: join(here, "..", "roles") });
			roleProfile = getRoleProfile(catalog, profileId);
		} catch (err) {
			console.warn("[fan-super-orchestrator] role profile load failed:", err);
		}
	}

	const unsubDelegate =
		typeof api.events?.on === "function"
			? api.events.on(DELEGATE_CHANNEL, async (data) => {
					await handleDelegateRecursive(data);
				})
			: () => {}; // нет EventBus (mock) — подписка не создаётся

	return { missionDir, journal, unsubDelegate, isRecursive: true, roleProfile };
}

/** F-5: TRIVIAL handler для recursive (spawned) SO circuit.
 *  Принимает mission_delegate event, но НЕ вызывает createDepth2 —
 *  делегация идёт через HTTP к parent (parent отправляет POST
 *  /api/mission-delegate и сам обрабатывает). В этом in-process контуре
 *  никакой работы не происходит: handleDelegateRecursive просто no-op,
 *  чтобы circuit имел registered delegate (TC-F5-1, TC-F5-2). */
export async function handleDelegateRecursive(_raw: unknown): Promise<void> {
	// TRIVIAL: recursive SO не обрабатывает mission_delegate in-process.
	// Delegated via HTTP к parent — см. F-3 (POST /api/mission-delegate).
}

/** F-5: graceful shutdown recursive circuit — пишет abort event в journal
 *  ПЕРЕД cleanup (TC-F5-5). Вызывается из index.ts shutdownCircuit если
 *  circuit.isRecursive === true. */
export async function shutdownRecursiveCircuit(circuit: RecursiveCircuit): Promise<void> {
	try {
		circuit.journal.write({
			event: "abort",
			nodeId: `recursive-${basename(circuit.missionDir)}`,
		});
	} catch (err) {
		console.warn("[fan-super-orchestrator] recursive abort journal write failed:", err);
	}
}

/** F-5: type guard для narrowing circuit.isRecursive === true. */
export function isRecursiveCircuit(circuit: { isRecursive?: boolean } | null): circuit is RecursiveCircuit {
	return circuit?.isRecursive === true;
}
