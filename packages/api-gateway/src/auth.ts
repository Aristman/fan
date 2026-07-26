import { randomBytes } from "node:crypto";
import { getPrismaClient, type Prisma } from "@fan/db";
import type { MiddlewareHandler } from "hono";
import { normalizeProjectPath } from "./path-utils.js";

// ============================================================================
// Types
// ============================================================================

export interface ClientTokenData {
	id: string;
	name: string;
	token: string;
	/** F-5.7: per-project scope. null = full access (backward compat); a set
	 *  value restricts the token to requests whose project context matches. */
	projectScope: string | null;
	createdAt: Date;
	lastUsed: Date | null;
}

/** Result of a project-scope authorization check (F-5.7). */
export interface ScopeCheckResult {
	authorized: boolean;
	reason?: string;
}

// ============================================================================
// Token CRUD Operations
// ============================================================================

/** Generate a new API token.
 *  F-5.7: optional projectScope — normalized before persisting; when omitted
 *  the token is created with scope null (full access, backward compat). */
export async function generateToken(name: string, projectScope?: string): Promise<ClientTokenData> {
	const token = randomBytes(32).toString("hex");
	const record = await getPrismaClient().clientToken.create({
		data: {
			name,
			token,
			...(projectScope !== undefined ? { projectScope: normalizeProjectPath(projectScope) } : {}),
		},
	});
	return mapToClientToken(record);
}

/** Validate a token string, returns the token data or null */
export async function validateToken(token: string): Promise<ClientTokenData | null> {
	try {
		const record = await getPrismaClient().clientToken.update({
			where: { token },
			data: { lastUsed: new Date() },
		});
		return mapToClientToken(record);
	} catch {
		return null;
	}
}

/**
 * List tokens (without exposing full token value).
 * F-5.7: when `scope` is provided, only tokens whose projectScope equals that
 * value are returned. Scoped UI clients use this to manage their own tokens.
 */
export async function listTokens(scope?: string): Promise<Omit<ClientTokenData, "token">[]> {
	const args: Prisma.ClientTokenFindManyArgs = { orderBy: { createdAt: "desc" } };
	if (scope !== undefined) {
		args.where = { projectScope: scope };
	}
	const records = await getPrismaClient().clientToken.findMany(args);
	return records.map(
		({
			token: _token,
			...rest
		}: {
			id: string;
			name: string;
			token: string;
			projectScope: string | null;
			createdAt: Date;
			lastUsed: Date | null;
		}) => rest,
	);
}

/** Fetch a single token record by ID, including the raw token value. */
export async function getTokenById(id: string): Promise<ClientTokenData | null> {
	try {
		const record = await getPrismaClient().clientToken.findUnique({ where: { id } });
		return record ? mapToClientToken(record) : null;
	} catch {
		return null;
	}
}

/**
 * Revoke a token by ID.
 * F-5.7: when `callerScope` is provided, the token is deleted only if it
 * belongs to that scope. A scoped caller cannot revoke foreign or full-access
 * tokens. Returns false when the token does not exist or the caller is not
 * allowed to revoke it.
 */
