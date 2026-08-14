import { beforeEach, describe, expect, it, vi } from "vitest";

// F-24: Сидинг FAN_NODE_TOKEN в ядре — RED-фаза TDD.
//
// seedNodeToken ещё НЕ существует в ../auth.js: файл обязан падать
// на импорте (named export отсутствует). После реализации (GREEN)
// тесты должны пройти БЕЗ изменений.
//
// Контракт:
//   seedNodeToken(token: string, name?: string): Promise<ClientTokenData>
//     — создаёт clientToken { name: name ?? "fan-node", token },
//       ЕСЛИ такого токена ещё нет (проверка findUnique по token)
//     — идемпотентна: повторный вызов с тем же token НЕ создаёт дубль,
//       возвращает существующую запись
//
// Покрытие (TC-карточки roadmap):
//   TC-F24-B1  seedNodeToken создаёт запись, name по умолчанию "fan-node"
//   TC-F24-B2  повторный вызов с тем же token → без дубля (одна запись)
//   TC-F24-B3  validateToken(seed-токен) → находит запись (roundtrip)

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls
const { mockClientToken } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		delete: vi.fn(),
	},
}));

// Mock @fan/db — returns the SAME mock object every time
vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
	}),
}));

import { seedNodeToken, validateToken } from "../auth.js";

describe("F-24: seedNodeToken", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("TC-F24-B1: создание записи", () => {
		it("создаёт clientToken с переданным token и name по умолчанию 'fan-node'", async () => {
			const token = "a".repeat(64);
			const mockRecord = {
				id: "token-1",
				name: "fan-node",
				token,
				createdAt: new Date("2026-08-14"),
				lastUsed: null,
			};
			mockClientToken.findUnique.mockResolvedValue(null);
			mockClientToken.create.mockResolvedValue(mockRecord);

			const result = await seedNodeToken(token);

			expect(result).toEqual(mockRecord);
			expect(mockClientToken.create).toHaveBeenCalledWith({
				data: { name: "fan-node", token },
			});
		});

		it("переданное name переопределяет дефолт", async () => {
			const token = "b".repeat(64);
			const mockRecord = {
				id: "token-2",
				name: "fan-node:L1/node-1",
				token,
				createdAt: new Date("2026-08-14"),
				lastUsed: null,
			};
			mockClientToken.findUnique.mockResolvedValue(null);
			mockClientToken.create.mockResolvedValue(mockRecord);

			const result = await seedNodeToken(token, "fan-node:L1/node-1");

			expect(result).toEqual(mockRecord);
			expect(mockClientToken.create).toHaveBeenCalledWith({
				data: { name: "fan-node:L1/node-1", token },
			});
		});
	});

	describe("TC-F24-B2: идемпотентность", () => {
		it("повторный вызов с тем же token → существующая запись, create не вызывается", async () => {
			const token = "c".repeat(64);
			const existing = {
				id: "token-1",
				name: "fan-node",
				token,
				createdAt: new Date("2026-08-14"),
				lastUsed: null,
			};
			mockClientToken.findUnique.mockResolvedValue(existing);

			const result = await seedNodeToken(token);

			expect(result).toEqual(existing);
			expect(mockClientToken.create).not.toHaveBeenCalled();
		});

		it("проверка существования идёт по token (findUnique)", async () => {
			const token = "d".repeat(64);
			mockClientToken.findUnique.mockResolvedValue(null);
			mockClientToken.create.mockResolvedValue({
				id: "token-3",
				name: "fan-node",
				token,
				createdAt: new Date("2026-08-14"),
				lastUsed: null,
			});

			await seedNodeToken(token);

			expect(mockClientToken.findUnique).toHaveBeenCalledWith({
				where: { token },
			});
		});
	});

	describe("TC-F24-B3: roundtrip через validateToken", () => {
		it("seed-токен валидируется: validateToken находит запись по token", async () => {
			const token = "e".repeat(64);
			const mockRecord = {
				id: "token-1",
				name: "fan-node",
				token,
				createdAt: new Date("2026-08-14"),
				lastUsed: null,
			};
			// Seed: токена нет → создаётся
			mockClientToken.findUnique.mockResolvedValue(null);
			mockClientToken.create.mockResolvedValue(mockRecord);

			const seeded = await seedNodeToken(token);
			expect(seeded.token).toBe(token);

			// Validate: та же запись находится и lastUsed обновляется
			mockClientToken.update.mockResolvedValue({ ...mockRecord, lastUsed: new Date("2026-08-14T12:00:00Z") });

			const validated = await validateToken(seeded.token);

			expect(validated).not.toBeNull();
			expect(validated?.token).toBe(token);
			expect(validated?.name).toBe("fan-node");
			expect(mockClientToken.update).toHaveBeenCalledWith({
				where: { token },
				data: { lastUsed: expect.any(Date) },
			});
		});
	});
});
