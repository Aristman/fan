// F-28: Протокол «отчёт узла» (L1 → L0) — RED-фаза TDD.
//
// Модуль ../node-report.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.3
//
// Контракт модуля:
//   interface NodeUsage {
//       inputTokens: number; outputTokens: number; costUsd: number;
//       turns?: number; durationMs?: number;
//   }
//   interface NodeResult {
//       text: string;
//       filesModified?: string[]; filesCreated?: string[]; commitsMade?: string[];
//   }
//   interface NodeReport {
//       nodeId: string; correlationId: string;
//       status: "completed" | "failed" | "aborted" | "timeout" | "unknown";
//       verdict: "PASS" | "FAIL" | "PARTIAL" | null;
//       result: NodeResult; usage: NodeUsage;
//       children?: NodeReport[];              // рекурсивно
//       completionReason?: "task_completed" | "budget_exhausted"
//                        | "deadline_reached" | "aborted";
//       interrupted?: boolean;                // true при crash
//   }
//   interface ParseCallbacks { onUnknownReport?: (raw: string) => void }
//
//   parseNodeReport(assistantText, meta: {nodeId, correlationId, usage?}, callbacks?)
//     - есть VERDICT → status "completed", verdict = PASS|FAIL|PARTIAL
//       (verdict FAIL — это ОЦЕНКА результата, отчёт доставлен → status остаётся
//       "completed"; status "failed" — только при ошибке выполнения)
//     - нет VERDICT → status "unknown", verdict null,
//       callbacks.onUnknownReport(assistantText) вызван с raw-текстом
//     - result.text = assistantText (raw), usage из meta (дефолты 0)
//
//   parseVerdict(text): "PASS" | "FAIL" | "PARTIAL" | null
//     - маркер "VERDICT: X" в любой строке, регистронезависимо,
//       допустимо "VERDICT:PASS" (без пробела)
//     - несколько маркеров → последний
//
//   totalUsage(report): NodeUsage
//     - рекурсивно: свой usage + Σ children (включая детей детей);
//       inputTokens/outputTokens/costUsd суммируются
//
//   makeTimeoutReport(meta: {nodeId, correlationId}, usage?)
//     - status "timeout", interrupted: true, verdict null
//
//   makeAbortedReport(meta, usage?)
//     - status "aborted", completionReason "aborted"
//
// Покрытие (TC-карточки roadmap):
//   TC-F28-1  "VERDICT: PASS" + текст → completed/PASS, result.text, usage из meta
//   TC-F28-2  без маркера → unknown/null + onUnknownReport(raw)
//   TC-F28-3  totalUsage: children + вложенность 2 уровня (рекурсивно)
//   Доп.      parseVerdict (FAIL, регистр, без пробела, последний из нескольких,
//             маркер в середине текста, нет маркера → null),
//             VERDICT: FAIL → status "completed" (отчёт доставлен),
//             usage-дефолты нули, children undefined → свой usage,
//             makeTimeoutReport, makeAbortedReport

import { beforeAll, describe, expect, it } from "vitest";

let parseNodeReport;
let parseVerdict;
let totalUsage;
let makeTimeoutReport;
let makeAbortedReport;

beforeAll(async () => {
	const mod = await import("../node-report.js");
	parseNodeReport = mod.parseNodeReport;
	parseVerdict = mod.parseVerdict;
	totalUsage = mod.totalUsage;
	makeTimeoutReport = mod.makeTimeoutReport;
	makeAbortedReport = mod.makeAbortedReport;
});

const META = { nodeId: "node-1", correlationId: "mission-7f3a/L1/node-1" };

// ─── TC-F28-1: VERDICT: PASS + текст результата ─────────────────────────────

