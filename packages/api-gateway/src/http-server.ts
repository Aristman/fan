import { getPrismaClient } from "@fan/db";
import type { ModelManager, RoutingRuleData } from "@fan/model-manager";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { generateToken as createToken, isAuthDisabled, listTokens, revokeToken, tokenAuth } from "./auth.js";
import { resolveCorsOrigin } from "./cors-config.js";
import type {
	ApiError,
	ApiMcpStatusResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	DeleteSessionResponse,
	GenerateTokenResponse,
	GetBudgetResponse,
	GetModelSettingsResponse,
	GetModelsResponse,
	GetSessionResponse,
	HealthResponse,
	ListSessionsResponse,
	ListTokensResponse,
	ModelInfo,
	RevokeTokenResponse,
	RoutingRuleInfo,
	SendMessageRequest,
	SendMessageResponse,
	SessionSummary,
	UpdateBudgetRequest,
	UpdateBudgetResponse,
	UpdateModelSettingsRequest,
	UpdateModelSettingsResponse,
} from "./types.js";
import { attachWebSocketHandler } from "./ws-handler.js";

// Version is passed via ServerOptions to avoid __dirname resolution issues
// in compiled Bun binaries where __dirname points inside the runtime.
let _version = "unknown";

// ============================================================================
// Session Adapter Interface
// ============================================================================

/** Minimal interface for session management — injected by CLI entry point */
export interface SessionAdapter {
	/** List available sessions */
	listSessions(): Promise<SessionSummary[]>;
	/** Get session details with messages */
	getSession(id: string): Promise<GetSessionResponse | null>;
	/** Create a new session */
	createSession(options?: { title?: string; parentSessionId?: string }): Promise<CreateSessionResponse>;
	/** Delete a session */
	deleteSession(id: string): Promise<boolean>;
	/** Send a message to a session (events stream via WebSocket) */
	sendMessage(sessionId: string, message: string, streamingBehavior?: "steer" | "followUp"): Promise<boolean>;
	/** Subscribe to session events for WebSocket forwarding */
	subscribeToSession(sessionId: string, handler: (event: any) => void): () => void;
	/** Get available models from ModelRegistry */
	getAvailableModels(): Promise<ModelInfo[]>;
	/** Bind extensions to the current session (called after session switch/create) */
	bindSessionExtensions(): Promise<void>;
	/** Get the id of the currently active session (null if none). Optional — used by /api/health readiness. */
	getActiveSessionId?(): string | null;
}

// ============================================================================
// Server Options
// ============================================================================

export interface ServerOptions {
	port?: number;
	host?: string;
	dashboardDir?: string; // Path to dashboard dist directory. If provided, serves the dashboard.
	version?: string; // Application version (passed from caller to avoid __dirname issues in compiled binaries)
}

// ============================================================================
// Error Classification Helpers
// ============================================================================

/** Classify an error into an appropriate HTTP status code. */
function classifyErrorStatus(err: unknown): number {
	const msg = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.constructor.name : "";

	// Client input errors
	if (name === "SyntaxError" && msg.includes("JSON")) return 400;
	if (msg.match(/invalid.*body|malformed.*json|unexpected.*token/i)) return 400;

	// Authentication / Authorization
	if (msg.match(/unauthorized|invalid.*token|token.*expired|not authenticated/i)) return 401;
	if (msg.match(/forbidden|insufficient.*permission|not authorized/i)) return 403;

	// Not Found
	if (msg.match(/not found|does not exist|no such/i)) return 404;

	// Conflict
	if (msg.match(/already exists|conflict|duplicate/i)) return 409;

	// Unprocessable Entity (validation)
	if (msg.match(/validation|invalid.*field|missing.*required|bad.*request/i)) return 422;

	// Default: server error
	return 500;
}

/** Classify an error into an ApiError code string. */
function classifyErrorCode(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);

	if (msg.match(/unauthorized|invalid.*token|token.*expired/i)) return "UNAUTHORIZED";
	if (msg.match(/forbidden|insufficient.*permission/i)) return "FORBIDDEN";
	if (msg.match(/not found|does not exist/i)) return "NOT_FOUND";
	if (msg.match(/already exists|conflict|duplicate/i)) return "CONFLICT";
	if (msg.match(/validation|invalid.*field|missing.*required|malformed.*json/i)) return "BAD_REQUEST";
	return "INTERNAL_ERROR";
}

// ============================================================================
// Create Hono App
// ============================================================================

const startTime = Date.now();

/** Max time to wait for the DB readiness probe before reporting "down" */
const DB_CHECK_TIMEOUT_MS = 1500;

/**
 * Lightweight DB readiness probe: `SELECT 1` via Prisma with a hard timeout.
 * Never throws — returns "down" on error or timeout so /api/health stays fast.
 */
