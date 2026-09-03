/**
 * TDD RED tests for F-1.3 «Routing fix классификатора задач».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-1.3» (TC-F-1.3-1, TC-F-1.3-2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md (security-задачи → security-воркер).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   classifyTaskByDescription (orchestrator-tools.js ~:140) получает security-правило:
 *   ключевые слова security / vulnerab* / exploit / cve / owasp / injection / xss /
 *   secret направляют задачу на воркера 'security' ПРИОРИТЕТНО относительно generic-правил.
 *   Сейчас слово security зашито прямо в generic verify-правиле
 *   (\b(review|verify|check|...|security|...)\b → verify), остальные security-слова
 *   проваливаются в default implement или explore.
 *
 * Как тестируем routing: classifyTaskByDescription НЕ экспортируется — вызываем
 * публичный инструмент classify_task через registerOrchestratorTools с моком fan
 * (паттерн chain-render.test.mjs) и извлекаем "Worker type:" из текстового ответа.
 *
 * TC-F-1.3-1 «Security-задача направляется на security» — 9 фраз (roadmap + по одной
 *   на каждое из 8 ключевых слов). Фактические маршруты сейчас (проверено по правилам):
 *     «проверь модуль на уязвимости и CVE» → implement (русские слова не матчатся)
 *     'security review of auth module'    → verify (слово security В verify-правиле!)
 *     'check for vulnerabilities'         → verify
 *     'exploit vector analysis'           → implement
 *     'CVE audit of dependencies'         → verify
 *     'OWASP compliance check'            → verify
 *     'SQL injection in query builder'    → implement
 *     'XSS in comment rendering'          → implement
 *     'hardcoded secrets in config'       → implement
 *
 *   Граничные кейсы (решения спецификации, задокументированы в тестах):
 *     - security-слова старше generic-глаголов ПОИСКА: 'search for hardcoded secrets
 *       in the repo' сейчас уходит в explore (правило explore — первое). Security-
 *       правило ставим ПЕРВЫМ правилом классификатора: security-слова специфичнее
 *       generic-глаголов и однозначно указывают на аудит.
 *     - регистр не важен (все правила классификатора /i — новое правило так же).
 *
 * TC-F-1.3-2 «Прежние маршруты не сломаны» — 6 эталонных фраз.
 *   ВАЖНО (расхождение с roadmap, формулировки подогнаны под фактические правила
 *   классификатора, как требует постановка): classifyTaskByDescription умеет
 *   возвращать ТОЛЬКО explore | plan | verify | implement (3 правила + default).
 *   Маршруты bug-fix / tests-impl / code-research / docs-impl из roadmap недостижимы:
 *     'fix bug in parser'  → implement (bug-правила нет; roadmap ожидал bug-fix)
 *     'write tests for Y'  → implement (\btest\b не матчит 'tests'; roadmap: tests-impl)
 *     'research architecture of Z' → implement (\barchitect\b не матчит 'architecture')
 *     'update docs for W'  → implement (нет docs-правила)
 *   Эталоны фиксируют ФАКТИЧЕСКИЕ маршруты — это regression-guard для Green-фазы:
 *   после вставки security-правила ни одна фраза не должна «переехать» на security.
 *   Если позже появятся новые правила (bug/tests/docs) — тесты обновляются осознанно.
 *
 * Контракты данных (orchestrator-extension.js; структуры локальные, не экспортируются —
 * проверяем как контракт исходника, без UI-скриншотов):
 *   - agentIcons (~:500, дубль ~:1216): каждый литерал содержит security: "🔒".
 *   - WORKER_PROFILES (~:750): security-профиль «по образцу read-only агентов»
 *     (verify {reasoning 0.5, context 0.5, cost 5, maxTokens 0.3}, explore {0.5, 6, 3, 0.3},
 *     code-research {1, 6, 2, 0.3}, docs-impl {0.3, 1, 4, 0.5}).
 *   - ASSIGNMENT_ORDER (~:761).
 *
 *   РЕШЕНИЕ ПО ASSIGNMENT_ORDER (семантика изучена по коду orchestrator-extension.js):
 *   это НЕ порядок авто-распределения ЗАДАЧ (как предполагала постановка) — это порядок
 *   раздачи МОДЕЛЕЙ в визарде «умное назначение» (/orchestrator models → провайдер):
 *   типы из списка получают лучшие модели первыми (комментарий в коде: "Priority order:
 *   assign heavy workers first so they get the best models"), а для типа ВНЕ списка
 *   smartAssignment[type] остаётся undefined → в UI «(none)», слот cloud/local.models[type]
 *   автозаполнением не накрывается. Следовательно, семантика «не авто-назначаем на каждый
 *   таск» к этому списку не относится. Решение: security ДОБАВЛЯЕМ, последним:
 *     (1) F-1.2 уже завёл слоты cloud/local.models.security — визард должен уметь их
 *         автозаполнять; вне списка он не смог бы;
 *     (2) все 8 существующих типов присутствуют и в WORKER_PROFILES, и в ASSIGNMENT_ORDER —
 *         security не должен быть исключением;
 *     (3) позиция — последняя (низший приоритет выбора модели): on-demand
 *         специализированный read-only воркер получает модель после основных воркеров,
 *         как verify/docs-impl в хвосте списка.
 *
 * Red-ожидание: routing-тесты TC-F-1.3-1 и граничные падают (verify/implement/explore
 * вместо security); контракт-тесты agentIcons / WORKER_PROFILES / ASSIGNMENT_ORDER
 * падают (security отсутствует). TC-F-1.3-2 и пустая строка зелёные СРАЗУ — это
 * фиксация текущего поведения (guard для Green-фазы).
 */
