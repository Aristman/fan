// ─── Stack Overflow for Agents — API Client with Session Management ───
import type {
  SofaConfig,
  SofaSession,
  SofaSearchParams,
  SofaSearchResult,
  SofaPost,
  SofaPostSummary,
  SofaReply,
  SofaTag,
  SofaAgent,
  SofaVerification,
  SofaVerificationPayload,
  SofaCreatePostPayload,
  PostContentType,
  VerificationOutcome,
  VoteValue,
  GuidelineType,
  SofaOnboardingContract,
  SofaFlowCreatePayload,
  SofaFlowResponse,
  SofaFlowStatus,
  SofaRegistrationPayload,
  SofaRegistrationResponse,
  SofaApiError,
} from "./types.ts";

// ─── Custom Errors ───
export class SofaApiErrorClass extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = "SofaApiError";
  }
}

export class SofaSessionExpiredError extends Error {
  constructor() {
    super("SOFA session expired");
    this.name = "SofaSessionExpired";
  }
}

export class SofaReadFirstError extends Error {
  constructor() {
    super("Post must be read before voting/verifying (read-first guard)");
    this.name = "SofaReadFirstError";
  }
}

// ─── Session Manager ───
export class SofaSessionManager {
  private _session: SofaSession | null = null;
  private _config: SofaConfig;
  private _readPostIds: Set<string> = new Set();

  constructor(config: SofaConfig) {
    this._config = config;
  }

  get config(): SofaConfig {
    return this._config;
  }

  // ─── Session Lifecycle ───

  async ensureSession(): Promise<string> {
    if (this._session) {
      const expiresAt = new Date(this._session.expires_at).getTime();
      // Refresh session if less than 5 minutes remaining
      if (expiresAt > Date.now() + 5 * 60 * 1000) {
        return this._session.session_id;
      }
      // Session expired or nearly expired — close it first
      await this.closeSession().catch(() => {});
    }
    return this.createSession();
  }

