/**
 * TDD RED tests for F-9 «Finding structure schema (Severity/File:Line/Category/Problem/Suggestion)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-9» (TC-F-9-1, TC-F-9-2, TC-F-9-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (формат строки finding — вывод воркера
 * code-review в F-8 review workflow; схему переиспользуют F-8 (парсинг отчёта в Finding[])
 * и F-11 (security-handoff tagging по полям finding)).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/findings.js с экспортом parseFinding, parseFindings.
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо): в extension вспомогательные модули лежат ПЛОСКО
 *   в корне extensions/fan-orchestrator/ — agents.js, context-builder.js, pipeline-state.js,
 *   permissions.js, task-complexity.js, stack-detection.js (F-3), conventions.js (F-5) и т.д.
 *   Подкаталог agents/ — только для определений воркеров. parseFinding — чистый парсер данных
 *   (переиспользуется F-8 review workflow и F-11 security-теги), roadmap-карточка явно называет
 *   «findings.js экспортирует parseFinding, parseFindings, Finding type» — значит,
 *   корень extension: findings.js.
 *
 *   Формат строки finding (вывод воркера, roadmap TC-F-9-1):
 *     "- Severity: <S> | File:Line: <path>:<line> | Category: <c> | Problem: <p> | Suggestion: <s>"
 *
 *   Контракт parseFinding(line) → Finding:
 *     - severity: "CRITICAL" | "MAJOR" | "MINOR" | "INFO" — enum 4 значений (переиспользует
 *       enum из F-10 severityToVerdict); невалидное значение → throw, сообщение содержит «severity»
 *     - file: string  — путь без строки («src/auth.ts» из «src/auth.ts:42»)
 *     - line: number  — ЧИСЛО (не строка) — typeof line === "number"
 *     - category: string — опциональное поле (category? в сигнатуре)
 *     - problem: string, suggestion: string
 *
 *   Контракт parseFindings(output) → Finding[]:
 *     - вход — многострочный markdown-вывод воркера
 *     - парсит строки формата выше, пустые строки фильтрует (критерий приёмки №3 карточки)
 *     - порядок сохраняется: output-порядок строк == порядок в массиве
 *
 *   (Refactor-цель карточки: единый regex с named groups
 *   /^- Severity:\s*(?<sev>CRITICAL|MAJOR|MINOR|INFO)\s*\|\s*File:Line:\s*(?<file>[^:]+):(?<line>\d+)...$/i
 *   и вынос Severity enum в shared — Green волен это сделать, тесты фиксируют только контракт.)
 *
 * TC-F-9-1: строка «- Severity: CRITICAL | File:Line: src/auth.ts:42 | Category: validation |
 *           Problem: missing input check | Suggestion: add null guard» → parseFinding даёт
 *           {severity: "CRITICAL", file: "src/auth.ts", line: 42 (number), category: "validation",
 *           problem: "missing input check", suggestion: "add null guard"} — все 5 полей распарсены.
 * TC-F-9-2: severity HIGH (вне enum) → parseFinding бросает, сообщение содержит «severity»
 *           (+ список допустимых значений CRITICAL|MAJOR|MINOR|INFO — «Ожидаемый результат» карточки).
 * TC-F-9-3: 3 строки findings (CRITICAL, MAJOR, MINOR), разделённые пустыми строками →
 *           parseFindings даёт length === 3, severity по порядку [CRITICAL, MAJOR, MINOR],
 *           все line — number (пустые строки отфильтрованы).
 *
 * Red-ожидание (roadmap + constraint задачи): ВСЕ 3 теста падают одинаково —
 * «Cannot find module ../findings.js» (статический import сверху файла): parseFinding/
 * parseFindings ещё не написаны, и это ЕДИНСТВЕННО допустимая причина падения. Модуль
 * НЕ создаётся в RED-фазе. Green-фаза создаёт модуль ровно по зафиксированному пути —
 * тесты зеленеют без правок (Red-тест карточки: TC-F-9-1 падает первым — на act).
 */
import { describe, expect, it } from "vitest";
import { parseFinding, parseFindings } from "../findings.js";

/** Эталонная строка TC-F-9-1 (roadmap: «строка в формате вывода воркера»). */
const CRITICAL_LINE =
    "- Severity: CRITICAL | File:Line: src/auth.ts:42 | Category: validation | Problem: missing input check | Suggestion: add null guard";

/** MAJOR-строка для TC-F-9-3 (тот же формат, другой стек/категория). */
const MAJOR_LINE =
    "- Severity: MAJOR | File:Line: src/api/client.ts:17 | Category: error-handling | Problem: unhandled promise rejection | Suggestion: add try/catch around fetch call";

/** MINOR-строка для TC-F-9-3. */
const MINOR_LINE =
    "- Severity: MINOR | File:Line: src/utils/format.ts:8 | Category: naming | Problem: unclear variable name | Suggestion: rename tmp to formattedDate";