import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentTypes } from "../agents/index.js";

const SECURITY_TYPE = "security";
const SECURITY_ICON = "🔒";

/* ============================================================================
 * Часть 1. Routing: classify_task → classifyTaskByDescription
 * (паттерн chain-render.test.mjs: у orchestrator-tools.js тяжёлые импорты — мокаем)
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
 * 9 фраз TC-F-1.3-1 (roadmap + по одной на каждое из 8 ключевых слов).
 * `now` — фактический маршрут до фикса (для читаемого Red-вывода).
 */
const SECURITY_PHRASES = [
    { phrase: "проверь модуль на уязвимости и CVE", word: "vulnerab* + cve", now: "implement" },
    { phrase: "security review of auth module", word: "security", now: "verify" },
    { phrase: "check for vulnerabilities", word: "vulnerab*", now: "verify" },
    { phrase: "exploit vector analysis", word: "exploit", now: "implement" },
    { phrase: "CVE audit of dependencies", word: "cve", now: "verify" },
    { phrase: "OWASP compliance check", word: "owasp", now: "verify" },
    { phrase: "SQL injection in query builder", word: "injection", now: "implement" },
    { phrase: "XSS in comment rendering", word: "xss", now: "implement" },
    { phrase: "hardcoded secrets in config", word: "secret", now: "implement" },
];

/** 6 эталонных фраз TC-F-1.3-2 (маршруты, зафиксированные по фактическим правилам). */
const REFERENCE_PHRASES = [
    {
        phrase: "review this PR",
        expected: "code-review",
        note: "мигрирован в F-12 (было verify): правило №2 code-review направляет review-обороты на code-review",
    },
    {
        phrase: "explore the project structure",
        expected: "explore",
        note: "первое правило классификатора (roadmap-эталон code-research недостижим — см. шапку)",
    },
    {
        phrase: "plan the rollout strategy",
        expected: "plan",
        note: "второе правило классификатора",
    },
    {
        phrase: "add feature X",
        expected: "implement",
        note: "эталон roadmap №3 — default-маршрут, без изменений",
    },
    {
        phrase: "fix bug in parser",
        expected: "implement",
        note: "расхождение с roadmap (ожидался bug-fix): bug-правила в классификаторе нет — фиксируем фактический default",
    },
    {
        phrase: "write tests for Y",
        expected: "implement",
        note: "расхождение с roadmap (ожидался tests-impl): \\btest\\b не матчит 'tests' — фиксируем фактический default",
    },
];