  async createSession(): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._config.apiKey}`,
      "X-Sofa-Client-Name": this._config.clientName,
      "X-Sofa-Model-Name": this._config.modelName,
    };
    if (this._config.modelProvider) headers["X-Sofa-Model-Provider"] = this._config.modelProvider;
    if (this._config.modelVersion) headers["X-Sofa-Model-Version"] = this._config.modelVersion;
    if (this._config.modelSelectionMode) headers["X-Sofa-Model-Selection-Mode"] = this._config.modelSelectionMode;

    const response = await fetch(`${this._config.baseUrl}/api/sessions`, {
      method: "POST",
      headers,
    });

    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, `Failed to create session: ${err.message}`, err.detail);
    }

    const session: SofaSession = await response.json();
    this._session = session;
    return session.session_id;
  }

  async closeSession(): Promise<void> {
    if (!this._session) return;
    try {
      await fetch(`${this._config.baseUrl}/api/sessions/${this._session.session_id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          "X-Sofa-Session": this._session.session_id,
        },
      });
    } finally {
      this._session = null;
    }
  }

  // ─── Read-First Guard ───
  markAsRead(postId: string): void {
    this._readPostIds.add(postId);
  }

  hasRead(postId: string): boolean {
    return this._readPostIds.has(postId);
  }

  // ─── API Request with Auto Session ───

  private async _request(
    method: string,
    path: string,
    options?: {
      params?: Record<string, string | number | undefined>;
      body?: unknown;
      skipSession?: boolean;
    },
  ): Promise<Response> {
    const url = new URL(`${this._config.baseUrl}${path}`);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._config.apiKey}`,
      "Content-Type": "application/json",
    };

    if (!options?.skipSession) {
      const sessionId = await this.ensureSession();
      headers["X-Sofa-Session"] = sessionId;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    // Handle session expiry — try to recreate session once
    if (response.status === 401 && !options?.skipSession) {
      const errBody = await parseSofaError(response);
      if (errBody.message.includes("invalid_session") || errBody.message.includes("expired")) {
        this._session = null;
        // Retry with new session
        const newSessionId = await this.ensureSession();
        headers["X-Sofa-Session"] = newSessionId;
        const retryResponse = await fetch(url.toString(), { ...fetchOptions, headers });
        return retryResponse;
      }
    }

    return response;
  }

  // ─── Endpoints ───

  // Onboarding
  async fetchOnboardingContract(): Promise<SofaOnboardingContract> {
    const response = await fetch(`${this._config.baseUrl}/api/onboarding`);
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to fetch onboarding contract", err.detail);
    }
    return response.json();
  }

  async createOnboardingFlow(payload: SofaFlowCreatePayload): Promise<SofaFlowResponse> {
    const response = await fetch(`${this._config.baseUrl}/api/onboarding/flows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to start onboarding flow", err.detail);
    }
    return response.json();
  }

  async pollOnboardingStatus(flowId: string, pollToken: string): Promise<SofaFlowStatus> {
    const response = await fetch(`${this._config.baseUrl}/api/onboarding/flows/${flowId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poll_token: pollToken }),
    });
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to poll onboarding status", err.detail);
    }
    return response.json();
  }

  async exchangeAuthCode(authCode: string, payload: SofaRegistrationPayload): Promise<SofaRegistrationResponse> {
    const response = await fetch(`${this._config.baseUrl}/api/onboarding/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, auth_code: authCode }),
    });
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to complete registration", err.detail);
    }
    return response.json();
  }

  // Posts
  async searchPosts(params: SofaSearchParams): Promise<SofaSearchResult> {
    const response = await this._request("GET", "/api/posts", {
      params: {
        search: params.search,
        tag: params.tag,
        content_type: params.content_type,
        page: params.page ?? 1,
        per_page: params.per_page ?? 20,
      },
    });

    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to search posts", err.detail);
    }

    return response.json();
  }

  async getPost(postId: string): Promise<SofaPost> {
    const response = await this._request("GET", `/api/posts/${postId}`);
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to get post", err.detail);
    }

    const post: SofaPost = await response.json();
    // Add web URL
    const typePath =
      post.content_type === "question" ? "questions" :
      post.content_type === "til" ? "tils" : "blueprints";
    post.web_url = `${this._config.baseUrl}/${typePath}/${post.id}`;

    this.markAsRead(postId);
    return post;
  }

  async createPost(payload: SofaCreatePostPayload): Promise<SofaPost> {
    const response = await this._request("POST", "/api/posts", {
      body: {
        content_type: payload.content_type,
        title: payload.title,
        body: payload.body,
        tags: payload.tags,
      },
    });

    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to create post", err.detail);
    }

    return response.json();
  }

  async deletePost(postId: string): Promise<void> {
    const response = await this._request("DELETE", `/api/posts/${postId}`);
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to delete post", err.detail);
    }
  }

  // Replies
  async createReply(postId: string, body: string): Promise<SofaReply> {
    const response = await this._request("POST", `/api/posts/${postId}/replies`, {
      body: { body },
    });

    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to create reply", err.detail);
    }

    return response.json();
  }

  // Votes
  async createVote(postId: string, value: VoteValue): Promise<void> {
    // Enforce read-first guard
    if (!this.hasRead(postId)) {
      await this.getPost(postId).catch(() => {}); // Best-effort read
    }

    const response = await this._request("POST", "/api/votes", {
      body: { post_id: postId, value },
    });

    if (!response.ok) {
      const err = await parseSofaError(response);

      // Handle "missing activity" — wait and retry once
      if (response.status === 401 && err.message.includes("read")) {
        await new Promise((r) => setTimeout(r, 1000));
        // Ensure post is marked as read and retry
        this.markAsRead(postId);
        const retryResponse = await this._request("POST", "/api/votes", {
          body: { post_id: postId, value },
        });
        if (!retryResponse.ok) {
          const retryErr = await parseSofaError(retryResponse);
          throw new SofaApiErrorClass(retryResponse.status, `Vote failed: ${retryErr.message}`, retryErr.detail);
        }
        return;
      }

      throw new SofaApiErrorClass(response.status, `Vote failed: ${err.message}`, err.detail);
    }
  }

  // Verifications
  async createVerification(payload: SofaVerificationPayload): Promise<SofaVerification> {
    // Enforce read-first guard
    if (!this.hasRead(payload.post_id)) {
      await this.getPost(payload.post_id).catch(() => {});
    }

    const response = await this._request("POST", "/api/verifications", {
      body: {
        post_id: payload.post_id,
        outcome: payload.outcome,
        feedback: payload.feedback,
      },
    });

    if (!response.ok) {
      const err = await parseSofaError(response);

      // Handle "missing activity" — wait and retry once
      if (response.status === 401 && err.message.includes("read")) {
        await new Promise((r) => setTimeout(r, 1000));
        this.markAsRead(payload.post_id);
        const retryResponse = await this._request("POST", "/api/verifications", {
          body: {
            post_id: payload.post_id,
            outcome: payload.outcome,
            feedback: payload.feedback,
          },
        });
        if (!retryResponse.ok) {
          const retryErr = await parseSofaError(retryResponse);
          throw new SofaApiErrorClass(retryResponse.status, `Verification failed: ${retryErr.message}`, retryErr.detail);
        }
        return retryResponse.json();
      }

      throw new SofaApiErrorClass(response.status, `Verification failed: ${err.message}`, err.detail);
    }

    return response.json();
  }

  async listMyVerifications(postId?: string): Promise<SofaVerification[]> {
    const params: Record<string, string | undefined> = {};
    if (postId) params.post_id = postId;
    const response = await this._request("GET", `/api/me/verifications`, { params });
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to list verifications", err.detail);
    }
    return response.json();
  }

  // Tags
  async listTags(): Promise<SofaTag[]> {
    const response = await this._request("GET", "/api/tags");
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to list tags", err.detail);
    }
    return response.json();
  }

  // Agents
  async getLeaderboard(limit?: number): Promise<SofaAgent[]> {
    const response = await this._request("GET", "/api/agents/leaderboard", {
      params: limit ? { limit } : undefined,
    });
    if (!response.ok) {
      const err = await parseSofaError(response);
      throw new SofaApiErrorClass(response.status, "Failed to get leaderboard", err.detail);
    }
    return response.json();
  }

  // Guidelines (public, no auth needed)
  async fetchGuidelines(type: GuidelineType): Promise<string> {
    const response = await fetch(`${this._config.baseUrl}/guidelines/${type}`);
    if (!response.ok) {
      throw new SofaApiErrorClass(response.status, `Failed to fetch guidelines for "${type}"`);
    }
    return response.text();
  }
}

// ─── Error Parsing ───
async function parseSofaError(response: Response): Promise<{ message: string; detail?: string }> {
  try {
    const body: SofaApiError = await response.json();
    if (typeof body.error === "string") {
      return { message: body.error };
    }
    return {
      message: body.error.title || "Unknown error",
      detail: body.error.detail,
    };
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

// ─── Error Formatting ───
export function formatSofaError(err: unknown): string {
  if (err instanceof SofaApiErrorClass) {
    const messages: Record<number, string> = {
      400: "Invalid request — check parameters and field limits",
      401: "Authentication failed — API key invalid, revoked, or session expired",
      403: "Forbidden — check agent permissions",
      404: "Resource not found",
      409: "Conflict — resource already deleted or duplicated",
      429: "Rate limited — wait before retrying",
    };
    const base = messages[err.status] || `API error (${err.status})`;
    return err.details ? `${base}: ${err.details}` : `${base}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
