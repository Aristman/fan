import type { ConfluenceConfig } from "./config.js";

export type ConfluenceClient = {
  space: {
    getSpaces: (params?: { limit?: number; start?: number }) => Promise<Record<string, unknown>>;
  };
  content: {
    getContent: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getContentById: (params: { id: string; expand?: string }) => Promise<Record<string, unknown>>;
    createContent: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    updateContentById: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  search: {
    search: (params: { cql: string; limit?: number; start?: number }) => Promise<Record<string, unknown>>;
  };
};

export type HealthCheckResult = {
  ok: boolean;
  version?: string;
  error?: string;
};

function buildHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function apiRequest(
  config: ConfluenceConfig,
  path: string,
  options: { method?: string; body?: string; params?: Record<string, string> } = {},
): Promise<unknown> {
  const url = new URL(`${config.baseUrl}/rest/api${path}`);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: buildHeaders(config.pat),
    body: options.body || undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Confluence API ${res.status}: ${text}`);
    (err as Record<string, number>).status = res.status;
    throw err;
  }

  return res.json();
}

export function initClient(config: ConfluenceConfig): ConfluenceClient {
  return {
    space: {
      async getSpaces(params?: { limit?: number; start?: number }) {
        const p: Record<string, string> = { limit: String(params?.limit ?? 25), type: "global" };
        if (params?.start) p.start = String(params.start);
        return apiRequest(config, "/space", { params: p }) as Promise<Record<string, unknown>>;
      },
    },

    content: {
      async getContent(params: Record<string, unknown>) {
        const p: Record<string, string> = {};
        if (params.spaceKey) p.spaceKey = String(params.spaceKey);
        if (params.title) p.title = String(params.title);
        if (params.limit) p.limit = String(params.limit);
        if (params.start) p.start = String(params.start);
        if (params.type) p.type = String(params.type);
        if (params.status) p.status = String(params.status);
        if (params.expand) p.expand = String(params.expand);
        return apiRequest(config, "/content", { params: p }) as Promise<Record<string, unknown>>;
      },

      async getContentById(params: { id: string; expand?: string }) {
        const p: Record<string, string> = {};
        if (params.expand) p.expand = params.expand;
        return apiRequest(config, `/content/${params.id}`, { params: p }) as Promise<Record<string, unknown>>;
      },

      async createContent(params: Record<string, unknown>) {
        return apiRequest(config, "/content", {
          method: "POST",
          body: JSON.stringify(params),
        }) as Promise<Record<string, unknown>>;
      },

      async updateContentById(params: Record<string, unknown>) {
        const id = String(params.id);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _, ...rest } = params;
        return apiRequest(config, `/content/${id}`, {
          method: "PUT",
          body: JSON.stringify(rest),
        }) as Promise<Record<string, unknown>>;
      },
    },

    search: {
      async search(params: { cql: string; limit?: number; start?: number }) {
        const p: Record<string, string> = { cql: params.cql, limit: String(params.limit ?? 25) };
        if (params.start) p.start = String(params.start);
        return apiRequest(config, "/search", { params: p }) as Promise<Record<string, unknown>>;
      },
    },
  };
}

export async function healthCheck(client: ConfluenceClient): Promise<HealthCheckResult> {
  try {
    await client.space.getSpaces({ limit: 1 });
    return { ok: true, version: "connected" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