async function checkDatabase(): Promise<"up" | "down"> {
	try {
		const prisma = getPrismaClient();
		const query = prisma.$queryRawUnsafe("SELECT 1").then(
			() => "up" as const,
			() => "down" as const,
		);
		const timeout = new Promise<"down">((resolve) => setTimeout(() => resolve("down"), DB_CHECK_TIMEOUT_MS));
		return await Promise.race([query, timeout]);
	} catch {
		return "down";
	}
}

async function createApp(
	modelManager: ModelManager,
	sessionAdapter: SessionAdapter,
	options: ServerOptions = {},
): Promise<Hono> {
	if (options.version) _version = options.version;
	const app = new Hono();

	// Middleware
	app.use("*", logger());
	// F-0.4: CORS origins from ALLOWED_ORIGINS env (comma-separated);
	// default "*" — full openness for local dev (backward compatibility).
	app.use("*", cors({ origin: resolveCorsOrigin() }));

	// --- Health (no auth required) ---
	// F-0.9: readiness probe. HTTP 200 when all checks pass; HTTP 503 when the DB
	// is unreachable so docker healthcheck (r.ok) transitions to unhealthy.
	app.get("/api/health", async (c) => {
		const db = await checkDatabase();
		const sessionId = sessionAdapter.getActiveSessionId?.() ?? null;
		const resp: HealthResponse = {
			status: db === "up" ? "ok" : "degraded",
			version: _version,
			uptime: Math.floor((Date.now() - startTime) / 1000),
			db,
			session: { active: sessionId !== null, id: sessionId },
		};
		return c.json(resp, db === "up" ? 200 : 503);
	});

	// --- All /api/ routes require auth (except health) ---
	app.use("/api/*", tokenAuth);

	// --- Sessions ---
	app.post("/api/sessions", async (c) => {
		const body = await c.req.json<CreateSessionRequest>();
		const session = await sessionAdapter.createSession(body);
		return c.json(session, 201);
	});

	app.get("/api/sessions", async (c) => {
		const sessions = await sessionAdapter.listSessions();
		const resp: ListSessionsResponse = { sessions };
		return c.json(resp);
	});

	app.get("/api/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const session = await sessionAdapter.getSession(id);
		if (!session) {
			return c.json({ error: "Session not found", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		return c.json(session);
	});

	app.delete("/api/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const deleted = await sessionAdapter.deleteSession(id);
		if (!deleted) {
			return c.json({ error: "Session not found", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		const resp: DeleteSessionResponse = { success: true };
		return c.json(resp);
	});

	// --- Messages ---
	app.post("/api/sessions/:id/messages", async (c) => {
		const sessionId = c.req.param("id");
		const body = await c.req.json<SendMessageRequest>();
		const sent = await sessionAdapter.sendMessage(sessionId, body.message, body.streamingBehavior);
		if (!sent) {
			return c.json({ error: "Session not found or unavailable", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		const resp: SendMessageResponse = { success: true };
		return c.json(resp);
	});

	// --- Models ---
	app.get("/api/models", async (c) => {
		const models = await sessionAdapter.getAvailableModels();
		const routingRules: RoutingRuleInfo[] = (await modelManager.getRoutingRules()).map((r: RoutingRuleData) => ({
			id: r.id,
			name: r.name,
			provider: r.provider,
			model: r.model,
			fallback: r.fallback,
			enabled: r.enabled,
		}));
		const resp: GetModelsResponse = { models, routingRules };
		return c.json(resp);
	});

	app.get("/api/models/settings", async (c) => {
		const settings = await modelManager.getAllModelSettings();
		const resp: GetModelSettingsResponse = { settings };
		return c.json(resp);
	});

	app.put("/api/models/settings", async (c) => {
		const body = await c.req.json<UpdateModelSettingsRequest>();
		await modelManager.setModelSetting({
			provider: body.provider,
			model: body.model,
			temperature: body.temperature,
			maxTokens: body.maxTokens,
			thinking: body.thinking,
		});
		const setting = modelManager.getModelSetting(body.provider, body.model);
		if (!setting) {
			return c.json({ error: "Setting not found after update", code: "INTERNAL_ERROR" } satisfies ApiError, 500);
		}
		const resp: UpdateModelSettingsResponse = { setting };
		return c.json(resp);
	});

	// --- Budget ---
	app.get("/api/budget", async (c) => {
		const budgets = await modelManager.getBudgetStatus();
		const resp: GetBudgetResponse = { budgets: Array.isArray(budgets) ? budgets : [budgets] };
		return c.json(resp);
	});

	app.put("/api/budget", async (c) => {
		const body = await c.req.json<UpdateBudgetRequest>();
		await modelManager.configureBudget(body);
		const resp: UpdateBudgetResponse = { config: body };
		return c.json(resp);
	});

	// --- MCP (Model Context Protocol) ---

	// F-3.6: MCP server status (for dashboard MCP card)
	// TODO Phase 4: real MCP inspector via fan-mcp runtime bridge, currently stub
	app.get("/api/mcp/servers", async (c) => {
		const response: ApiMcpStatusResponse = {
			servers: [],
			totalConnected: 0,
			totalUnavailable: 0,
			lastUpdate: new Date().toISOString(),
		};
		return c.json(response);
	});

	// --- Tokens ---
	app.post("/api/tokens", async (c) => {
		const body = await c.req.json<{ name: string }>();
		if (!body.name) {
			return c.json({ error: "Token name is required", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		const token = await createToken(body.name);
		const resp: GenerateTokenResponse = {
			token: {
				id: token.id,
				name: token.name,
				token: token.token,
				createdAt: token.createdAt.toISOString(),
				lastUsed: token.lastUsed?.toISOString(),
			},
		};
		return c.json(resp, 201);
	});

	app.get("/api/tokens", async (c) => {
		const tokens = await listTokens();
		const resp: ListTokensResponse = {
			tokens: tokens.map((t) => ({
				id: t.id,
				name: t.name,
				createdAt: t.createdAt.toISOString(),
				lastUsed: t.lastUsed?.toISOString(),
			})),
		};
		return c.json(resp);
	});

	app.delete("/api/tokens/:id", async (c) => {
		const id = c.req.param("id");
		const revoked = await revokeToken(id);
		if (!revoked) {
			return c.json({ error: "Token not found", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		const resp: RevokeTokenResponse = { success: true };
		return c.json(resp);
	});

	// --- Dashboard static serving (optional) ---
	let dashboardServed = false;
	if (options.dashboardDir) {
		const { existsSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const dashboardPath = resolve(options.dashboardDir);

		if (existsSync(dashboardPath)) {
			dashboardServed = true;

			// Serve static assets from dashboard dir
			app.use("/*", serveStatic({ root: dashboardPath }));

			// SPA fallback: serve index.html for non-API, non-static routes
			app.get("*", async (c) => {
				const { readFile } = await import("node:fs/promises");
				const indexPath = resolve(dashboardPath, "index.html");
				return c.html(await readFile(indexPath, "utf-8"));
			});
		}
	}

	// Only set 404 handler if dashboard is not being served
	if (!dashboardServed) {
		app.notFound((c) => {
			return c.json({ error: "Not found", code: "NOT_FOUND" } satisfies ApiError, 404);
		});
	}

	// --- Global error handler ---
	app.onError((err, c) => {
		const status = classifyErrorStatus(err);
		const code = classifyErrorCode(err);
		const message = status === 500 ? "Internal server error" : err instanceof Error ? err.message : "Request error";

		if (status >= 500) {
			console.error("[api-gateway] Unhandled error:", err);
		} else {
			console.warn(`[api-gateway] Client error (${status}):`, err.message);
		}

		return c.json({ error: message, code } satisfies ApiError, status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
	});

	return app;
}

// ============================================================================
// Start Server
// ============================================================================

export async function startServer(
	modelManager: ModelManager,
	sessionAdapter: SessionAdapter,
	options: ServerOptions = {},
): Promise<{ port: number; stop: () => Promise<void> }> {
	const { port = 3456, host = "localhost" } = options;
	const app = await createApp(modelManager, sessionAdapter, options);

	// Dynamic import to support both Bun and Node.js
	let stop: () => Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const hasBun = typeof (globalThis as any).Bun !== "undefined";

	if (hasBun) {
		// Bun native serve
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const bunGlobal = (globalThis as any).Bun as any;
		const server = bunGlobal.serve({
			port,
			hostname: host,
			fetch: app.fetch,
		});
		stop = async () => server.stop();
	} else {
		// Node.js — use @hono/node-server for proper body handling + raw Server for WebSocket upgrade
		const { serve } = await import("@hono/node-server");

		// serve() returns the raw http.Server (ServerType) which we need for WebSocket upgrade
		const httpServer = serve({ fetch: app.fetch, port, hostname: host });

		// Attach WebSocket handler (requires 'ws' package)
		const wsHandler = attachWebSocketHandler({ server: httpServer as any, sessionAdapter });

		stop = async () => {
			wsHandler.close();
			return new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		};
	}

	console.log(`[api-gateway] Server running at http://${host}:${port}`);
	console.log(`[api-gateway] Health: http://${host}:${port}/api/health`);
	console.log(`[api-gateway] Docs: http://${host}:${port}/api/health`);
	if (isAuthDisabled()) {
		console.warn(`[api-gateway] ⚠️  Auth disabled (FAN_NO_AUTH=${process.env.FAN_NO_AUTH})`);
	}

	return { port, stop };
}

export { createApp };
