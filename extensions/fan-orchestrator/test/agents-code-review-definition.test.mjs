/**
 * TDD RED tests for F-2 «Agent definition (code-review.js + .md)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-2» (TC-F-2-1, TC-F-2-2, TC-F-2-3).
 * Spec: docs/specs/spec_code-review-worker_2026-09-03.md (B-2: read-only + единственное
 * исключение — запись .fan/code-review/conventions.md через bash-heredoc).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   Создать extensions/fan-orchestrator/agents/code-review.{js,md} по образцу verify.{js,md}
 *   (10-й read-only воркер) и зарегистрировать в agents/index.js.
 *
 * TC-F-2-1: getAgentTypes() содержит "code-review" и увеличился 9 → 10;
 *           agents/code-review.js соответствует контракту:
 *           readOnly=true, icon="🔎", label="Code Reviewer",
 *           tools (sorted) ровно ["bash","find","grep","ls","read"].
 *           Критерий приёмки №1 карточки: регистрация последней —
 *           getAgentTypes().indexOf("code-review") === 9.
 * TC-F-2-2: agents/code-review.md содержит 10 обязательных секций
 *           (точный regex из roadmap TC-F-2-2), упоминает 4 стека
 *           (typescript/python/kotlin/rust), 6 вердиктов, conventions.md
 *           и heredoc-исключение (единственное исключение из read-only, спека B-2).
 * TC-F-2-3: error case — (a) битый YAML-frontmatter (":::invalid" вместо "---")
 *           не роняет процесс: loader либо бросает Error с "frontmatter",
 *           либо пропускает файл; остальные агенты и реестр живы;
 *           (b) соседний code-review-v2.md не создаёт нового типа:
 *           getAgentDefinition("code-review-v2") → undefined (только точное имя).
 *
 * Как тестируем loader (TC-F-2-3): agents/index.js — СТАТИЧЕСКИЙ реестр (статические
 * импорты, без файлового loader'а). Единственный механизм, читающий agents/*.md —
 * discoverAgents() из agents.js → loadAgentsFromDir() → parseFrontmatter()
 * (@seaagents/fan-coding-agent): он же грузит builtin-каталог agents/, где лежит
 * и будущий code-review.md. Тот же паттерн tmp-фикстур, что в
 * agents-consistency.test.mjs (F-0.1): fs.mkdtemp + .fan/agents в tmp-проекте,
 * scope "project" (user-каталог ~/.fan не затрагивается).
 *
 * Red-ожидание (roadmap): Red-тест карточки — TC-F-2-1: agents/code-review.{js,md}
 * не существуют, agents/index.js не импортирует их → getAgentTypes() возвращает 9
 * типов, динамический import("../agents/code-review.js") бросает ERR_MODULE_NOT_FOUND.
 * TC-F-2-2 падает следом (agents/code-review.md не существует → guard).
 * TC-F-2-3 ЗЕЛЁНЫЙ СРАЗУ и это НЕ нарушение Red: это error-case на СУЩЕСТВУЮЩЕМ
 * loader'е (parseFrontmatter/loadAgentsFromDir в F-2 не меняются) — fixture-гвард
 * для Green-фазы, как TC-F-1.3-2 в agents-security-routing.test.mjs.
 * Все падения должны читаться как «агента/файла нет», а не «тест сломан» —
 * guard-хелперы дают понятные сообщения.
 *
 * РЕШЕНИЕ ПО REGEX СЕКЦИЙ (TC-F-2-2): используется ТОЧНЫЙ regex из roadmap —
 * /^## (...)/gm БЕЗ $-якоря конца строки: заголовки секций могут нести уточнения
 * после имени (прецедент verify.md: «## ROLE BOUNDARY — FRESH DIFF ONLY»).
 * toHaveLength(10) гарантирует, что каждая секция встречается ровно один раз.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDefinition, getAgentTypes } from "../agents/index.js";
import { discoverAgents } from "../agents.js";

const CODE_REVIEW_TYPE = "code-review";
const CODE_REVIEW_JS_URL = new URL("../agents/code-review.js", import.meta.url);
const CODE_REVIEW_MD_URL = new URL("../agents/code-review.md", import.meta.url);

/** Ожидаемые tools — ровно как в roadmap F-2 (и в read-only эталоне verify.js). */
const EXPECTED_TOOLS_SORTED = ["bash", "find", "grep", "ls", "read"];

