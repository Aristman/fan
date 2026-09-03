/**
 * TDD RED tests for F-4 «Rules loading pipeline (common + stack + conventions)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-4» (TC-F-4-1, TC-F-4-2, TC-F-4-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (STEP 2 промпта воркера — загрузка правил;
 * результат потребляет F-8 runReview → блок «## Loaded Rules» в worker context; rulesDir приходит
 * из F-13 CODE_REVIEW_RULES_DIR constraint injection).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/rules-loader.js с экспортом loadRules(projectDir, stack, rulesDir).
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо): вспомогательные модули лежат ПЛОСКО в корне
 *   extensions/fan-orchestrator/ — conventions.js (F-5), findings.js (F-9), stack-detection.js (F-3),
 *   context-builder.js, pipeline-state.js, permissions.js и т.д. Подкаталог agents/ — только для
 *   определений воркеров. Из двух кандидатов (rules-loader.js / rules-loading.js) выбран
 *   rules-loader.js — существительное + роль, как context-builder.js / preset-selector.js,
 *   а не отглагольное имя (loading).
 *
 *   Контракт loadRules(projectDir, stack, rulesDir) → { files: string[], warning?: string }:
 *     - ФУНКЦИЯ СИНХРОННАЯ (TC-F-4-3 использует expect(() => loadRules(...)).toThrow).
 *     - files — упорядоченный список путей (roadmap F-4: строго common → stack → conventions):
 *         1. <rulesDir>/common.md                          — общие правила (минимальное требование)
 *         2. <rulesDir>/<stack>.md                         — правила стека (только если файл существует)
 *         3. <projectDir>/.fan/code-review/conventions.md  — конвенции проекта (F-5, из projectDir)
 *     - stack === "unknown" ИЛИ <stack>.md отсутствует в rulesDir → files содержит ТОЛЬКО common.md
 *       (common-only, даже conventions не грузится), warning === "Stack unknown, using common rules only"
 *       (warning попадает в Review Scope отчёта).
 *     - <rulesDir>/common.md отсутствует → throw, сообщение содержит «common.md»
 *       (error, не warning — без common ревью не запускается).
 *
 * TC-F-4-1: tmp-проект (review-rules/common.md + review-rules/typescript.md +
 *           .fan/code-review/conventions.md) → loadRules(projectDir, "typescript", rulesDir) →
 *           files — массив из 3 путей по порядку: [0] endsWith common.md,
 *           [1] endsWith typescript.md, [2] endsWith .fan/code-review/conventions.md;
 *           warning отсутствует (undefined).
 * TC-F-4-2: stack = "unknown" → files содержит только common.md (даже typescript.md и
 *           conventions.md в фикстуре НЕ попадают в files); warning === "Stack unknown, using
 *           common rules only".
 * TC-F-4-3: rulesDir без common.md (только typescript.md) → loadRules бросает,
 *           сообщение содержит «common.md».
 *
 * Фикстуры (constraint карточки): tmp-директории через fs.mkdtemp (tmpdir) —
 * review-rules/ с common.md/<stack>.md + .fan/code-review/conventions.md;
 * cleanup — rmSync в finally. Паттерн makeTmpDir + cleanup — как в
 * conventions-schema.test.mjs (F-5) и agents-code-review-stack-detection.test.mjs (F-3).
 *
 * Red-ожидание (roadmap F-4 «Red-тест: TC-F-4-1» + constraint задачи): ВСЕ 3 теста падают
 * одинаково — «Cannot find module ../rules-loader.js» (статический import сверху файла):
 * loadRules ещё не реализован, и это ЕДИНСТВЕННО допустимая причина падения. Green-фаза
 * создаёт модуль ровно по зафиксированному пути — тесты зеленеют без правок.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRules } from "../rules-loader.js";

/** Содержимое фикстурных правил (зеркало реального корpusa review-rules/, F-1). */
const RULE_CONTENTS = {
    "common.md": "# Common review rules\n\n- Check error handling on every public API boundary.\n",
    "typescript.md": "# TypeScript rules\n\n- No implicit any; prefer readonly for public fields.\n",
    "conventions.md": [
        "---",
        "stack: typescript",
        "last_analyzed: 2026-09-03T12:00:00Z",
        "analyzed_files:",
        "  - src/index.ts",
        "---",
        "",
        "## Style",
        "",
        "- Prefer named exports.",
    ].join("\n"),
};