describe("TC-F28-1: assistant message с 'VERDICT: PASS' → completed/PASS", () => {
	const assistantText = [
		"Исследование завершено.",
		"Найдено 3 конкурента, собраны данные по ценам.",
		"",
		"VERDICT: PASS",
	].join("\n");

	it("status === 'completed'", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.status).toBe("completed");
	});

	it("verdict === 'PASS'", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.verdict).toBe("PASS");
	});

	it("result.text содержит текст результата (raw)", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.result.text).toBe(assistantText);
		expect(report.result.text).toContain("Исследование завершено.");
		expect(report.result.text).toContain("Найдено 3 конкурента");
	});

	it("usage берётся из meta (inputTokens/outputTokens/costUsd)", () => {
		const report = parseNodeReport(assistantText, {
			...META,
			usage: { inputTokens: 12_345, outputTokens: 6_789, costUsd: 0.42 },
		});
		expect(report.usage.inputTokens).toBe(12_345);
		expect(report.usage.outputTokens).toBe(6_789);
		expect(report.usage.costUsd).toBe(0.42);
	});

	it("nodeId и correlationId из meta", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.nodeId).toBe("node-1");
		expect(report.correlationId).toBe("mission-7f3a/L1/node-1");
	});

	it("onUnknownReport НЕ вызывается при наличии VERDICT", () => {
		const unknownCalls = [];
		parseNodeReport(assistantText, META, { onUnknownReport: (raw) => unknownCalls.push(raw) });
		expect(unknownCalls).toEqual([]);
	});
});

// ─── TC-F28-2: финальное сообщение БЕЗ маркера VERDICT ──────────────────────

describe("TC-F28-2: без маркера VERDICT → unknown/null + onUnknownReport", () => {
	const assistantText = "Я что-то сделал, но забыл отчитаться по протоколу.";

	it("status === 'unknown'", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.status).toBe("unknown");
	});

	it("verdict === null", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.verdict).toBeNull();
	});

	it("result.text = raw-текст сообщения", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.result.text).toBe(assistantText);
	});

	it("onUnknownReport вызван с raw-текстом", () => {
		const unknownCalls = [];
		parseNodeReport(assistantText, META, { onUnknownReport: (raw) => unknownCalls.push(raw) });
		expect(unknownCalls).toEqual([assistantText]);
	});

	it("onUnknownReport вызван ровно один раз", () => {
		let calls = 0;
		parseNodeReport(assistantText, META, { onUnknownReport: () => { calls += 1; } });
		expect(calls).toBe(1);
	});

	it("без callbacks — не бросает", () => {
		expect(() => parseNodeReport(assistantText, META)).not.toThrow();
	});

	it("пустое сообщение → unknown, onUnknownReport с пустой строкой", () => {
		const unknownCalls = [];
		const report = parseNodeReport("", META, { onUnknownReport: (raw) => unknownCalls.push(raw) });
		expect(report.status).toBe("unknown");
		expect(report.verdict).toBeNull();
		expect(unknownCalls).toEqual([""]);
	});
});

// ─── TC-F28-3: totalUsage — рекурсивная агрегация ───────────────────────────

