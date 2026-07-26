import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { normalize as normalizePath, resolve as resolvePath } from "node:path";
import { getPrismaClient } from "@fan/db";
import type { ModelManager, RoutingRuleData } from "@fan/model-manager";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { generateToken as createToken, isAuthDisabled, listTokens, revokeToken, tokenAuth } from "./auth.js";
import { resolveCorsOrigin } from "./cors-config.js";
import { ProjectBudgetStore } from "./project-budgets.js";
import type {
	ApiError,
	ApiMcpStatusResponse,
	CreateProjectRequest,
	CreateProjectResponse,
	CreateProjectResult,
	CreateSessionRequest,
	CreateSessionResponse,
	GenerateTokenResponse,
	GetBudgetResponse,
	GetModelSettingsResponse,
	GetModelsResponse,
	GetProjectBudgetResponse,
	GetSessionResponse,
	HealthResponse,
	ListProjectsResponse,
	ListSessionsResponse,
	ListTokensResponse,
	ModelInfo,
	ProjectInfo,
	ProjectSummary,
	RevokeTokenResponse,
	RoutingRuleInfo,
	SendMessageRequest,
	SendMessageResponse,
	SessionSummary,
	SetProjectBudgetResponse,
	UpdateBudgetRequest,
	UpdateBudgetResponse,
	UpdateModelSettingsRequest,
	UpdateModelSettingsResponse,
	UpdateProjectRequest,
	UpdateProjectResponse,
} from "./types.js";
import { logCwdRejection, resolveAllowedRoots, validateCwd } from "./workspace-validation.js";
import { attachWebSocketHandler, type BunServerLike, createBunWebSocketBridge } from "./ws-handler.js";

// Version is passed via ServerOptions to avoid __dirname resolution issues
// in compiled Bun binaries where __dirname points inside the runtime.
let _version = "unknown";

// ============================================================================
// Session Adapter Interface
// ============================================================================

/** Minimal interface for session management — injected by CLI entry point */
export interface SessionAdapter {
	/** List available sessions.
	 *  F-1.9: optional projectPath — only sessions whose cwd belongs to that project
	 *  (normalized comparison). Without it, all sessions (global, backward compat). */
	listSessions(projectPath?: string): Promise<SessionSummary[]>;
	/** Get session details with messages.
	 *  F-1.9: optional projectPath — returns null when the session exists but belongs
	 *  to a different project. Decision: null (not an error) — the adapter is
	 *  transport-agnostic and has no notion of HTTP 403; the HTTP layer maps null
	 *  to its own status codes. Without projectPath the lookup is global. */
	getSession(id: string, projectPath?: string): Promise<GetSessionResponse | null>;
	/** Create a new session (F-1.3: optional cwd — working directory of the new session) */
	createSession(options?: { title?: string; parentSessionId?: string; cwd?: string }): Promise<CreateSessionResponse>;
	/** Delete a session.
	 *  F-1.9: optional projectPath — refuses to delete (returns false, session kept)
	 *  when the session belongs to a different project. Without projectPath the
	 *  delete is global (backward compat). */
	deleteSession(id: string, projectPath?: string): Promise<boolean>;
	/** Send a message to a session (events stream via WebSocket) */
	sendMessage(sessionId: string, message: string, streamingBehavior?: "steer" | "followUp"): Promise<boolean>;
	/** Subscribe to session events for WebSocket forwarding */
	subscribeToSession(sessionId: string, handler: (event: any) => void): () => void;
	/** Get available models from ModelRegistry */
	getAvailableModels(): Promise<ModelInfo[]>;
	/** Bind extensions to the current session (called after session switch/create) */
	bindSessionExtensions(): Promise<void>;
	/** List registered projects/workspaces (F-1.5; source: project-registry in coding-agent) */
	listProjects(): Promise<ProjectInfo[]>;
	/** Remove a project from the registry by absolute path (F-2.13).
	 *  Returns true when an entry was removed, false when it was not registered.
	 *  Optional — adapters without it cause DELETE /api/projects to answer 501. */
	removeProject?(path: string): Promise<boolean>;
	/** Update a project's type in the registry by absolute path (F-3.10 —
	 *  manual type override). Returns the updated entry, or null when the
	 *  path is not registered. Registry-only: sessions and files on disk
	 *  are never touched. Optional — adapters without it cause
	 *  PUT /api/projects to answer 501. */
	updateProject?(path: string, type: string): Promise<ProjectInfo | null>;
	/** Create a project workspace (F-3.5): apply the optional template to
	 *  `rootPath/name`, auto-detect the type and register the project.
	 *  Returns metadata plus `created` (false = path already registered,
	 *  idempotent repeat). Throws `Error('Unknown template: ...')` for
	 *  unregistered template names — mapped to 400 by the HTTP layer.
	 *  Optional — adapters without it cause POST /api/projects to answer 501. */
	createProject?(options: { name: string; template?: string; rootPath: string }): Promise<CreateProjectResult>;
	/** Get the id of the currently active session (null if none). Optional — used by /api/health readiness. */
	getActiveSessionId?(): string | null;
	/** F-2.5: whether the engine is currently executing a prompt (streaming).
	 *  Single-engine runtime: the check is global, not per-session. Optional —
	 *  adapters without it are treated as always idle (WS messages are dispatched
	 *  directly, never queued). */
	isExecuting?(): boolean;
}

