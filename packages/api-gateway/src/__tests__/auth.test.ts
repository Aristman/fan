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
	authorizeProjectScope,
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
				projectScope: null,
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
				projectScope: null,
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

		it("F-5.7: should create a scoped token with normalized projectScope", async () => {
			const mockRecord = {
				id: "token-456",
				name: "Scoped Client",
				token: "some-hex-token",
				projectScope: "/data/repos/my-project",
				createdAt: new Date("2026-01-01"),
				lastUsed: null,
			};
			mockClientToken.create.mockResolvedValue(mockRecord);

			const result = await generateToken("Scoped Client", "/data/repos/my-project/");
			expect(result.projectScope).toBe("/data/repos/my-project");
			expect(mockClientToken.create).toHaveBeenCalledWith({
				data: {
					name: "Scoped Client",
					token: "mocked-random-token-hex",
					projectScope: "/data/repos/my-project",
				},
			});
		});
	});

	describe("validateToken", () => {
		it("should return token data for valid token", async () => {
			const mockRecord = {
				id: "token-123",
				name: "Test Client",
				token: "valid-hex",
				projectScope: null,
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
				projectScope: null,
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
				{ id: "1", name: "Client A", token: "secret1", projectScope: null, createdAt: new Date(), lastUsed: null },
				{
					id: "2",
					name: "Client B",
					token: "secret2",
					projectScope: null,
					createdAt: new Date(),
					lastUsed: new Date(),
				},
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

	describe("project scope (F-5.7)", () => {
		describe("authorizeProjectScope", () => {
			it("TC-F-5.7-1: null scope = full access to any project (backward compat)", () => {
				expect(authorizeProjectScope({ projectScope: null }, "/any/project/path")).toEqual({ authorized: true });
				// and also without any project context
				expect(authorizeProjectScope({ projectScope: null })).toEqual({ authorized: true });
			});

			it("TC-F-5.7-2: scoped token is rejected for a different project", () => {
				const result = authorizeProjectScope({ projectScope: "/data/repos/my-project" }, "/data/repos/other");
				expect(result.authorized).toBe(false);
				expect(result.reason).toBe("token not scoped to this project");
			});

			it("TC-F-5.7-3: exact project path match is authorized", () => {
				expect(authorizeProjectScope({ projectScope: "/data/repos/my-project" }, "/data/repos/my-project")).toEqual(
					{
						authorized: true,
					},
				);
			});

			it("normalized comparison: trailing slash, backslashes and case-folded drive match", () => {
				expect(
					authorizeProjectScope({ projectScope: "/data/repos/my-project" }, "/data/repos/my-project/"),
				).toEqual({
					authorized: true,
				});
				expect(authorizeProjectScope({ projectScope: "C:\\repos\\my-project" }, "c:/repos/my-project")).toEqual({
					authorized: true,
				});
			});

			it("no prefix matching: a subdirectory of the scope is rejected", () => {
				const result = authorizeProjectScope(
					{ projectScope: "/data/repos/my-project" },
					"/data/repos/my-project/sub",
				);
				expect(result.authorized).toBe(false);
				expect(result.reason).toBe("token not scoped to this project");
			});

			it("scoped token without a requested project is rejected", () => {
				const result = authorizeProjectScope({ projectScope: "/data/repos/my-project" });
				expect(result.authorized).toBe(false);
				expect(result.reason).toBe("token requires a project context matching its scope");
			});
		});

		describe("tokenAuth middleware scope enforcement", () => {
			const SCOPED_RECORD = {
				id: "token-scoped",
				name: "Scoped Client",
				token: "scoped-hex",
				projectScope: "/proj/a",
				createdAt: new Date(),
				lastUsed: new Date(),
			};

			const makeCtx = (
				url: string,
				opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
			) =>
				({
					req: {
						url,
						method: opts.method ?? "GET",
						header: (name: string) => opts.headers?.[name],
						json: async () => opts.body,
					},
					json: (body: unknown, status: number) => ({ body, status }),
					set: vi.fn(),
				}) as unknown as Parameters<typeof tokenAuth>[0];

			beforeEach(() => {
				delete process.env.FAN_NO_AUTH;
				delete process.env.FAN_PUBLIC;
				mockClientToken.update.mockResolvedValue(SCOPED_RECORD);
			});

			afterEach(() => {
				process.env.FAN_NO_AUTH = "1";
			});

			const bearer = { Authorization: "Bearer scoped-hex" };

			it("?project= matching the scope → authorized", async () => {
				const next = vi.fn();
				await tokenAuth(makeCtx("http://localhost/api/sessions?project=/proj/a", { headers: bearer }), next);
				expect(next).toHaveBeenCalled();
			});

			it("?project= of another project → 403 'token not scoped to this project'", async () => {
				const next = vi.fn();
				const result = (await tokenAuth(
					makeCtx("http://localhost/api/sessions?project=/proj/b", { headers: bearer }),
					next,
				)) as unknown as { status: number; body: { error: string } };
				expect(next).not.toHaveBeenCalled();
				expect(result.status).toBe(403);
				expect(result.body.error).toBe("token not scoped to this project");
			});

			it("no project context on a project endpoint → 403", async () => {
				const next = vi.fn();
				const result = (await tokenAuth(
					makeCtx("http://localhost/api/sessions", { headers: bearer }),
					next,
				)) as unknown as {
					status: number;
					body: { error: string };
				};
				expect(next).not.toHaveBeenCalled();
				expect(result.status).toBe(403);
				expect(result.body.error).toBe("token requires a project context matching its scope");
			});

			it("no project context on a whitelisted neutral endpoint (GET /api/models) → authorized", async () => {
				const next = vi.fn();
				await tokenAuth(makeCtx("http://localhost/api/models", { headers: bearer }), next);
				expect(next).toHaveBeenCalled();
			});

			it("body cwd matching the scope → authorized (body still readable by the handler afterwards)", async () => {
				const next = vi.fn();
				await tokenAuth(
					makeCtx("http://localhost/api/sessions", {
						method: "POST",
						headers: { ...bearer, "Content-Type": "application/json" },
						body: { title: "S", cwd: "/proj/a" },
					}),
					next,
				);
				expect(next).toHaveBeenCalled();
			});

			it("body cwd of another project → 403", async () => {
				const next = vi.fn();
				const result = (await tokenAuth(
					makeCtx("http://localhost/api/sessions", {
						method: "POST",
						headers: { ...bearer, "Content-Type": "application/json" },
						body: { title: "S", cwd: "/proj/b" },
					}),
					next,
				)) as { status: number };
				expect(next).not.toHaveBeenCalled();
				expect(result.status).toBe(403);
			});

			it("POST /api/tokens is reachable for scoped tokens (handler constrains the scope)", async () => {
				const next = vi.fn();
				await tokenAuth(
					makeCtx("http://localhost/api/tokens", {
						method: "POST",
						headers: { ...bearer, "Content-Type": "application/json" },
						body: { name: "sub-token" },
					}),
					next,
				);
				expect(next).toHaveBeenCalled();
			});

			it("GET /api/tokens without project context → 403 (token management is not neutral)", async () => {
				const next = vi.fn();
				const result = (await tokenAuth(makeCtx("http://localhost/api/tokens", { headers: bearer }), next)) as {
					status: number;
				};
				expect(next).not.toHaveBeenCalled();
				expect(result.status).toBe(403);
			});

			it("GET /api/sessions/:id without project context → allowed through for resource-level check", async () => {
				const next = vi.fn();
				await tokenAuth(makeCtx("http://localhost/api/sessions/sess-123", { headers: bearer }), next);
				expect(next).toHaveBeenCalled();
			});

			it("POST /api/sessions/:id/messages without project context → allowed through for resource-level check", async () => {
				const next = vi.fn();
				await tokenAuth(
					makeCtx("http://localhost/api/sessions/sess-123/messages", {
						method: "POST",
						headers: { ...bearer, "Content-Type": "application/json" },
						body: { message: "hi" },
					}),
					next,
				);
				expect(next).toHaveBeenCalled();
			});

			it("DELETE /api/sessions/:id without project context → allowed through for resource-level check", async () => {
				const next = vi.fn();
				await tokenAuth(
					makeCtx("http://localhost/api/sessions/sess-123", { method: "DELETE", headers: bearer }),
					next,
				);
				expect(next).toHaveBeenCalled();
			});

			it("unscoped token (null scope) → full access regardless of project context", async () => {
				mockClientToken.update.mockResolvedValue({ ...SCOPED_RECORD, projectScope: null });
				const next = vi.fn();
				await tokenAuth(makeCtx("http://localhost/api/sessions?project=/proj/b", { headers: bearer }), next);
				expect(next).toHaveBeenCalled();
			});
		});
	});
});
