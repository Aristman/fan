// F-18: Лестница верификации — Red-фаза
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-18
// Спека:     docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3 (шаг 4
//            «Верификация»: статика → линтеры → сборка → тесты → приёмочная
//            команда пункта → независимый аудитор в свежем контексте).
//
// Все тесты ожидают модули `extensions/fan-mission/verification-ladder.ts` и
// `extensions/fan-mission/verification-config.ts`, компилируемые в
// `verification-ladder.js` / `verification-config.js`. На момент Red-фазы
// модули не существуют — динамический import в beforeAll выбрасывает, символы
// остаются undefined, и каждый `it` падает индивидуально на отсутствии API
// (правильный TDD Red: тесты запускаются и падают, а не «файл не загрузился»).
// После реализации модулей по контракту ниже тесты должны проходить.
//
// Контракт API (по карточке F-18 + спека §3.1.3, шаг 4):
//
//   createVerificationLadder(opts?: {
//     steps?: VerificationStep[],          // конфигурация ступеней (дефолт — DEFAULT_STEPS)
//     runCommand?: (cmd: string, opts: { cwd: string, timeoutMs: number })
//       => Promise<{ exitCode: number; output: string }>,   // DI для mock
//   }): VerificationLadder
//
//   interface VerificationStep {
//     name: string;        // имя ступени: typecheck | linters | build | tests | acceptance
//     command: string;     // shell-команда ступени
//     timeoutMs: number;   // таймаут ступени (мс); при отсутствии — дефолт
//     required: boolean;   // false → провал не останавливает лестницу
//   }
//
//   ladder.run(missionDir: string): Promise<{
//     passed: boolean;             // true если все required-ступени прошли
//     failedStep: string | null;    // имя провалившейся required-ступени (или null)
//     diagnosis: string | null;     // имя ступени + вывод инструмента (обрезано до ~2000)
//   }>
//
// Поведение (из карточки + спеки):
//   1. Ступени выполняются ПОСЛЕДОВАТЕЛЬНО в порядке конфигурации.
//   2. Провал required-ступени (exitCode != 0, throw, timeout) → немедленный
//      { passed: false, failedStep: <name>, diagnosis: <name + output> },
//      следующие ступени НЕ запускаются.
//   3. required:false ступень падает → лестница ПРОДОЛЖАЕТ; passed
//      определяется только required-ступенями.
//   4. Пустой массив steps → { passed: true } (нет проверок = нет провалов).
//   5. runCommand бросает неожиданную ошибку → провал с диагностикой (не crash).
//   6. diagnosis обрезается до разумной длины (output ~100KB не тащить целиком;
//      например последние ~2000 символов — хвост).
//   7. missionDir передаётся в runCommand как opts.cwd.
//   8. Дефолтный timeoutMs применяется, если у ступени не указан свой.
//
// DI-стиль: runCommand — чистая функция-заглушка, реальные команды НЕ
// запускаются (тесты быстрые и детерминированные). vi.useFakeTimers НЕ нужен —
// таймаут эмулируется тем, что mock runCommand бросает Error("timeout ...").
//
// Refactor-цель карточки: конфигурация ступеней вынесена в verification-config.ts
// (экспорт DEFAULT_STEPS: VerificationStep[] — 5 ступеней:
// typecheck/linters/build/tests/acceptance). Тесты ниже покрывают и этот контракт.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модулей под верификацию (SUT). На Red-фазе модулей нет — динамический
// import в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит его,
// символы остаются undefined. Файл при этом ЗАГРУЖАЕТСЯ, все it-блоки
// собираются и падают ИНДИВИДУАЛЬНО на вызове/чтении undefined-символов.
// На Green-фазе модули появятся — import подтянет символы, тесты пройдут.
// ────────────────────────────────────────────────────────────────────────────

let createVerificationLadder;
let DEFAULT_STEPS;

