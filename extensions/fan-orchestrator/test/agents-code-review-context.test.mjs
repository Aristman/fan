/**
 * TDD RED tests for F-13 «RULES_DIR constraint injection через enrichWorkerContext».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-13» (TC-F-13-1, TC-F-13-2, TC-F-13-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md — воркер code-review читает правила
 * из constraint `CODE_REVIEW_RULES_DIR` (agents/code-review.md STEP 2), но инъекции constraint
 * в orchestrator-tools.js НЕТ: воркер не получает путь и не может загрузить правила.
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   В extensions/fan-orchestrator/orchestrator-tools.js появляется функция
 *
 *     enrichWorkerContext(agent, context)
 *
 *   и экспортируется из модуля (критерий приёмки №1 карточки). Контракт:
 *     - agent === "code-review" → в context.constraints добавляется строка
 *       `CODE_REVIEW_RULES_DIR=<abs>`, где <abs> = path.join(__dirname, "review-rules")
 *       — абсолютный путь к каталогу правил extension (dev / ~/.fan/agent/extensions/ /
 *       execDir — __dirname всегда вычисляется относительно orchestrator-tools.js).
 *     - agent !== "code-review" → контекст НЕ меняется (no-op, критерий приёмки №2).
 *     - Функция обёрнута вокруг ВСЕХ 3 точек mergeContext в orchestrator-tools.js
 *       (критерий приёмки №3): chain (~355), parallel (~538), single (~616) — результат
 *       mergeContext доходит до runSingleAgent уже обогащённым.
 *
 * Паттерн теста: registerOrchestratorTools с моком fan (как chain-render.test.mjs),
 * мок mergeContext функциональный (не `() => null`) + спаи на mergeContext/runSingleAgent —
 * иначе инъекцию не поймать (карточка TC-F-13-3: «unit-тест с моком mergeContext»).
 * ВАЖНО: discoverAgents мокается СИНХРОННЫМ (в отличие от async-мока в
 * agents-security-routing.test.mjs) — delegate_task.execute вызывает его без await
 * и сразу читает discovery.agents (сортировки/classify это не касались).
 *
 * TC-F-13-1: enrichWorkerContext("code-review", {constraints: []}) → в constraints появляется
 *            `CODE_REVIEW_RULES_DIR=<abs>`: path.isAbsolute(<abs>) === true, <abs> заканчивается
 *            на «review-rules».
 * TC-F-13-2: enrichWorkerContext("verify", {constraints: []}) → constraints БЕЗ изменений
 *            (no-op — только code-review получает RULES_DIR).
 * TC-F-13-3: integration-спаи: delegate_task в режимах chain/parallel/single — все 3 точки
 *            mergeContext реально исполняются (spy mergeContext + runSingleAgent вызваны),
 *            контекст, дошедший до воркера (последний аргумент runSingleAgent), содержит
 *            constraint CODE_REVIEW_RULES_DIR.
 *
 * Red-ожидание (roadmap + constraint задачи): TC-F-13-1/2 падают ПЕРВЫМИ —
 * «enrichWorkerContext не экспортируется» (guard перед act: единственная допустимая причина);
 * TC-F-13-3 падает на assert'е constraint'а — точки mergeContext исполняются (спаи срабатывают),
 * но инъекции нет, и контекст воркера приходит без CODE_REVIEW_RULES_DIR. Функциональность
 * в orchestrator-tools.js в RED-фазе НЕ добавляется.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "node:path";

/** Спаи пересоздаются в beforeEach; vi.mock-фабрики делегируют в них по ссылке (паттерн chain-render). */
let mergeContextSpy;
let runSingleAgentSpy;
/** Захваченное определение delegate_task из mockFan.registerTool. */
let delegateTool;

/** Минимальный успешный результат воркера — чтобы execute дошёл до конца без isError-веток. */
const MOCK_WORKER_RESULT = () => ({
    exitCode: 0,
    stopReason: undefined,
    messages: [{ role: "assistant", content: [{ type: "text", text: "mock worker output" }] }],
    stderr: "",
    errorMessage: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: "mock-model",
    text: "mock worker output",
});

