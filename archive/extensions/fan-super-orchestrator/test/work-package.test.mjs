// F-27: Протокол «пакет работ» (L0 → L1) — тесты.
//
// Speка: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
// Wire-формат: message = JSON.stringify({ work_package: {...} }) — ВЛОЖЕННЫЙ объект.
//
// Покрытие (TC-карточки roadmap):
//   TC-F27-1  полный пакет: create → serialize → roundtrip parse (wire-формат вложенный)
//   TC-F27-2  buildToolFlag(["read","write","edit","bash"])
//   TC-F27-3  createWorkPackage({depth:1}) → WorkPackageValidationError, missingFields
//   Доп.      дефолты, формат correlationId, parseWorkPackage (невалид → null),
//             buildToolFlag([]), makeCorrelationId, обязательность deadline,
//             числовая валидация, buildToolArgs, makeCorrelationId валидация

import { beforeAll, describe, expect, it } from "vitest";

let createWorkPackage;
let serializeWorkPackage;
let parseWorkPackage;
let buildToolFlag;
let buildToolArgs;
let makeCorrelationId;
let WorkPackageValidationError;

beforeAll(async () => {
	const mod = await import("../work-package.js");
	createWorkPackage = mod.createWorkPackage;
	serializeWorkPackage = mod.serializeWorkPackage;
	parseWorkPackage = mod.parseWorkPackage;
	buildToolFlag = mod.buildToolFlag;
	buildToolArgs = mod.buildToolArgs;
	makeCorrelationId = mod.makeCorrelationId;
	WorkPackageValidationError = mod.WorkPackageValidationError;
});

/** Валидный минимально-полный вход для createWorkPackage. */
const VALID_INPUT = {
	task: "Исследовать рынок VECTOR-линз",
	correlationId: "mission-7f3a/L1/node-1",
	depth: 1,
	tokenBudget: 50_000,
	deadline: "2026-08-15T00:00:00.000Z",
};

// ─── TC-F27-1: полный цикл create → serialize → parse ───────────────────────

describe("TC-F27-1: полный пакет — create, serialize, roundtrip", () => {
	it("createWorkPackage возвращает пакет со всеми полями", () => {
		const wp = createWorkPackage({
			...VALID_INPUT,
			toolManifest: ["read", "write", "bash"],
			spawnBudget: 4,
			costBudgetUsd: 1.5,
			maxRetries: 3,
			verificationCommand: "npm test",
			context: {
				parentSummary: "L0: исследование рынка",
				relevantFiles: ["docs/research/market.md"],
				constraints: ["без сетевых вызовов"],
			},
		});
		expect(wp.task).toBe("Исследовать рынок VECTOR-линз");
		expect(wp.correlationId).toBe("mission-7f3a/L1/node-1");
		expect(wp.depth).toBe(1);
		expect(wp.tokenBudget).toBe(50_000);
		expect(wp.toolManifest).toEqual(["read", "write", "bash"]);
		expect(wp.spawnBudget).toBe(4);
		expect(wp.costBudgetUsd).toBe(1.5);
		expect(wp.maxRetries).toBe(3);
		expect(wp.deadline).toBe("2026-08-15T00:00:00.000Z");
		expect(wp.verificationCommand).toBe("npm test");
		expect(wp.context).toEqual({
			parentSummary: "L0: исследование рынка",
			relevantFiles: ["docs/research/market.md"],
			constraints: ["без сетевых вызовов"],
		});
	});

	it("serializeWorkPackage → ВЛОЖЕННЫЙ формат {work_package: {...}} по спеке §3.3.2", () => {
		const wp = createWorkPackage({ ...VALID_INPUT, toolManifest: ["read", "write", "bash"] });
		const req = serializeWorkPackage(wp);
		expect(req.streamingBehavior).toBe("followUp");
		expect(typeof req.message).toBe("string");
		const parsed = JSON.parse(req.message);
		// Wire-формат по спеке: {work_package: {...}}, а НЕ flat с маркером.
		expect(parsed.work_package).toBeDefined();
		expect(typeof parsed.work_package).toBe("object");
		expect(parsed.work_package).not.toBe(true);
		expect(parsed.work_package.task).toBe(wp.task);
		expect(parsed.work_package.correlationId).toBe(wp.correlationId);
		expect(parsed.work_package.depth).toBe(wp.depth);
		expect(parsed.work_package.tokenBudget).toBe(wp.tokenBudget);
		expect(parsed.work_package.toolManifest).toEqual(["read", "write", "bash"]);
		expect(parsed.work_package.deadline).toBe(wp.deadline);
	});

	it("roundtrip: parseWorkPackage(serializeWorkPackage(wp).message) → тот же пакет", () => {
		const wp = createWorkPackage({
			...VALID_INPUT,
			toolManifest: ["read", "write", "bash"],
			spawnBudget: 2,
			context: { parentSummary: "L0 summary" },
		});
		const req = serializeWorkPackage(wp);
		const restored = parseWorkPackage(req.message);
		expect(restored).toEqual(wp);
	});
});

