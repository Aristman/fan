// F-21: Сбор метрик миссии — Red-фаза
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-21
// Спека:     docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//            §5.2 (надёжность: crash recovery через файлы) и §6.1 / Этап 1
//            (критерии приёмки: «частота отказов координации <20%, доля
//            преждевременных завершений <15% (ориентиры MAST)»; MAST: 21.3%
//            отказов — преждевременное завершение, 41.8% — системный дизайн).
//
// Все тесты ожидают модуль `extensions/fan-mission/metrics-collector.ts`,
// компилируемый в `metrics-collector.js`. На момент Red-фазы модуль не
// существует — динамический import в beforeAll выбрасывает
// ERR_MODULE_NOT_FOUND, try/catch глушит его, символ `createMetricsCollector`
// остаётся undefined. Файл при этом ЗАГРУЖАЕТСЯ, все it-блоки собираются и
// падают ИНДИВИДУАЛЬНО на вызове undefined (правильный TDD Red: тесты
// запускаются и падаются, а не «файл не загрузился»). После реализации модуля
// по контракту ниже тесты должны пройти.
//
// ────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ API (DI-стиль, для Green-фазы)
// ────────────────────────────────────────────────────────────────────────────
//
//   createMetricsCollector(opts?: {
//     now?: () => Date,   // DI clock; default () => new Date()
//   }): MetricsCollector
//
//   interface MetricsCollector {
//     // Дописать ОДНУ JSON-строку в <missionDir>/metrics.jsonl (append-only).
//     // Строка = JSON.stringify({ ...record, timestamp: now().toISOString() }),
//     // завершается '\n'. Файл НЕ перезаписывается (append, не write).
//     onIterationEnd(missionDir: string, record: {
//       iteration: number,
//       tokensIn: number,
//       tokensOut: number,
//       durationMs: number,
//       status: string,
//       promiseTag?: string | null,
//       verificationResult?: string | null,
//     }): Promise<void>
//
//     // Прочитать metrics.jsonl, распарсить построчно, агрегировать.
//     // Повреждённые / пустые строки ПРОПУСКАЮТСЯ (не падают).
//     getMetrics(missionDir: string): Promise<{
//       totalIterations: number,            // кол-во валидных записей
//       avgDurationMs: number,               // среднее durationMs (0 если нет записей)
//       failureRate: number,                 // FAILURE / total (доля, 0..1)
//       prematureTerminationRate: number,    // PREMATURE / total (доля, 0..1)
//       totalTokensIn: number,              // сумма tokensIn
//       totalTokensOut: number,             // сумма tokensOut
//     }>
//   }
//
// ─── Файл метрик ──────────────────────────────────────────────────────────────
//   <missionDir>/metrics.jsonl — append-only JSONL. КАЖДАЯ запись = ровно одна
//   строка (без pretty-print, без встроенных '\n'), завершается '\n'. Файл всегда
//   остаётся валидным JSONL. missionDir передаётся аргументом (как у
//   verification-ladder / file-state-manager) — метрики пишутся в
//   `<missionDir>/metrics.jsonl`. Состояние на диске переживает рестарт
//   процесса (новый экземпляр коллектора видит записи предыдущего — спека §5.2).
//
// ─── Классификация статусов (ЗАФИКСИРОВАНА) ──────────────────────────────────
//   Проверено по реальному контуру: `extensions/fan-mission/mission-loop.ts`
//   определяет MissionStatus = "active" | "paused" | "completed" | "aborted"
//   | "failed" | "budget_exhausted" | "awaiting_decision". ВАЖНО: watchdog
//   (F-03) в контуре — это RUNTIME-таймер в agent-session.ts (emit события с
//   reason "watchdog_timeout"), а НЕ миссионный статус. Отдельного статуса
//   «watchdog» в mission-loop.ts НЕТ. Поэтому для F-21 фиксируем статус
//   итерации, прерванной watchdog'ем, как "failed_watchdog" (так roadmap TC-F21-3
//   описывает «1 failed (watchdog)»). Бонус-алиас "watchdog" (без префикса)
//   тоже признаётся premature — на случай, если интеграция F-03→F-21 запишет
//   именно его.
//
//   FAILURE_STATUSES     = ["failed", "failed_watchdog"]
//     → считаются в failureRate (числитель).
//   PREMATURE_STATUSES   = ["failed_watchdog", "watchdog", "budget_exhausted"]
//     → считаются в prematureTerminationRate (числитель).
//
//   Матрица (по TC-F21-2/F21-3 + edge-кейсам карточки):
//     "completed"        → failure: нет,  premature: нет   (успех)
//     "failed"           → failure: ДА,   premature: нет   (агент сам сообщил FAILED)
//     "failed_watchdog"  → failure: ДА,   premature: ДА    (watchdog убил итерацию:
//                          это и провал, и преждевременное завершение)
//     "watchdog"         → failure: —,    premature: ДА    (alias; failure не пинируем)
//     "budget_exhausted" → failure: нет,  premature: ДА   (ресурсный лимит, не ошибка
//                          агента — в failureRate НЕ входит, см. TC-F21-3 = 0.1)
//     "aborted"          → failure: нет,  premature: нет   (оператор, I0)
//     прочие/неизвестные → failure: нет,  premature: нет
//
//   Проверка числами (TC):
//     TC-F21-2: 8 completed + 2 failed
//       → failureRate = 2/10 = 0.2 (failed ∈ FAILURE)
//       → prematureTerminationRate = 0/10 = 0.0 (нет watchdog/budget)
//     TC-F21-3: 7 completed + 1 aborted + 1 failed_watchdog + 1 budget_exhausted
//       → failureRate = 1/10 = 0.1 (только failed_watchdog ∈ FAILURE;
//          budget_exhausted ∉ FAILURE, aborted ∉ FAILURE)
//       → prematureTerminationRate = 2/10 = 0.2 (failed_watchdog + budget_exhausted
//          ∈ PREMATURE; aborted ∉ PREMATURE — оператор)
//
// ─── MAST-ориентиры (§5.2 / §6.1) ─────────────────────────────────────────────
//   failureRate < 0.20 (частота отказов координации <20%);
//   prematureTerminationRate < 0.15 (доля преждевременных завершений <15%).
//   Сам коллектор только ВОЗВРАЩАЕТ доли — сравнение с порогами вне его контракта.
//
// ─── Red-фаза ─────────────────────────────────────────────────────────────────
//   На момент написания metrics-collector.ts не существует → createMetricsCollector
//   undefined → каждый it падает на «createMetricsCollector is not a function»
//   (или на undefined.onIterationEnd/undefined.getMetrics). Существующие 415
//   тестов fan-mission не затронуты (динамический import изолирован в beforeAll).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля под верификацию (SUT). На Red-фазе модуля нет — динамический
// import выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит, символ остаётся
// undefined. Файл при этом ЗАГРУЖАЕТСЯ, все it-блоки собираются и падают
// ИНДИВИДУАЛЬНО на вызове undefined-символа. На Green-фазе import подтянет символ.
// ────────────────────────────────────────────────────────────────────────────

