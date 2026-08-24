// F-SO-PP: Пул портов super-orchestrator (выделен из process-manager в REFACTOR-фазе).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.1
//
// Блокировки портов живут в portsFile (JSON {[id]: port}) и переживают
// перезапуск: занятые порты прошлой сессии не переиспользуются. Все
// операции синхронные — файл читается/пишется на каждое действие, что
// делает пул безопасным для нескольких процессов-менеджеров.
//
// Вынесен из process-manager.ts для переиспользования (roadmap §F-23,
// Refactor-цели). Поведение 1:1 совпадает с прежней инлайн-реализацией:
//   • повреждённый/отсутствующий файл трактуется как пустой пул;
//   • allocate(id) не блокирует собственную запись id (рестарт/пересоздание);
//   • исчерпание пула — явная ошибка.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PortRange {
	/** Первый порт пула (default 7001). */
	start: number;
	/** Последний порт пула (default 7099). */
	end: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { start: 7001, end: 7099 };

export class PortPool {
	private readonly portsFile: string;
	private readonly range: PortRange;

	constructor(portsFile: string, range?: Partial<PortRange>) {
		this.portsFile = portsFile;
		this.range = {
			start: range?.start ?? DEFAULT_PORT_RANGE.start,
			end: range?.end ?? DEFAULT_PORT_RANGE.end,
		};
	}

	/** Текущие блокировки: {[id]: port} ({} если файла нет или он повреждён). */
	list(): Record<string, number> {
		if (!existsSync(this.portsFile)) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.portsFile, "utf8"));
			return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
		} catch {
			// Повреждённый файл не блокирует менеджер: трактуем как пустой.
			return {};
		}
	}

	/**
	 * Выделить первый свободный порт диапазона для id: блокировка сразу
	 * фиксируется в portsFile. Собственная запись id (рестарт/пересоздание)
	 * порт не блокирует. Исчерпание пула — явная ошибка.
	 */
	allocate(id: string): number {
		const ports = this.list();
		const taken = new Set<number>();
		for (const [nodeId, port] of Object.entries(ports)) {
			if (nodeId !== id) {
				taken.add(port);
			}
		}
		for (let port = this.range.start; port <= this.range.end; port += 1) {
			if (!taken.has(port)) {
				ports[id] = port;
				this.persist(ports);
				return port;
			}
		}
		throw new Error(`Port pool exhausted: no free port in range ${this.range.start}-${this.range.end}`);
	}

	/** Освободить порт id (запись удаляется из portsFile). Идемпотентно. */
	release(id: string): void {
		const ports = this.list();
		delete ports[id];
		this.persist(ports);
	}

	private persist(ports: Record<string, number>): void {
		mkdirSync(dirname(this.portsFile), { recursive: true });
		writeFileSync(this.portsFile, JSON.stringify(ports, null, 2), "utf8");
	}
}
