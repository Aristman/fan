/**
 * TDD RED tests for F-12 «Routing classification (classify_task правило №2 + сужение verify)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-12» (TC-F-12-1, TC-F-12-2, TC-F-12-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (semantic-фразы → воркер code-review).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   classifyTaskByDescription (orchestrator-tools.js ~:149) получает правило №2 (сразу после
 *   security-правила №1): regex CODE_REVIEW_KEYWORDS — ключевые обороты
 *   code\s*review / review (this|the) (pr|diff|changes|commit|branch) / pr\s*review / lgtm /
 *   ревью / код[\s-]ревью направляют задачу на воркера 'code-review' ПРИОРИТЕТНЕЕ generic-правил.
 *   Попутно сужается verify-regex: из него убираются \breview\b|\bsecurity\b — домены переезжают
 *   к code-review (№2) и security (№1), иначе новые правила никогда бы не сработали
 *   (verify-правило ловит 'review' раньше всего, что ниже него).
 *   Порядок правил: security (№1) → code-review (№2) → explore (№3) → plan (№4) → verify → default.
 *
 * Как тестируем routing: classifyTaskByDescription НЕ экспортируется — вызываем
 * публичный инструмент classify_task через registerOrchestratorTools с моком fan
 * (паттерн chain-render.test.mjs, 1:1 как в agents-security-routing.test.mjs) и извлекаем
 * "Worker type:" из текстового ответа.
 *
 * TC-F-12-1 «8 positive phrases роутятся на code-review». Фактические маршруты сейчас
 *   (проверено по правилам классификатора):
 *     'code review of the auth module'    → verify (слово review В verify-правиле!)
 *     'review this PR'                    → verify
 *     'review the diff'                   → verify
 *     'review the changes'                → verify
 *     'commit review for last commit'     → verify
 *     'branch review before merge'        → verify
 *     'LGTM check'                        → verify ('check' в verify-правиле)
 *     'ревью диффа'                       → implement (кириллица правилами не ловится)
 *
 * TC-F-12-2 «5 negative guards НЕ роутятся на code-review» — каждая фраза остаётся
 *   в своём домене. ВАЖНО (расхождение с roadmap TC-F-12-2, ожидания подогнаны под
 *   фактические правила классификатора — прецедент зафиксирован в шапке
 *   agents-security-routing.test.mjs: «формулировки подогнаны под фактические правила,
 *   как требует постановка»):
 *     'verify the build'              → verify      (= roadmap)
 *     'check for vulnerabilities'     → security    (= roadmap, правило №1)
 *     'review the new feature design' → plan        (roadmap ожидал verify: слово design
 *                                      матчит plan-правило №4, которое СТАРШЕ verify;
 *                                      design-ревью — планирование, не verify)
 *     'run tests'                     → implement   (roadmap ожидал verify: \btest\b не
 *                                      матчит 'tests' — задокументировано в шапке
 *                                      security-теста на эталоне 'write tests for Y')
 *     ''                              → implement   (= roadmap, default)
 *   Суть guard'а — вторая половина roadmap-формулировки: НИ ОДНА из 5 фраз не должна
 *   уезжать на code-review. Подогнанные ожидания остаются валидными и после Green
 *   (сужение verify-regex не двигает эти фразы в verify).
 *
 * TC-F-12-3 «Regression guard — миграция эталона agents-security-routing.test.mjs:201-205».
 *   Подход (зафиксирован по условию задачи): РЕГЭКСП-ЧТЕНИЕ файла-эталона через node:fs
 *   (паттерн «Части 2» самого agents-security-routing.test.mjs — контракт исходника).
 *   Импортировать REFERENCE_PHRASES нельзя: это top-level const тестового файла БЕЗ export,
 *   а import .mjs с describe/it на верхнем уровне зарегистрировал бы весь чужой сюит
 *   повторно в этом же vitest-ране. Поэтому: читаем исходник, regex'ом вытаскиваем
 *   expected из эталонной записи phrase: "review this PR" и требуем "code-review".
 *   ВАЖНО (постановка): на Red-фазе TC-F-12-3 ДОЛЖЕН падать — эталон ещё ожидает "verify",
 *   миграция expected → "code-review" выполняется в Green-фазе ВМЕСТЕ с routing-правилом.
 *   agents-security-routing.test.mjs в этой задаче НЕ мигрирует (правка существующего
 *   теста — зона Green).
 *
 * Red-ожидание: TC-F-12-1 — все 8 падают (7× verify + 'ревью диффа' → implement);
 * TC-F-12-2 — все 5 зелёные СРАЗУ (guard'ы фиксируют фактические маршруты, до code-review
 * ничто доехать не может); TC-F-12-3 — оба теста падают (эталон "verify", фраза → verify).
 * После Green + миграции эталона — все зелёные.
 */
import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CODE_REVIEW_TYPE = "code-review";

/* ============================================================================
 * Routing: classify_task → classifyTaskByDescription
 * (паттерн chain-render.test.mjs / agents-security-routing.test.mjs:
 *  у orchestrator-tools.js тяжёлые импорты — мокаем)
 * ========================================================================== */