// ============================================================================
// Server Options
// ============================================================================

export interface ServerOptions {
	port?: number;
	host?: string;
	dashboardDir?: string; // Path to dashboard dist directory. If provided, serves the dashboard.
	version?: string; // Application version (passed from caller to avoid __dirname issues in compiled binaries)
	/** F-1.13: workspace whitelist for cwd validation. When omitted, resolved
	 *  from FAN_WORKSPACE_ROOT (env pattern like ALLOWED_ORIGINS). An empty
	 *  resolved list → bypass (local mode, no restrictions). */
	allowedRoots?: string[];
	/** F-4.9: path of the per-project budget store file.
	 *  Default: `~/.fan/agent/project-budgets.json` (next to projects.json).
	 *  Overridable for tests / custom agent dirs. */
	projectBudgetsFile?: string;
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

/** Known project types (F-3.1; mirrors PROJECT_TYPES in coding-agent's
 *  project-registry — duplicated here to keep the gateway dependency-free). */
const PROJECT_TYPES = ["code", "research", "automation", "unknown"] as const;

/** Mask the value of any `token` query parameter in a log line.
 *  Handles both `?token=...` and `&token=...` without affecting other params.
 */
function scrubTokenInLog(line: string): string {
	return line.replace(/([?&])token=[^&\s]*/g, "$1token=***");
}

/**
 * Normalize a filesystem path for equality comparison (F-1.2 ?project= filter).
 * Pure string-based (no fs access, platform-independent):
 * backslashes → forward slashes, resolve `.`/`..` segments, strip trailing slash,
 * lowercase drive letter on Windows-style paths (`C:\...`).
 */
function normalizeProjectPath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	// Collapse duplicate slashes
	s = s.replace(/\/{2,}/g, "/");
	// Resolve . and .. segments
	const isAbsolute = s.startsWith("/") || /^[A-Za-z]:\//.test(s);
	const segments: string[] = [];
	for (const seg of s.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else if (!isAbsolute) segments.push("..");
			continue;
		}
		segments.push(seg);
	}
	let normalized = segments.join("/");
	if (s.startsWith("/")) normalized = `/${normalized}`;
	// Windows: case-insensitive filesystem — compare case-folded
	if (/^[A-Za-z]:/.test(normalized)) normalized = normalized.toLowerCase();
	return normalized;
}

