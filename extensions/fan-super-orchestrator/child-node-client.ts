// F-29: Child node client (REST + WS).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-29
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3
//
// Клиент дочернего узла: L0 отправляет пакет работ (F-27) дочернему узлу L1
// через REST api-gateway (POST /api/sessions/:id/messages, Bearer-токен) и
// ждёт финальный отчёт через WS-подписку /api/ws/:sessionId (событие
// agent_end → последнее assistant-сообщение → parseNodeReport из
// node-report.js). При обрыве WS — reconnect + переподписка (источник
// правды — JSONL на диске дочернего узла, пакет повторно не POSTится);
// при превышении deadline пакета — timeout-отчёт и закрытие WS.
// Все зависимости (fetch, WebSocket) инъектируются для тестируемости.

import {
	makeAbortedReport,
	makeTimeoutReport,
	type NodeReport,
	type NodeUsage,
	parseNodeReport,
} from "./node-report.js";
import { serializeWorkPackage, type WorkPackage } from "./work-package.js";

/** WebSocket-подобный интерфейс (реальный WebSocket оборачивается, в тестах — моки). */
export interface WsLike {
	onopen?: (() => void) | undefined;
	onmessage?: ((ev: { data: string }) => void) | undefined;
	onclose?: (() => void) | undefined;
	onerror?: ((err: unknown) => void) | undefined;
	close(): void;
	send(data: string): void;
}

/** Опции клиента (все зависимости инъектируются, дефолты — в скобках). */
export interface ChildNodeClientOptions {
	/** HTTP-транспорт (default: global fetch). */
	fetchFn?: typeof fetch;
	/** Фабрика WS-соединений (default: global WebSocket). */
	wsFactory?: (url: string) => WsLike;
	/** Таймаут установки WS-соединения, мс (30000). */
	connectTimeoutMs?: number;
	/** Задержка reconnect при обрыве WS, мс (1000). */
	reconnectDelayMs?: number;
	/** Максимум reconnect-попыток сверх первого соединения (5). */
	maxReconnects?: number;
}

/** Опции отправки пакета работ дочернему узлу. */
export interface SendWorkPackageOptions {
	port: number;
	token: string;
	workPackage: WorkPackage;
	/** Если не задан — discovery через GET /api/sessions (первая сессия). */
	sessionId?: string;
}

/** Клиент дочернего узла. */
export interface ChildNodeClient {
	sendWorkPackage(opts: SendWorkPackageOptions): Promise<NodeReport>;
	/** Закрыть активные WS и таймеры; идемпотентен. */
	close(): void;
}

/** Дефолты (roadmap §F-29: connection timeout 30 сек). */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECTS = 5;

/** Дефолтная WS-фабрика: global WebSocket, обёрнутый в WsLike. */
function defaultWsFactory(url: string): WsLike {
	const socket = new WebSocket(url);
	const adapter: WsLike = {
		close: () => socket.close(),
		send: (data: string) => socket.send(data),
	};
	socket.onopen = () => adapter.onopen?.();
	socket.onmessage = (ev) => adapter.onmessage?.({ data: typeof ev.data === "string" ? ev.data : String(ev.data) });
	socket.onclose = () => adapter.onclose?.();
	socket.onerror = (ev) => adapter.onerror?.(ev);
	return adapter;
}

/** Текст assistant-сообщения: content — строка либо массив TextContent. */
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	let text = "";
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const chunk = (part as { text?: unknown }).text;
			if (typeof chunk === "string") {
				text += chunk;
			}
		}
	}
	return text;
}

/** Маппинг usage api-gateway ({input, output, cost.total}) → NodeUsage; absent → 0. */
function mapUsage(raw: unknown): Partial<NodeUsage> {
	if (typeof raw !== "object" || raw === null) {
		return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	}
	const usage = raw as { input?: unknown; output?: unknown; cost?: { total?: unknown } };
	const total = typeof usage.cost === "object" && usage.cost !== null ? usage.cost.total : undefined;
	return {
		inputTokens: typeof usage.input === "number" ? usage.input : 0,
		outputTokens: typeof usage.output === "number" ? usage.output : 0,
		costUsd: typeof total === "number" ? total : 0,
	};
}

/** Маскирует query-параметр token в URL для безопасного логирования. */
function maskTokenUrl(url: string): string {
	return url.replace(/([?&]token=)[^&]*/g, "$1***");
}