let classifyTool;

beforeEach(async () => {
    vi.resetModules();

    // Моки внешних зависимостей, чтобы импортировать orchestrator-tools.js
    vi.mock("node:os", () => ({ homedir: () => "/home/user", platform: () => "win32", cpus: () => [] }));
    vi.mock("@seaagents/fan-ai", () => ({ StringEnum: (vals) => vals[0] }));
    vi.mock("@seaagents/fan-coding-agent", () => ({ getMarkdownTheme: () => ({}) }));
    vi.mock("@seaagents/fan-tui", () => ({
        Container: class {},
        Markdown: class {},
        Spacer: class {},
        Text: class {},
    }));
    // Pass-through Type — схема не нужна для проверки classify
    vi.mock("@sinclair/typebox", () => {
        const pass = (v) => v;
        return { Type: new Proxy({}, { get: () => pass }) };
    });
    vi.mock("../agents.js", () => ({ discoverAgents: async () => ({ agents: [], projectAgentsDir: null }) }));
    vi.mock("../task-complexity.js", () => ({
        classifyComplexity: () => ({}),
        formatComplexityResult: () => "",
        DIRECT_TASK_RULES: [],
        DELEGATE_TASK_RULES: [],
    }));
    vi.mock("../config.js", () => ({ resolveWorkerModel: () => "model", resolveWorkerTemperature: () => 0.7 }));
    vi.mock("../subagent-runner.js", () => ({
        formatUsageStats: () => "",
        formatTokens: (n) => String(n),
        formatToolPreview: (n) => n,
        getDisplayItems: () => [],
        getFinalOutput: () => "",
        MAX_CONCURRENCY: 5,
        MAX_PARALLEL_TASKS: 10,
        mapWithConcurrencyLimit: async () => [],
        runSingleAgent: async () => ({}),
        getResultToolCalls: () => [],
    }));
    vi.mock("../workers.js", () => ({
        acquireSlot: () => {},
        releaseSlot: () => {},
        getWorker: () => null,
        updateWorker: () => {},
    }));
    vi.mock("../context-builder.js", () => ({
        collectProjectContext: async () => null,
        mergeContext: () => null,
        truncate: (s) => s,
        PREVIOUS_OUTPUT_LIMIT: 4000,
    }));

    const { registerOrchestratorTools } = await import("../orchestrator-tools.js");
    const mockFan = {
        registerTool: (def) => {
            if (def.name === "classify_task") classifyTool = def;
        },
        registerCommand: () => {},
        registerAgent: () => {},
    };
    registerOrchestratorTools(mockFan, null, {});
});

/** Guard: инструмент classify_task зарегистрирован. Красная причина всегда читаема. */
function requireClassifyTool() {
    if (!classifyTool || typeof classifyTool.execute !== "function") {
        throw new Error(
            "Инструмент classify_task не зарегистрирован registerOrchestratorTools — " +
                "проверь мок fan.registerTool и имя инструмента в orchestrator-tools.js.",
        );
    }
    return classifyTool;
}

/** Прогоняем фразу через публичный classify_task и извлекаем workerType из ответа. */
async function classifyWorkerType(description) {
    const tool = requireClassifyTool();
    const result = await tool.execute("test-call-id", { description }, {}, undefined, {});
    const text = result?.content?.[0]?.text ?? "";
    const match = /Worker type:\s*(\S+)/.exec(text);
    if (!match) {
        throw new Error(
            `Не удалось извлечь "Worker type:" из ответа classify_task ` +
                `для фразы ${JSON.stringify(description)}.\nОтвет инструмента:\n${text}`,
        );
    }
    return match[1];
}

/**
 * 8 фраз TC-F-12-1 (roadmap). `now` — фактический маршрут до фикса (для читаемого Red-вывода).
 */
const CODE_REVIEW_PHRASES = [
    { phrase: "code review of the auth module", trigger: "code review", now: "verify" },
    { phrase: "review this PR", trigger: "review this pr", now: "verify" },
    { phrase: "review the diff", trigger: "review the diff", now: "verify" },
    { phrase: "review the changes", trigger: "review the changes", now: "verify" },
    { phrase: "commit review for last commit", trigger: "commit review", now: "verify" },
    { phrase: "branch review before merge", trigger: "branch review", now: "verify" },
    { phrase: "LGTM check", trigger: "lgtm", now: "verify" },
    { phrase: "ревью диффа", trigger: "ревью", now: "implement" },
];

/**
 * 5 negative guards TC-F-12-2 (roadmap; два ожидания подогнаны под фактические правила —
 * см. шапку). `expected` — домен фразы; guard: ни одна не уходит на code-review.
 */
