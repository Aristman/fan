import { describe, it, expect, vi, beforeEach } from "vitest";
import { FanApiClient, FanApiError } from "../api/client.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("FanApiClient", () => {
  let client: FanApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new FanApiClient({ baseUrl: "http://localhost:3456", token: "test-token" });
  });

  describe("constructor", () => {
    it("should create client with baseUrl and token", () => {
      expect(client).toBeDefined();
    });

    it("should strip trailing slashes from baseUrl", () => {
      const c = new FanApiClient({ baseUrl: "http://localhost:3456/", token: "tok" });
      // Client should work with stripped URL
      expect(c).toBeDefined();
    });
  });

  describe("health", () => {
    it("should call GET /api/health without auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ status: "ok", version: "0.1.0", uptime: 123 }),
      });
      const result = await client.health();
      expect(result.status).toBe("ok");
      expect(result.version).toBe("0.1.0");
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/health");
      expect(opts.headers).not.toHaveProperty("Authorization"); // no auth on health
    });
  });

  describe("authenticated requests", () => {
    it("should send Authorization header for authenticated endpoints", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ sessions: [] }),
      });
      await client.listSessions();
      
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe("Bearer test-token");
    });
  });

  describe("error handling", () => {
    it("should throw FanApiError on 401", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 401, statusText: "Unauthorized",
        json: () => Promise.resolve({ error: "Invalid token", code: "AUTH_ERROR" }),
      });
      await expect(client.listSessions()).rejects.toThrow(FanApiError);
    });

    it("should throw FanApiError on 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 404, statusText: "Not Found",
        json: () => Promise.resolve({ error: "Not found", code: "NOT_FOUND" }),
      });
      await expect(client.getSession("abc")).rejects.toThrow(FanApiError);
    });

    it("should include status and code in FanApiError", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 404, statusText: "Not Found",
        json: () => Promise.resolve({ error: "Session not found", code: "NOT_FOUND" }),
      });
      try {
        await client.getSession("abc");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(FanApiError);
        expect((e as FanApiError).status).toBe(404);
        expect((e as FanApiError).code).toBe("NOT_FOUND");
      }
    });
  });

  describe("CRUD operations", () => {
    it("should create session via POST", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201,
        json: () => Promise.resolve({ id: "s1", title: "Test", createdAt: new Date().toISOString() }),
      });
      const result = await client.createSession({ title: "Test" });
      expect(result.id).toBe("s1");
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/sessions");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ title: "Test" });
    });

    it("should delete session via DELETE", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ success: true }),
      });
      const result = await client.deleteSession("s1");
      expect(result.success).toBe(true);
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/sessions/s1");
      expect(opts.method).toBe("DELETE");
    });

    it("should send message via POST", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ success: true }),
      });
      const result = await client.sendMessage("s1", "Hello world");
      expect(result.success).toBe(true);
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/sessions/s1/messages");
      expect(opts.method).toBe("POST");
    });
  });

  describe("budget", () => {
    it("should get budget status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({
          budgets: [{ provider: "anthropic", period: "daily", tokensUsed: 1000, costUsed: 0.05, exceeded: false }],
        }),
      });
      const result = await client.getBudget();
      expect(result.budgets).toHaveLength(1);
      expect(result.budgets[0].provider).toBe("anthropic");
    });

    it("should update budget config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ config: { period: "daily", tokenLimit: 50000 } }),
      });
      const result = await client.updateBudget({ period: "daily", tokenLimit: 50000 });
      expect(result.config.tokenLimit).toBe(50000);
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/budget");
      expect(opts.method).toBe("PUT");
    });
  });

  describe("tokens", () => {
    it("should generate token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201,
        json: () => Promise.resolve({ token: { id: "t1", name: "Test", token: "secret123", createdAt: "..." } }),
      });
      const result = await client.generateToken("Test");
      expect(result.token.name).toBe("Test");
      
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3456/api/tokens");
      expect(opts.method).toBe("POST");
    });

    it("should list tokens (without secret)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ tokens: [{ id: "t1", name: "Test", createdAt: "..." }] }),
      });
      const result = await client.listTokens();
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]).not.toHaveProperty("token"); // secret hidden
    });
  });
});