/** Клиент дочернего узла: REST-отправка пакета + WS-ожидание отчёта. */
export function createChildNodeClient(opts: ChildNodeClientOptions = {}): ChildNodeClient {
	const fetchFn = opts.fetchFn ?? fetch;
	const wsFactory = opts.wsFactory ?? defaultWsFactory;
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;

	let closed = false;
	/** Аборты активных sendWorkPackage (для close()). */
	const activeAborts = new Set<() => void>();

	async function sendWorkPackage({
		port,
		token,
		workPackage,
		sessionId: sessionIdOpt,
	}: SendWorkPackageOptions): Promise<NodeReport> {
		const baseUrl = `http://127.0.0.1:${port}`;
		const authorization = `Bearer ${token}`;

		// 1. sessionId: задан явно либо discovery через GET /api/sessions.
		let sessionId = sessionIdOpt;
		if (sessionId === undefined) {
			const discovery = await fetchFn(`${baseUrl}/api/sessions`, { headers: { Authorization: authorization } });
			if (!discovery.ok) {
				throw new Error(`Session discovery failed: GET /api/sessions → HTTP ${discovery.status}`);
			}
			const body = (await discovery.json()) as { sessions?: Array<{ id?: unknown }> };
			const firstId = body.sessions?.[0]?.id;
			if (typeof firstId !== "string" || firstId.length === 0) {
				throw new Error("Session discovery failed: child node has no active sessions");
			}
			sessionId = firstId;
		}

		const correlationId = workPackage.correlationId;
		// nodeId — часть correlationId без mission-префикса: "L<N>/node-<M>".
		const meta = { nodeId: correlationId.split("/").slice(1).join("/"), correlationId };
		const wsUrl = `ws://127.0.0.1:${port}/api/ws/${sessionId}?token=${token}`;
		const postUrl = `${baseUrl}/api/sessions/${sessionId}/messages`;

		return new Promise<NodeReport>((resolve, reject) => {
			if (closed) {
				reject(new Error("ChildNodeClient is closed"));
				return;
			}

			let settled = false;
			let socket: WsLike | null = null;
			/** Пакет POSTится один раз — после reconnect только переподписка. */
			let posted = false;
			let reconnectsUsed = 0;
			let connectTimer: ReturnType<typeof setTimeout> | undefined;
			let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

			const clearTimers = (): void => {
				if (connectTimer !== undefined) clearTimeout(connectTimer);
				if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
				if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
				connectTimer = undefined;
				reconnectTimer = undefined;
				deadlineTimer = undefined;
			};

			const closeSocket = (): void => {
				if (socket !== null) {
					try {
						socket.close();
					} catch {
						// Сокет уже закрыт — не критично.
					}
					socket = null;
				}
			};

			const settle = (report: NodeReport): void => {
				if (settled) return;
				settled = true;
				activeAborts.delete(abort);
				clearTimers();
				closeSocket();
				resolve(report);
			};

			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				activeAborts.delete(abort);
				clearTimers();
				closeSocket();
				reject(error);
			};

			const abort = (): void => {
				fail(new Error("ChildNodeClient closed while waiting for node report"));
			};
			activeAborts.add(abort);

			// 2. Deadline-таймер: из workPackage.deadline (response timeout).
			const deadlineMs = Date.parse(workPackage.deadline) - Date.now();
			const deadlineDelay = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 0;
			deadlineTimer = setTimeout(() => {
				settle(makeTimeoutReport(meta));
			}, deadlineDelay);

			// 3. REST-отправка сериализованного пакета (после открытия WS).
			const postPackage = async (): Promise<void> => {
				try {
					const response = await fetchFn(postUrl, {
						method: "POST",
						headers: { Authorization: authorization, "Content-Type": "application/json" },
						body: JSON.stringify(serializeWorkPackage(workPackage)),
					});
					if (!response.ok) {
						fail(new Error(`Work package POST failed: HTTP ${response.status} (${postUrl})`));
					}
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			};

			// 4. Обработка agent_end: последнее assistant-сообщение → отчёт.
			const handleAgentEnd = (messages: unknown): void => {
				const list = Array.isArray(messages) ? messages : [];
				let lastAssistant: { content?: unknown; usage?: unknown } | null = null;
				for (const message of list) {
					if (
						typeof message === "object" &&
						message !== null &&
						(message as { role?: unknown }).role === "assistant"
					) {
						lastAssistant = message as { content?: unknown; usage?: unknown };
					}
				}
				const text = lastAssistant === null ? "" : extractAssistantText(lastAssistant.content);
				const usage = mapUsage(lastAssistant?.usage);
				settle(parseNodeReport(text, { nodeId: meta.nodeId, correlationId: meta.correlationId, usage }));
			};

			// 5. WS-подписка с reconnect при обрыве (переподписка без повторного POST).
			const connect = (): void => {
				if (settled) return;
				const ws = wsFactory(wsUrl);
				socket = ws;

				connectTimer = setTimeout(() => {
					fail(new Error(`WS connect timeout after ${connectTimeoutMs} ms: ${maskTokenUrl(wsUrl)}`));
				}, connectTimeoutMs);

				ws.onopen = () => {
					if (settled || socket !== ws) return;
					if (connectTimer !== undefined) {
						clearTimeout(connectTimer);
						connectTimer = undefined;
					}
					if (!posted) {
						posted = true;
						void postPackage();
					}
				};

				ws.onmessage = (ev) => {
					if (settled || socket !== ws) return;
					let frame: unknown;
					try {
						frame = JSON.parse(ev.data);
					} catch {
						return; // Не-JSON кадр — игнорируем.
					}
					if (typeof frame !== "object" || frame === null) return;
					const typed = frame as { type?: unknown; event?: unknown };
					if (typed.type !== "agent_event") return; // connected/pong/etc.
					const event = typed.event;
					if (typeof event !== "object" || event === null) return;
					const agentEvent = event as { type?: unknown; messages?: unknown };
					if (agentEvent.type !== "agent_end") return;
					handleAgentEnd(agentEvent.messages);
				};

				ws.onclose = () => {
					if (settled || socket !== ws) return;
					if (connectTimer !== undefined) {
						clearTimeout(connectTimer);
						connectTimer = undefined;
					}
					if (reconnectsUsed >= maxReconnects) {
						// makeAbortedReport не ставит interrupted — добавляем флаг поверх.
						settle({ ...makeAbortedReport(meta), interrupted: true });
						return;
					}
					reconnectsUsed += 1;
					reconnectTimer = setTimeout(() => {
						reconnectTimer = undefined;
						connect();
					}, reconnectDelayMs);
				};

				ws.onerror = () => {
					// Обрыв обрабатывается в onclose (следует за onerror).
				};
			};

			connect();
		});
	}

	function close(): void {
		if (closed) return;
		closed = true;
		for (const abort of activeAborts) {
			abort();
		}
		activeAborts.clear();
	}

	return { sendWorkPackage, close };
}