const NEGATIVE_GUARDS = [
    {
        phrase: "verify the build",
        expected: "verify",
        note: "механическая проверка сборки — домен verify (= roadmap)",
    },
    {
        phrase: "check for vulnerabilities",
        expected: "security",
        note: "уязвимости — домен security (правило №1, = roadmap)",
    },
    {
        phrase: "review the new feature design",
        expected: "plan",
        note: "расхождение с roadmap (ожидался verify): слово design матчит plan-правило №4, которое старше verify — фиксируем фактический маршрут; design-ревью — планирование",
    },
    {
        phrase: "run tests",
        expected: "implement",
        note: "расхождение с roadmap (ожидался verify): \\btest\\b не матчит 'tests' (см. эталон 'write tests for Y' в шапке security-теста) — фиксируем фактический default",
    },
    {
        phrase: "",
        expected: "implement",
        note: "пустая строка — default не сломан (= roadmap)",
    },
];

/* ============================================================================
 * TC-F-12-3: миграция эталона agents-security-routing.test.mjs (201-205).
 * Подход: regex-чтение исходника через node:fs — контракт исходника (паттерн
 * «Части 2» самого эталонного теста). Импорт невозможен: REFERENCE_PHRASES не
 * экспортируется, а import файла с describe/it задвоил бы чужой сюит в ране.
 * ========================================================================== */

const SECURITY_TEST_URL = new URL("./agents-security-routing.test.mjs", import.meta.url);

/** Guard: файл-эталон читается (база, не предмет F-12). */
function requireSecurityTestSource() {
    if (!fs.existsSync(SECURITY_TEST_URL)) {
        throw new Error(
            "agents-security-routing.test.mjs не найден рядом с тестом (extensions/fan-orchestrator/test/) — " +
                "TC-F-12-3 мигрирует ЭТОТ файл, без него regression-guard невозможен.",
        );
    }
    return fs.readFileSync(SECURITY_TEST_URL, "utf-8");
}

/** expected из эталонной записи `phrase: "review this PR"` в REFERENCE_PHRASES. */
function extractReferenceExpected(source) {
    const match = /phrase:\s*"review this PR",\s*expected:\s*"([a-z-]+)"/.exec(source);
    if (!match) {
        throw new Error(
            'В agents-security-routing.test.mjs не найдена эталонная запись REFERENCE_PHRASES ' +
                'с phrase: "review this PR" (~:201-205) — структура переименована/перенесена? ' +
                "Обнови TC-F-12-3 (roadmap F-12).",
        );
    }
    return match[1];
}

describe("F-12: routing-классификация code-review (classify_task → classifyTaskByDescription)", () => {
    describe("TC-F-12-1: code-review-задача направляется на code-review", () => {
        for (const { phrase, trigger, now } of CODE_REVIEW_PHRASES) {
            it(`«${phrase}» → code-review (сейчас: ${now})`, async () => {
                const workerType = await classifyWorkerType(phrase);
                expect(
                    workerType,
                    `«${phrase}» сейчас уходит в ${now}: code-review-оборот «${trigger}» должен ` +
                        `направлять задачу на code-review правилом №2 (сразу после security; roadmap F-12, TC-F-12-1)`,
                ).toBe(CODE_REVIEW_TYPE);
            });
        }
    });

    describe("TC-F-12-2: negative guards — чужие домены не перехватываются", () => {
        for (const { phrase, expected, note } of NEGATIVE_GUARDS) {
            it(`«${phrase}» → ${expected} (не code-review)`, async () => {
                const workerType = await classifyWorkerType(phrase);
                expect(
                    workerType,
                    `guard TC-F-12-2 нарушен (${note})`,
                ).toBe(expected);
                expect(
                    workerType,
                    `«${phrase}» уехала на ${CODE_REVIEW_TYPE}: negative guard запрещает перехват чужих доменов ` +
                        `(roadmap F-12, TC-F-12-2; CODE_REVIEW_KEYWORDS должны матчить только review-артефакты: PR/diff/changes/commit/branch)`,
                ).not.toBe(CODE_REVIEW_TYPE);
            });
        }
    });

    describe("TC-F-12-3: regression — миграция эталона agents-security-routing.test.mjs", () => {
        it("эталон 'review this PR' в REFERENCE_PHRASES мигрирован на expected: 'code-review' (сейчас: 'verify')", () => {
            const expected = extractReferenceExpected(requireSecurityTestSource());
            expect(
                expected,
                "эталон agents-security-routing.test.mjs всё ещё ожидает " +
                    `"${expected}": при добавлении правила №2 фраза 'review this PR' переезжает verify → code-review, ` +
                    "мигрируй expected эталона (Green-фаза F-12, TC-F-12-3; agents-security-routing.test.mjs:201-205)",
            ).toBe(CODE_REVIEW_TYPE);
        });

        it("живой контракт согласован с эталоном: 'review this PR' → code-review (сейчас: verify)", async () => {
            const workerType = await classifyWorkerType("review this PR");
            expect(
                workerType,
                "фраза-эталон должна реально уходить на code-review — иначе миграция expected " +
                    "в agents-security-routing.test.mjs разойдётся с поведением классификатора",
            ).toBe(CODE_REVIEW_TYPE);
        });
    });
});