beforeAll(async () => {
	try {
		({ createVerificationLadder } = await import("../verification-ladder.js"));
	} catch {
		// Red: verification-ladder.ts ещё не реализован.
	}
	try {
		({ DEFAULT_STEPS } = await import("../verification-config.js"));
	} catch {
		// Red: verification-config.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock runCommand (DI), TEST_STEPS, временный missionDir
// ────────────────────────────────────────────────────────────────────────────

/**
 * Тестовый набор из 5 ступеней (имена и порядок как у DEFAULT_STEPS, но с
 * известными command-строками, чтобы mock мог ветвиться по команде).
 * timeoutMs у linters = 500 (для TC-F18-3).
 */
const TEST_STEPS = [
	{ name: "typecheck", command: "tsc --noEmit", timeoutMs: 30_000, required: true },
	{ name: "linters", command: "eslint .", timeoutMs: 500, required: true },
	{ name: "build", command: "npm run build", timeoutMs: 120_000, required: true },
	{ name: "tests", command: "npm test", timeoutMs: 60_000, required: true },
	{ name: "acceptance", command: "npm run test:acceptance", timeoutMs: 120_000, required: true },
];

/**
 * Создаёт mock runCommand с записью вызовов (calls).
 *
 * map — отображение command → результат. Результат может быть:
 *   - { exitCode, output }           — обычный возврат
 *   - { throw: "<message>" }          — mock бросает Error(message) (таймаут/ошибка)
 *   - (cmd, opts) => result           — динамическая функция
 * Команды вне map возвращают defaultResult (по умолчанию — success).
 *
 * Возвращаемая функция имеет поле .calls[] для assertions (cmd, cwd, timeoutMs).
 */
function makeRunCommand(map = {}, defaultResult = { exitCode: 0, output: "" }) {
	const calls = [];
	const fn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
		let entry = map[cmd];
		if (entry === undefined) {
			entry = defaultResult;
		}
		if (typeof entry === "function") {
			return entry(cmd, opts);
		}
		if (
			entry !== null &&
			typeof entry === "object" &&
			Object.prototype.hasOwnProperty.call(entry, "throw")
		) {
			throw new Error(entry.throw);
		}
		return entry;
	};
	fn.calls = calls;
	return fn;
}

// Временный missionDir для каждого теста. Реальные команды НЕ запускаются
// (runCommand замокан), но настоящий каталог страховует от impl, который
// может stat()'нуть директорию перед запуском ступени.

let missionDir;

beforeEach(() => {
	missionDir = mkdtempSync(join(tmpdir(), "fan-f18-red-"));
});

afterEach(() => {
	rmSync(missionDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F18-1: Ступени последовательно, провал останавливает
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / TC-F18-1: ступени последовательно, провал останавливает", () => {
	it("ступени 1-3 проходят, ступень 4 (tests) exitCode 1 → passed:false, failedStep:'tests'", async () => {
		const runCommand = makeRunCommand({
			"npm test": { exitCode: 1, output: "test auth.test.ts:42 failed" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		const result = await ladder.run(missionDir);

		expect(result.passed).toBe(false);
		expect(result.failedStep).toBe("tests");
	});

	it("diagnosis содержит имя ступени + вывод инструмента", async () => {
		const runCommand = makeRunCommand({
			"npm test": { exitCode: 1, output: "test auth.test.ts:42 failed" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		const result = await ladder.run(missionDir);

		// Имя ступени (в output 'test auth.test.ts' нет подстроки 'tests' —
		// значит это проверяет именно имя ступени, а не вывод).
		expect(result.diagnosis).toContain("tests");
		// Вывод инструмента (хвост output).
		expect(result.diagnosis).toContain("auth.test.ts:42");
	});

	it("ступень 5 (acceptance) НЕ запускается — провал останавливает лестницу", async () => {
		const runCommand = makeRunCommand({
			"npm test": { exitCode: 1, output: "test auth.test.ts:42 failed" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		await ladder.run(missionDir);

		const cmds = runCommand.calls.map((c) => c.cmd);
		expect(runCommand.calls.length).toBe(4); // typecheck, linters, build, tests
		expect(cmds[3]).toBe("npm test");
		expect(cmds).not.toContain("npm run test:acceptance");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F18-2: Все ступени пройдены → passed
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / TC-F18-2: все ступени пройдены → passed", () => {
	it("все mock-ступени exitCode 0 → { passed:true, failedStep:null, diagnosis:null }", async () => {
		const runCommand = makeRunCommand({}); // все команды → default success
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		const result = await ladder.run(missionDir);

		expect(result).toEqual({ passed: true, failedStep: null, diagnosis: null });
	});

	it("все 5 ступеней вызваны в порядке конфигурации", async () => {
		const runCommand = makeRunCommand({});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		await ladder.run(missionDir);

		expect(runCommand.calls.length).toBe(5);
		expect(runCommand.calls.map((c) => c.cmd)).toEqual(
			TEST_STEPS.map((s) => s.command),
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F18-3: Таймаут ступени → провал с диагностикой
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / TC-F18-3: таймаут ступени → провал с диагностикой", () => {
	it("ступень 2 (linters) timeoutMs=500, mock бросает timeout → passed:false, failedStep:'linters'", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { throw: "timeout after 500ms" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		const result = await ladder.run(missionDir);

		expect(result.passed).toBe(false);
		expect(result.failedStep).toBe("linters");
	});

	it("diagnosis содержит 'timeout'", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { throw: "timeout after 500ms" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		const result = await ladder.run(missionDir);

		expect(result.diagnosis).toContain("timeout");
	});

	it("ступень 3+ НЕ запускается после timeout (провал останавливает)", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { throw: "timeout after 500ms" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		await ladder.run(missionDir);

		expect(runCommand.calls.length).toBe(2); // typecheck, linters
		expect(runCommand.calls[1].cmd).toBe("eslint .");
		expect(runCommand.calls.map((c) => c.cmd)).not.toContain("npm run build");
	});

	it("step.timeoutMs (500) передаётся в runCommand как opts.timeoutMs", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { throw: "timeout after 500ms" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		await ladder.run(missionDir);

		expect(runCommand.calls[1].timeoutMs).toBe(500);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: required:false — провал не останавливает лестницу
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: required:false — провал не останавливает лестницу", () => {
	const steps = [
		{ name: "typecheck", command: "tsc --noEmit", timeoutMs: 30_000, required: true },
		{ name: "linters", command: "eslint .", timeoutMs: 500, required: false },
		{ name: "build", command: "npm run build", timeoutMs: 120_000, required: true },
	];

	it("required:false падает, но лестница продолжает — следующая ступень вызвана", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { exitCode: 1, output: "warning: unused variable" },
		});
		const ladder = createVerificationLadder({ steps, runCommand });
		await ladder.run(missionDir);

		// build (после упавшей linters) всё равно вызвана — лестница не встала
		expect(runCommand.calls.map((c) => c.cmd)).toContain("npm run build");
		expect(runCommand.calls.length).toBe(3);
	});

	it("required:false падает и все required проходят → passed:true, failedStep:null", async () => {
		const runCommand = makeRunCommand({
			"eslint .": { exitCode: 1, output: "warning: unused variable" },
		});
		const ladder = createVerificationLadder({ steps, runCommand });
		const result = await ladder.run(missionDir);

		expect(result.passed).toBe(true);
		expect(result.failedStep).toBe(null);
		// diagnosis/предупреждение МОЖЕТ фиксироваться — не утверждаем строго
		// (контракт: passed определяется только required-ступенями).
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: пустой массив steps → passed
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: пустой массив steps → passed", () => {
	it("steps:[] → { passed:true, failedStep:null, diagnosis:null }, runCommand не вызван", async () => {
		const runCommand = makeRunCommand({});
		const ladder = createVerificationLadder({ steps: [], runCommand });
		const result = await ladder.run(missionDir);

		expect(result).toEqual({ passed: true, failedStep: null, diagnosis: null });
		expect(runCommand.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: неожиданная ошибка runCommand → провал без crash
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: неожиданная ошибка runCommand → провал без crash", () => {
	it("runCommand бросает EACCES → run() не падает, возвращает провал с диагностикой", async () => {
		const runCommand = makeRunCommand({
			"tsc --noEmit": { throw: "EACCES: permission denied" },
		});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });

		// Не crash — run() резолвится объектом-результатом.
		const result = await ladder.run(missionDir);

		expect(result.passed).toBe(false);
		expect(result.failedStep).toBe("typecheck");
		expect(typeof result.diagnosis).toBe("string");
		expect(result.diagnosis.length).toBeGreaterThan(0);
		// Сообщение брошенной ошибки echoed в diagnosis (информативность).
		expect(result.diagnosis).toContain("permission");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: diagnosis обрезается (хвост — последние символы output)
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: diagnosis обрезается до разумной длины (хвост output)", () => {
	it("output ~100KB → diagnosis короче output, содержит хвост, разумной длины", async () => {
		const headMarker = "HEAD_MARKER_START";
		const tailMarker = "TAIL_MARKER_END";
		const hugeOutput = headMarker + "x".repeat(100_000) + tailMarker; // ~100031 chars
		const steps = [
			{ name: "build", command: "npm run build", timeoutMs: 60_000, required: true },
		];
		const runCommand = makeRunCommand({
			"npm run build": { exitCode: 1, output: hugeOutput },
		});
		const ladder = createVerificationLadder({ steps, runCommand });
		const result = await ladder.run(missionDir);

		expect(result.passed).toBe(false);
		expect(result.failedStep).toBe("build");
		// Хвост сохранён (последние символы output — там обычно суть ошибки).
		expect(result.diagnosis).toContain(tailMarker);
		// Не тащит весь 100KB output целиком.
		expect(result.diagnosis.length).toBeLessThan(hugeOutput.length);
		// Разумная длина (например ~2000 + префикс; точно не 50KB).
		expect(result.diagnosis.length).toBeLessThan(10_000);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: DEFAULT_STEPS — структура 5 ступеней (refactor-цель verification-config.ts)
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: DEFAULT_STEPS — структура 5 ступеней", () => {
	it("содержит ровно 5 ступеней", () => {
		expect(DEFAULT_STEPS).toHaveLength(5);
	});

	it("имена в порядке typecheck/linters/build/tests/acceptance", () => {
		expect(DEFAULT_STEPS.map((s) => s.name)).toEqual([
			"typecheck",
			"linters",
			"build",
			"tests",
			"acceptance",
		]);
	});

	it("каждая ступень имеет command (непустой), timeoutMs (>0), required (boolean)", () => {
		for (const step of DEFAULT_STEPS) {
			expect(typeof step.command).toBe("string");
			expect(step.command.length).toBeGreaterThan(0);
			expect(typeof step.timeoutMs).toBe("number");
			expect(step.timeoutMs).toBeGreaterThan(0);
			expect(typeof step.required).toBe("boolean");
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: дефолтные ступени используются при отсутствии steps
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: дефолтные ступени используются при отсутствии steps", () => {
	it("createVerificationLadder без steps → run использует DEFAULT_STEPS (5 ступеней)", async () => {
		const runCommand = makeRunCommand({});
		const ladder = createVerificationLadder({ runCommand });
		const result = await ladder.run(missionDir);

		expect(result).toEqual({ passed: true, failedStep: null, diagnosis: null });
		expect(runCommand.calls.length).toBe(5);
		expect(runCommand.calls.map((c) => c.cmd)).toEqual(
			DEFAULT_STEPS.map((s) => s.command),
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: дефолтный таймаут применяется если не указан
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: дефолтный таймаут применяется если не указан", () => {
	it("ступень без timeoutMs → runCommand получает default timeoutMs > 0", async () => {
		// timeoutMs намеренно опущен — лестница должна применить дефолт.
		const step = { name: "custom", command: "echo hi", required: true };
		const runCommand = makeRunCommand({
			"echo hi": { exitCode: 0, output: "" },
		});
		const ladder = createVerificationLadder({ steps: [step], runCommand });
		await ladder.run(missionDir);

		expect(runCommand.calls.length).toBe(1);
		expect(runCommand.calls[0].timeoutMs).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: missionDir передаётся в runCommand как cwd
// ────────────────────────────────────────────────────────────────────────────

describe("F-18 / EDGE: missionDir передаётся в runCommand как cwd", () => {
	it("каждый вызов runCommand получает opts.cwd === missionDir", async () => {
		const runCommand = makeRunCommand({});
		const ladder = createVerificationLadder({ steps: TEST_STEPS, runCommand });
		await ladder.run(missionDir);

		expect(runCommand.calls.length).toBe(5);
		for (const call of runCommand.calls) {
			expect(call.cwd).toBe(missionDir);
		}
	});
});
