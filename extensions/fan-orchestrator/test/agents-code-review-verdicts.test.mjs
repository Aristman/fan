/**
 * TDD RED tests for F-10 «Verdict parser extension (6 значений + severity-маппинг)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-10» (TC-F-10-1, TC-F-10-2, TC-F-10-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md → «parseVerdict (D4)» + решение
 * D4 «Вердикты: 6 значений с явным маппингом severity».
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *
 *   1. parseVerdict(text) в agents.js — regex расширен с 3 до 6 значений:
 *        /VERDICT:\s*(PASS|FAIL|PARTIAL|APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION)\b/i
 *      case-insensitive, whitespace-устойчивость (\s*), null/пустой вход → null
 *      (эталон спеки D4: `if (!text) return null;` — БЕЗ TypeError).
 *
 *   2. НОВАЯ функция severityToVerdict(findings) в agents.js. Вход — Finding[]
 *      (формат F-9: {severity, file, line, ...}, severity ∈ CRITICAL|MAJOR|MINOR|INFO).
 *      Маппинг (D4):
 *        - есть CRITICAL или MAJOR            → "CHANGES_REQUESTED"
 *        - только MINOR/INFO                  → "APPROVED"
 *        - MAJOR-находка с пометкой «unclear» → "NEEDS_DISCUSSION"
 *      Пометка unclear: поле `metadata: { unclear: true }` у finding
 *      (roadmap TC-F-10-1: «[MAJOR] с пометкой "unclear" в metadata»).
 *
 *   3. agents.d.ts — union-тип Verdict из 6 значений (перегенерация tsc,
 *      без рассинхрона с .js):
 *        type Verdict = "PASS" | "FAIL" | "PARTIAL" | "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION"
 *
 * TC-F-10-1: parseVerdict 8 кейсов → [PASS, FAIL, PARTIAL, APPROVED, CHANGES_REQUESTED,
 *           NEEDS_DISCUSSION, APPROVED, null]; severityToVerdict 4 кейса →
 *           [CHANGES_REQUESTED, CHANGES_REQUESTED, APPROVED, NEEDS_DISCUSSION].
 * TC-F-10-2: regex /Verdict.*=.*"PASS"..."NEEDS_DISCUSSION"/s находит union в agents.d.ts.
 * TC-F-10-3: 4 невалидных входа → null без бросков; diagnostic ОПЦИОНАЛЕН
 *           (roadmap: «в логе или возвращённом объекте (если {value, diagnostic})» —
 *           если реализация логирует/возвращает diagnostic, проверяем содержимое).
 *
 * Импорт-стратегия (constraint задачи):
 *   - parseVerdict — статический import: экспорт существует, модуль линкуется.
 *   - severityToVerdict — динамический import + проверка наличия экспорта:
 *     статический import несуществующего имени уронил бы ВЕСЬ файл на линковке
 *     (SyntaxError: does not provide an export named ...), и parseVerdict-тесты
 *     не выполнились бы вовсе. Динамический import даёт читаемое RED-падение:
 *     «expected 'undefined' to be 'function'».
 *
 * Red-ожидание (roadmap + constraint задачи):
 *   - TC-F-10-1 падает: текущий regex /VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i (agents.js:610)
 *     не знает APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION → null; parseVerdict(null)
 *     бросает TypeError (нет `if (!text)` guard); severityToVerdict не экспортирован.
 *   - TC-F-10-2 падает: в agents.d.ts нет union-типа Verdict (только inline return-type
 *     из 3 значений у parseVerdict, agents.d.ts:31).
 *   - TC-F-10-3 зелёный сразу: текущий parseVerdict уже возвращает null на всех
 *     4 невалидных входах и не бросает — это ОЖИДАЕМО и допустимо (constraint задачи).
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVerdict } from "../agents.js";

/** 8 кейсов parseVerdict (roadmap TC-F-10-1; порядок == порядок карточки). */
const PARSE_CASES = [
    { label: "PASS (verify-воркер)", input: "VERDICT: PASS\n", expected: "PASS" },
    { label: "FAIL (verify-воркер)", input: "VERDICT: FAIL\n", expected: "FAIL" },
    { label: "PARTIAL (verify-воркер)", input: "VERDICT: PARTIAL\n", expected: "PARTIAL" },
    { label: "APPROVED (code-review)", input: "VERDICT: APPROVED\n", expected: "APPROVED" },
    { label: "CHANGES_REQUESTED (code-review)", input: "VERDICT: CHANGES_REQUESTED\n", expected: "CHANGES_REQUESTED" },
    { label: "NEEDS_DISCUSSION (code-review)", input: "VERDICT: NEEDS_DISCUSSION\n", expected: "NEEDS_DISCUSSION" },
    { label: "case-insensitive", input: "verdict: approved\n", expected: "APPROVED" },
    { label: "null-вход (спека D4: if (!text) return null)", input: null, expected: null },
];

/**
 * 4 кейса severityToVerdict (roadmap TC-F-10-1, решение D4 спеки).
 * findings — Finding[] в формате F-9; unclear-пометка — metadata.unclear.
 */