/**
 * Fixture: tmp-проект (паттерн F-3/F-5: mkdtemp + rmSync в cleanup).
 * Создаёт <dir>/review-rules/ с перечисленными правилами и (опционально)
 * <dir>/.fan/code-review/conventions.md — те же относительные пути, по которым
 * воркер читает правила в реальном проекте (roadmap F-4, arrange TC-F-4-1).
 */
function makeTmpProject(prefix, { rules = [], withConventions = false }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const rulesDir = path.join(dir, "review-rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    for (const name of rules) {
        fs.writeFileSync(path.join(rulesDir, name), RULE_CONTENTS[name] ?? `# ${name}\n`, "utf-8");
    }
    let conventionsPath = null;
    if (withConventions) {
        conventionsPath = path.join(dir, ".fan", "code-review", "conventions.md");
        fs.mkdirSync(path.dirname(conventionsPath), { recursive: true });
        fs.writeFileSync(conventionsPath, RULE_CONTENTS["conventions.md"], "utf-8");
    }
    return {
        dir,
        rulesDir,
        conventionsPath,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe("F-4: Rules loading pipeline (common + stack + conventions, rules-loader.js)", () => {
    it("TC-F-4-1: порядок загрузки строго common → typescript → conventions", () => {
        const fixture = makeTmpProject("f4-rules-full-", {
            rules: ["common.md", "typescript.md"],
            withConventions: true,
        });
        try {
            const result = loadRules(fixture.dir, "typescript", fixture.rulesDir);
            expect(
                result.files,
                "files должен быть массивом из 3 путей — по одному на каждую ступень пайплайна (roadmap F-4, TC-F-4-1)",
            ).toHaveLength(3);
            expect(
                result.files[0].endsWith("common.md"),
                "первая ступень — общие правила common.md из rulesDir (roadmap F-4: порядок common → stack → conventions)",
            ).toBe(true);
            expect(
                result.files[1].endsWith("typescript.md"),
                "вторая ступень — правила стека <stack>.md из rulesDir (roadmap F-4, TC-F-4-1)",
            ).toBe(true);
            expect(
                result.files[2].endsWith(path.join(".fan", "code-review", "conventions.md")),
                "третья ступень — конвенции проекта из projectDir (.fan/code-review/conventions.md, F-5), а не из rulesDir (roadmap F-4, TC-F-4-1)",
            ).toBe(true);
            expect(
                result.warning,
                "на happy path warning отсутствует — warning появляется только при unknown-стеке (контракт {files, warning?})",
            ).toBeUndefined();
        } finally {
            fixture.cleanup();
        }
    });

    it("TC-F-4-2: stack unknown → common-only + warning «Stack unknown, using common rules only»", () => {
        const fixture = makeTmpProject("f4-rules-unknown-", {
            rules: ["common.md", "typescript.md"],
            withConventions: true,
        });
        try {
            const result = loadRules(fixture.dir, "unknown", fixture.rulesDir);
            expect(
                result.files,
                "при unknown-стеке files содержит только common.md — common-only, стековые и conventions-файлы не грузятся (roadmap F-4, TC-F-4-2)",
            ).toHaveLength(1);
            expect(
                result.files[0].endsWith("common.md"),
                "единственный файл — common.md из rulesDir (roadmap F-4, TC-F-4-2)",
            ).toBe(true);
            expect(
                result.warning,
                "warning должен явно сообщать о fallback на common-only — попадает в Review Scope (roadmap F-4, TC-F-4-2)",
            ).toBe("Stack unknown, using common rules only");
        } finally {
            fixture.cleanup();
        }
    });

    it("TC-F-4-3: rulesDir без common.md → throw с упоминанием common.md в сообщении", () => {
        const fixture = makeTmpProject("f4-rules-nocommon-", {
            rules: ["typescript.md"],
            withConventions: false,
        });
        try {
            expect(
                () => loadRules(fixture.dir, "typescript", fixture.rulesDir),
                "отсутствие common.md — error, а не warning: без общих правил ревью не запускается (roadmap F-4, TC-F-4-3)",
            ).toThrow(/common\.md/);
        } finally {
            fixture.cleanup();
        }
    });
});
