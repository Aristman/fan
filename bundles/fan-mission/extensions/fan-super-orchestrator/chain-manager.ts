// chain-manager.ts
// F-6: Chain manager для recursive spawned SO chain.
//
// Карточка: docs/features/recursive-orchestrator-spawn/roadmap.md §F-6
// Спека:    docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-6
//
// Управляет chain-ом mock fan servers (real HTTP между ними):
//   • registerNode — добавляет node в chain
//   • shutdownChain — graceful shutdown всей цепочки (leaf-first)
//
// Используется:
//   • mock-fan-server.mjs (chainPropagation="auto" mode) — для
//     register/unregister + leaf-first shutdown в e2e-тестах.
//   • recursive-spawn.test.mjs — integration test для depth-4 chain.

/** Роль узла в chain. */
export type ChainRole = "super-orchestrator" | "worker" | "coordinator";

/** Запись lineage (один hop). Используется для walk-up. */
export interface LineageEntryLike {
	correlationId: string;
	url: string;
	token: string;
	role: string;
	profile?: string;
}

/** Reference на mock server (для shutdown propagation). */
export interface MockServerRef {
	stop: () => Promise<void>;
	/** Закрыть все WS connections (для тестов WS-close detection). */
	closeWs: () => void;
}

/** Информация о зарегистрированном node. */
export interface ChainNodeInfo {
	nodeId: string;
	port: number;
	url: string;
	token: string;
	role: ChainRole;
	parentNodeId?: string;
	childNodeIds: string[];
	mockServer?: MockServerRef;
}

/** Опции registerNode. */
export interface RegisterNodeOpts {
	nodeId: string;
	port: number;
	url: string;
	token: string;
	role: ChainRole;
	parentNodeId?: string;
	mockServer?: MockServerRef;
}

/**
 * ChainManager — управляет иерархией mock-узлов (real HTTP между ними).
 *
 * Используется в e2e-тестах recursive-spawn.test.mjs для проверки:
 *   • chain propagation (Coord → SO → SO → worker)
 *   • crash mid-chain → walk-up escalation через lineage
 *   • graceful shutdown всей цепочки (leaf-first)
 *
 * Mock-узлы регистрируются при создании (mock-fan-server.mjs,
 * chainPropagation="auto" mode). ChainManager предоставляет helpers для
 * shutdown coordination; делегации/walk-up реализованы inline в mock
 * (через lineage из payload — real-world scenario).
 */
export class ChainManager {
	private nodes = new Map<string, ChainNodeInfo>();

	/** Зарегистрировать node в chain. */
	registerNode(opts: RegisterNodeOpts): ChainNodeInfo {
		const node: ChainNodeInfo = {
			nodeId: opts.nodeId,
			port: opts.port,
			url: opts.url,
			token: opts.token,
			role: opts.role,
			parentNodeId: opts.parentNodeId,
			childNodeIds: [],
			mockServer: opts.mockServer,
		};
		this.nodes.set(opts.nodeId, node);
		// Link parent → child (если parent указан и зарегистрирован).
		if (opts.parentNodeId) {
			const parent = this.nodes.get(opts.parentNodeId);
			if (parent && !parent.childNodeIds.includes(opts.nodeId)) {
				parent.childNodeIds.push(opts.nodeId);
			}
		}
		return node;
	}

	/** Удалить node из chain (cleanup на stop). */
	unregisterNode(nodeId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) return;
		if (node.parentNodeId) {
			const parent = this.nodes.get(node.parentNodeId);
			if (parent) {
				parent.childNodeIds = parent.childNodeIds.filter((id) => id !== nodeId);
			}
		}
		this.nodes.delete(nodeId);
	}

	/** Получить node по id. */
	getNode(nodeId: string): ChainNodeInfo | undefined {
		return this.nodes.get(nodeId);
	}

	/** Все зарегистрированные nodeIds. */
	getAllNodeIds(): string[] {
		return [...this.nodes.keys()];
	}

	/**
	 * Graceful shutdown всей цепочки.
	 *
	 * Порядок: leaf-first (узлы без children останавливаются первыми).
	 * Timeout: 1s per node (existing convention).
	 */
	async shutdownChain(timeoutMsPerNode = 1000): Promise<void> {
		// Итеративно находим leaf-узлы и останавливаем их, повторяя пока
		// цепочка не опустошится. На каждом шаге снимаем сначала те leaf'ы,
		// которые не имеют children — это корректный post-order без рекурсии.
		const stopNode = async (node: ChainNodeInfo): Promise<void> => {
			if (!node.mockServer) return;
			try {
				await Promise.race([
					node.mockServer.stop(),
					new Promise<void>((resolve) => setTimeout(resolve, timeoutMsPerNode)),
				]);
			} catch {
				// best-effort
			}
		};

		// Leaf-first iteration: каждый проход останавливает все текущие leaf'ы.
		// После их остановки и unregister появятся новые leaf'ы; повторяем.
		let safetyCounter = this.nodes.size + 1;
		while (this.nodes.size > 0 && safetyCounter-- > 0) {
			const leafIds: string[] = [];
			for (const [id, node] of this.nodes) {
				if (node.childNodeIds.length === 0) {
					leafIds.push(id);
				}
			}
			if (leafIds.length === 0) {
				// Цикл в chain (не должно случиться в тестах) — break.
				break;
			}
			await Promise.all(
				leafIds.map(async (id) => {
					const node = this.nodes.get(id);
					if (node) {
						await stopNode(node);
						this.unregisterNode(id);
					}
				}),
			);
		}
	}

	/** Очистить state (для test isolation). */
	clear(): void {
		this.nodes.clear();
	}
}

/**
 * Singleton instance для использования из mock-fan-server.mjs и тестов.
 *
 * Важно: при parallel-тестах состояние разделяется. Тесты должны вызывать
 * `chainManager.clear()` в setup/teardown или полагаться на то, что все
 * mocks с chainPropagation="auto" вызывают unregisterNode в stop().
 */
export const chainManager = new ChainManager();