export async function revokeToken(id: string, callerScope?: string): Promise<boolean> {
	try {
		const prisma = getPrismaClient();
		if (callerScope !== undefined) {
			const token = await prisma.clientToken.findUnique({ where: { id } });
			if (!token) return false;
			if (token.projectScope !== callerScope) return false;
		}
		await prisma.clientToken.delete({ where: { id } });
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Project Scope Authorization (F-5.7)
// ============================================================================

/**
 * Pure project-scope check for a validated token (F-5.7).
 *
 * Semantics (documented contract):
 * - `projectScope === null` (legacy token) → always authorized, any project
 *   (full backward compatibility, TC-F-5.7-1).
 * - Scoped token + requested project that differs (normalized comparison) →
 *   not authorized, reason 'token not scoped to this project' (TC-F-5.7-2).
 * - Scoped token + requested project equal to the scope (exact match after
 *   normalization — no prefix/subtree matching) → authorized (TC-F-5.7-3).
 * - Scoped token + NO requested project (undefined/null/empty) → not
 *   authorized: a scoped token must operate inside its project context.
 *   The HTTP middleware whitelists a small set of project-neutral endpoints
 *   (see SCOPE_NEUTRAL_ENDPOINTS) before applying this branch.
 */
export function authorizeProjectScope(
	clientToken: Pick<ClientTokenData, "projectScope">,
	requestedProject?: string | null,
): ScopeCheckResult {
	if (!clientToken.projectScope) {
		return { authorized: true };
	}
	if (requestedProject === undefined || requestedProject === null || requestedProject.trim().length === 0) {
		return { authorized: false, reason: "token requires a project context matching its scope" };
	}
	if (normalizeProjectPath(requestedProject) !== normalizeProjectPath(clientToken.projectScope)) {
		return { authorized: false, reason: "token not scoped to this project" };
	}
	return { authorized: true };
}

/**
 * Endpoints a project-scoped token may call WITHOUT a project context (F-5.7).
 *
 * Explicit policy: a scoped token = only its own project + only its own tokens.
 * Neutral endpoints are either read-only global metadata or operations whose
 * handler further constrains the result to the caller's scope.
 *
 *   - GET /api/models /models/settings /mcp/servers: read-only global metadata.
 *   - POST /api/tokens: handler enforces the created token's scope = caller scope.
 *   - GET /api/tokens: handler filters to tokens within the caller's scope.
 *   - DELETE /api/tokens/:id: handler verifies the target token's scope.
 *   - GET /api/projects: handler filters to the caller's scope project.
 *   - POST /api/projects: handler verifies the resolved target path is inside
 *     the caller's scope.
 */
const SCOPE_NEUTRAL_ENDPOINTS: ReadonlyArray<{ method: string; path: string }> = [
	{ method: "GET", path: "/api/models" },
	{ method: "GET", path: "/api/models/settings" },
	{ method: "GET", path: "/api/mcp/servers" },
	{ method: "POST", path: "/api/tokens" },
	{ method: "GET", path: "/api/tokens" },
	{ method: "GET", path: "/api/projects" },
	{ method: "POST", path: "/api/projects" },
];

/**
 * Neutral endpoints whose path contains a dynamic segment. These are treated
 * the same as SCOPE_NEUTRAL_ENDPOINTS: no project context is required at the
 * middleware layer; the handler performs the ownership check.
 */
const SCOPE_NEUTRAL_PATTERNS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
	{ method: "DELETE", pattern: /^\/api\/tokens\/[^/]+$/ },
];

/**
 * Endpoints where the project scope is resolved from the requested resource
 * itself, not from an explicit ?project= context (F-5.7).
 *
 * For these routes a scoped token is allowed through even when the request
 * carries no project context; the handler then checks the resource's project
 * (session.cwd) against the token scope. Without this exception a REST client
 * holding a scoped token could not access its own sessions except by
 * redundantly adding ?project=<scope> to every request.
 *
 * Matches:
 *   GET /api/sessions/:id
 *   POST /api/sessions/:id/messages
 *   DELETE /api/sessions/:id
 */
const SCOPE_RESOURCE_ENDPOINTS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
	{ method: "GET", pattern: /^\/api\/sessions\/[^/]+$/ },
	{ method: "POST", pattern: /^\/api\/sessions\/[^/]+\/messages$/ },
	{ method: "DELETE", pattern: /^\/api\/sessions\/[^/]+$/ },
];

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Extract project context candidates from a request (F-5.7).
 * Sources, in order: query `?project=`, query `?path=` (project registry
 * endpoints), JSON body fields `cwd` / `project` / `rootPath`. Hono caches
 * the parsed body, so reading it here does not consume it for the handler.
 */
async function extractRequestedProjects(c: Parameters<MiddlewareHandler>[0]): Promise<string[]> {
	const projects: string[] = [];
	const url = new URL(c.req.url);
	for (const param of ["project", "path"]) {
		const value = url.searchParams.get(param);
		if (value && value.trim().length > 0) projects.push(value);
	}
	if (BODY_METHODS.has(c.req.method)) {
		const contentType = c.req.header("Content-Type") ?? "";
		if (contentType.includes("application/json")) {
			try {
				const body = await c.req.json();
				if (body !== null && typeof body === "object" && !Array.isArray(body)) {
					for (const key of ["cwd", "project", "rootPath"]) {
						const value = (body as Record<string, unknown>)[key];
						if (typeof value === "string" && value.trim().length > 0) projects.push(value);
					}
				}
			} catch {
				// Empty or malformed JSON body — no project context extractable;
				// the handler will surface the body error itself.
			}
		}
	}
	return projects;
}

const PUBLIC_TRUE = new Set(["1", "true", "yes", "on"]);
const PUBLIC_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Check if public server mode is enabled (`FAN_PUBLIC`).
 *
 * Public mode is intended for internet-facing deployments: authentication
 * becomes mandatory and `FAN_NO_AUTH` is ignored entirely.
 *
 * Values are normalized with `trim().toLowerCase()`:
 * - public: "1", "true", "yes", "on"
 * - local: undefined, empty/whitespace, "0", "false", "no", "off"
 * - any other non-empty value is treated as public (fail-closed) and a warning
 *   is written to stderr.
 */
