import { createServer, type Server } from "node:http";
import { createLogger } from "./logger.js";
import { PENDING_QUEUE_VERSION } from "./persistent-storage.js";
import type { TaskQueue, TaskStatus } from "./queue.js";

const log = createLogger("scheduler");

/** Default localhost port of the scheduler control server (F-4.12). */
export const DEFAULT_CONTROL_PORT = 3457;

export interface ControlServerOptions {
	queue: TaskQueue;
	/** Bind host (default 127.0.0.1 — localhost only, never exposed). */
	host?: string;
	/** Bind port (default 3457). Pass 0 for an ephemeral port (tests). */
	port?: number;
	/** Extra state provider merged into GET /state responses (e.g. the
	 *  UserActivityMonitor's pausedForChat flag). */
	extraState?: () => Record<string, unknown>;
	/** F-4.14: degradation probe for GET /health — return true when the
	 *  scheduler started with a corrupt pending-queue file. Reads in-memory
	 *  state only; must never block or throw. */
	degraded?: () => boolean;
}

export interface ControlServerHandle {
	/** Actual bound port (useful when port 0 was requested). */
	readonly port: number;
	close(): Promise<void>;
}

/** JSON state payload shared by GET /state, POST /pause and POST /resume. */
export interface ControlState {
	state: "idle" | "running" | "paused";
	isRunning: boolean;
	pendingCount: number;
	currentTask: string | null;
	lastResult: unknown;
	[key: string]: unknown;
}

/**
 * F-4.14 health & metrics payload (GET /health).
 * Operational metrics only — no secrets, tokens or task message contents.
 */
export interface SchedulerHealth {
	/** "ok" when the scheduler is healthy, "degraded" when it started with a
	 *  corrupt pending-queue file (tasks were dropped, operator attention needed). */
	status: "ok" | "degraded";
	/** True while a task is executing. */
	running: boolean;
	/** Number of tasks waiting in the pending queue. */
	pendingCount: number;
	/** Terminal status of the most recently finished task (null before the first one). */
	lastTaskStatus: TaskStatus | null;
	/** Seconds since the control server started. */
	uptimeSeconds: number;
	/** Pending-queue persistence schema version. */
	queueVersion: typeof PENDING_QUEUE_VERSION;
}

/**
 * Local HTTP control server (F-4.12).
 *
 * The scheduler is a separate process from the api-gateway, so external
 * actors (an operator, a future gateway hook, tests) signal it through this
 * localhost-only endpoint instead of in-process calls:
 *
 *   POST /pause  → queue.pauseCurrent() — pause autonomous tasks
 *   POST /resume → queue.runNext()      — resume auto-advance
 *   GET  /state  → { state, isRunning, pendingCount, currentTask, lastResult }
 *   GET  /health → { status, running, pendingCount, lastTaskStatus, uptimeSeconds, queueVersion } (F-4.14)
 *
 * Deliberately minimal: no auth (bound to 127.0.0.1 only — same trust model
 * as the rest of the local runtime), no body parsing, no blocking operations
 * (reads in-memory queue state only). A failed bind is reported by the caller
 * as a warning and never prevents the scheduler from running.
 */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const requestedPort = options.port ?? DEFAULT_CONTROL_PORT;
	const startedAt = Date.now();

	const buildState = (): ControlState => ({
		state: options.queue.state,
		isRunning: options.queue.isRunning,
		pendingCount: options.queue.pending.length,
		currentTask: options.queue.currentTask?.name ?? null,
		lastResult: options.queue.lastResult,
		...(options.extraState?.() ?? {}),
	});

	const buildHealth = (): SchedulerHealth => {
		const degraded = options.degraded?.() === true;
		return {
			status: degraded ? "degraded" : "ok",
			running: options.queue.isRunning,
			pendingCount: options.queue.pending.length,
			lastTaskStatus: options.queue.lastResult?.status ?? null,
			uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
			queueVersion: PENDING_QUEUE_VERSION,
		};
	};

	const server: Server = createServer((req, res) => {
		const send = (status: number, body: unknown): void => {
			const json = JSON.stringify(body);
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(json);
		};

		const url = new URL(req.url ?? "/", `http://${host}`);
		if (req.method === "GET" && url.pathname === "/state") {
			send(200, buildState());
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			send(200, buildHealth());
			return;
		}
		if (req.method === "POST" && url.pathname === "/pause") {
			options.queue.pauseCurrent();
			log.info("control_pause", "[control] POST /pause — autonomous tasks paused");
			send(200, { ok: true, ...buildState() });
			return;
		}
		if (req.method === "POST" && url.pathname === "/resume") {
			log.info("control_resume", "[control] POST /resume — resuming autonomous tasks");
			void options.queue.runNext();
			send(200, { ok: true, ...buildState() });
			return;
		}
		send(404, { error: "not found", routes: ["GET /state", "GET /health", "POST /pause", "POST /resume"] });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(requestedPort, host, () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : requestedPort;
	log.info("control_server_started", `[control] control server listening at http://${host}:${port}`, {
		host,
		port,
	});

	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