describe("TC-F28-3: totalUsage — свой usage + Σ children (рекурсивно)", () => {
	it("свой {costUsd: 0.45} + child {costUsd: 0.12} → 0.57", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "completed",
			verdict: "PASS",
			result: { text: "ok" },
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.45 },
			children: [
				{
					nodeId: "node-2",
					correlationId: "m/L2/node-2",
					status: "completed",
					verdict: "PASS",
					result: { text: "child ok" },
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.12 },
				},
			],
		};
		expect(totalUsage(report).costUsd).toBeCloseTo(0.57, 10);
	});

	it("вложенность 2 уровня: дети детей учитываются", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "completed",
			verdict: "PASS",
			result: { text: "root" },
			usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.10 },
			children: [
				{
					nodeId: "node-2",
					correlationId: "m/L2/node-2",
					status: "completed",
					verdict: "PASS",
					result: { text: "child" },
					usage: { inputTokens: 200, outputTokens: 20, costUsd: 0.20 },
					children: [
						{
							nodeId: "node-3",
							correlationId: "m/L3/node-3",
							status: "completed",
							verdict: "PASS",
							result: { text: "grandchild" },
							usage: { inputTokens: 300, outputTokens: 30, costUsd: 0.30 },
						},
					],
				},
			],
		};
		const total = totalUsage(report);
		expect(total.inputTokens).toBe(600);
		expect(total.outputTokens).toBe(60);
		expect(total.costUsd).toBeCloseTo(0.6, 10);
	});

	it("несколько children на одном уровне суммируются", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "completed",
			verdict: "PARTIAL",
			result: { text: "root" },
			usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
			children: [
				{
					nodeId: "node-2",
					correlationId: "m/L2/node-2",
					status: "completed",
					verdict: "PASS",
					result: { text: "a" },
					usage: { inputTokens: 20, outputTokens: 2, costUsd: 0.02 },
				},
				{
					nodeId: "node-3",
					correlationId: "m/L2/node-3",
					status: "failed",
					verdict: null,
					result: { text: "b" },
					usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.04 },
				},
			],
		};
		const total = totalUsage(report);
		expect(total.inputTokens).toBe(70);
		expect(total.outputTokens).toBe(7);
		expect(total.costUsd).toBeCloseTo(0.07, 10);
	});
});

// ─── parseVerdict ───────────────────────────────────────────────────────────

describe("parseVerdict: маркер 'VERDICT: X' в любой строке", () => {
	it("'VERDICT: PASS' → 'PASS'", () => {
		expect(parseVerdict("Готово.\nVERDICT: PASS")).toBe("PASS");
	});

	it("'VERDICT: FAIL' → 'FAIL'", () => {
		expect(parseVerdict("VERDICT: FAIL")).toBe("FAIL");
	});

	it("'verdict: partial' (нижний регистр) → 'PARTIAL'", () => {
		expect(parseVerdict("verdict: partial")).toBe("PARTIAL");
	});

	it("'Verdict: Pass' (смешанный регистр) → 'PASS'", () => {
		expect(parseVerdict("Verdict: Pass")).toBe("PASS");
	});

	it("'VERDICT:PASS' (без пробела) → 'PASS'", () => {
		expect(parseVerdict("VERDICT:PASS")).toBe("PASS");
	});

	it("несколько маркеров → последний", () => {
		const text = "VERDICT: FAIL\n...\nVERDICT: PASS";
		expect(parseVerdict(text)).toBe("PASS");
	});

	it("несколько маркеров (PARTIAL последний) → 'PARTIAL'", () => {
		const text = "VERDICT: PASS\nпромежуточный текст\nVERDICT: PARTIAL";
		expect(parseVerdict(text)).toBe("PARTIAL");
	});

	it("нет маркера → null", () => {
		expect(parseVerdict("Обычный текст без маркера")).toBeNull();
	});

	it("пустая строка → null", () => {
		expect(parseVerdict("")).toBeNull();
	});

	it("маркер в середине текста (не последняя строка) → распознаётся", () => {
		const text = "Шапка отчёта.\nVERDICT: FAIL\nПослесловие с деталями провала.";
		expect(parseVerdict(text)).toBe("FAIL");
	});

	it("маркер с отступом в начале строки → распознаётся", () => {
		expect(parseVerdict("  VERDICT: PARTIAL")).toBe("PARTIAL");
	});

	it("слово 'verdict' без двоеточия → null", () => {
		expect(parseVerdict("my verdict is PASS")).toBeNull();
	});

	it("неизвестное значение маркера → null", () => {
		expect(parseVerdict("VERDICT: MAYBE")).toBeNull();
	});
});

// ─── parseNodeReport: VERDICT: FAIL → status 'completed' ────────────────────

