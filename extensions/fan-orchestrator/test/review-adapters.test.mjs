/**
 * TDD RED tests for F-15 «PlatformReviewAdapter contract (типы + документация)»
 * (feature-pipeline, code-review-worker — фаза RED, последняя функция P1).
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-15»
 * (TC-F-15-1, TC-F-15-2, TC-F-15-3; слой [INTEG], приоритет P1, deps = none).
 *
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза):
 *   Создать ДВА файла в extensions/fan-orchestrator/ (в Red НЕ создавать):
 *
 *   1) review-adapters.d.ts — TypeScript declaration file, 0 рантайма:
 *      8 экспортированных объявлений — типы ReviewSeverity, ReviewVerdict,
 *      PlatformRef (id: string & {} — extensibility с autocomplete для
 *      известных платформ), DiffRequest, DiffResult, ReviewComment,
 *      ReviewResolution + interface PlatformReviewAdapter
 *      { id, getDiff, postComments, resolvePr }.
 *
 *   2) review-adapters.md — документация с 3 секциями уровня «##»:
 *      «Semantics of errors» (network → retry, auth → явная ошибка,
 *      not found → 404), «Extension model» (новые extension регистрируют
 *      реализацию, orchestrator остаётся platform-agnostic + ЯВНОЕ ПРАВИЛО:
 *      «Unknown platform id must be explicitly handled by the implementation» —
 *      тип permissive, реализация строгая), «Precedent»
 *      (прецедент extensions/fan-confluence/client.ts).
 *
 * TC-F-15-1 «Структурная полнота контракта»: .d.ts содержит все 8 объявлений
 *   (≥ 1 совпадение каждого имени — итого 8) + .md покрывает 3 секции
 *   (^## …, ≥ 1 каждой, суммарно ≥ 3). Объединённые структурные проверки файлов.
 * TC-F-15-2 «tsc strict на контракте»: tmp-tsconfig {noEmit: true, strict: true},
 *   tsc -p → exit code 0, «error TS» в выводе нет (0 рантайма, чистые типы).
 * TC-F-15-3 «Extensibility + explicit handling»: tmp-fixture .ts
 *   (`const unknownPlatform: PlatformRef["id"] = "github-enterprise-self-hosted"`)
 *   компилируется tsc БЕЗ ошибок (тип принимает произвольный string через
 *   string & {} паттерн — autocomplete + extensibility), и .md содержит
 *   правило explicit handling.
 *
 * РЕШЕНИЕ ПО REGEX ОБЪЯВЛЕНИЙ (TC-F-15-1): kind объявления (type|interface)
 *   НЕ пинится — источники противоречивы: заголовок карточки «6 типов +
 *   1 interface + 1 re-export», regex-список карточки «2× export type +
 *   6× export interface», constraint задачи «7× export type + 1 interface».
 *   Пинится ТОЧНОЕ ИМЯ + факт экспорта: /export\s+(?:type|interface)\s+<Name>\b/
 *   × 8. Re-export из acceptance №1 механически НЕ пинится — это Refactor-цель
 *   карточки (общий review-types.d.ts, F-10). Секции .md — точный regex
 *   карточки /^##\s+(…)/gm БЕЗ $-якоря (прецедент TC-F-2-2: заголовки секций
 *   могут нести уточнения после имени).
 *
 * TSC (TC-F-15-2/3): компилятор резолвится детерминированно из монорепо
 *   (<root>/node_modules/typescript/bin/tsc; в окружении проверен TS 5.9.3),
 *   запуск через process.execPath — эквивалент «npx tsc --noEmit --strict»
 *   из карточки («или эквивалент»), но без npx-shell (Windows-совместимость,
 *   без зависимости от PATH). tsconfig — tmp, {"noEmit": true, "strict": true}
 *   (точно по карточке) + герметичный минимум: target/lib ES2022, module
 *   commonjs, types: [] (без авто-подхвата @types монорепо) — ошибки в самом
 *   контракте не маскируются (skipLibCheck НЕ включается).
 *
 * ФИКСТУРА (TC-F-15-3): ассерт только про PlatformRef["id"] — единственная
 *   часть контракта, которую карточка пинит. Форма PlatformRef сверх id
 *   сознательно НЕ пинится (реализатор волен добавить обязательные поля) →
 *   конструкция объекта через `as PlatformRef` (comparable-подмножество):
 *   при closed-union id падает СТРОКА const unknownPlatform (hard error),
 *   а не cast. Unknown-литерал — точно из карточки:
 *   "github-enterprise-self-hosted".
 *
 * Red-ожидание (roadmap «Red-тест: TC-F-15-1 … fs.readFileSync throws ENOENT» +
 *   constraint задачи: файлы НЕ создавать): ВСЕ 3 теста падают одинаково —
 *   fs.readFileSync("review-adapters.d.ts") бросает ENOENT на arrange
 *   (TC-F-15-1 — первым по порядку). Это ЕДИНСТВЕННО допустимая причина
 *   падения. Green-шаг создаёт оба файла ровно по зафиксированным путям —
 *   тесты зеленеют без правок тест-файла.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Корень extension: extensions/fan-orchestrator/test/*.test.mjs → ../ */
