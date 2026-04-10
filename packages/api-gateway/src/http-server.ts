import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { tokenAuth } from "./auth.js";
import { generateToken as createToken, listTokens, revokeToken } from "./auth.js";
import { attachWebSocketHandler } from "./ws-handler.js";
import type {
  CreateSessionRequest, CreateSessionResponse, SessionSummary,
  ListSessionsResponse, GetSessionResponse,
  DeleteSessionResponse, SendMessageRequest, SendMessageResponse,
  GetModelsResponse, ModelInfo, RoutingRuleInfo,
  GetModelSettingsResponse, UpdateModelSettingsRequest, UpdateModelSettingsResponse,
  GetBudgetResponse, UpdateBudgetRequest, UpdateBudgetResponse,
  HealthResponse, GenerateTokenResponse, ListTokensResponse, RevokeTokenResponse,
  ApiError,
} from "./types.js";
import type { ModelManager, RoutingRuleData } from "@fan/model-manager";

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
}

// ============================================================================
// Server Options
// ============================================================================

export interface ServerOptions {
  port?: number;
  host?: string;
}

// ============================================================================
// Create Hono App
// ============================================================================

const startTime = Date.now();

function createApp(modelManager: ModelManager, sessionAdapter: SessionAdapter): Hono {
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use("*", cors({ origin: "*" }));

  // --- Health (no auth required) ---
  app.get("/api/health", (c) => {
    const resp: HealthResponse = {
      status: "ok",
      version: "0.1.0",
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
    return c.json(resp);
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

  // --- 404 fallback ---
  app.notFound((c) => {
    return c.json({ error: "Not found", code: "NOT_FOUND" } satisfies ApiError, 404);
  });

  // --- Global error handler ---
  app.onError((err, c) => {
    console.error("[api-gateway] Unhandled error:", err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" } satisfies ApiError, 500);
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
  const app = createApp(modelManager, sessionAdapter);

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
    // Node.js — create raw HTTP server for WebSocket upgrade support
    const { createServer } = await import("node:http");
    const { IncomingMessage, ServerResponse } = await import("node:http");

    const httpServer = createServer((req: InstanceType<typeof IncomingMessage>, res: InstanceType<typeof ServerResponse>) => {
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(url.toString(), {
        method: req.method || "GET",
        headers,
      });
      Promise.resolve(app.fetch(request)).then((response: Response) => {
        res.statusCode = response.status;
        response.headers.forEach((value: string, key: string) => {
          res.setHeader(key, value);
        });
        return response.text();
      }).then((body: string) => {
        res.end(body);
      }).catch((err: unknown) => {
        console.error("[api-gateway] Error handling request:", err);
        res.statusCode = 500;
        res.end("Internal Server Error");
      });
    });

    // Attach WebSocket handler (requires 'ws' package)
    const wsHandler = attachWebSocketHandler({ server: httpServer, sessionAdapter });

    stop = async () => {
      wsHandler.close();
      return new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    };

    await new Promise<void>((resolve, reject) => {
      httpServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(err);
        }
      });
      httpServer.listen(port, host, () => {
        resolve();
      });
    });
  }

  console.log(`[api-gateway] Server running at http://${host}:${port}`);
  console.log(`[api-gateway] Health: http://${host}:${port}/api/health`);
  console.log(`[api-gateway] Docs: http://${host}:${port}/api/health`);
  if (process.env["FAN_NO_AUTH"]) {
    console.warn(`[api-gateway] ⚠️  Auth disabled (FAN_NO_AUTH=${process.env["FAN_NO_AUTH"]})`);
  }

  return { port, stop };
}

export { createApp };