describe("parseNodeReport: VERDICT: FAIL — отчёт доставлен, status остаётся 'completed'", () => {
	const assistantText = "Проверка не пройдена: 2 теста красные.\nVERDICT: FAIL";

	it("status === 'completed' (verdict FAIL — оценка результата, не ошибка выполнения)", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.status).toBe("completed");
	});

	it("verdict === 'FAIL'", () => {
		const report = parseNodeReport(assistantText, META);
		expect(report.verdict).toBe("FAIL");
	});

	it("VERDICT: PARTIAL → completed/PARTIAL", () => {
		const report = parseNodeReport("Сделано частично.\nVERDICT: PARTIAL", META);
		expect(report.status).toBe("completed");
		expect(report.verdict).toBe("PARTIAL");
	});
});

// ─── parseNodeReport: usage-дефолты ─────────────────────────────────────────

describe("parseNodeReport: usage-дефолты", () => {
	it("meta без usage → нули", () => {
		const report = parseNodeReport("VERDICT: PASS", META);
		expect(report.usage.inputTokens).toBe(0);
		expect(report.usage.outputTokens).toBe(0);
		expect(report.usage.costUsd).toBe(0);
	});

	it("частичный usage: незаданные поля → нули", () => {
		const report = parseNodeReport("VERDICT: PASS", { ...META, usage: { costUsd: 0.5 } });
		expect(report.usage.costUsd).toBe(0.5);
		expect(report.usage.inputTokens).toBe(0);
		expect(report.usage.outputTokens).toBe(0);
	});
});

// ─── totalUsage: граничные случаи ───────────────────────────────────────────

describe("totalUsage: граничные случаи", () => {
	it("children undefined → totalUsage = свой usage", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "completed",
			verdict: "PASS",
			result: { text: "ok" },
			usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.33 },
		};
		const total = totalUsage(report);
		expect(total.inputTokens).toBe(1000);
		expect(total.outputTokens).toBe(500);
		expect(total.costUsd).toBeCloseTo(0.33, 10);
	});

	it("children = [] → totalUsage = свой usage", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "completed",
			verdict: "PASS",
			result: { text: "ok" },
			usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
			children: [],
		};
		const total = totalUsage(report);
		expect(total.inputTokens).toBe(10);
		expect(total.outputTokens).toBe(5);
		expect(total.costUsd).toBeCloseTo(0.01, 10);
	});

	it("нулевой usage везде → нули", () => {
		const report = {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			status: "unknown",
			verdict: null,
			result: { text: "" },
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			children: [
				{
					nodeId: "node-2",
					correlationId: "m/L2/node-2",
					status: "unknown",
					verdict: null,
					result: { text: "" },
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
				},
			],
		};
		expect(totalUsage(report)).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
	});
});

// ─── makeTimeoutReport ──────────────────────────────────────────────────────

describe("makeTimeoutReport: узел убит по deadline", () => {
	it("status === 'timeout'", () => {
		const report = makeTimeoutReport(META);
		expect(report.status).toBe("timeout");
	});

	it("interrupted === true (отличие от штатного завершения)", () => {
		const report = makeTimeoutReport(META);
		expect(report.interrupted).toBe(true);
	});

	it("verdict === null", () => {
		const report = makeTimeoutReport(META);
		expect(report.verdict).toBeNull();
	});

	it("nodeId/correlationId из meta", () => {
		const report = makeTimeoutReport(META);
		expect(report.nodeId).toBe("node-1");
		expect(report.correlationId).toBe("mission-7f3a/L1/node-1");
	});

	it("без usage → нули", () => {
		const report = makeTimeoutReport(META);
		expect(report.usage.inputTokens).toBe(0);
		expect(report.usage.outputTokens).toBe(0);
		expect(report.usage.costUsd).toBe(0);
	});

	it("usage из аргумента сохраняется (потрачено до таймаута)", () => {
		const report = makeTimeoutReport(META, { inputTokens: 8000, outputTokens: 100, costUsd: 0.07 });
		expect(report.usage.inputTokens).toBe(8000);
		expect(report.usage.outputTokens).toBe(100);
		expect(report.usage.costUsd).toBe(0.07);
	});

	it("completionReason — 'deadline_reached' (по спеке §3.3.3)", () => {
		const report = makeTimeoutReport(META);
		expect(report.completionReason).toBe("deadline_reached");
	});
});