// ─── TC-F27-2: buildToolFlag ────────────────────────────────────────────────

describe("TC-F27-2: buildToolFlag", () => {
	it('buildToolFlag(["read","write","edit","bash"]) === "--tools read,write,edit,bash"', () => {
		expect(buildToolFlag(["read", "write", "edit", "bash"])).toBe("--tools read,write,edit,bash");
	});

	it("один инструмент → --tools read", () => {
		expect(buildToolFlag(["read"])).toBe("--tools read");
	});

	it("пустой manifest → пустая строка", () => {
		expect(buildToolFlag([])).toBe("");
	});
});

// ─── buildToolArgs ──────────────────────────────────────────────────────────

describe("buildToolArgs: argv-массив для spawn", () => {
	it('buildToolArgs(["read","write","edit","bash"]) → ["--tools", "read,write,edit,bash"]', () => {
		expect(buildToolArgs(["read", "write", "edit", "bash"])).toEqual([
			"--tools",
			"read,write,edit,bash",
		]);
	});

	it("один инструмент → [\"--tools\", \"read\"]", () => {
		expect(buildToolArgs(["read"])).toEqual(["--tools", "read"]);
	});

	it("пустой manifest → []", () => {
		expect(buildToolArgs([])).toEqual([]);
	});
});

// ─── TC-F27-3: валидация обязательных полей ─────────────────────────────────

describe("TC-F27-3: createWorkPackage без обязательных полей → WorkPackageValidationError", () => {
	it("createWorkPackage({depth:1}) бросает WorkPackageValidationError", () => {
		expect(() => createWorkPackage({ depth: 1 })).toThrow(WorkPackageValidationError);
	});

	it("missingFields содержит task, correlationId, tokenBudget", () => {
		let caught;
		try {
			createWorkPackage({ depth: 1 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("task");
		expect(caught.missingFields).toContain("correlationId");
		expect(caught.missingFields).toContain("tokenBudget");
	});

	it("missingFields содержит deadline (обязателен, без дефолта)", () => {
		let caught;
		try {
			createWorkPackage({ depth: 1 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("deadline");
	});

	it("частично заполненный вход: missingFields перечисляет только отсутствующие", () => {
		let caught;
		try {
			createWorkPackage({ task: "t", depth: 1, deadline: "2026-08-15T00:00:00.000Z" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("correlationId");
		expect(caught.missingFields).toContain("tokenBudget");
		expect(caught.missingFields).not.toContain("task");
		expect(caught.missingFields).not.toContain("deadline");
		expect(caught.missingFields).not.toContain("depth");
	});

	it("пустой объект → все обязательные поля в missingFields", () => {
		let caught;
		try {
			createWorkPackage({});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		for (const field of ["task", "correlationId", "depth", "tokenBudget", "deadline"]) {
			expect(caught.missingFields).toContain(field);
		}
	});
});

// ─── createWorkPackage: не-объект / null → ValidationError ──────────────────

describe("createWorkPackage(null/undefined/не-объект) → WorkPackageValidationError", () => {
	it("null → WorkPackageValidationError со всеми обязательными в missingFields", () => {
		let caught;
		try {
			createWorkPackage(null);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		for (const field of ["task", "correlationId", "depth", "tokenBudget", "deadline"]) {
			expect(caught.missingFields).toContain(field);
		}
	});

	it("undefined → WorkPackageValidationError", () => {
		expect(() => createWorkPackage(undefined)).toThrow(WorkPackageValidationError);
	});

	it("строка → WorkPackageValidationError", () => {
		expect(() => createWorkPackage("не объект")).toThrow(WorkPackageValidationError);
	});

	it("число → WorkPackageValidationError", () => {
		expect(() => createWorkPackage(42)).toThrow(WorkPackageValidationError);
	});

	it("массив → WorkPackageValidationError", () => {
		expect(() => createWorkPackage([{ task: "t" }])).toThrow(WorkPackageValidationError);
	});
});

// ─── Числовая валидация (depth, tokenBudget, spawnBudget, maxRetries, costBudgetUsd) ──

describe("числовая валидация: finite, integer, ≥ 0", () => {
	it("depth = -5 → invalidFields содержит depth", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, depth: -5 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("depth");
	});

	it("depth = 1.5 → invalidFields содержит depth (не integer)", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, depth: 1.5 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("depth");
	});

	it("depth = Infinity → invalidFields содержит depth", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, depth: Infinity });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("depth");
	});

	it("tokenBudget = -1000 → invalidFields содержит tokenBudget", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, tokenBudget: -1000 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("tokenBudget");
	});

	it("tokenBudget = Infinity → invalidFields содержит tokenBudget", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, tokenBudget: Infinity });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("tokenBudget");
	});

	it("spawnBudget = -1 → invalidFields содержит spawnBudget", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, spawnBudget: -1 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("spawnBudget");
	});

	it("maxRetries = -3 → invalidFields содержит maxRetries", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, maxRetries: -3 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("maxRetries");
	});

	it("costBudgetUsd = -0.01 → invalidFields содержит costBudgetUsd", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, costBudgetUsd: -0.01 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("costBudgetUsd");
	});

	it("costBudgetUsd = Infinity → invalidFields содержит costBudgetUsd", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, costBudgetUsd: Infinity });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.invalidFields).toContain("costBudgetUsd");
	});

	it("depth = 0 → принимается (граница)", () => {
		const wp = createWorkPackage({ ...VALID_INPUT, depth: 0 });
		expect(wp.depth).toBe(0);
	});

	it("costBudgetUsd = 1.5 → принимается (дробное допустимо)", () => {
		const wp = createWorkPackage({ ...VALID_INPUT, costBudgetUsd: 1.5 });
		expect(wp.costBudgetUsd).toBe(1.5);
	});
});