describe("F-1.3: routing-фикс классификатора задач (classify_task → classifyTaskByDescription)", () => {
    describe("TC-F-1.3-1: security-задача направляется на security", () => {
        for (const { phrase, word, now } of SECURITY_PHRASES) {
            it(`ключевое слово ${word}: «${phrase}» → security (сейчас: ${now})`, async () => {
                const workerType = await classifyWorkerType(phrase);
                expect(
                    workerType,
                    `«${phrase}» сейчас уходит в ${now}: security-ключевое слово «${word}» должно ` +
                        `направлять задачу на security ДО generic-правил (roadmap F-1.3, TC-F-1.3-1)`,
                ).toBe(SECURITY_TYPE);
            });
        }
    });

    describe("TC-F-1.3-1 (граничные, решения спецификации)", () => {
        it("security-слова старше generic-глаголов поиска: 'search for hardcoded secrets in the repo' → security (сейчас: explore)", async () => {
            const workerType = await classifyWorkerType("search for hardcoded secrets in the repo");
            expect(
                workerType,
                "«search for…» сейчас уходит в explore (первое правило). Security-правило ставим ПЕРВЫМ: " +
                    "security-слова специфичнее generic-глаголов и однозначно указывают на аудит (roadmap F-1.3)",
            ).toBe(SECURITY_TYPE);
        });

        it("регистр не важен (правила классификатора /i): 'Security REVIEW of the auth module' → security", async () => {
            const workerType = await classifyWorkerType("Security REVIEW of the auth module");
            expect(
                workerType,
                "в существующих правилах используется флаг /i — новое security-правило должно быть таким же",
            ).toBe(SECURITY_TYPE);
        });
    });

    describe("TC-F-1.3-2: прежние маршруты не сломаны (regression-guard Green-фазы)", () => {
        for (const { phrase, expected, note } of REFERENCE_PHRASES) {
            it(`«${phrase}» → ${expected}`, async () => {
                const workerType = await classifyWorkerType(phrase);
                expect(
                    workerType,
                    `эталонная фраза не должна менять маршрут при добавлении security-правила (${note})`,
                ).toBe(expected);
            });
        }

        it("пустая строка → implement (default не сломан, инструмент не падает)", async () => {
            const workerType = await classifyWorkerType("");
            expect(workerType, "пустое описание — default-маршрут implement").toBe("implement");
        });
    });
});

/* ============================================================================
 * Часть 2. Контракты данных в orchestrator-extension.js:
 * agentIcons (~:500, ~:1216), WORKER_PROFILES (~:750), ASSIGNMENT_ORDER (~:761).
 * Структуры локальные (не экспортируются) — фиксируем контракт исходника.
 * ========================================================================== */

const EXTENSION_URL = new URL("../orchestrator-extension.js", import.meta.url);

/** Guard: исходник orchestrator-extension.js читается (база, не предмет F-1.3). */
function requireExtensionSource() {
    if (!fs.existsSync(EXTENSION_URL)) {
        throw new Error("orchestrator-extension.js не существует — ожидается рядом с тестом (extensions/fan-orchestrator/).");
    }
    return fs.readFileSync(EXTENSION_URL, "utf-8");
}

/** Все литералы `const agentIcons = { ... }` в файле (сейчас два: ~:500 и ~:1216). */
function extractAgentIconsBlocks(source) {
    return [...source.matchAll(/const agentIcons = \{([^}]*?)\}/g)].map((m) => m[1]);
}

/** Парсинг плоской map-ы `ключ: "значение"` из тела литерала. Ключи с дефисом
 * в JS требуют кавычек ("bug-fix": "…"), голые пишутся без — видим оба варианта. */
function parseIconMap(block) {
    return Object.fromEntries(
        [...block.matchAll(/(?:"([a-z-]+)"|([a-z-]+))\s*:\s*"([^"]+)"/g)].map((m) => [m[1] || m[2], m[3]]),
    );
}