const EXTENSION_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Целевые файлы контракта (в Red НЕ существуют — единственная причина падения). */
const DTS_PATH = path.join(EXTENSION_ROOT, "review-adapters.d.ts");
const DOC_PATH = path.join(EXTENSION_ROOT, "review-adapters.md");

/** 8 объявлений контракта (точные имена из карточки F-15 / TC-F-15-1). */
const DTS_DECLARATIONS = Object.freeze([
    "ReviewSeverity",
    "ReviewVerdict",
    "PlatformRef",
    "DiffRequest",
    "DiffResult",
    "ReviewComment",
    "ReviewResolution",
    "PlatformReviewAdapter",
]);

/** 3 секции .md (точные имена из карточки F-15 / TC-F-15-1). */
const DOC_SECTIONS = Object.freeze(["Semantics of errors", "Extension model", "Precedent"]);

/** Unknown-платформа из карточки TC-F-15-3 — заведомо не из «известных» платформ. */
const UNKNOWN_PLATFORM_ID = "github-enterprise-self-hosted";

/** Правило explicit handling, которое .md обязан содержать (TC-F-15-3, шаг 2). */
const EXPLICIT_HANDLING_RULE = /unknown platform id must be explicitly handled/i;

/**
 * Regex объявления: точное имя + факт экспорта; kind (type|interface) не пинится
 * (см. «РЕШЕНИЕ ПО REGEX ОБЪЯВЛЕНИЙ» в шапке). \b отсекает префиксы
 * (ReviewSeverityFoo не satisfies ReviewSeverity).
 */