const SEVERITY_CASES = [
    {
        label: "[CRITICAL]",
        findings: [{ severity: "CRITICAL", file: "src/auth.ts", line: 42 }],
        expected: "CHANGES_REQUESTED",
    },
    {
        label: "[MAJOR, MINOR]",
        findings: [{ severity: "MAJOR", file: "src/a.ts", line: 1 }, { severity: "MINOR", file: "src/b.ts", line: 2 }],
        expected: "CHANGES_REQUESTED",
    },
    {
        label: "[MINOR, INFO]",
        findings: [{ severity: "MINOR", file: "src/c.ts", line: 3 }, { severity: "INFO", file: "src/d.ts", line: 4 }],
        expected: "APPROVED",
    },
    {
        label: "[MAJOR] с пометкой unclear в metadata",
        findings: [{ severity: "MAJOR", file: "src/e.ts", line: 5, metadata: { unclear: true } }],
        expected: "NEEDS_DISCUSSION",
    },
];

/** 4 невалидных входа (roadmap TC-F-10-3). */
const INVALID_CASES = [
    { label: "пустая строка", input: "" },
    { label: "VERDICT: без значения", input: "VERDICT:" },
    { label: "значение вне enum", input: "VERDICT: UNKNOWN_VALUE\n" },
    { label: "текст без VERDICT-строки", input: "Some random text without verdict line\n" },
];

/**
 * Динамический импорт severityToVerdict (см. «Импорт-стратегия» в шапке файла):
 * возвращает undefined вместо SyntaxError линковки, если экспорта ещё нет.
 */
async function importSeverityToVerdict() {
    const agentsModule = await import("../agents.js");
    return agentsModule.severityToVerdict;
}

/** Regex карточки TC-F-10-2: union Verdict из 6 значений в agents.d.ts. */
const VERDICT_UNION_RE =
    /Verdict.*=.*"PASS".*"FAIL".*"PARTIAL".*"APPROVED".*"CHANGES_REQUESTED".*"NEEDS_DISCUSSION"/s;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("F-10: Verdict parser extension (6 значений + severity-маппинг)", () => {
    describe("TC-F-10-1: parseVerdict распознаёт 6 значений + severityToVerdict маппинг", () => {
        it("parseVerdict: 8 кейсов (6 валидных + case-insensitive + null)", () => {
            for (const { label, input, expected } of PARSE_CASES) {
                // null-вход: контракт спеки D4 — `if (!text) return null`, без TypeError.
                let actual;
                expect(
                    () => {
                        actual = parseVerdict(input);
                    },
                    `parseVerdict(${JSON.stringify(input)}) [${label}] не должен бросать (спека D4: if (!text) return null)`,
                ).not.toThrow();
                expect(
                    actual,
                    `parseVerdict(${JSON.stringify(input)}) [${label}] должен вернуть «${expected}» (roadmap F-10, TC-F-10-1)`,
                ).toBe(expected);
            }
        });

        it("severityToVerdict: 4 кейса маппинга severity → verdict", async () => {
            const severityToVerdict = await importSeverityToVerdict();

            // Читаемое RED-падение: экспорта ещё нет → undefined, а не ошибка линковки модуля.
            expect(
                typeof severityToVerdict,
                "agents.js должен экспортировать severityToVerdict(findings) (roadmap F-10, TC-F-10-1)",
            ).toBe("function");

            for (const { label, findings, expected } of SEVERITY_CASES) {
                expect(
                    severityToVerdict(findings),
                    `severityToVerdict(${label}) должен вернуть «${expected}» (решение D4 спеки, roadmap F-10)`,
                ).toBe(expected);
            }
        });
    });

    describe("TC-F-10-2: agents.d.ts содержит union Verdict из 6 значений", () => {
        it("regex карточки находит Verdict = \"PASS\" | ... | \"NEEDS_DISCUSSION\" в agents.d.ts", () => {
            const dts = fs.readFileSync(new URL("../agents.d.ts", import.meta.url), "utf-8");
            const matched = VERDICT_UNION_RE.exec(dts);
            expect(
                matched,
                "agents.d.ts должен содержать union Verdict из 6 значений после регенерации tsc — без рассинхрона с agents.js (roadmap F-10, TC-F-10-2)",
            ).toBeTruthy();
        });
    });

    describe("TC-F-10-3: невалидные входы → null + diagnostic (без бросков)", () => {
        it("4 невалидных входа возвращают null, без unhandled exceptions", () => {
            // Roadmap допускает diagnostic «в логе или возвращённом объекте»:
            // перехватываем console-вывод; если реализация логирует diagnostic —
            // проверяем, что он называет причину. Текущая реализация (просто null)
            // тест проходит — это ожидаемо для RED-фазы (constraint задачи).
            const logs = [];
            for (const method of ["error", "warn", "log"]) {
                vi.spyOn(console, method).mockImplementation((...args) => logs.push(`[${method}] ${args.join(" ")}`));
            }

            for (const { label, input } of INVALID_CASES) {
                let result;
                expect(
                    () => {
                        result = parseVerdict(input);
                    },
                    `parseVerdict(${JSON.stringify(input)}) [${label}] не должен бросать (roadmap F-10, TC-F-10-3)`,
                ).not.toThrow();
                expect(
                    result,
                    `parseVerdict(${JSON.stringify(input)}) [${label}] невалидный вход → null (roadmap F-10, TC-F-10-3)`,
                ).toBe(null);
            }

            const diagnostic = logs.join("\n");
            if (diagnostic.trim()) {
                expect(
                    diagnostic,
                    "если реализация логирует diagnostic — он должен указывать причину: no VERDICT line / unknown verdict value / valid values (roadmap F-10, TC-F-10-3)",
                ).toMatch(/VERDICT|valid values|unknown verdict/i);
            }
        });
    });
});
