import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@fan/db";
import type { MiddlewareHandler } from "hono";

// ============================================================================
// Types
// ============================================================================

export interface ClientTokenData {
	id: string;
	name: string;
	token: string;
	createdAt: Date;
	lastUsed: Date | null;
}

// ============================================================================
// Token CRUD Operations
// ============================================================================

/** Generate a new API token */
export async function generateToken(name: string): Promise<ClientTokenData> {
	const token = randomBytes(32).toString("hex");
	const record = await getPrismaClient().clientToken.create({
		data: { name, token },
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

/** List all tokens (without exposing full token value) */
export async function listTokens(): Promise<Omit<ClientTokenData, "token">[]> {
	const records = await getPrismaClient().clientToken.findMany({
		orderBy: { createdAt: "desc" },
	});
	return records.map(
		({
			token: _token,
			...rest
		}: {
			id: string;
			name: string;
			token: string;
			createdAt: Date;
			lastUsed: Date | null;
		}) => rest,
	);
}

/** Revoke a token by ID */
export async function revokeToken(id: string): Promise<boolean> {
	try {
		await getPrismaClient().clientToken.delete({ where: { id } });
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Hono Middleware
// ============================================================================

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
	createdAt: Date;
	lastUsed: Date | null;
}): ClientTokenData {
	return {
		id: record.id,
		name: record.name,
		token: record.token,
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