// ─── Пустые / whitespace-only строки ────────────────────────────────────────

describe("пустые и whitespace-only строки → ValidationError", () => {
	it('task = "   " (whitespace) → missingFields содержит task', () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, task: "   " });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("task");
	});

	it("task = \"\" → missingFields содержит task", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, task: "" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("task");
	});

	it('correlationId = "   " → missingFields содержит correlationId', () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, correlationId: "   " });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("correlationId");
	});

	it('deadline = "   " → missingFields содержит deadline', () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, deadline: "   " });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("deadline");
	});
});

// ─── Дефолты ────────────────────────────────────────────────────────────────

describe("дефолты необязательных полей", () => {
	it("maxRetries не задан → 2", () => {
		const wp = createWorkPackage(VALID_INPUT);
		expect(wp.maxRetries).toBe(2);
	});

	it("maxRetries задан явно → сохраняется", () => {
		const wp = createWorkPackage({ ...VALID_INPUT, maxRetries: 5 });
		expect(wp.maxRetries).toBe(5);
	});

	it("spawnBudget не задан → 0", () => {
		const wp = createWorkPackage(VALID_INPUT);
		expect(wp.spawnBudget).toBe(0);
	});

	it("costBudgetUsd не задан → 0", () => {
		const wp = createWorkPackage(VALID_INPUT);
		expect(wp.costBudgetUsd).toBe(0);
	});

	it("toolManifest не задан → []", () => {
		const wp = createWorkPackage(VALID_INPUT);
		expect(wp.toolManifest).toEqual([]);
	});
});

// ─── Формат correlationId ───────────────────────────────────────────────────

describe("валидация формата correlationId", () => {
	it('"abc" → ValidationError', () => {
		expect(() => createWorkPackage({ ...VALID_INPUT, correlationId: "abc" })).toThrow(
			WorkPackageValidationError,
		);
	});

	it('"L1/node-1" (без mission-uuid) → ValidationError', () => {
		expect(() => createWorkPackage({ ...VALID_INPUT, correlationId: "L1/node-1" })).toThrow(
			WorkPackageValidationError,
		);
	});

	it('"mission-1/L1" (без node-сегмента) → ValidationError', () => {
		expect(() => createWorkPackage({ ...VALID_INPUT, correlationId: "mission-1/L1" })).toThrow(
			WorkPackageValidationError,
		);
	});

	it('валидный "mission-7f3a/L1/node-1" → принимается', () => {
		const wp = createWorkPackage({ ...VALID_INPUT, correlationId: "mission-7f3a/L1/node-1" });
		expect(wp.correlationId).toBe("mission-7f3a/L1/node-1");
	});

	it('валидный "m-123/L12/node-42" (многоразрядные числа) → принимается', () => {
		const wp = createWorkPackage({ ...VALID_INPUT, correlationId: "m-123/L12/node-42" });
		expect(wp.correlationId).toBe("m-123/L12/node-42");
	});
});