let createMetricsCollector;

beforeAll(async () => {
	try {
		({ createMetricsCollector } = await import("../metrics-collector.js"));
	} catch {
		// Red: metrics-collector.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock clock, временный missionDir, чтение/запись metrics.jsonl
// ────────────────────────────────────────────────────────────────────────────

/** Создать mock clock, всегда возвращающий одну и ту же дату (детерминизм timestamp). */
function makeMockClock(iso = "2026-08-13T12:00:00.000Z") {
	const d = new Date(iso);
	return () => d;
}

/** Свежий tmp-каталог для missionDir (метрики пишутся в <missionDir>/metrics.jsonl). */
function freshMissionDir(prefix = "fan-f21-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function metricsPath(missionDir) {
	return join(missionDir, "metrics.jsonl");
}

/** Прочитать сырые строки metrics.jsonl (без парсинга). */
function readRawLines(missionDir) {
	const p = metricsPath(missionDir);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n");
}

/** Прочитать и распарсить валидные JSON-записи (только для тестов, где все строки валидны). */
function readRecords(missionDir) {
	return readRawLines(missionDir)
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));
}

/** Записать массив объектов как JSONL (каждый → одна строка + '\n'). Все строки валидны. */
function seedRecords(missionDir, records) {
	const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
	writeFileSync(metricsPath(missionDir), content, "utf8");
}

/** Записать сырые строки как JSONL (включая повреждённые — для edge-кейсов). */
function seedRawLines(missionDir, lines) {
	const content = lines.join("\n") + (lines.length > 0 ? "\n" : "");
	writeFileSync(metricsPath(missionDir), content, "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F21-1: Метрики записываются в JSONL после итерации
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / TC-F21-1: метрики записываются в JSONL после итерации", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-tc1-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("onIterationEnd → metrics.jsonl содержит 1 JSON-строку с полями + timestamp (ISO)", async () => {
		const clock = makeMockClock("2026-08-13T10:00:00.000Z");
		const collector = createMetricsCollector({ now: clock });
		await collector.onIterationEnd(missionDir, {
			iteration: 1,
			tokensIn: 5000,
			tokensOut: 2000,
			durationMs: 30000,
			status: "completed",
			promiseTag: "COMPLETE",
		});

		const records = readRecords(missionDir);
		expect(records.length).toBe(1);
		const r = records[0];
		// Все поля записи сохранены.
		expect(r.iteration).toBe(1);
		expect(r.tokensIn).toBe(5000);
		expect(r.tokensOut).toBe(2000);
		expect(r.durationMs).toBe(30000);
		expect(r.status).toBe("completed");
		expect(r.promiseTag).toBe("COMPLETE");
		// timestamp добавлен коллектором — ISO-строка, детерминирована DI clock.
		expect(r.timestamp).toBe("2026-08-13T10:00:00.000Z");
		// timestamp — валидный ISO (round-trip через Date).
		expect(new Date(r.timestamp).toISOString()).toBe(r.timestamp);
	});

	it("повторный вызов → 2 строки (append-only, файл не перезаписывается)", async () => {
		const collector = createMetricsCollector({ now: makeMockClock("2026-08-13T10:00:00.000Z") });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});
		await collector.onIterationEnd(missionDir, {
			iteration: 2, tokensIn: 200, tokensOut: 100, durationMs: 2000, status: "completed",
		});

		const records = readRecords(missionDir);
		expect(records.length).toBe(2);
		expect(records[0].iteration).toBe(1);
		expect(records[1].iteration).toBe(2);
	});

	it("каждая запись — ровно одна строка (нет pretty-print), файл валидный JSONL", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 10, tokensOut: 5, durationMs: 100, status: "completed",
		});
		await collector.onIterationEnd(missionDir, {
			iteration: 2, tokensIn: 20, tokensOut: 10, durationMs: 200, status: "completed",
		});

		const raw = readFileSync(metricsPath(missionDir), "utf8");
		// Файл заканчивается '\n' (последняя запись завершена переносом).
		expect(raw.endsWith("\n")).toBe(true);
		const lines = raw.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBe(2);
		// Каждая строка — валидный JSON без встроенных переносов (не pretty-print).
		for (const line of lines) {
			expect(line.includes("\n")).toBe(false);
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F21-2: Агрегация вычисляет failureRate
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / TC-F21-2: агрегация вычисляет failureRate", () => {
	let missionDir;
	// Фикстура: 8 completed + 2 failed = 10 записей.
	// completed: tokensIn=1000, tokensOut=500, durationMs=10000 (×8)
	// failed #9: tokensIn=2000, tokensOut=1000, durationMs=30000
	// failed #10: tokensIn=3000, tokensOut=1500, durationMs=50000
	const records = [];

	beforeAll(() => {
		records.length = 0;
		for (let i = 1; i <= 8; i++) {
			records.push({
				iteration: i, timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 1000, tokensOut: 500, durationMs: 10000, status: "completed",
			});
		}
		records.push({
			iteration: 9, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 2000, tokensOut: 1000, durationMs: 30000, status: "failed",
		});
		records.push({
			iteration: 10, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 3000, tokensOut: 1500, durationMs: 50000, status: "failed",
		});
	});

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-tc2-");
		seedRecords(missionDir, records);
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("8 completed + 2 failed → totalIterations 10, failureRate 0.2, premature 0.0", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		const m = await collector.getMetrics(missionDir);

		expect(m.totalIterations).toBe(10);
		// failed ∈ FAILURE → 2/10 = 0.2; watchdog/budget нет → premature 0.0.
		expect(m.failureRate).toBeCloseTo(0.2, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
	});

	it("totalTokensIn/Out — суммы по всем записям", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// in: 8×1000 + 2000 + 3000 = 13000; out: 8×500 + 1000 + 1500 = 6500.
		expect(m.totalTokensIn).toBe(13000);
		expect(m.totalTokensOut).toBe(6500);
	});

	it("avgDurationMs — среднее durationMs по всем записям", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// (8×10000 + 30000 + 50000) / 10 = 160000 / 10 = 16000.
		expect(m.avgDurationMs).toBe(16000);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F21-3: Преждевременные завершения считаются отдельно
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / TC-F21-3: преждевременные завершения считаются отдельно", () => {
	let missionDir;
	// Фикстура: 7 completed + 1 aborted + 1 failed_watchdog + 1 budget_exhausted = 10.
	// completed ×7: tokensIn=1000, tokensOut=500, durationMs=10000
	// aborted:      tokensIn=500,  tokensOut=200, durationMs=5000
	// failed_watchdog: tokensIn=2000, tokensOut=1000, durationMs=60000
	// budget_exhausted: tokensIn=3000, tokensOut=1500, durationMs=10000
	const records = [];

	beforeAll(() => {
		records.length = 0;
		for (let i = 1; i <= 7; i++) {
			records.push({
				iteration: i, timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 1000, tokensOut: 500, durationMs: 10000, status: "completed",
			});
		}
		records.push({
			iteration: 8, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 500, tokensOut: 200, durationMs: 5000, status: "aborted",
		});
		records.push({
			iteration: 9, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 2000, tokensOut: 1000, durationMs: 60000, status: "failed_watchdog",
		});
		records.push({
			iteration: 10, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 3000, tokensOut: 1500, durationMs: 10000, status: "budget_exhausted",
		});
	});

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-tc3-");
		seedRecords(missionDir, records);
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("prematureTerminationRate = 0.2 (watchdog + budget; abort оператора НЕ считается)", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// failed_watchdog + budget_exhausted ∈ PREMATURE → 2/10 = 0.2;
		// aborted ∉ PREMATURE (оператор).
		expect(m.prematureTerminationRate).toBeCloseTo(0.2, 3);
	});

	it("failureRate = 0.1 (только failed_watchdog; budget/aborted НЕ failure)", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// failed_watchdog ∈ FAILURE → 1/10 = 0.1;
		// budget_exhausted ∉ FAILURE, aborted ∉ FAILURE.
		expect(m.failureRate).toBeCloseTo(0.1, 3);
		expect(m.totalIterations).toBe(10);
	});

	it("totalTokens/avgDuration корректны для смешанных статусов", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// in: 7×1000 + 500 + 2000 + 3000 = 12500; out: 7×500 + 200 + 1000 + 1500 = 6200.
		expect(m.totalTokensIn).toBe(12500);
		expect(m.totalTokensOut).toBe(6200);
		// (7×10000 + 5000 + 60000 + 10000) / 10 = 145000 / 10 = 14500.
		expect(m.avgDurationMs).toBe(14500);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: пустой / отсутствующий metrics.jsonl → нули, не падает
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: пустой/отсутствующий metrics.jsonl → нули", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-empty-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("файл не существует → getMetrics возвращает нули и не падает", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m).toEqual({
			totalIterations: 0,
			avgDurationMs: 0,
			failureRate: 0,
			prematureTerminationRate: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
		});
	});

	it("пустой файл (0 байт) → нули", async () => {
		writeFileSync(metricsPath(missionDir), "", "utf8");
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(0);
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
		expect(m.totalTokensIn).toBe(0);
		expect(m.totalTokensOut).toBe(0);
		expect(m.avgDurationMs).toBe(0);
	});

	it("файл из пустых строк / whitespace → нули (пустые строки пропускаются)", async () => {
		seedRawLines(missionDir, ["", "   ", "\t", ""]);
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(0);
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
	});

	it("getMetrics на отсутствующем файле: failureRate/premature — именно 0 (не NaN, не undefined)", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// При 0 итераций деление на 0 не должно давать NaN/Infinity.
		expect(Number.isNaN(m.failureRate)).toBe(false);
		expect(Number.isNaN(m.prematureTerminationRate)).toBe(false);
		expect(Number.isNaN(m.avgDurationMs)).toBe(false);
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: повреждённая JSON-строка пропускается при агрегации
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: повреждённая JSON-строка пропускается", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-corrupt-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("мусорная строка пропускается, валидные записи считаются", async () => {
		seedRawLines(missionDir, [
			JSON.stringify({
				iteration: 1, timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
			}),
			"{ это не валидный json",
			JSON.stringify({
				iteration: 2, timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 200, tokensOut: 100, durationMs: 2000, status: "failed",
			}),
		]);

		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		// Мусорная строка пропущена → 2 валидные записи.
		expect(m.totalIterations).toBe(2);
		expect(m.totalTokensIn).toBe(300);
		expect(m.totalTokensOut).toBe(150);
		// 1 failed из 2 валидных → 0.5.
		expect(m.failureRate).toBeCloseTo(0.5, 3);
	});

	it("все строки повреждены → нули, не падает", async () => {
		seedRawLines(missionDir, ["{ broken", "also not json", "}}}{"]);
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(0);
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
		expect(m.totalTokensIn).toBe(0);
	});

	it("частично обрезанная JSON-строка пропускается", async () => {
		seedRawLines(missionDir, [
			'{"iteration":3,"timestamp":"2026-08-13T10:00:00.000Z","tokensIn":300', // обрезана
			JSON.stringify({
				iteration: 1, timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
			}),
		]);
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(1);
		expect(m.totalTokensIn).toBe(100);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: классификация статусов (failure / premature) — матрица
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: классификация статусов (failure / premature)", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-status-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	/**
	 * Создать по одной записи на каждый статус из массива (без completed-базиса —
	 * caller передаёт ровно те записи, что нужны). Возвращает getMetrics-результат.
	 */
	async function metricsFor(statuses) {
		const records = statuses.map((s, i) => ({
			iteration: i + 1, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 100, tokensOut: 50, durationMs: 1000, status: s,
		}));
		seedRecords(missionDir, records);
		const collector = createMetricsCollector();
		return collector.getMetrics(missionDir);
	}

	it("completed → не failure, не premature", async () => {
		const m = await metricsFor(["completed", "completed"]);
		expect(m.failureRate).toBeCloseTo(0.0, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
	});

	it("failed → failure, НЕ premature", async () => {
		const m = await metricsFor(["completed", "failed"]);
		expect(m.failureRate).toBeCloseTo(0.5, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
	});

	it("failed_watchdog → failure AND premature (зафиксировано в контракте)", async () => {
		const m = await metricsFor(["completed", "failed_watchdog"]);
		// failed_watchdog ∈ FAILURE ∩ PREMATURE (watchdog = и провал, и преждевременное завершение).
		expect(m.failureRate).toBeCloseTo(0.5, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.5, 3);
	});

	it("watchdog (bare alias) → premature (failure для bare-алиаса не пинируем)", async () => {
		const m = await metricsFor(["completed", "watchdog"]);
		expect(m.prematureTerminationRate).toBeCloseTo(0.5, 3);
		// failureRate для bare 'watchdog' контракт оставляет открытым — не пинируем.
	});

	it("budget_exhausted → premature, НЕ failure", async () => {
		const m = await metricsFor(["completed", "budget_exhausted"]);
		expect(m.failureRate).toBeCloseTo(0.0, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.5, 3);
	});

	it("aborted → НЕ failure, НЕ premature (оператор)", async () => {
		const m = await metricsFor(["completed", "aborted"]);
		expect(m.failureRate).toBeCloseTo(0.0, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
	});

	it("неизвестный статус → не failure, не premature (считается в totalIterations)", async () => {
		const m = await metricsFor(["completed", "awaiting_decision"]);
		expect(m.totalIterations).toBe(2);
		expect(m.failureRate).toBeCloseTo(0.0, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: promiseTag/verificationResult опциональны (null/undefined)
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: promiseTag/verificationResult опциональны", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-opt-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("null promiseTag/verificationResult → JSONL валиден, поля null или отсутствуют", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000,
			status: "completed", promiseTag: null, verificationResult: null,
		});

		const records = readRecords(missionDir);
		expect(records.length).toBe(1);
		// Поле либо null, либо отсутствует — оба варианта acceptable (контракт не фиксирует).
		expect(records[0].promiseTag ?? null).toBe(null);
		expect(records[0].verificationResult ?? null).toBe(null);

		// getMetrics не падает на null-полях.
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(1);
	});

	it("поля не переданы (undefined) → JSONL валиден, getMetrics работает", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});

		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(1);
		expect(m.totalTokensIn).toBe(100);
	});

	it("строковые promiseTag/verificationResult сохраняются 1:1", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000,
			status: "completed",
			promiseTag: "COMPLETE",
			verificationResult: "lint+build+tests OK",
		});

		const records = readRecords(missionDir);
		expect(records[0].promiseTag).toBe("COMPLETE");
		expect(records[0].verificationResult).toBe("lint+build+tests OK");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: timestamp детерминирован DI clock; персистентность между экземплярами
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: timestamp (DI clock) и персистентность на диске", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-clock-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("timestamp = now().toISOString() — детерминирован DI clock", async () => {
		const clock = makeMockClock("2026-08-13T09:30:45.000Z");
		const collector = createMetricsCollector({ now: clock });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 10, tokensOut: 5, durationMs: 100, status: "completed",
		});
		const records = readRecords(missionDir);
		expect(records[0].timestamp).toBe("2026-08-13T09:30:45.000Z");
	});

	it("новый экземпляр коллектора видит записи предыдущего (файл переживает restart)", async () => {
		// Спека §5.2: состояние миссии в файлах, переживает crash процесса.
		const c1 = createMetricsCollector({ now: makeMockClock("2026-08-13T10:00:00.000Z") });
		await c1.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});

		// Новый экземпляр (эмуляция рестарта процесса) — дописывает, не затирая.
		const c2 = createMetricsCollector({ now: makeMockClock("2026-08-13T11:00:00.000Z") });
		await c2.onIterationEnd(missionDir, {
			iteration: 2, tokensIn: 200, tokensOut: 100, durationMs: 2000, status: "completed",
		});

		// Третий экземпляр — читает обе записи.
		const c3 = createMetricsCollector();
		const m = await c3.getMetrics(missionDir);
		expect(m.totalIterations).toBe(2);
		expect(m.totalTokensIn).toBe(300);

		const records = readRecords(missionDir);
		expect(records[0].timestamp).toBe("2026-08-13T10:00:00.000Z");
		expect(records[1].timestamp).toBe("2026-08-13T11:00:00.000Z");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: unicode в статусах не ломает JSONL
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: unicode в статусах/полях не ломает JSONL", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-unicode-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("кириллица + эмодзи в status сохраняются 1:1, getMetrics работает", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000,
			status: "завершено 🔥", promiseTag: "COMPLETE",
		});

		const records = readRecords(missionDir);
		expect(records[0].status).toBe("завершено 🔥");

		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(1);
		// Неизвестный unicode-статус → не failure, не premature.
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
	});

	it("кириллица в promiseTag/verificationResult сохраняется без потерь", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000,
			status: "completed",
			promiseTag: "BLOCKED:нет доступа к БД",
			verificationResult: "линтеры ✓, сборка ✓, тесты ✗",
		});

		const records = readRecords(missionDir);
		expect(records[0].promiseTag).toBe("BLOCKED:нет доступа к БД");
		expect(records[0].verificationResult).toBe("линтеры ✓, сборка ✓, тесты ✗");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: большой файл (1000 записей) — агрегация работает
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: большой файл (1000 записей) — агрегация работает", () => {
	let missionDir;
	const records = [];

	beforeAll(() => {
		records.length = 0;
		// 1000 записей: каждый 10-й — failed (100 failed), остальные completed.
		for (let i = 1; i <= 1000; i++) {
			records.push({
				iteration: i,
				timestamp: "2026-08-13T10:00:00.000Z",
				tokensIn: 100,
				tokensOut: 50,
				durationMs: 1000,
				status: i % 10 === 0 ? "failed" : "completed",
			});
		}
	});

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-large-");
		seedRecords(missionDir, records);
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("1000 записей → totalIterations 1000, суммы и среднее корректны", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);

		expect(m.totalIterations).toBe(1000);
		expect(m.totalTokensIn).toBe(100000);
		expect(m.totalTokensOut).toBe(50000);
		expect(m.avgDurationMs).toBe(1000);
	});

	it("100 failed из 1000 → failureRate 0.1 (MAST-порог <0.20 — проходит)", async () => {
		const collector = createMetricsCollector();
		const m = await collector.getMetrics(missionDir);
		expect(m.failureRate).toBeCloseTo(0.1, 3);
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
		// MAST-ориентир: failureRate < 0.20 → миссия в норме.
		expect(m.failureRate).toBeLessThan(0.2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: onIterationEnd + getMetrics вместе (round-trip через публичный API)
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / EDGE: round-trip onIterationEnd → getMetrics через публичный API", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-edge-rt-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("5 итераций (3 completed, 1 failed, 1 aborted) → метрики через публичный API", async () => {
		// TC-F22-3 smoke: 5 mock-итераций с разными статусами.
		const collector = createMetricsCollector({ now: makeMockClock("2026-08-13T10:00:00.000Z") });
		await collector.onIterationEnd(missionDir, { iteration: 1, tokensIn: 1000, tokensOut: 500, durationMs: 10000, status: "completed", promiseTag: "COMPLETE" });
		await collector.onIterationEnd(missionDir, { iteration: 2, tokensIn: 1100, tokensOut: 550, durationMs: 11000, status: "completed", promiseTag: "COMPLETE" });
		await collector.onIterationEnd(missionDir, { iteration: 3, tokensIn: 900, tokensOut: 450, durationMs: 9000, status: "completed", promiseTag: "COMPLETE" });
		await collector.onIterationEnd(missionDir, { iteration: 4, tokensIn: 2000, tokensOut: 1000, durationMs: 40000, status: "failed", promiseTag: "FAILED" });
		await collector.onIterationEnd(missionDir, { iteration: 5, tokensIn: 300, tokensOut: 100, durationMs: 1000, status: "aborted" });

		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(5);
		// 1 failed из 5 → 0.2 (MAST-порог <0.20 — на грани).
		expect(m.failureRate).toBeCloseTo(0.2, 3);
		// aborted ∉ premature → 0.0.
		expect(m.prematureTerminationRate).toBeCloseTo(0.0, 3);
		// in: 1000+1100+900+2000+300 = 5300; out: 500+550+450+1000+100 = 2600.
		expect(m.totalTokensIn).toBe(5300);
		expect(m.totalTokensOut).toBe(2600);

		// metrics.jsonl содержит ровно 5 JSON-строк.
		const lines = readRawLines(missionDir).filter((l) => l.trim().length > 0);
		expect(lines.length).toBe(5);
	});

	it("здоровая миссия (все completed) → failureRate 0, premature 0 (ниже MAST-порогов)", async () => {
		const collector = createMetricsCollector({ now: makeMockClock() });
		for (let i = 1; i <= 10; i++) {
			await collector.onIterationEnd(missionDir, {
				iteration: i, tokensIn: 1000, tokensOut: 500, durationMs: 10000,
				status: "completed", promiseTag: "COMPLETE",
			});
		}
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(10);
		expect(m.failureRate).toBe(0);
		expect(m.prematureTerminationRate).toBe(0);
		// MAST-ориентиры: отказы <20%, преждевременные <15% — проходит.
		expect(m.failureRate).toBeLessThan(0.2);
		expect(m.prematureTerminationRate).toBeLessThan(0.15);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// REGRESSION: onIterationEnd восстанавливает отсутствующий финальный '\n'
// Баг: если файл на диске не заканчивается '\n' (прерванная запись при crash,
// внешняя правка), новая запись склеивалась с последней строкой — обе записи
// терялись при агрегации (getMetrics пропускал невалидную строку).
// ────────────────────────────────────────────────────────────────────────────

describe("F-21 / REGRESSION: восстановление отсутствующего финального '\\n'", () => {
	let missionDir;

	beforeEach(() => {
		missionDir = freshMissionDir("fan-f21-reg-nonl-");
	});

	afterEach(() => {
		rmSync(missionDir, { recursive: true, force: true });
	});

	it("файл без финального '\\n' → onIterationEnd → все 3 записи читаются отдельно (валидный JSONL)", async () => {
		// Сидируем 2 записи, последняя БЕЗ trailing '\n' (эмуляция crash).
		const rec1 = JSON.stringify({
			iteration: 1, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});
		const rec2 = JSON.stringify({
			iteration: 2, timestamp: "2026-08-13T10:00:00.000Z",
			tokensIn: 200, tokensOut: 100, durationMs: 2000, status: "completed",
		});
		// rec1 + '\n' + rec2 (БЕЗ финального '\n').
		writeFileSync(metricsPath(missionDir), `${rec1}\n${rec2}`, "utf8");

		// onIterationEnd должен обнаружить отсутствие '\n' и дописать его перед rec3.
		const collector = createMetricsCollector({ now: makeMockClock("2026-08-13T12:00:00.000Z") });
		await collector.onIterationEnd(missionDir, {
			iteration: 3, tokensIn: 300, tokensOut: 150, durationMs: 3000, status: "failed",
		});

		// Все 3 записи читаются отдельно.
		const records = readRecords(missionDir);
		expect(records.length).toBe(3);
		expect(records[0].iteration).toBe(1);
		expect(records[1].iteration).toBe(2);
		expect(records[2].iteration).toBe(3);

		// getMetrics агрегирует все 3 записи.
		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(3);
		expect(m.totalTokensIn).toBe(600);
		expect(m.failureRate).toBeCloseTo(1 / 3, 3);
	});

	it("пустой файл (0 байт) → append без лишнего '\\n' в начале", async () => {
		// Создаём пустой файл (0 байт).
		writeFileSync(metricsPath(missionDir), "", "utf8");

		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});

		const raw = readFileSync(metricsPath(missionDir), "utf8");
		// Файл НЕ должен начинаться с '\n' — это создало бы пустую первую строку.
		expect(raw.startsWith("\n")).toBe(false);
		// Файл = ровно одна JSON-строка + '\n'.
		expect(raw.endsWith("\n")).toBe(true);

		const records = readRecords(missionDir);
		expect(records.length).toBe(1);
		expect(records[0].iteration).toBe(1);

		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(1);
	});

	it("файл с финальным '\\n' → поведение без изменений (нет лишней пустой строки)", async () => {
		// Нормальное состояние: файл заканчивается '\n'.
		const collector = createMetricsCollector({ now: makeMockClock() });
		await collector.onIterationEnd(missionDir, {
			iteration: 1, tokensIn: 100, tokensOut: 50, durationMs: 1000, status: "completed",
		});
		await collector.onIterationEnd(missionDir, {
			iteration: 2, tokensIn: 200, tokensOut: 100, durationMs: 2000, status: "completed",
		});

		const raw = readFileSync(metricsPath(missionDir), "utf8");
		// Нет двойного '\n\n' между записями (нет лишней пустой строки).
		expect(raw.includes("\n\n")).toBe(false);
		// Файл заканчивается ровно одним '\n'.
		expect(raw.endsWith("\n")).toBe(true);

		const records = readRecords(missionDir);
		expect(records.length).toBe(2);
		expect(records[0].iteration).toBe(1);
		expect(records[1].iteration).toBe(2);

		const m = await collector.getMetrics(missionDir);
		expect(m.totalIterations).toBe(2);
	});
});