describe("F-9: Finding structure schema (parseFinding/parseFindings, findings.js)", () => {
    describe("TC-F-9-1: parseFinding парсит строку формата Severity | File:Line | Category | Problem | Suggestion", () => {
        it("все 5 полей распарсены: severity enum, file, line — number, category, problem, suggestion", () => {
            const result = parseFinding(CRITICAL_LINE);

            expect(
                result.severity,
                "severity должен распарситься в enum-значение CRITICAL (roadmap F-9, TC-F-9-1)",
            ).toBe("CRITICAL");
            expect(
                result.file,
                "file должен быть путём БЕЗ номера строки — «src/auth.ts», а не «src/auth.ts:42» (roadmap F-9, TC-F-9-1)",
            ).toBe("src/auth.ts");
            expect(
                result.line,
                "line должен быть ЧИСЛОМ 42, а не строкой «42» — typeof line === 'number' (roadmap F-9, TC-F-9-1; база для F-11 file:line handoff)",
            ).toBe(42);
            expect(typeof result.line, "line — примитив number, не строка").toBe("number");
            expect(
                result.category,
                "category должен распарситься из 3-й секции строки (roadmap F-9, TC-F-9-1)",
            ).toBe("validation");
            expect(
                result.problem,
                "problem должен распарситься из 4-й секции строки (roadmap F-9, TC-F-9-1)",
            ).toBe("missing input check");
            expect(
                result.suggestion,
                "suggestion должен распарситься из 5-й секции строки (roadmap F-9, TC-F-9-1)",
            ).toBe("add null guard");
        });
    });

    describe("TC-F-9-2: parseFinding бросает ошибку на невалидном severity (HIGH вне enum)", () => {
        it("severity HIGH → throw, сообщение называет severity", () => {
            const invalidLine =
                "- Severity: HIGH | File:Line: src/x.ts:1 | Category: x | Problem: x | Suggestion: x";

            expect(
                () => parseFinding(invalidLine),
                "невалидный severity (HIGH не входит в CRITICAL|MAJOR|MINOR|INFO) должен бросать ошибку (roadmap F-9, TC-F-9-2)",
            ).toThrow(/severity/i);
        });
    });

    describe("Regression: parseFinding парсит двоеточия внутри пути (F-9 bugfix)", () => {
        it("Windows-путь «C:\\path\\file.ts:42» → file='C:\\path\\file.ts', line=42", () => {
            const result = parseFinding(
                "- Severity: CRITICAL | File:Line: C:\\path\\file.ts:42 | Category: validation | Problem: missing input check | Suggestion: add null guard",
            );

            expect(result.file, "Windows-путь с двоеточием диска должен распарситься целиком").toBe(
                "C:\\path\\file.ts",
            );
            expect(result.line, "последний ':<digits>' в пути — это line").toBe(42);
            expect(result.severity).toBe("CRITICAL");
            expect(result.category).toBe("validation");
            expect(result.problem).toBe("missing input check");
            expect(result.suggestion).toBe("add null guard");
        });

        it("двоеточие в имени файла «src/foo:bar.ts:5» → file='src/foo:bar.ts', line=5", () => {
            const result = parseFinding(
                "- Severity: MAJOR | File:Line: src/foo:bar.ts:5 | Problem: unhandled rejection | Suggestion: add try/catch",
            );

            expect(result.file, "двоеточие внутри имени файла не должно ломать парсинг").toBe(
                "src/foo:bar.ts",
            );
            expect(result.line).toBe(5);
            expect(result.category, "строка без секции Category: — category undefined").toBeUndefined();
        });
    });

    describe("TC-F-9-3: parseFindings агрегирует многострочный вывод воркера в Finding[]", () => {
        it("3 findings (CRITICAL, MAJOR, MINOR) по порядку, пустые строки отфильтрованы, все line — number", () => {
            // Многострочный markdown-вывод воркера: findings, разделённые пустыми строками
            // (критерий приёмки №3 карточки: «агрегирует массив, фильтрует пустые строки»).
            const output = [CRITICAL_LINE, "", MAJOR_LINE, "", MINOR_LINE, ""].join("\n");

            const result = parseFindings(output);

            expect(
                result,
                "3 строки findings + 3 пустые → массив длиной ровно 3: пустые строки отфильтрованы (roadmap F-9, TC-F-9-3)",
            ).toHaveLength(3);
            expect(
                result[0].severity,
                "result[0].severity === CRITICAL — порядок строк сохраняется (roadmap F-9, TC-F-9-3)",
            ).toBe("CRITICAL");
            expect(
                result[1].severity,
                "result[1].severity === MAJOR — порядок строк сохраняется (roadmap F-9, TC-F-9-3)",
            ).toBe("MAJOR");
            expect(
                result[2].severity,
                "result[2].severity === MINOR — порядок строк сохраняется (roadmap F-9, TC-F-9-3)",
            ).toBe("MINOR");
            expect(
                result.every((f) => typeof f.line === "number"),
                "все findings должны иметь line как number — regex-группа (?<line>\\d+) парсится в число (roadmap F-9, TC-F-9-3)",
            ).toBe(true);
        });
    });
});