beforeEach(async () => {
    vi.resetModules();
    runSingleAgentSpy = vi.fn(async () => MOCK_WORKER_RESULT());
    mergeContextSpy = vi.fn((explicit, auto) => {
        if (!explicit && !auto) return undefined;
        if (!explicit) return auto;
        if (!auto) return explicit;
        return { ...auto, ...explicit };
    });

    // Моки внешних зависимостей, чтобы импортировать orchestrator-tools.js
    // (набор — из chain-render.test.mjs / agents-security-routing.test.mjs).
    vi.mock("node:os", () => ({ homedir: () => "/home/user", platform: () => "win32", cpus: () => [] }));
    vi.mock("@seaagents/fan-ai", () => ({ StringEnum: (vals) => vals[0] }));
    vi.mock("@seaagents/fan-coding-agent", () => ({ getMarkdownTheme: () => ({}) }));
    vi.mock("@seaagents/fan-tui", () => ({
        Container: class {},
        Markdown: class {},
        Spacer: class {},
        Text: class {},
    }));
    // Pass-through Type — схема delegate_task не валидируется в тестах
    vi.mock("@sinclair/typebox", () => {
        const pass = (v) => v;
        return { Type: new Proxy({}, { get: () => pass }) };
    });
    // СИНХРОННЫЙ мок (см. шапку): execute читает discovery.agents без await.
    // readOnly-агенты → toWorkerType даёт слот по имени, write-фильтр parallel их не блокирует.
    vi.mock("../agents.js", () => ({
        discoverAgents: () => ({
            agents: [
                { name: "explore", source: "builtin", readOnly: true },
                { name: "plan", source: "builtin", readOnly: true },
                { name: "implement", source: "builtin", readOnly: false },
                { name: "verify", source: "builtin", readOnly: true },
                { name: "code-review", source: "builtin", readOnly: true },
            ],
            projectAgentsDir: null,
        }),
    }));
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
        getFinalOutput: () => "mock worker output",
        MAX_CONCURRENCY: 5,
        MAX_PARALLEL_TASKS: 10,
        // Функциональный мок: parallel-режим реально прогоняет задачи через callback
        mapWithConcurrencyLimit: async (items, _limit, fn) => {
            const out = [];
            for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
            return out;
        },
        runSingleAgent: (...args) => runSingleAgentSpy(...args),
    }));
    vi.mock("../workers.js", () => ({
        acquireSlot: () => {},
        releaseSlot: () => {},
        getWorker: () => null,
        updateWorker: () => {},
    }));
    // РЕАЛЬНЫЙ mergeContext (через importActual), обёрнутый спаем. Функциональный мок
    // `{...auto, ...explicit}` копировал объект и НЕ воспроизводил семантику return-by-
    // reference (при отсутствии step.context mergeContext возвращает autoContext по ссылке) —
    // с ним chain-leak регрессия F-13 была бы невидима (TC-F-13-4). Спаи на mergeContext
    // сохранены: TC-F-13-3 assert'ит, что точки mergeContext реально исполняются.
    // collectProjectContext возвращает НОВЫЙ объект на каждый вызов — как реальный:
    // один shared autoContext на delegate_task.execute (одна точка collect на вызов).
    vi.mock("../context-builder.js", async () => {
        const actual = await vi.importActual("../context-builder.js");
        return {
            collectProjectContext: () => ({ gitState: "mock-git-state", projectTree: "mock-project-tree" }),
            mergeContext: (explicit, auto) => {
                mergeContextSpy(explicit, auto);
                return actual.mergeContext(explicit, auto);
            },
            truncate: (s) => s,
            PREVIOUS_OUTPUT_LIMIT: 4000,
        };
    });

    const { registerOrchestratorTools } = await import("../orchestrator-tools.js");

    const registered = {};
    const mockFan = {
        registerTool: (def) => { registered[def.name] = def; },
        registerCommand: () => {},
        registerAgent: () => {},
    };
    registerOrchestratorTools(mockFan, null, { parallelWorkers: 8 });

    delegateTool = registered["delegate_task"];
    if (!delegateTool || typeof delegateTool.execute !== "function") {
        throw new Error(
            "Инструмент delegate_task не зарегистрирован registerOrchestratorTools — " +
                "проверь мок fan.registerTool и имя инструмента в orchestrator-tools.js.",
        );
    }
});

/** Guard читаемого Red: enrichWorkerContext должен быть экспортирован из orchestrator-tools.js. */
function requireEnrichWorkerContext(enrichWorkerContext) {
    if (typeof enrichWorkerContext !== "function") {
        throw new Error(
            "RED: enrichWorkerContext не экспортируется из orchestrator-tools.js — F-13 не реализована. " +
                "Green-фаза: добавить export function enrichWorkerContext(agent, context) " +
                "(критерий приёмки №1 карточки F-13).",
        );
    }
    return enrichWorkerContext;
}

