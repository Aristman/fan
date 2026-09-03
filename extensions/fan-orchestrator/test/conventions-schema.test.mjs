/**
 * TDD RED tests for F-5 «Conventions.md schema (frontmatter + секции)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-5» (TC-F-5-1, TC-F-5-2, TC-F-5-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (формат .fan/code-review/conventions.md —
 * project-local — и .fan/code-review/conventions.<name>.md для внешних репо; схему переиспользуют
 * F-6 lifecycle (merge customSections) и F-7 внешние репо).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/conventions.js с экспортом parseConventions(path).
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо): в extension вспомогательные модули лежат ПЛОСКО
 *   в корне extensions/fan-orchestrator/ — agents.js, context-builder.js, pipeline-state.js,
 *   permissions.js, task-complexity.js, stack-detection.js (F-3) и т.д. Подкаталог agents/ —
 *   только для определений воркеров. parseConventions — чистый парсер данных (переиспользуется
 *   F-6 lifecycle и F-7 внешние репо), roadmap-карточка явно называет «conventions.js» —
 *   значит, корень extension: conventions.js.
 *
 *   Контракт parseConventions(path) → объект:
 *     - stack: string            — из frontmatter, обязательное поле
 *     - lastAnalyzed: Date       — из frontmatter last_analyzed (ISO 8601), парсится в Date, обязательное
 *     - analyzedFiles: string[]  — из frontmatter, non-empty array строк, обязательное
 *     - sections: { style, architecture, patterns } — стандартные секции тела (## Style, ## Architecture, ## Patterns)
 *     - customSections: { [name]: text } — ЛЮБЫЕ другие «## …» секции тела (ручные правки пользователя)
 *   Frontmatter — YAML между маркерами «---» в начале файла.
 *   Валидация: отсутствие любого обязательного поля frontmatter → throw, сообщение содержит
 *   ИМЯ отсутствующего поля (тесты фиксируют /analyzed_files/).
 *   (Refactor-цель карточки: gray-matter/Zod-схема — в зависимостях orchestrator их нет,
 *   Green волен парсить regex'ом; тесты фиксируют только контракт parseConventions.)
 *
 * TC-F-5-1: tmp conventions.md с валидным frontmatter (stack: typescript,
 *           last_analyzed: 2026-09-03T12:00:00Z, analyzed_files: [src/index.ts, src/cli/init.ts])
 *           + 3 секции → stack === "typescript", lastAnalyzed instanceof Date,
 *           analyzedFiles.length === 2, sections.style непуста (плюс architecture/patterns —
 *           «секции доступны как sections[key]»).
 * TC-F-5-2: tmp conventions.md без analyzed_files → parseConventions бросает,
 *           сообщение содержит «analyzed_files».
 * TC-F-5-3: tmp conventions.md + ручная секция «## Custom Notes» →
 *           result.customSections["Custom Notes"] содержит текст секции (не теряется при парсинге —
 *           база для merge в F-6).
 *
 * Фикстуры (constraint карточки): tmp-файлы conventions.md через fs.mkdtemp (tmpdir),
 * frontmatter — YAML между «---» маркерами; cleanup — rmSync в finally.
 * Паттерн makeTmpDir + cleanup — как в agents-code-review-stack-detection.test.mjs (F-3).
 *
 * Red-ожидание (roadmap + constraint задачи): ВСЕ 3 теста падают одинаково —
 * «Cannot find module ../conventions.js» (статический import сверху файла):
 * парсера ещё нет, и это ЕДИНСТВЕННО допустимая причина падения. Green-фаза
 * создаёт модуль ровно по зафиксированному пути — тесты зеленеют без правок.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConventions } from "../conventions.js";

/** Валидный frontmatter для TC-F-5-1/TC-F-5-3 (roadmap TC-F-5-1: 3 обязательных поля). */
const VALID_FRONTMATTER = [
    "---",
    "stack: typescript",
    "last_analyzed: 2026-09-03T12:00:00Z",
    "analyzed_files:",
    "  - src/index.ts",
    "  - src/cli/init.ts",
    "---",
].join("\n");

