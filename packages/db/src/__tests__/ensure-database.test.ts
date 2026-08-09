import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted — variables available inside vi.mock factory (hoisted above imports)
const { mockQueryRawUnsafe, mockExecuteRawUnsafe, mockDisconnect, MockPrismaClient } = vi.hoisted(() => {
	const mockQueryRawUnsafe = vi.fn().mockResolvedValue([{ count: 0 }]);
	const mockExecuteRawUnsafe = vi.fn().mockResolvedValue(undefined);
	const mockDisconnect = vi.fn().mockResolvedValue(undefined);
	const MockPrismaClient = vi.fn().mockImplementation(() => ({
		$queryRawUnsafe: mockQueryRawUnsafe,
		$executeRawUnsafe: mockExecuteRawUnsafe,
		$disconnect: mockDisconnect,
	}));
	return { mockQueryRawUnsafe, mockExecuteRawUnsafe, mockDisconnect, MockPrismaClient };
});

// Mock @prisma/client so no real SQLite connection is ever created
vi.mock("@prisma/client", () => ({
	PrismaClient: MockPrismaClient,
}));

// Import after vi.mock — module picks up the mocked PrismaClient
import { __resetForTesting, closePrismaClient, ensureDatabase } from "../client.js";

// Number of DDL statements in client.ts (12) + migration table CREATE + INSERT = 14
const DDL_EXECUTE_COUNT = 14;

describe("ensureDatabase singleton", () => {
	beforeEach(() => {
		__resetForTesting();
		mockQueryRawUnsafe.mockReset().mockResolvedValue([{ count: 0 }]);
		mockExecuteRawUnsafe.mockReset().mockResolvedValue(undefined);
		mockDisconnect.mockReset().mockResolvedValue(undefined);
		MockPrismaClient.mockReset().mockImplementation(() => ({
			$queryRawUnsafe: mockQueryRawUnsafe,
			$executeRawUnsafe: mockExecuteRawUnsafe,
			$disconnect: mockDisconnect,
		}));
		// Clear env vars set by getPrismaClient() so each test starts fresh
		delete process.env.DATABASE_URL;
		delete process.env.PRISMA_QUERY_ENGINE_LIBRARY;
	});

	afterEach(async () => {
		await closePrismaClient();
	});

	it("returns the same promise on repeated calls (idempotency)", async () => {
		const p1 = ensureDatabase();
		const p2 = ensureDatabase();

		// Must be the exact same promise reference
		expect(p1).toBe(p2);

		await p1;

		// initDatabase queried sqlite_master exactly once
		expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
		// DDL was executed fully
		expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(DDL_EXECUTE_COUNT);
	});

	it("swallows errors — promise resolves even when initDatabase fails", async () => {
		// Make PrismaClient constructor throw → getPrismaClient() throws → initDatabase throws
		MockPrismaClient.mockImplementation(() => {
			throw new Error("Simulated PrismaClient failure");
		});

		const result = ensureDatabase();

		// Must resolve (not reject) — error is swallowed
		await expect(result).resolves.toBeUndefined();

		// Error should have been logged
		// (console.error is called inside the .catch of ensureDatabase)
	});

	it("handles 50 concurrent first calls — all resolve, init runs once", async () => {
		const promises = Array.from({ length: 50 }, () => ensureDatabase());

		// All promises should be the same reference
		const first = promises[0];
		for (const p of promises) {
			expect(p).toBe(first);
		}

		const results = await Promise.all(promises);

		// All resolved to undefined
		expect(results).toEqual(new Array(50).fill(undefined));

		// init ran exactly once
		expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
		expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(DDL_EXECUTE_COUNT);
		// Only one PrismaClient was constructed
		expect(MockPrismaClient).toHaveBeenCalledTimes(1);
	});

	it("closePrismaClient resets state — next ensureDatabase re-runs init", async () => {
		// First init
		await ensureDatabase();
		expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
		expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(DDL_EXECUTE_COUNT);

		// Close — disconnects + resets singleton
		await closePrismaClient();
		expect(mockDisconnect).toHaveBeenCalledTimes(1);

		// Second init — should re-run DDL
		await ensureDatabase();
		expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
		expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(DDL_EXECUTE_COUNT * 2);
		// Two PrismaClient instances constructed (one per init cycle)
		expect(MockPrismaClient).toHaveBeenCalledTimes(2);
	});

	it("closePrismaClient does NOT reset _initPromise while init is in-flight", async () => {
		// Use a gate so all executeRawUnsafe calls block until we open it
		let openGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		mockExecuteRawUnsafe.mockImplementation(async () => {
			await gate;
		});

		// Start init (don't await) — it will block on the first $executeRawUnsafe
		const pendingPromise = ensureDatabase();

		// Call close while init is in-flight
		await closePrismaClient();

		// The in-flight promise should still be the cached one (not reset)
		const p2 = ensureDatabase();
		expect(p2).toBe(pendingPromise);

		// Open the gate — all pending executeRawUnsafe calls resolve
		openGate?.();
		await pendingPromise;
	});
});