// ─── Обязательность deadline ────────────────────────────────────────────────

describe("deadline: обязателен, ISO-8601, непустая строка", () => {
	it("отсутствует → ValidationError с deadline в missingFields", () => {
		const { deadline: _omit, ...noDeadline } = VALID_INPUT;
		let caught;
		try {
			createWorkPackage(noDeadline);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("deadline");
	});

	it("пустая строка → ValidationError с deadline в missingFields", () => {
		let caught;
		try {
			createWorkPackage({ ...VALID_INPUT, deadline: "" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WorkPackageValidationError);
		expect(caught.missingFields).toContain("deadline");
	});
});

// ─── makeCorrelationId ──────────────────────────────────────────────────────

describe("makeCorrelationId", () => {
	it('makeCorrelationId("m-123", 1, 3) === "m-123/L1/node-3"', () => {
		expect(makeCorrelationId("m-123", 1, 3)).toBe("m-123/L1/node-3");
	});

	it("depth=0 (L0), node=1", () => {
		expect(makeCorrelationId("mission-abc", 0, 1)).toBe("mission-abc/L0/node-1");
	});

	it("результат принимается createWorkPackage (самосогласованность)", () => {
		const correlationId = makeCorrelationId("m-123", 1, 3);
		const wp = createWorkPackage({ ...VALID_INPUT, correlationId });
		expect(wp.correlationId).toBe("m-123/L1/node-3");
	});

	it("depth = -1 → бросает WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("m", -1, 0)).toThrow(WorkPackageValidationError);
	});

	it("node = -2 → бросает WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("m", 0, -2)).toThrow(WorkPackageValidationError);
	});

	it("depth = 1.5 → бросает WorkPackageValidationError (не integer)", () => {
		expect(() => makeCorrelationId("m", 1.5, 0)).toThrow(WorkPackageValidationError);
	});

	it("missionId = \"\" → бросает WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("", 0, 0)).toThrow(WorkPackageValidationError);
	});

	it('missionId с "/" → бросает WorkPackageValidationError', () => {
		expect(() => makeCorrelationId("a/b", 0, 0)).toThrow(WorkPackageValidationError);
	});

	it("depth = Infinity → бросает WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("m", Infinity, 0)).toThrow(WorkPackageValidationError);
	});
});

// ─── parseWorkPackage: невалидный ввод → null ───────────────────────────────

describe("parseWorkPackage: невалидный ввод → null", () => {
	it("не-JSON строка → null", () => {
		expect(parseWorkPackage("не json вовсе")).toBeNull();
	});

	it("пустая строка → null", () => {
		expect(parseWorkPackage("")).toBeNull();
	});

	it("JSON без work_package → null", () => {
		expect(parseWorkPackage(JSON.stringify({ task: "t", depth: 1 }))).toBeNull();
	});

	it("JSON с work_package:false → null", () => {
		expect(parseWorkPackage(JSON.stringify({ work_package: false, task: "t" }))).toBeNull();
	});

	it("JSON с work_package:true (старый flat-формат) → null", () => {
		expect(parseWorkPackage(JSON.stringify({ work_package: true, task: "t" }))).toBeNull();
	});

	it("JSON-примитив (число, строка, null) → null", () => {
		expect(parseWorkPackage("42")).toBeNull();
		expect(parseWorkPackage('"строка"')).toBeNull();
		expect(parseWorkPackage("null")).toBeNull();
	});

	it("JSON-массив → null", () => {
		expect(parseWorkPackage(JSON.stringify([{ work_package: true }]))).toBeNull();
	});

	it("work_package с невалидными полями → null", () => {
		const msg = JSON.stringify({
			work_package: { task: "t", depth: -1, correlationId: "bad", tokenBudget: 100, deadline: "2026-08-15" },
		});
		expect(parseWorkPackage(msg)).toBeNull();
	});

	it("work_package без обязательных полей → null", () => {
		const msg = JSON.stringify({ work_package: { task: "t" } });
		expect(parseWorkPackage(msg)).toBeNull();
	});

	it("work_package с пустым task → null", () => {
		const msg = JSON.stringify({
			work_package: {
				task: "",
				correlationId: "m/L1/node-1",
				depth: 1,
				tokenBudget: 50000,
				deadline: "2026-08-15T00:00:00.000Z",
			},
		});
		expect(parseWorkPackage(msg)).toBeNull();
	});

	it("полный пакет через serializeWorkPackage → валидный WorkPackage", () => {
		const wp = createWorkPackage(VALID_INPUT);
		const req = serializeWorkPackage(wp);
		const restored = parseWorkPackage(req.message);
		expect(restored).not.toBeNull();
		expect(restored.task).toBe(wp.task);
		expect(restored.correlationId).toBe(wp.correlationId);
	});

	it("полный пакет через JSON.stringify({work_package:...}) → валидный WorkPackage", () => {
		const pkg = {
			task: "Тест",
			correlationId: "m/L1/node-1",
			depth: 1,
			tokenBudget: 50000,
			deadline: "2026-08-15T00:00:00.000Z",
		};
		const restored = parseWorkPackage(JSON.stringify({ work_package: pkg }));
		expect(restored).not.toBeNull();
		expect(restored.task).toBe("Тест");
		expect(restored.correlationId).toBe("m/L1/node-1");
		expect(restored.depth).toBe(1);
		expect(restored.maxRetries).toBe(2); // дефолт
		expect(restored.spawnBudget).toBe(0); // дефолт
	});
});