/** Тело `const WORKER_PROFILES = { ... };` (вложенные `{...}` значений не содержат `};`). */
function extractWorkerProfilesBody(source) {
    const match = /const WORKER_PROFILES = \{([\s\S]*?)\};/.exec(source);
    if (!match) {
        throw new Error(
            "В orchestrator-extension.js не найден литерал WORKER_PROFILES (~:750) — " +
                "структура переименована/перенесена? Обнови контракт-тест (roadmap F-1.3).",
        );
    }
    return match[1];
}

/** Парсинг весов профиля `type: { reasoning: X, context: Y, cost: Z, maxTokens: W }`.
 * Кавычки вокруг ключа опциональны: hyphenated-типы ("bug-fix") пишутся в кавычках. */
function parseProfileWeights(profilesBody, type) {
    const match = new RegExp(`"?${type}"?\\s*:\\s*\\{([^}]*)\\}`).exec(profilesBody);
    if (!match) return null;
    const weights = {};
    for (const [, key, value] of match[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) {
        weights[key] = Number(value);
    }
    return weights;
}

/** Массив `const ASSIGNMENT_ORDER = [...]` (строковые литералы). */
function extractAssignmentOrder(source) {
    const match = /const ASSIGNMENT_ORDER = \[([^\]]*)\]/.exec(source);
    if (!match) {
        throw new Error(
            "В orchestrator-extension.js не найден литерал ASSIGNMENT_ORDER (~:761) — " +
                "структура переименована/перенесена? Обнови контракт-тест (roadmap F-1.3).",
        );
    }
    return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("F-1.3: контракты данных orchestrator-extension.js (agentIcons / WORKER_PROFILES / ASSIGNMENT_ORDER)", () => {
    describe("agentIcons: каждый литерал содержит security: '🔒'", () => {
        it("литералы agentIcons найдены в исходнике (база)", () => {
            const blocks = extractAgentIconsBlocks(requireExtensionSource());
            expect(
                blocks.length,
                "не найден ни один литерал const agentIcons = {...} — структура переименована? Обнови контракт-тест.",
            ).toBeGreaterThan(0);
        });

        it("security: '🔒' присутствует в каждом литерале agentIcons (~:500 и дубль ~:1216)", () => {
            const source = requireExtensionSource();
            const blocks = extractAgentIconsBlocks(source);
            expect(blocks.length).toBeGreaterThan(0);
            blocks.forEach((block, i) => {
                const icons = parseIconMap(block);
                expect(
                    icons[SECURITY_TYPE],
                    `литерал agentIcons #${i + 1} (из ${blocks.length}, orchestration-extension.js ~:500/~:1216) ` +
                        `не содержит "${SECURITY_TYPE}": "${SECURITY_ICON}" — добавь по образцу остальных 8 типов ` +
                        "(иначе в UI тип security отображается как «undefinedsecurity»; roadmap F-1.3)",
                ).toBe(SECURITY_ICON);
            });
        });

        it("иконки покрывают ВСЕ типы из реестра (динамические списки F-0.1: getAgentTypes)", () => {
            const source = requireExtensionSource();
            const blocks = extractAgentIconsBlocks(source);
            expect(blocks.length).toBeGreaterThan(0);
            for (const type of getAgentTypes()) {
                for (const [i, block] of blocks.entries()) {
                    expect(
                        parseIconMap(block)[type],
                        `agentIcons #${i + 1}: тип «${type}» из реестра (getAgentTypes) без иконки — ` +
                            "списки типов динамические (F-0.1), иконки должны покрывать весь реестр",
                    ).toBeTruthy();
                }
            }
        });
    });

    describe("WORKER_PROFILES: security-профиль по образцу read-only агентов", () => {
        it("профиль security присутствует со всеми четырьмя весами", () => {
            const body = extractWorkerProfilesBody(requireExtensionSource());
            const weights = parseProfileWeights(body, SECURITY_TYPE);
            expect(
                weights,
                'WORKER_PROFILES (~:750) не содержит ключ "security" — добавь профиль по образцу ' +
                    "read-only агентов (verify/explore/code-research/docs-impl; roadmap F-1.3)",
            ).not.toBeNull();
            for (const key of ["reasoning", "context", "cost", "maxTokens"]) {
                expect(
                    weights[key],
                    `WORKER_PROFILES.security.${key} отсутствует или не число — профиль должен быть валиден для scoreModel()`,
                ).toBeTypeOf("number");
                expect(weights[key], `WORKER_PROFILES.security.${key} должен быть > 0`).toBeGreaterThan(0);
                expect(Number.isFinite(weights[key])).toBe(true);
            }
        });

        it("веса security в конверте read-only агентов: reasoning ≤ 2, maxTokens ≤ 1, cost ≥ 1", () => {
            // Read-only сиблинги: verify {0.5, 0.5, 5, 0.3}, explore {0.5, 6, 3, 0.3},
            // code-research {1, 6, 2, 0.3}, docs-impl {0.3, 1, 4, 0.5}. Write-агенты
            // (implement/bug-fix) — reasoning 8–10, cost 0.1. Security-аудит — чтение и
            // анализ, не генерация кода → конверт read-only.
            const body = extractWorkerProfilesBody(requireExtensionSource());
            const weights = parseProfileWeights(body, SECURITY_TYPE);
            expect(weights, "профиль security отсутствует (см. предыдущий тест)").not.toBeNull();
            expect(
                weights.reasoning,
                `reasoning=${weights.reasoning}: у read-only агентов 0.3–1 (у write 8–10) — security должен быть в конверте read-only`,
            ).toBeLessThanOrEqual(2);
            expect(
                weights.maxTokens,
                `maxTokens=${weights.maxTokens}: у read-only агентов 0.3–0.5 (короткие отчёты, не длинный код)`,
            ).toBeLessThanOrEqual(1);
            expect(
                weights.cost,
                `cost=${weights.cost}: у read-only агентов 2–5 (дешёвые модели достаточны для чтения/анализа)`,
            ).toBeGreaterThanOrEqual(1);
        });

        it("WORKER_PROFILES покрывает все типы из реестра (getAgentTypes)", () => {
            const body = extractWorkerProfilesBody(requireExtensionSource());
            for (const type of getAgentTypes()) {
                expect(
                    parseProfileWeights(body, type),
                    `WORKER_PROFILES: тип «${type}» из реестра без профиля — findBestModel() использует uncalibrated default`,
                ).not.toBeNull();
            }
        });
    });

    describe("ASSIGNMENT_ORDER: security добавляется ПОСЛЕДНИМ (решение — см. шапку файла)", () => {
        it("ASSIGNMENT_ORDER содержит security", () => {
            const order = extractAssignmentOrder(requireExtensionSource());
            expect(
                order,
                `ASSIGNMENT_ORDER (${order.join(", ")}) не содержит «security». Решение F-1.3: добавить последним — ` +
                    "это порядок раздачи МОДЕЛЕЙ в визарде (не задач!): без списка smartAssignment[security] === undefined, " +
                    "в UI «(none)», слоты cloud/local.models.security из F-1.2 не автозаполняются",
            ).toContain(SECURITY_TYPE);
        });

        it("security — последний элемент (низший приоритет выбора модели: on-demand read-only воркер)", () => {
            const order = extractAssignmentOrder(requireExtensionSource());
            expect(order.indexOf(SECURITY_TYPE), "security должен быть в конце списка").toBe(order.length - 1);
        });

        it("прежние 8 типов сохраняют прежний порядок (regression-guard)", () => {
            const EXISTING_ORDER = [
                "implement",
                "plan",
                "bug-fix",
                "explore",
                "code-research",
                "tests-impl",
                "verify",
                "docs-impl",
            ];
            const order = extractAssignmentOrder(requireExtensionSource());
            expect(
                order.filter((t) => t !== SECURITY_TYPE),
                "порядок существующих 8 типов не должен меняться при добавлении security",
            ).toEqual(EXISTING_ORDER);
        });
    });
});