/** Стандартные 3 секции тела (roadmap F-5: ## Style, ## Architecture, ## Patterns со списками). */
const STANDARD_SECTIONS = [
    "## Style",
    "",
    "- Prefer named exports; default export only for extension entry points.",
    "",
    "## Architecture",
    "",
    "- Helper modules live flat in the extension root; agents/ only for worker definitions.",
    "",
    "## Patterns",
    "",
    "- Schema violations throw with the missing field name in the message.",
].join("\n");

/**
 * Fixture: tmp-директория с conventions.md (паттерн F-3: mkdtemp + rmSync в cleanup).
 * writeConventions(content) создаёт .fan/code-review/conventions.md — тот же относительный
 * путь, по которому воркер читает файл в реальном проекте (roadmap F-5: project-local формат).
 */
function makeTmpConventions(prefix, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, ".fan", "code-review", "conventions.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
    return {
        dir,
        file,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe("F-5: Conventions.md schema (frontmatter + секции, conventions.js)", () => {
    it("TC-F-5-1: parseConventions читает frontmatter (3 обязательных поля) и 3 секции", () => {
        const fixture = makeTmpConventions("f5-conv-valid-", `${VALID_FRONTMATTER}\n\n${STANDARD_SECTIONS}\n`);
        try {
            const result = parseConventions(fixture.file);
            expect(
                result.stack,
                "stack из frontmatter должен читаться как строка (roadmap F-5, TC-F-5-1)",
            ).toBe("typescript");
            expect(
                result.lastAnalyzed,
                "last_analyzed (ISO 8601) должен парситься в Date — база для триггера «>30 дней» в F-6",
            ).toBeInstanceOf(Date);
            expect(
                result.lastAnalyzed.toISOString(),
                "lastAnalyzed должен сохранять момент времени из ISO 8601 строки",
            ).toBe("2026-09-03T12:00:00.000Z");
            expect(
                result.analyzedFiles,
                "analyzed_files должен читаться в массив из 2 строк (roadmap F-5, TC-F-5-1)",
            ).toHaveLength(2);
            expect(
                result.sections.style,
                "sections.style должен быть непустым — стандартные секции тела доступны как sections[key] (roadmap F-5, TC-F-5-1)",
            ).toBeTruthy();
            expect(result.sections.architecture, "sections.architecture доступен как sections[key]").toBeTruthy();
            expect(result.sections.patterns, "sections.patterns доступен как sections[key]").toBeTruthy();
        } finally {
            fixture.cleanup();
        }
    });

    it("TC-F-5-2: frontmatter без analyzed_files → throw с именем поля в сообщении", () => {
        const frontmatterWithoutAnalyzedFiles = [
            "---",
            "stack: typescript",
            "last_analyzed: 2026-09-03T12:00:00Z",
            "---",
        ].join("\n");
        const fixture = makeTmpConventions(
            "f5-conv-missing-",
            `${frontmatterWithoutAnalyzedFiles}\n\n${STANDARD_SECTIONS}\n`,
        );
        try {
            expect(
                () => parseConventions(fixture.file),
                "отсутствие обязательного поля analyzed_files должно бросать ошибку (roadmap F-5, TC-F-5-2)",
            ).toThrow(/analyzed_files/);
        } finally {
            fixture.cleanup();
        }
    });

    it("TC-F-5-3: ручная секция ## Custom Notes сохраняется в customSections", () => {
        const customSection = ["## Custom Notes", "", "- Never use `any` без явного обоснования в public API."].join(
            "\n",
        );
        const fixture = makeTmpConventions(
            "f5-conv-custom-",
            `${VALID_FRONTMATTER}\n\n${STANDARD_SECTIONS}\n\n${customSection}\n`,
        );
        try {
            const result = parseConventions(fixture.file);
            expect(
                result.customSections["Custom Notes"],
                "ручная секция ## Custom Notes должна попасть в customSections — парсер не теряет пользовательские секции (roadmap F-5, TC-F-5-3; merge для F-6)",
            ).toContain("без явного обоснования");
        } finally {
            fixture.cleanup();
        }
    });
});