/** Constraint CODE_REVIEW_RULES_DIR из массива constraints (или undefined). */
function findRulesDirConstraint(constraints) {
    return (constraints ?? []).find(
        (c) => typeof c === "string" && c.startsWith("CODE_REVIEW_RULES_DIR="),
    );
}

/**
 * Три точки mergeContext в delegate_task.execute (orchestrator-tools.js):
 * chain (~355), parallel (~538), single (~616). Параметры каждой mode branch —
 * ровно по одному режиму за вызов (guard modeCount !== 1).
 */
const MODES = [
    {
        name: "chain",
        params: (ctx) => ({ chain: [{ agent: "code-review", task: "review the staged diff", context: ctx }] }),
    },
    {
        name: "parallel",
        params: (ctx) => ({ tasks: [{ agent: "code-review", task: "review the staged diff", context: ctx }] }),
    },
    {
        name: "single",
        params: (ctx) => ({ agent: "code-review", task: "review the staged diff", context: ctx }),
    },
];

/** Прогоняем delegate_task в одном режиме, возвращаем контекст, дошедший до воркера. */
async function runModeAndGetWorkerContext(mode) {
    mergeContextSpy.mockClear();
    runSingleAgentSpy.mockClear();

    const result = await delegateTool.execute(
        "test-call-id",
        mode.params({ constraints: [] }),
        undefined,
        undefined,
        { cwd: "/tmp/fake-project" },
    );

    expect(
        mergeContextSpy,
        `точка mergeContext режима ${mode.name} должна быть реально исполнена (roadmap F-13, TC-F-13-3)`,
    ).toHaveBeenCalled();
    expect(
        runSingleAgentSpy,
        `воркер должен быть запущен в режиме ${mode.name}`,
    ).toHaveBeenCalledTimes(1);

    const workerArgs = runSingleAgentSpy.mock.calls[0];
    // Контекст воркера — последний аргумент runSingleAgent во всех 3 режимах
    return { result, workerContext: workerArgs[workerArgs.length - 1] };
}