/** 10 обязательных секций code-review.md (roadmap TC-F-2-2, порядок как в карточке). */
const REQUIRED_SECTIONS = [
    "ROLE",
    "ROLE BOUNDARY",
    "CRITICAL RULES",
    "STEP 0",
    "STEP 1",
    "STEP 2",
    "STEP 3",
    "REVIEW CHECKLIST",
    "COMMON MISTAKES",
    "MANDATORY OUTPUT FORMAT",
];

/** Снимок реестра на момент старта: до Green — 9 типов, после Green — 10. */
const REGISTRY_SNAPSHOT = [...getAgentTypes()];

/**
 * Guard: agents/code-review.js существует и экспортирует definition.
 * Динамический import (не статический!) — чтобы в RED падал только TC-F-2-1,
 * а TC-F-2-3 оставался работоспособным. Форма экспорта — по образцу verify.js:
 * именованный `export const definition` (принимается и default, как в постановке).
 */
async function requireCodeReviewDefinition() {
    if (!fs.existsSync(CODE_REVIEW_JS_URL)) {
        throw new Error(
            "agents/code-review.js не существует — создай по образцу verify.js " +
                "(readOnly: true, icon: \"🔎\", label: \"Code Reviewer\", tools: [read, bash, grep, find, ls]) " +
                "и зарегистрируй в agents/index.js (roadmap F-2, Red-фаза).",
        );
    }
    try {
        const mod = await import(CODE_REVIEW_JS_URL.href);
        const def = mod.definition ?? mod.default;
        if (!def || typeof def !== "object") {
            throw new TypeError(
                "модуль не экспортирует definition (named export по образцу verify.js) ни default",
            );
        }
        return def;
    } catch (e) {
        throw new Error(
            `agents/code-review.js не импортируется: ${e.message} — ` +
                "исправь синтаксис/экспорты по образцу verify.js (roadmap F-2).",
        );
    }
}

/**
 * Guard: agents/code-review.md существует. Читается напрямую fs-ом —
 * тот же механизм, что loadAgentsFromDir (fs.readFileSync + regex по тексту).
 */
function requireCodeReviewMd() {
    if (!fs.existsSync(CODE_REVIEW_MD_URL)) {
        throw new Error(
            "agents/code-review.md не существует — создай по образцу verify.md, 10 секций: " +
                REQUIRED_SECTIONS.join(" → ") + " (roadmap F-2, Red-фаза).",
        );
    }
    return fs.readFileSync(CODE_REVIEW_MD_URL, "utf-8");
}

/**
 * Fixture: временный проект с .fan/agents/ (паттерн agents-consistency.test.mjs).
 * discoverAgents(projectDir, "project") грузит builtin (реальный agents/*.md),
 * project (наши tmp-файлы) и НЕ трогает user-каталог ~/.fan.
 */
function makeTmpProject() {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "f2-code-review-loader-"));
    const agentsDir = path.join(projectDir, ".fan", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    return {
        projectDir,
        agentsDir,
        cleanup() {
            fs.rmSync(projectDir, { recursive: true, force: true });
        },
    };
}

/** Валидный .md-агент (frontmatter по образцу verify.md) — санити «loader жив». */
function writeValidAgentMd(agentsDir, name) {
    const filePath = path.join(agentsDir, `${name}.md`);
    fs.writeFileSync(
        filePath,
        [
            "---",
            `name: ${name}`,
            `description: "Valid fixture agent ${name} for F-2 loader tests"`,
            "tools: read",
            "icon: 🧪",
            "---",
            "",
            `You are ${name}, a fixture agent used by the F-2 tests.`,
            "",
        ].join("\n"),
        "utf-8",
    );
    return filePath;
}

