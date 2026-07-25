import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
process.env.FAN_NO_AUTH = "1";

import {
	generateToken,
	isAuthDisabled,
	isPublicMode,
	listTokens,
	revokeToken,
	tokenAuth,
	validateToken,
} from "../auth.js";

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
			process.env.FAN_NO_AUTH = "1";
			expect(isAuthDisabled()).toBe(true);
		});

		it("should return true when FAN_NO_AUTH=true", () => {
			process.env.FAN_NO_AUTH = "true";
			expect(isAuthDisabled()).toBe(true);
		});

		it("should return false when FAN_NO_AUTH is not set", () => {
			delete process.env.FAN_NO_AUTH;
			expect(isAuthDisabled()).toBe(false);
		});
	});

	describe("public mode (F-0.3)", () => {
		const originalPublic = process.env.FAN_PUBLIC;
		const originalNoAuth = process.env.FAN_NO_AUTH;

		afterEach(() => {
			if (originalPublic === undefined) {
				delete process.env.FAN_PUBLIC;
			} else {
				process.env.FAN_PUBLIC = originalPublic;
			}
			if (originalNoAuth === undefined) {
				delete process.env.FAN_NO_AUTH;
			} else {
				process.env.FAN_NO_AUTH = originalNoAuth;
			}
		});

		const makeContext = (url: string, headers: Record<string, string> = {}) =>
			({
				req: { header: (name: string) => headers[name], url },
				json: (body: unknown, status: number) => ({ body, status }),
				set: vi.fn(),
			}) as unknown as Parameters<typeof tokenAuth>[0];

		it("treats 1/true/yes/on (case/space insensitive) as public mode", () => {
			for (const value of ["1", "true", "TRUE", "True", "yes", "YES", "on", " 1 ", " true "]) {
				process.env.FAN_PUBLIC = value;
				expect(isPublicMode()).toBe(true);
			}
		});

		it("treats 0/false/no/off/empty/undefined as local mode", () => {
			for (const value of ["0", "false", "FALSE", "no", "off", "", "   "]) {
				process.env.FAN_PUBLIC = value;
				expect(isPublicMode()).toBe(false);
			}
			delete process.env.FAN_PUBLIC;
			expect(isPublicMode()).toBe(false);
		});

		it("treats unrecognized non-empty values as public mode (fail-closed) and warns", () => {
			const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				for (const value of ["2", "enbale", "yes please"]) {
					process.env.FAN_PUBLIC = value;
					expect(isPublicMode()).toBe(true);
					expect(stderrWrite).toHaveBeenCalledWith(
						expect.stringContaining(`FAN_PUBLIC имеет нераспознанное значение ${JSON.stringify(value)}`),
					);
				}
			} finally {
				stderrWrite.mockRestore();
			}
		});

		it("TC-F-0.3-1: FAN_PUBLIC=1 ignores FAN_NO_AUTH — request without token gets 401", async () => {
			process.env.FAN_PUBLIC = "1";
			process.env.FAN_NO_AUTH = "1";
			expect(isAuthDisabled()).toBe(false);

			const next = vi.fn();
			const result = (await tokenAuth(makeContext("http://localhost/api/sessions"), next)) as {
				status: number;
			};
			expect(next).not.toHaveBeenCalled();
			expect(result.status).toBe(401);
		});

		it("TC-F-0.3-3: FAN_PUBLIC=1 without FAN_NO_AUTH — token is required", async () => {
			process.env.FAN_PUBLIC = "1";
			delete process.env.FAN_NO_AUTH;
			expect(isAuthDisabled()).toBe(false);

			const next = vi.fn();
			const result = (await tokenAuth(makeContext("http://localhost/api/sessions"), next)) as {
				status: number;
			};
			expect(next).not.toHaveBeenCalled();
			expect(result.status).toBe(401);
		});

		it("legacy: without FAN_PUBLIC, FAN_NO_AUTH=1 still disables auth", async () => {
			delete process.env.FAN_PUBLIC;
			process.env.FAN_NO_AUTH = "1";
			expect(isAuthDisabled()).toBe(true);

			const next = vi.fn();
			await tokenAuth(makeContext("http://localhost/api/sessions"), next);
			expect(next).toHaveBeenCalled();
		});

		it("valid Bearer token passes in public mode", async () => {
			process.env.FAN_PUBLIC = "1";
			process.env.FAN_NO_AUTH = "1";
			mockClientToken.update.mockResolvedValue({
				id: "token-123",
				name: "Test Client",
				token: "valid-hex",
				createdAt: new Date(),
				lastUsed: new Date(),
			});

			const next = vi.fn();
			await tokenAuth(makeContext("http://localhost/api/sessions", { Authorization: "Bearer valid-hex" }), next);
			expect(next).toHaveBeenCalled();
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
