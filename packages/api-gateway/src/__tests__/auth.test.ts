import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls
const { mockClientToken, mockRandomBytes } = vi.hoisted(() => ({
  mockClientToken: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  mockRandomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
  }),
}));

// Mock @fan/db — returns the SAME mock object every time
vi.mock("@fan/db", () => ({
  getPrismaClient: () => ({
    clientToken: mockClientToken,
  }),
}));

// Mock node:crypto — auth.ts imports randomBytes from "node:crypto"
vi.mock("node:crypto", () => ({
  randomBytes: mockRandomBytes,
}));

// Set FAN_NO_AUTH to prevent real auth checks during tests
process.env["FAN_NO_AUTH"] = "1";

import { generateToken, validateToken, listTokens, revokeToken, isAuthDisabled } from "../auth.js";

describe("Auth module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set the mock return value after clearAllMocks
    mockRandomBytes.mockReturnValue({
      toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
    });
  });

  describe("isAuthDisabled", () => {
    it("should return true when FAN_NO_AUTH=1", () => {
      process.env["FAN_NO_AUTH"] = "1";
      expect(isAuthDisabled()).toBe(true);
    });

    it("should return true when FAN_NO_AUTH=true", () => {
      process.env["FAN_NO_AUTH"] = "true";
      expect(isAuthDisabled()).toBe(true);
    });

    it("should return false when FAN_NO_AUTH is not set", () => {
      delete process.env["FAN_NO_AUTH"];
      expect(isAuthDisabled()).toBe(false);
    });
  });

  describe("generateToken", () => {
    it("should create a token with the given name", async () => {
      const mockRecord = {
        id: "token-123",
        name: "Test Client",
        token: "some-hex-token",
        createdAt: new Date("2026-01-01"),
        lastUsed: null,
      };
      mockClientToken.create.mockResolvedValue(mockRecord);

      const result = await generateToken("Test Client");
      expect(result).toEqual(mockRecord);
      expect(mockClientToken.create).toHaveBeenCalledWith({
        data: { name: "Test Client", token: "mocked-random-token-hex" },
      });
    });
  });

  describe("validateToken", () => {
    it("should return token data for valid token", async () => {
      const mockRecord = {
        id: "token-123",
        name: "Test Client",
        token: "valid-hex",
        createdAt: new Date("2026-01-01"),
        lastUsed: new Date("2026-01-02"),
      };
      mockClientToken.update.mockResolvedValue(mockRecord);

      const result = await validateToken("valid-hex");
      expect(result).toEqual(mockRecord);
    });

    it("should return null for invalid token", async () => {
      mockClientToken.update.mockRejectedValue(new Error("Not found"));

      const result = await validateToken("invalid");
      expect(result).toBeNull();
    });

    it("should call update with lastUsed timestamp", async () => {
      const mockRecord = {
        id: "token-123",
        name: "Test Client",
        token: "valid-hex",
        createdAt: new Date("2026-01-01"),
        lastUsed: new Date("2026-01-02"),
      };
      mockClientToken.update.mockResolvedValue(mockRecord);

      await validateToken("valid-hex");
      expect(mockClientToken.update).toHaveBeenCalledWith({
        where: { token: "valid-hex" },
        data: { lastUsed: expect.any(Date) },
      });
    });
  });

  describe("listTokens", () => {
    it("should return tokens without the token value", async () => {
      const mockRecords = [
        { id: "1", name: "Client A", token: "secret1", createdAt: new Date(), lastUsed: null },
        { id: "2", name: "Client B", token: "secret2", createdAt: new Date(), lastUsed: new Date() },
      ];
      mockClientToken.findMany.mockResolvedValue(mockRecords);

      const result = await listTokens();
      expect(result).toHaveLength(2);
      expect(result[0]).not.toHaveProperty("token");
      expect(result[0].name).toBe("Client A");
      expect(result[1].name).toBe("Client B");
    });

    it("should call findMany with orderBy createdAt desc", async () => {
      mockClientToken.findMany.mockResolvedValue([]);

      await listTokens();
      expect(mockClientToken.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("revokeToken", () => {
    it("should return true for existing token", async () => {
      mockClientToken.delete.mockResolvedValue({});
      const result = await revokeToken("token-123");
      expect(result).toBe(true);
    });

    it("should return false for non-existent token", async () => {
      mockClientToken.delete.mockRejectedValue(new Error("Not found"));
      const result = await revokeToken("non-existent");
      expect(result).toBe(false);
    });

    it("should call delete with the token id", async () => {
      mockClientToken.delete.mockResolvedValue({});
      await revokeToken("token-123");
      expect(mockClientToken.delete).toHaveBeenCalledWith({
        where: { id: "token-123" },
      });
    });
  });
});