export function isPublicMode(envPublic: string | undefined = process.env.FAN_PUBLIC): boolean {
	if (envPublic === undefined) {
		return false;
	}
	const normalized = envPublic.trim().toLowerCase();
	if (normalized === "") {
		return false;
	}
	if (PUBLIC_TRUE.has(normalized)) {
		return true;
	}
	if (PUBLIC_FALSE.has(normalized)) {
		return false;
	}
	process.stderr.write(
		`FAN_PUBLIC имеет нераспознанное значение ${JSON.stringify(envPublic)}, трактуется как включённый публичный режим\n`,
	);
	return true;
}

/** Check if auth is disabled via environment variable.
 *  FAN_NO_AUTH is ignored in public mode (FAN_PUBLIC=1): auth cannot be
 *  disabled on an internet-facing deployment, even if set explicitly.
 */
export function isAuthDisabled(): boolean {
	if (isPublicMode()) {
		return false;
	}
	return process.env.FAN_NO_AUTH === "1" || process.env.FAN_NO_AUTH === "true";
}

/** Hono middleware for token-based authentication.
 *  Checks Authorization: Bearer <token> header or ?token=<token> query param.
 *  Skipped entirely if FAN_NO_AUTH=1 (ignored when FAN_PUBLIC=1).
 *
 *  F-5.7 project scope enforcement (after token validation):
 *  - scope=null → full access (backward compat);
 *  - scoped token → every project context found in the request (query
 *    project/path, body cwd/project/rootPath) must equal the scope,
 *    otherwise 403 'token not scoped to this project';
 *  - scoped token + no project context → 403, except the project-neutral
 *    endpoints in SCOPE_NEUTRAL_ENDPOINTS (conservative default: deny).
 */
export const tokenAuth: MiddlewareHandler = async (c, next) => {
	if (isAuthDisabled()) {
		return next();
	}

	const authHeader = c.req.header("Authorization");
	const queryToken = new URL(c.req.url).searchParams.get("token");

	let tokenValue: string | undefined;

	if (authHeader?.startsWith("Bearer ")) {
		tokenValue = authHeader.slice(7);
	} else if (queryToken) {
		tokenValue = queryToken;
	}

	if (!tokenValue) {
		return c.json({ error: "Authentication required", code: "UNAUTHORIZED" }, 401);
	}

	const clientToken = await validateToken(tokenValue);
	if (!clientToken) {
		return c.json({ error: "Invalid token", code: "FORBIDDEN" }, 403);
	}

	// F-5.7: per-project scope enforcement
	if (clientToken.projectScope) {
		const requestedProjects = await extractRequestedProjects(c);
		if (requestedProjects.length === 0) {
			const path = new URL(c.req.url).pathname;
			const neutral =
				SCOPE_NEUTRAL_ENDPOINTS.some((e) => e.method === c.req.method && e.path === path) ||
				SCOPE_NEUTRAL_PATTERNS.some((e) => e.method === c.req.method && e.pattern.test(path));
			const resource = SCOPE_RESOURCE_ENDPOINTS.some((e) => e.method === c.req.method && e.pattern.test(path));
			if (!neutral && !resource) {
				const check = authorizeProjectScope(clientToken, null);
				return c.json({ error: check.reason, code: "FORBIDDEN" }, 403);
			}
		} else {
			for (const requested of requestedProjects) {
				const check = authorizeProjectScope(clientToken, requested);
				if (!check.authorized) {
					return c.json({ error: check.reason, code: "FORBIDDEN" }, 403);
				}
			}
		}
	}

	// Store token info in context for handlers
	c.set("clientToken", clientToken);
	return next();
};

// ============================================================================
// Helpers
// ============================================================================

function mapToClientToken(record: {
	id: string;
	name: string;
	token: string;
	projectScope?: string | null;
	createdAt: Date;
	lastUsed: Date | null;
}): ClientTokenData {
	return {
		id: record.id,
		name: record.name,
		token: record.token,
		projectScope: record.projectScope ?? null,
		createdAt: record.createdAt,
		lastUsed: record.lastUsed,
	};
}

// ============================================================================
// Hono Context Variable Augmentation
// ============================================================================

declare module "hono" {
	interface ContextVariableMap {
		clientToken: ClientTokenData;
	}
}