// ─── Интеграционный сценарий протокола L0 → L1 ──────────────────────────────

describe("протокол L0 → L1 end-to-end (без процессов)", () => {
	it("L0 формирует пакет → serialize → L1 parse → buildToolFlag + buildToolArgs для CLI", () => {
		const correlationId = makeCorrelationId("mission-7f3a", 1, 2);
		const wp = createWorkPackage({
			task: "Собрать данные по конкурентам",
			correlationId,
			depth: 1,
			tokenBudget: 30_000,
			deadline: "2026-08-16T12:00:00.000Z",
			spawnBudget: 0,
			toolManifest: ["read", "write"],
			context: { constraints: ["только публичные источники"] },
		});

		// L0 сериализует в SendMessageRequest-подобную форму
		const req = serializeWorkPackage(wp);
		expect(req.streamingBehavior).toBe("followUp");

		// L1 парсит входящее сообщение
		const received = parseWorkPackage(req.message);
		expect(received).toEqual(wp);

		// L1 строит флаг инструментов для дочернего fan-процесса
		expect(buildToolFlag(received.toolManifest)).toBe("--tools read,write");

		// L1 строит argv-массив для spawn
		expect(buildToolArgs(received.toolManifest)).toEqual(["--tools", "read,write"]);

		// Дефолтные ретраи и бюджет стоимости
		expect(received.maxRetries).toBe(2);
		expect(received.costBudgetUsd).toBe(0);
	});
});

// ─── makeCorrelationId: charset missionId (F-38, синхронизация с границей) ──

describe("makeCorrelationId: charset missionId = [A-Za-z0-9._-]+ (как validateCorrelationId)", () => {
	it("кириллический missionId → WorkPackageValidationError с диагностикой (fail-fast)", () => {
		expect(() => makeCorrelationId("миссия-1", 1, 1)).toThrow(WorkPackageValidationError);
		try {
			makeCorrelationId("миссия-1", 1, 1);
			expect.unreachable("должен был бросить");
		} catch (error) {
			expect(error).toBeInstanceOf(WorkPackageValidationError);
			expect(error.invalidFields).toContain("missionId");
			expect(error.message).toMatch(/missionId/);
		}
	});

	it("missionId с пробелом → WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("my mission", 1, 1)).toThrow(WorkPackageValidationError);
	});

	it("missionId со служебными скобками ('[FILTERED]') → WorkPackageValidationError", () => {
		expect(() => makeCorrelationId("[FILTERED]", 1, 1)).toThrow(WorkPackageValidationError);
	});

	it("валидный charset (точки, дефисы, подчёркивания) → работает", () => {
		expect(makeCorrelationId("mission_v2.1-alpha", 1, 3)).toBe("mission_v2.1-alpha/L1/node-3");
	});

	it("результат makeCorrelationId проходит validateCorrelationId границы (самосогласованность charset)", async () => {
		const { validateCorrelationId } = await import("../message-sanitizer.js");
		const correlationId = makeCorrelationId("mission_v2.1-alpha", 1, 3);
		expect(validateCorrelationId(correlationId).valid).toBe(true);
	});
});