describe("F-2: Agent definition (agents/code-review.{js,md}, 10-й read-only воркер)", () => {
    it("TC-F-2-1: getAgentTypes() содержит code-review (9 → 10), definition соответствует контракту readOnly/icon/label/tools", async () => {
        // 1) Регистрация в реестре: тип присутствует, реестр вырос до 10.
        const types = getAgentTypes();
        expect(
            types,
            `getAgentTypes() (${types.length} шт.: ${types.join(", ")}) не содержит «${CODE_REVIEW_TYPE}» — ` +
                "создай agents/code-review.js и импортируй его в agents/index.js (roadmap F-2, TC-F-2-1)",
        ).toContain(CODE_REVIEW_TYPE);
        expect(
            types,
            `getAgentTypes() должен вырасти 9 → 10 после регистрации code-review ` +
                `(сейчас ${types.length}: ${types.join(", ")})`,
        ).toHaveLength(10);
        // Критерий приёмки №1 карточки F-2: 10-й воркер — последним в реестре.
        expect(
            types.indexOf(CODE_REVIEW_TYPE),
            "code-review должен регистрироваться ПОСЛЕДНИМ (getAgentTypes().indexOf === 9, критерий приёмки №1 F-2)",
        ).toBe(9);

        // 2) Контракт definition (agents/code-review.js).
        const codeReviewDef = await requireCodeReviewDefinition();
        expect(
            codeReviewDef.readOnly,
            "code-review должен быть read-only (параллельный слот, спека B-2; образец verify.js)",
        ).toBe(true);
        expect(codeReviewDef.icon, "иконка 10-го воркера в task widget — 🔎 (roadmap F-2)").toBe("🔎");
        expect(codeReviewDef.label, "label для UI task widget — \"Code Reviewer\" (roadmap F-2)").toBe(
            "Code Reviewer",
        );
        expect(
            [...codeReviewDef.tools].sort(),
            `tools code-review (sorted) должны быть ровно ${JSON.stringify(EXPECTED_TOOLS_SORTED)} — ` +
                `фактически: ${JSON.stringify([...(codeReviewDef.tools ?? [])].sort())}; ` +
                "набор как у read-only эталона verify.js",
        ).toEqual(EXPECTED_TOOLS_SORTED);
    });

    it("TC-F-2-2: code-review.md содержит 10 обязательных секций + 4 стека + 6 вердиктов + conventions.md + heredoc-исключение", () => {
        const text = requireCodeReviewMd();

        // 1) Точный regex из roadmap TC-F-2-2 (без $-якоря — см. решение в шапке файла).
        const matches = text.match(
            /^## (ROLE|ROLE BOUNDARY|CRITICAL RULES|STEP 0|STEP 1|STEP 2|STEP 3|REVIEW CHECKLIST|COMMON MISTAKES|MANDATORY OUTPUT FORMAT)/gm,
        );
        expect(
            matches ?? [],
            `найдено ${matches?.length ?? 0} из 10 секций (${(matches ?? []).join(" | ") || "нет"}) — ` +
                `каждая из [${REQUIRED_SECTIONS.join(", ")}] должна быть заголовком «## …» ровно один раз`,
        ).toHaveLength(10);

        // 2) Упоминания всех 4 стеков (STEP 1: stack detection → правила review-rules/<stack>.md).
        for (const stack of ["typescript", "python", "kotlin", "rust"]) {
            expect(
                text,
                `стек «${stack}» не упомянут в code-review.md — STEP 1 должен покрывать все 4 стека (roadmap F-2, TC-F-2-2)`,
            ).toMatch(new RegExp(stack, "i"));
        }

        // 3) Все 6 вердиктов (расширение verdict-модели: PASS/FAIL/PARTIAL — verify,
        //    APPROVED/CHANGES_REQUESTED/NEEDS_DISCUSSION — code-review, спека D4).
        for (const verdict of ["PASS", "FAIL", "PARTIAL", "APPROVED", "CHANGES_REQUESTED", "NEEDS_DISCUSSION"]) {
            expect(
                text,
                `вердикт «${verdict}» не упомянут в code-review.md — MANDATORY OUTPUT FORMAT должен покрывать 6 вердиктов (roadmap F-2, TC-F-2-2)`,
            ).toContain(verdict);
        }

        // 4) conventions.md + heredoc-исключение (единственное исключение из read-only, спека B-2).
        expect(
            text,
            "code-review.md не упоминает conventions.md — STEP 3 (.fan/code-review/conventions.md) обязателен (roadmap F-2, TC-F-2-2)",
        ).toContain("conventions.md");
        expect(
            text,
            "code-review.md не упоминает heredoc — запись conventions.md через bash-heredoc, единственное исключение из read-only (спека B-2)",
        ).toMatch(/heredoc/i);
    });

    it("TC-F-2-3: (a) битый YAML-frontmatter не роняет loader и реестр; (b) code-review-v2.md не создаёт новый тип", () => {
        // ─── Часть (a): corrupted frontmatter (:::invalid вместо --- делимитеров) ───
        const fixtureA = makeTmpProject();
        try {
            const corruptedPath = path.join(fixtureA.agentsDir, "code-review.md");
            fs.writeFileSync(corruptedPath, ":::invalid\nfoo: bar\n:::invalid\n", "utf-8");
            const validSiblingPath = writeValidAgentMd(fixtureA.agentsDir, "helper-f2-valid");

            // Запускаем тот же loader, что читает agents/*.md: discoverAgents → loadAgentsFromDir → parseFrontmatter.
            let thrown = null;
            let discovered = null;
            try {
                discovered = discoverAgents(fixtureA.projectDir, "project");
            } catch (e) {
                thrown = e;
            }

            if (thrown) {
                // Допустимая реакция №1: ЯВНАЯ ошибка с упоминанием frontmatter (не unhandled crash).
                expect(
                    thrown.message,
                    `loader упал с ошибкой без упоминания frontmatter: ${thrown.message} — ` +
                        "ожидается Error с 'frontmatter' либо graceful skip (roadmap F-2, TC-F-2-3)",
                ).toMatch(/frontmatter/i);
            } else {
                // Допустимая реакция №2: warning + skip (фактически loadAgentsFromDir молча пропускает).
                const loadedPaths = discovered.agents.map((a) => a.filePath);
                expect(
                    loadedPaths,
                    "битый code-review.md не должен попадать в discovered-агентов (graceful skip, roadmap F-2, TC-F-2-3)",
                ).not.toContain(corruptedPath);
                // Санити fixture: loader в целом работает — валидный сосед загружен.
                const projectNames = discovered.agents.filter((a) => a.source === "project").map((a) => a.name);
                expect(
                    projectNames,
                    "валидный сосед не загрузился — loader сломан не из-за frontmatter, тест-фикстура невалидна",
                ).toContain("helper-f2-valid");
                // Builtin-агенты (реальный agents/*.md) живы.
                expect(
                    discovered.agents.some((a) => a.source === "builtin"),
                    "builtin-агенты (agents/*.md) должны продолжать загружаться рядом с битым файлом",
                ).toBe(true);
            }

            // Реестр не пострадал в обеих реакциях: состав типов не изменился.
            expect(
                getAgentTypes(),
                "реестр (getAgentTypes) изменился после прогона loader'а на битом frontmatter — недопустимо (roadmap F-2, TC-F-2-3)",
            ).toEqual(REGISTRY_SNAPSHOT);
            expect(
                getAgentTypes(),
                "остальные типы должны оставаться живы при битом frontmatter (roadmap F-2, TC-F-2-3)",
            ).toContain("verify");
        } finally {
            fixtureA.cleanup();
        }

        // ─── Часть (b): code-review-v2.md не создаёт новый тип (только точное имя) ───
        const fixtureB = makeTmpProject();
        try {
            // Валидный code-review.md + соседний code-review-v2.md (roadmap TC-F-2-3b).
            writeValidAgentMd(fixtureB.agentsDir, "code-review");
            writeValidAgentMd(fixtureB.agentsDir, "code-review-v2");

            const discovered = discoverAgents(fixtureB.projectDir, "project");

            // Санити fixture: code-review-v2 виден как КАСТОМНЫЙ project-агент (.md-discovery работает)…
            const projectNames = discovered.agents.filter((a) => a.source === "project").map((a) => a.name);
            expect(
                projectNames,
                "санити: code-review-v2.md должен загружаться как кастомный project-агент",
            ).toContain("code-review-v2");
            // …но НЕ создаёт тип в реестре: getAgentDefinition по имени файла не резолвится.
            expect(
                getAgentDefinition("code-review-v2"),
                "getAgentDefinition('code-review-v2') должен быть undefined — только точное имя code-review.md матчится типом code-review (roadmap F-2, TC-F-2-3)",
            ).toBeUndefined();
            expect(
                getAgentTypes(),
                "code-review-v2 не должен появиться в getAgentTypes() — .md-discovery не создаёт built-in типов (семантика F-0.1)",
            ).not.toContain("code-review-v2");
            expect(getAgentTypes()).toEqual(REGISTRY_SNAPSHOT);
        } finally {
            fixtureB.cleanup();
        }
    });
});
