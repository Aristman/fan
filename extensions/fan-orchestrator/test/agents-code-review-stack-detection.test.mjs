/**
 * TDD RED tests for F-3 «Stack detection (манифесты → стек)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-3» (TC-F-3-1, TC-F-3-2, TC-F-3-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (STEP 1 воркера: детекция стека
 * по наличию манифестов; правила review-rules/<stack>.md подключаются по результату).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/stack-detection.js с экспортом detectStack(dir).
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо): в extension вспомогательные модули лежат ПЛОСКО
 *   в корне extensions/fan-orchestrator/ — agents.js, context-builder.js, pipeline-state.js,
 *   permissions.js, task-complexity.js и т.д. Подкаталог agents/ — только для определений
 *   воркеров (agents/<name>.{js,md,d.ts}). detectStack — чистый хелпер (переиспользуется
 *   F-4 rules loading и F-8 review workflow), значит — корень: stack-detection.js.
 *
 *   Контракт detectStack(dir) → string:
 *     - package.json     → "typescript"
 *     - pyproject.toml   → "python"
 *     - Cargo.toml       → "rust"
 *     - build.gradle.kts → "kotlin"   (pom.xml → тоже kotlin, вне TC этой карточки)
 *     - несколько манифестов → приоритет typescript > python > rust > kotlin
 *     - ни одного известного манифеста → "unknown" (БЕЗ падения — common-only правила)
 *   (Refactor-цель карточки: константа STACK_DETECTION_ORDER = ["typescript","python","rust","kotlin"]
 *   как single source of truth — Green волен её добавить, тесты фиксируют только detectStack.)
 *
 * TC-F-3-1: 4 tmp-директории, каждая с одним манифестом → detectStack(dir) даёт
 *           ["typescript", "python", "rust", "kotlin"] — детекция корректна 4/4.
 * TC-F-3-2: tmp-директория с package.json + pyproject.toml одновременно → "typescript"
 *           (при конфликте манифестов побеждает первый в приоритете).
 * TC-F-3-3: tmp-директория БЕЗ известных манифестов (только .txt) → detectStack
 *           возвращает "unknown" и НЕ бросает (воркер переходит на common-only правила).
 *
 * Фикстуры (constraint карточки): временные директории через fs.mkdtemp (tmpdir),
 * манифесты — ПУСТЫЕ файлы: детекция по наличию файла, содержимое не важно.
 * Паттерн makeTmpDir + cleanup — как makeTmpProject в agents-code-review-definition.test.mjs (F-2).
 *
 * Red-ожидание (roadmap + constraint задачи): ВСЕ 3 теста падают одинаково —
 * «Cannot find module ../stack-detection.js» (статический import сверху файла):
 * детектора ещё нет, и это ЕДИНСТВЕННО допустимая причина падения. Green-фаза
 * создаёт модуль ровно по зафиксированному пути — тесты зеленеют без правок.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack } from "../stack-detection.js";

/** Манифест → ожидаемый стек (roadmap F-3, порядок == приоритет typescript > python > rust > kotlin). */
const MANIFEST_TO_STACK = [
    { manifest: "package.json", expected: "typescript" },
    { manifest: "pyproject.toml", expected: "python" },
    { manifest: "Cargo.toml", expected: "rust" },
    { manifest: "build.gradle.kts", expected: "kotlin" },
];

/**
 * Fixture: tmp-директория проекта (паттерн F-2: mkdtemp + rmSync в cleanup).
 * touch(name) создаёт ПУСТОЙ файл — детекция стека идёт по наличию манифеста.
 */
function makeTmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        dir,
        touch(name) {
            fs.writeFileSync(path.join(dir, name), "", "utf-8");
        },
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe("F-3: Stack detection (манифесты → стек, stack-detection.js)", () => {
    it("TC-F-3-1: каждый из 4 манифестов однозначно маппит в стек", () => {
        for (const { manifest, expected } of MANIFEST_TO_STACK) {
            const fixture = makeTmpDir("f3-stack-single-");
            try {
                fixture.touch(manifest);
                expect(
                    detectStack(fixture.dir),
                    `манифест «${manifest}» должен детектироваться как «${expected}» (roadmap F-3, TC-F-3-1)`,
                ).toBe(expected);
            } finally {
                fixture.cleanup();
            }
        }
    });

    it("TC-F-3-2: приоритет при множественных манифестах: typescript > python", () => {
        const fixture = makeTmpDir("f3-stack-priority-");
        try {
            fixture.touch("package.json");
            fixture.touch("pyproject.toml");
            expect(
                detectStack(fixture.dir),
                "при package.json + pyproject.toml вместе побеждает typescript — первый в приоритете (roadmap F-3, TC-F-3-2)",
            ).toBe("typescript");
        } finally {
            fixture.cleanup();
        }
    });

    it("TC-F-3-3: ни одного известного манифеста → 'unknown' без падения", () => {
        const fixture = makeTmpDir("f3-stack-unknown-");
        try {
            // Только не-манифестный файл (roadmap TC-F-3-3: «только файлы .txt или пусто»).
            fixture.touch("README.txt");
            let stack;
            expect(
                () => {
                    stack = detectStack(fixture.dir);
                },
                "detectStack не должен бросать при отсутствии известных манифестов — graceful fallback в unknown (roadmap F-3, TC-F-3-3)",
            ).not.toThrow();
            expect(
                stack,
                "без известных манифестов detectStack возвращает 'unknown' — воркер продолжит с common-only правилами",
            ).toBe("unknown");
        } finally {
            fixture.cleanup();
        }
    });
});