/** Basename of a normalized path (pure string-based, no fs access). */
function pathBasename(p: string): string {
	const segments = p.split("/").filter((seg) => seg.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : p;
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
	// F-1.13: whitelist for cwd validation. Explicit option wins (server mode
	// passes [FAN_WORKSPACE_ROOT → ~/projects]); otherwise the env-based
	// resolution. Empty list → bypass (local mode).
	const allowedRoots = options.allowedRoots ?? resolveAllowedRoots();
	const app = new Hono();

	// Middleware
	// F-0.10: scrub token query parameter from access logs before they reach
	// stdout, docker logs and the persistent /data/logs/app.log volume.
	app.use(
		"*",
		logger((line) => console.log(scrubTokenInLog(line))),
	);
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
		// F-1.3: optional cwd — must be a non-empty string when provided.
		// Validate the body shape and cwd type before normalization so that
		// non-string values (null/number/array/object) surface as 400 instead
		// of TypeError → 500. An empty/whitespace-only cwd is also rejected as
		// 400 because it is not a usable filesystem path.
		const rawBody = await c.req.json();
		if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
			return c.json({ error: "Request body must be a JSON object", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		const body = rawBody as CreateSessionRequest;

		if ("cwd" in body) {
			if (typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
				return c.json({ error: "cwd must be a non-empty string", code: "BAD_REQUEST" } satisfies ApiError, 400);
			}
			const normalizedCwd = normalizeProjectPath(body.cwd);
			// F-1.13: whitelist validation BEFORE the runtime touches the path
			// (previously an invalid directory surfaced as a 500 on process.chdir).
			// Rejections are audit-logged (structured field → F-0.10 file logger).
			const validation = validateCwd(normalizedCwd, allowedRoots);
			if (!validation.valid) {
				logCwdRejection({ cwd: normalizedCwd, reason: validation.reason ?? "rejected", allowedRoots });
				return c.json({ error: `cwd rejected: ${validation.reason}`, code: "FORBIDDEN" } satisfies ApiError, 403);
			}
			body.cwd = normalizedCwd;
		}
		const session = await sessionAdapter.createSession(body);
		return c.json(session, 201);
	});

	app.get("/api/sessions", async (c) => {
		// F-1.2: optional ?project=<path> filter — only sessions whose cwd
		// matches the project path (normalized comparison). Without the param
		// the full list is returned (backward compatible).
		// F-1.9: the filter is also pushed down into the adapter; the handler-side
		// filter stays as defense-in-depth for adapters that ignore the param.
		// F-2.13: a ?project= path that does not exist on disk is NOT an error —
		// the whitelist (F-1.13) allows not-yet-created directories inside a root,
		// and orphaned sessions of a deleted project must stay visible/manageable.
		// The endpoint simply returns the cwd-filtered list (empty when no session
		// ever ran with that cwd). No error, no warning header.
		const project = c.req.query("project");
		let sessions = await sessionAdapter.listSessions(project);
		if (project) {
			const target = normalizeProjectPath(project);
			sessions = sessions.filter((s) => s.cwd !== undefined && normalizeProjectPath(s.cwd) === target);
		}
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
		// F-1.4: optional ?project=<path> — the session must belong to the given
		// project (cwd match, normalized comparison) or deletion is rejected with
		// 403. Without the param the delete is global (backward compatible).
		const project = c.req.query("project");
		if (project) {
			const session = await sessionAdapter.getSession(id);
			if (!session) {
				return c.json({ error: "Session not found", code: "NOT_FOUND" } satisfies ApiError, 404);
			}
			const target = normalizeProjectPath(project);
			if (session.cwd === undefined || normalizeProjectPath(session.cwd) !== target) {
				return c.json({ error: "session does not belong to this project" }, 403);
			}
		}
		const deleted = await sessionAdapter.deleteSession(id, project);
		if (!deleted) {
			return c.json({ error: "Session not found", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		return c.body(null, 204);
	});

	// --- Projects (F-1.5) ---
	app.get("/api/projects", async (c) => {
		// Projects come from the adapter (project registry); session counts are
		// derived from listSessions() grouped by normalized cwd.
		const [projects, sessions] = await Promise.all([sessionAdapter.listProjects(), sessionAdapter.listSessions()]);

		const countByCwd = new Map<string, number>();
		for (const s of sessions) {
			if (s.cwd === undefined) continue;
			const key = normalizeProjectPath(s.cwd);
			countByCwd.set(key, (countByCwd.get(key) ?? 0) + 1);
		}

		const resp: ListProjectsResponse = {
			projects: projects.map((p): ProjectSummary => {
				const normalizedPath = normalizeProjectPath(p.path);
				// F-2.13: check directory existence at the API boundary (adapter-
				// agnostic). Missing projects are NOT excluded from the list — the
				// user must see them to remove them via DELETE /api/projects.
				const available = existsSync(p.path);
				return {
					path: p.path,
					// name from the registry when present; otherwise basename of the path
					name: p.name && p.name.length > 0 ? p.name : pathBasename(normalizedPath),
					type: p.type,
					sessionCount: countByCwd.get(normalizedPath) ?? 0,
					available,
					...(available ? {} : { error: "PROJECT_NOT_FOUND" as const }),
				};
			}),
		};
		return c.json(resp);
	});

	// F-3.5: create a project workspace from a template.
	// Flow: validate body → resolve path → whitelist validation (F-1.13) →
	// adapter.createProject (template application + type detection + registry
	// write — the gateway never touches coding-agent directly, DI-style like
	// listProjects/removeProject).
	//
	// Documented contract decisions:
	// - `template` is OPTIONAL. Without it the adapter creates an empty
	//   directory (mkdir -p), auto-detects the type (an empty dir → 'unknown')
	//   and registers the project.
	// - Unknown template name → 400 { error: 'Unknown template: <name>' }.
	//   The gateway stays template-agnostic: the adapter throws an Error whose
	//   message starts with 'Unknown template:' and the handler maps it to 400.
	// - Duplicate (resolved path already in the registry) → 200 with the
	//   EXISTING registry entry (idempotent creation, mirrors the registry's
	//   dedup-by-path semantics). Fresh creation → 201.
	// - `name` must be a non-empty single path segment: path separators
	//   ('/', '\\') and '..' are rejected with 400 — traversal never reaches
	//   the filesystem. Path-outside-whitelist is rejected with 403 (F-1.13).
	// - Default rootPath: the first allowed root (= FAN_WORKSPACE_ROOT →
	//   ~/projects chain resolved at startup), falling back to ~/projects when
	//   no whitelist is configured (local mode).
	app.post("/api/projects", async (c) => {
		const rawBody = await c.req.json();
		if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
			return c.json({ error: "Request body must be a JSON object", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		const body = rawBody as CreateProjectRequest;

		// name: required, non-empty, single path segment (no traversal).
		if (typeof body.name !== "string" || body.name.trim().length === 0) {
			return c.json(
				{ error: "name is required and must be a non-empty string", code: "BAD_REQUEST" } satisfies ApiError,
				400,
			);
		}
		const name = body.name.trim();
		if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
			return c.json(
				{
					error: "name must be a single path segment (no '/', '\\\\', '..' or '.')",
					code: "BAD_REQUEST",
				} satisfies ApiError,
				400,
			);
		}

		// template: optional, non-empty string when provided.
		let template: string | undefined;
		if (body.template !== undefined) {
			if (typeof body.template !== "string" || body.template.trim().length === 0) {
				return c.json(
					{ error: "template must be a non-empty string", code: "BAD_REQUEST" } satisfies ApiError,
					400,
				);
			}
			template = body.template.trim();
		}

		// rootPath: optional, defaults to the workspace root (whitelist root or ~/projects).
		let rootPath: string;
		if (body.rootPath !== undefined) {
			if (typeof body.rootPath !== "string" || body.rootPath.trim().length === 0) {
				return c.json(
					{ error: "rootPath must be a non-empty string", code: "BAD_REQUEST" } satisfies ApiError,
					400,
				);
			}
			rootPath = body.rootPath;
		} else {
			rootPath = allowedRoots[0] ?? resolvePath(homedir(), "projects");
		}

		// F-1.13: whitelist validation BEFORE the adapter touches the filesystem.
		const fullPath = resolvePath(rootPath, name);
		if (normalizePath(fullPath) === normalizePath(resolvePath(rootPath))) {
			return c.json(
				{ error: "name cannot resolve to the workspace root", code: "BAD_REQUEST" } satisfies ApiError,
				400,
			);
		}
		const validation = validateCwd(fullPath, allowedRoots);
		if (!validation.valid) {
			logCwdRejection({ cwd: fullPath, reason: validation.reason ?? "rejected", allowedRoots });
			return c.json({ error: `path rejected: ${validation.reason}`, code: "FORBIDDEN" } satisfies ApiError, 403);
		}

		if (!sessionAdapter.createProject) {
			return c.json(
				{ error: "project creation is not supported by this adapter", code: "NOT_IMPLEMENTED" } satisfies ApiError,
				501,
			);
		}

		let result: CreateProjectResult;
		try {
			result = await sessionAdapter.createProject({
				name,
				...(template !== undefined ? { template } : {}),
				rootPath,
			});
		} catch (err) {
			// Unknown template names surface from the template registry as
			// Error('Unknown template: <name>') — map to 400 (contract: the
			// gateway stays agnostic of registered template names).
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.startsWith("Unknown template:")) {
				return c.json({ error: msg, code: "BAD_REQUEST" } satisfies ApiError, 400);
			}
			throw err;
		}

		const resp: CreateProjectResponse = {
			path: result.path,
			name: result.name,
			type: result.type,
			...(result.template !== undefined ? { template: result.template } : {}),
		};
		return c.json(resp, result.created ? 201 : 200);
	});

	// F-2.13: remove a project from the registry by absolute path.
	// Contract: query param ?path= (not body — DELETE bodies are poorly
	// supported by proxies/clients, and ?path= mirrors the ?project= convention
	// used by the session endpoints). 204 on success; 400 when the param is
	// missing/empty; 404 when the path is not registered; 501 when the adapter
	// does not implement removeProject. Only the registry entry is removed —
	// sessions and files on disk are never touched.
	app.delete("/api/projects", async (c) => {
		const path = c.req.query("path");
		if (!path || path.trim().length === 0) {
			return c.json({ error: "path query parameter is required", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		if (!sessionAdapter.removeProject) {
			return c.json(
				{ error: "project removal is not supported by this adapter", code: "NOT_IMPLEMENTED" } satisfies ApiError,
				501,
			);
		}
		const removed = await sessionAdapter.removeProject(path);
		if (!removed) {
			return c.json({ error: "Project not found in registry", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		return c.body(null, 204);
	});

	// F-3.10: manual project type override.
	// Contract mirrors DELETE /api/projects: the path travels as a query
	// parameter (?path=<encoded>) because it contains slashes; the body
	// carries only { type }. Used when auto-detection (F-3.2) classified a
	// project wrong. 200 with the updated entry on success; 400 when the
	// param is missing/empty or the type is not one of the four known values;
	// 404 when the path is not registered; 501 when the adapter does not
	// implement updateProject. Registry-only — sessions and files on disk
	// are never touched.
	app.put("/api/projects", async (c) => {
		const path = c.req.query("path");
		if (!path || path.trim().length === 0) {
			return c.json({ error: "path query parameter is required", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		const rawBody = await c.req.json();
		if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
			return c.json({ error: "Request body must be a JSON object", code: "BAD_REQUEST" } satisfies ApiError, 400);
		}
		const body = rawBody as UpdateProjectRequest;
		if (typeof body.type !== "string" || !(PROJECT_TYPES as readonly string[]).includes(body.type)) {
			return c.json(
				{ error: `type must be one of: ${PROJECT_TYPES.join(", ")}`, code: "BAD_REQUEST" } satisfies ApiError,
				400,
			);
		}
		if (!sessionAdapter.updateProject) {
			return c.json(
				{ error: "project update is not supported by this adapter", code: "NOT_IMPLEMENTED" } satisfies ApiError,
				501,
			);
		}
		const updated = await sessionAdapter.updateProject(path, body.type);
		if (!updated) {
			return c.json({ error: "Project not found in registry", code: "NOT_FOUND" } satisfies ApiError, 404);
		}
		const resp: UpdateProjectResponse = { path: updated.path, name: updated.name, type: updated.type };
		return c.json(resp, 200);
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
	// F-4.9 (part A): the endpoint is provider-scoped by default (backward compat)
	// and project-scoped when ?project=<path> is given. The project branch
	// aggregates assistant-message tokens from the project's JSONL sessions
	// (listSessions(project) → getSession(id) → sum message.tokens — disk is the
	// single source of truth, same philosophy as the WebUI). The per-project cap
	// is stored in project-budgets.json (see project-budgets.ts).
	// NOTE: enforcement is NOT done here — the gateway only stores/serves the
	// numbers. Deep integration with BudgetTracker/model-manager was explicitly
	// deferred; the scheduler monitors usage itself (F-4.9 part B).
	const projectBudgets = new ProjectBudgetStore(
		options.projectBudgetsFile ?? resolvePath(homedir(), ".fan", "agent", "project-budgets.json"),
	);

	app.get("/api/budget", async (c) => {
		const project = c.req.query("project");
		if (project) {
			const target = normalizeProjectPath(project);
			// Defense-in-depth cwd filter (same as GET /api/sessions?project=).
			const sessions = (await sessionAdapter.listSessions(project)).filter(
				(s) => s.cwd !== undefined && normalizeProjectPath(s.cwd) === target,
			);
			const details = await Promise.all(sessions.map((s) => sessionAdapter.getSession(s.id, project)));
			let used = 0;
			for (const detail of details) {
				for (const m of detail?.messages ?? []) {
					if (typeof m.tokens === "number") used += m.tokens;
				}
			}
			const entry = projectBudgets.get(target);
			const resp: GetProjectBudgetResponse = { project: target, used, limit: entry?.tokenLimit ?? null };
			return c.json(resp);
		}
		const budgets = await modelManager.getBudgetStatus();
		const resp: GetBudgetResponse = { budgets: Array.isArray(budgets) ? budgets : [budgets] };
		return c.json(resp);
	});

	app.put("/api/budget", async (c) => {
		const rawBody = await c.req.json();
		// F-4.9: a body with a non-empty `project` string selects the project-scoped
		// branch; anything else keeps the legacy provider-scoped behavior.
		if (
			rawBody !== null &&
			typeof rawBody === "object" &&
			!Array.isArray(rawBody) &&
			typeof (rawBody as { project?: unknown }).project === "string" &&
			((rawBody as { project: string }).project as string).trim().length > 0
		) {
			const body = rawBody as { project: string; tokenLimit?: unknown };
			if (typeof body.tokenLimit !== "number" || !Number.isFinite(body.tokenLimit) || body.tokenLimit < 0) {
				return c.json(
					{ error: "tokenLimit must be a non-negative finite number", code: "BAD_REQUEST" } satisfies ApiError,
					400,
				);
			}
			const target = normalizeProjectPath(body.project);
			const entry = projectBudgets.set(target, body.tokenLimit);
			const resp: SetProjectBudgetResponse = {
				project: target,
				limit: entry.tokenLimit,
				updatedAt: entry.updatedAt,
			};
			return c.json(resp, 200);
		}
		const body = rawBody as UpdateBudgetRequest;
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
		// Bun native serve. Bun.serve has no raw http.Server "upgrade" event,
		// so the ws-package handler cannot be attached here — WebSocket support
		// goes through server.upgrade() + the `websocket` option instead
		// (see createBunWebSocketBridge). Without this, /api/ws/* requests fell
		// through to the SPA fallback (HTTP 200 HTML instead of 101).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const bunGlobal = (globalThis as any).Bun as any;
		const wsBridge = createBunWebSocketBridge(sessionAdapter);
		const server = bunGlobal.serve({
			port,
			hostname: host,
			fetch(req: Request, srv: BunServerLike) {
				const url = new URL(req.url);
				if (url.pathname.startsWith("/api/ws/")) {
					return wsBridge.handleFetch(req, srv, url);
				}
				return app.fetch(req);
			},
			websocket: wsBridge.websocket,
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