describe("F-13: RULES_DIR constraint injection через enrichWorkerContext (orchestrator-tools.js)", () => {
    describe("TC-F-13-1: enrichWorkerContext('code-review', ctx) добавляет CODE_REVIEW_RULES_DIR=<abs>", () => {
        it("constraint добавлен: значение — абсолютный путь, заканчивающийся на review-rules", async () => {
            const { enrichWorkerContext } = await import("../orchestrator-tools.js");
            requireEnrichWorkerContext(enrichWorkerContext);

            const ctx = { constraints: [] };
            // Иммутабельный контракт (фикс F-13): enrich ВОЗВРАЩАЕТ новый объект, вход не мутируется.
            const enriched = enrichWorkerContext("code-review", ctx);

            const constraint = findRulesDirConstraint(enriched.constraints);
            expect(
                constraint,
                "в ctx.constraints должна появиться строка CODE_REVIEW_RULES_DIR=<abs> (roadmap F-13, TC-F-13-1)",
            ).toBeDefined();

            const value = constraint.slice("CODE_REVIEW_RULES_DIR=".length);
            expect(
                value,
                "значение constraint не должно быть пустым — это путь к каталогу правил",
            ).toBeTruthy();
            expect(
                path.isAbsolute(value),
                `путь должен быть АБСОЛЮТНЫМ (path.isAbsolute), получено: «${value}» — иначе воркер не найдёт правила в другом cwd (roadmap F-13, TC-F-13-1)`,
            ).toBe(true);
            expect(
                value.endsWith("review-rules"),
                `путь должен указывать на каталог review-rules extension, получено: «${value}» (roadmap F-13, TC-F-13-1)`,
            ).toBe(true);

            // Фикс F-13 (VERDICT FAIL): входной context НЕ мутируется — иначе при
            // return-by-reference из mergeContext constraint утекал бы в shared autoContext.
            expect(
                ctx.constraints,
                "enrichWorkerContext не должен мутировать входной context (иммутабельный enrich, фикс F-13)",
            ).toEqual([]);
        });
    });

    describe("TC-F-13-2: enrichWorkerContext('verify', ctx) — no-op для других агентов", () => {
        it("constraints остаются без изменений: length === 0, CODE_REVIEW_RULES_DIR отсутствует", async () => {
            const { enrichWorkerContext } = await import("../orchestrator-tools.js");
            requireEnrichWorkerContext(enrichWorkerContext);

            const ctx = { constraints: [] };
            enrichWorkerContext("verify", ctx);

            expect(
                ctx.constraints,
                "constraints для НЕ-code-review агента не должны меняться (roadmap F-13, TC-F-13-2: RULES_DIR — только code-review)",
            ).toEqual([]);
            expect(
                findRulesDirConstraint(ctx.constraints),
                "CODE_REVIEW_RULES_DIR не должен появиться в constraints агента verify",
            ).toBeUndefined();
        });
    });

    describe("TC-F-13-3: mergeContext обогащён во всех 3 режимах (chain, parallel, single)", () => {
        it("контекст, дошедший до воркера, содержит CODE_REVIEW_RULES_DIR в каждом режиме", async () => {
            for (const mode of MODES) {
                const { workerContext } = await runModeAndGetWorkerContext(mode);

                const constraint = findRulesDirConstraint(workerContext?.constraints);
                expect(
                    constraint,
                    `контекст воркера (${mode.name}) должен содержать constraint CODE_REVIEW_RULES_DIR=<abs> — ` +
                        "все 3 точки mergeContext (chain/parallel/single) должны быть обёрнуты enrichWorkerContext " +
                        "(roadmap F-13, TC-F-13-3, критерий приёмки №3)",
                ).toBeDefined();

                const value = constraint.slice("CODE_REVIEW_RULES_DIR=".length);
                expect(
                    path.isAbsolute(value),
                    `(${mode.name}) путь должен быть абсолютным, получено: «${value}»`,
                ).toBe(true);
                expect(
                    value.endsWith("review-rules"),
                    `(${mode.name}) путь должен указывать на review-rules, получено: «${value}»`,
                ).toBe(true);
            }
        });
    });

    describe("TC-F-13-4: chain-leak regression — мутация autoContext не утекает в следующие шаги", () => {
        it("chain [code-review → verify] БЕЗ step.context: verify НЕ получает CODE_REVIEW_RULES_DIR (реальный mergeContext)", async () => {
            // Сценарий из верификации F-13 (VERDICT FAIL): оба шага без explicit context →
            // РЕАЛЬНЫЙ mergeContext возвращает shared autoContext ПО ССЫЛКЕ (context-builder.js).
            // До фикса enrichWorkerContext мутировал context.constraints → constraint утекал
            // в autoContext и доставался verify-шагу (нарушение критерия 2 «no-op другим агентам»).
            // После фикса enrich иммутабелен: autoContext остаётся чистым.
            runSingleAgentSpy.mockClear();

            await delegateTool.execute(
                "test-call-id",
                {
                    chain: [
                        { agent: "code-review", task: "review the staged diff" },
                        { agent: "verify", task: "verify the fix" },
                    ],
                },
                undefined,
                undefined,
                { cwd: "/tmp/fake-project" },
            );

            expect(
                runSingleAgentSpy,
                "chain из 2 шагов должен запустить 2 воркера",
            ).toHaveBeenCalledTimes(2);

            const workerContextOf = (callIdx) => {
                const args = runSingleAgentSpy.mock.calls[callIdx];
                return args[args.length - 1];
            };

            const codeReviewCtx = workerContextOf(0);
            const verifyCtx = workerContextOf(1);

            expect(
                findRulesDirConstraint(codeReviewCtx?.constraints),
                "контекст code-review воркера ДОЛЖЕН содержать CODE_REVIEW_RULES_DIR (F-13, инъекция на месте)",
            ).toBeDefined();
            expect(
                findRulesDirConstraint(verifyCtx?.constraints),
                "контекст verify воркера НЕ должен содержать CODE_REVIEW_RULES_DIR — " +
                    "утечка через мутацию shared autoContext (реальный mergeContext возвращает его по ссылке, " +
                    "критерий приёмки №2: no-op для других агентов в реалистичных сценариях)",
            ).toBeUndefined();

            // Известный gap (зафиксирован, не блокер): повторный enrich одного и того же
            // УЖЕ обогащённого объекта продублирует constraint. В реальном потоке не
            // воспроизводится: enrich вызывается один раз на результат mergeContext, а
            // иммутабельный enrich не загрязняет shared autoContext повторными вызовами.
        });
    });
});