function declarationRegex(name) {
    return new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex секции .md: точный паттерн карточки ^##\s+<Name>, gm, без $-якоря. */
function sectionRegex(section) {
    return new RegExp(`^##\\s+${escapeRegExp(section)}`, "gm");
}

/** Нормализация пробелов/переносов (правило в .md может быть переформато). */
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Детерминированный резолв tsc из монорепо (bin/tsc через process.execPath —
 * эквивалент «npx tsc …» из карточки без shell/PATH). null → окружение без TS.
 */
function resolveTsc() {
    const candidates = [
        path.join(EXTENSION_ROOT, "node_modules", "typescript", "bin", "tsc"),
        path.join(EXTENSION_ROOT, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}
const TSC_JS = resolveTsc();

/**
 * Tmp-tsconfig ровно по карточке: {"noEmit": true, "strict": true} + герметичный
 * минимум (types: [] — без авто-подхвата @types; skipLibCheck НЕ включаем, чтобы
 * ошибки самого контракта не маскировались). files — абсолютные пути (tsconfig
 * лежит во tmp-каталоге, относительные пути резолвились бы от него).
 */
function makeTmpTsconfig(dir, files) {
    const tsconfigPath = path.join(dir, "tsconfig.f15.json");
    fs.writeFileSync(
        tsconfigPath,
        JSON.stringify(
            {
                compilerOptions: {
                    noEmit: true,
                    strict: true,
                    target: "ES2022",
                    lib: ["ES2022"],
                    module: "commonjs",
                    moduleResolution: "node",
                    types: [],
                },
                files,
            },
            null,
            2,
        ),
    );
    return tsconfigPath;
}

/** Запуск tsc: {code, output}; не-нулевой exit НЕ бросает — код ассертится. */
function runTsc(tsconfigPath) {
    try {
        const stdout = execFileSync(process.execPath, [TSC_JS, "-p", tsconfigPath], {
            encoding: "utf-8",
        });
        return { code: 0, output: stdout };
    } catch (err) {
        const code = typeof err.status === "number" ? err.status : -1;
        const output = [err.stdout, err.stderr].filter(Boolean).join("\n");
        return { code, output };
    }
}

/** Guard окружения (после arrange-чтения файлов — Red-ENOENT всегда первый). */
function requireTsc() {
    if (!TSC_JS) {
        throw new Error(
            "Precondition: TypeScript compiler не найден (node_modules/typescript/bin/tsc) — npx tsc недоступен в окружении",
        );
    }
}

/** Фикстура TC-F-15-3: неизвестная платформа обязана проходить тип (string & {}). */
const FIXTURE_SOURCE = `// Auto-generated by test/review-adapters.test.mjs (TC-F-15-3).
// Неизвестный platform id НЕ отвергается типом: string & {} паттерн
// сохраняет autocomplete для известных платформ и extensibility для новых.
import type { PlatformRef } from "../../review-adapters";

const unknownPlatform: PlatformRef["id"] = "${UNKNOWN_PLATFORM_ID}";

// Форма PlatformRef сверх id фикстурой не пинится (as — comparable-подмножество):
// при closed-union id упала бы строка const unknownPlatform выше, а не cast.
export const ref: PlatformRef = { id: unknownPlatform } as PlatformRef;
`;

describe("platform review adapter contract (F-15, code-review-worker)", () => {
    it("TC-F-15-1: review-adapters.d.ts содержит все 8 объявлений + review-adapters.md покрывает 3 секции", () => {
        // arrange: оба файла читаются с диска (Red: ENOENT — единственная причина падения)
        const dts = fs.readFileSync(DTS_PATH, "utf-8");
        const doc = fs.readFileSync(DOC_PATH, "utf-8");

        // act/assert (.d.ts): ≥ 1 совпадение каждого из 8 объявлений (итого 8)
        for (const name of DTS_DECLARATIONS) {
            const matches = dts.match(declarationRegex(name));
            expect(matches, `review-adapters.d.ts: объявление «${name}» экспортировано`).not.toBeNull();
        }

        // act/assert (.md): каждая из 3 секций ≥ 1, суммарно ≥ 3 (regex карточки, gm)
        let totalSectionMatches = 0;
        for (const section of DOC_SECTIONS) {
            const found = doc.match(sectionRegex(section)) ?? [];
            totalSectionMatches += found.length;
            expect(found.length, `review-adapters.md: секция «${section}»`).toBeGreaterThan(0);
        }
        expect(totalSectionMatches).toBeGreaterThanOrEqual(3);
    });

    it("TC-F-15-2: tsc --noEmit --strict на review-adapters.d.ts → exit code 0, без «error TS»", () => {
        // arrange: контракт существует (Red: ENOENT) + компилятор доступен
        fs.readFileSync(DTS_PATH, "utf-8");
        requireTsc();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-f15-tc2-"));

        try {
            // arrange: tmp-tsconfig {noEmit: true, strict: true} на целевой файл
            const tsconfigPath = makeTmpTsconfig(tmpDir, [DTS_PATH]);

            // act
            const { code, output } = runTsc(tsconfigPath);

            // assert: exit code 0, ошибок компиляции нет (0 рантайма, чистые типы)
            expect(code, `tsc exit code != 0:\n${output}`).toBe(0);
            expect(output).not.toMatch(/error TS/);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }, 120_000);

    it(`TC-F-15-3: PlatformRef["id"] принимает «${UNKNOWN_PLATFORM_ID}» (string & {}) + .md требует explicit handling`, () => {
        // arrange: контракт существует (Red: ENOENT) + компилятор доступен
        fs.readFileSync(DTS_PATH, "utf-8");
        const doc = fs.readFileSync(DOC_PATH, "utf-8");
        requireTsc();

        // фикстура живёт рядом с тестом: import "../../review-adapters" резолвит
        // review-adapters.d.ts; каталог временный — удаляется в finally
        const tmpDir = fs.mkdtempSync(path.join(EXTENSION_ROOT, "test", ".tmp-f15-tc3-"));

        try {
            const fixturePath = path.join(tmpDir, "platform-ref-extensibility.fixture.ts");
            fs.writeFileSync(fixturePath, FIXTURE_SOURCE);
            const tsconfigPath = makeTmpTsconfig(tmpDir, [fixturePath]);

            // act (1): tsc --noEmit на фикстуру (тянет контракт через import type)
            const { code, output } = runTsc(tsconfigPath);

            // assert (1): unknown platform id НЕ отвергается типом — exit 0
            expect(code, `tsc отклонил неизвестный platform id:\n${output}`).toBe(0);
            expect(output).not.toMatch(/error TS/);

            // assert (2): .md содержит явное требование к реализации (explicit handling)
            const normalized = normalizeWhitespace(doc);
            expect(normalized).toMatch(EXPLICIT_HANDLING_RULE);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }, 120_000);
});