// ─── makeAbortedReport ──────────────────────────────────────────────────────

describe("makeAbortedReport: узел остановлен координатором", () => {
	it("status === 'aborted'", () => {
		const report = makeAbortedReport(META);
		expect(report.status).toBe("aborted");
	});

	it("completionReason === 'aborted'", () => {
		const report = makeAbortedReport(META);
		expect(report.completionReason).toBe("aborted");
	});

	it("verdict === null", () => {
		const report = makeAbortedReport(META);
		expect(report.verdict).toBeNull();
	});

	it("nodeId/correlationId из meta", () => {
		const report = makeAbortedReport(META);
		expect(report.nodeId).toBe("node-1");
		expect(report.correlationId).toBe("mission-7f3a/L1/node-1");
	});

	it("без usage → нули", () => {
		const report = makeAbortedReport(META);
		expect(report.usage.inputTokens).toBe(0);
		expect(report.usage.outputTokens).toBe(0);
		expect(report.usage.costUsd).toBe(0);
	});

	it("usage из аргумента сохраняется", () => {
		const report = makeAbortedReport(META, { inputTokens: 500, costUsd: 0.01 });
		expect(report.usage.inputTokens).toBe(500);
		expect(report.usage.costUsd).toBe(0.01);
	});
});

// ─── Интеграционный сценарий протокола L1 → L0 ──────────────────────────────

describe("протокол L1 → L0 end-to-end (без процессов)", () => {
	it("L1 вернул отчёт с VERDICT → L0 парсит → агрегирует totalUsage с дочерним отчётом L2", () => {
		// Отчёт дочернего узла L2 (уже распарсен ранее)
		const childReport = parseNodeReport("Подзадача решена.\nVERDICT: PASS", {
			nodeId: "node-2",
			correlationId: "mission-7f3a/L2/node-2",
			usage: { inputTokens: 5000, outputTokens: 1000, costUsd: 0.12 },
		});
		expect(childReport.status).toBe("completed");
		expect(childReport.verdict).toBe("PASS");

		// Отчёт узла L1 со вложенным дочерним отчётом
		const parentReport = parseNodeReport(
			"Собрал результаты дочерних узлов.\nVERDICT: PASS",
			{
				nodeId: "node-1",
				correlationId: "mission-7f3a/L1/node-1",
				usage: { inputTokens: 20_000, outputTokens: 3000, costUsd: 0.45 },
			},
		);
		parentReport.children = [childReport];

		// L0 агрегирует usage по всему дереву
		const total = totalUsage(parentReport);
		expect(total.inputTokens).toBe(25_000);
		expect(total.outputTokens).toBe(4000);
		expect(total.costUsd).toBeCloseTo(0.57, 10);
	});

	it("узел убит по таймауту → L0 получает timeout-отчёт, сумма не теряется", () => {
		const ok = parseNodeReport("VERDICT: PASS", {
			nodeId: "node-1",
			correlationId: "m/L1/node-1",
			usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
		});
		const timedOut = makeTimeoutReport(
			{ nodeId: "node-2", correlationId: "m/L1/node-2" },
			{ inputTokens: 200, outputTokens: 20, costUsd: 0.2 },
		);
		ok.children = [timedOut];
		const total = totalUsage(ok);
		expect(total.inputTokens).toBe(300);
		expect(total.costUsd).toBeCloseTo(0.3, 10);
		expect(timedOut.interrupted).toBe(true);
	});
});
