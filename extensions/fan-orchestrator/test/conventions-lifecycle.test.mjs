/**
 * TDD RED tests for F-6 «Conventions auto-profile lifecycle (генерация + регенерация)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-6» (TC-F-6-1, TC-F-6-2, TC-F-6-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (STEP 3 промпта code-review:
 * 3 триггера регенерации .fan/code-review/conventions.md; bash-heredoc запись;
 * customSections из parseConventions (F-5) переживают регенерацию).
 *
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/conventions-lifecycle.js с экспортом
 *   regenerateConventions(projectDir, options).
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо, зафиксировано): плоско в корне extension —
 *   conventions-lifecycle.js. Вспомогательные модули orchestrator лежат ПЛОСКО
 *   в корне extensions/fan-orchestrator/ (agents.js, context-builder.js,
 *   pipeline-state.js, stack-detection.js, findings.js, conventions.js (F-5) и т.д.).
 *   Карточка F-6, в отличие от F-5, модуль НЕ называет; lifecycle — отдельная
 *   ответственность (триггеры + генерация + heredoc) поверх чистого парсера
 *   conventions.js, который реиспользуется как есть; имя тест-файла
 *   conventions-lifecycle.test.mjs зеркалит имя модуля.
 *
 *   Контракт: regenerateConventions(projectDir, options) → {regenerated: boolean, reason: string}
 *     options:
 *       - stack: string (required)           — стек для frontmatter (один из STACK_DETECTION_ORDER)
 *       - analyzedFiles: string[] (required) — актуальный список файлов (review scope / disk)
 *       - executeBash?: (command: string) => void|Promise<void> — ОПЦИОНАЛЕН:
 *           · передан → файл пишется РОВНО ОДНОЙ bash-командой heredoc (путь сужен до
 *             .fan/code-review/conventions*.md, относительный к projectDir):
 *                 cat > .fan/code-review/conventions.md << 'EOF'
 *                 <new content>
 *                 EOF
 *           · НЕ передан → прямая fs-запись содержимого в projectDir/.fan/code-review/conventions.md
 *     Триггеры регенерации (достаточно первого сработавшего):
 *       1. .fan/code-review/conventions.md отсутствует / не парсится (parseConventions (F-5)
 *          бросает, включая отсутствие файла) → регенерация с нуля;
 *       2. frontmatter last_analyzed старше 30 дней → регенерация;
 *       3. frontmatter analyzed_files ≠ options.analyzedFiles (список изменился) → регенерация;
 *       ни один не сработал → {regenerated: false, reason: "no triggers fired" или эквивалент},
 *       файл байт-в-байт не меняется, executeBash НЕ вызывается.
 *     При регенерации: customSections (ручные «## …» секции, parseConventions.customSections)
 *       сохраняются и попадают в новое тело; Style/Architecture/Patterns + frontmatter
 *       (stack: options.stack, last_analyzed: текущий момент, analyzed_files: options.analyzedFiles)
 *       генерируются заново. Результат регенерации: {regenerated: true, reason: <триггер>}.
 *
 * TC-F-6-1: триггеры «файл отсутствует» и «last_analyzed > 30 дней»:
 *   (a) conventions.md не существует → после вызова создан: frontmatter stack: typescript,
 *       last_analyzed — текущий момент, analyzed_files непустой;
 *   (b) conventions.md с last_analyzed: 2026-07-01T00:00:00Z (roadmap-фикстура, > 30 дней от
 *       «сегодня» 2026-09-03) + ручная секция «## Custom Notes» → last_analyzed обновлён
 *       до текущего момента, «## Custom Notes» сохранена.
 * TC-F-6-2: триггер «analyzed_files изменились» (в файле [src/a.ts], актуальный список
 *   [src/a.ts, src/b.ts]) → файл обновлён; в моке executeBash РОВНО ОДНА команда вида
 *   cat > .fan/code-review/conventions.md << 'EOF' … EOF (heredoc-путь сужен до
 *   conventions*.md — без абсолютных путей, без «..», только .fan/code-review/).
 * TC-F-6-3: все триггеры ложны (last_analyzed свежий + analyzed_files совпадает) →
 *   файл байт-в-байт НЕ изменён, executeBash НЕ вызван, результат {regenerated: false}.
 *
 * Даты в тестах: СТАРАЯ фиксированная — 2026-07-01T00:00:00Z (roadmap-карточка F-6,
 * «сегодня» в этой фиче-ветке — 2026-09-03, т.е. 64 дня, триггер «>30 дней» срабатывает
 * на любой дате запуска ≥ 2026-07-31); СВЕЖАЯ — new Date() в момент arrange (всегда
 * «сегодня», триггер «>30 дней» гарантированно молчит). Ассерт «last_analyzed обновлён
 * до текущего момента» допускает ISO-момент в пределах последних 26 часов (полный
 * timestamp «прямо сейчас» или date-only «полночь сегодня» — оба валидный ISO 8601).
 *
 * Мок executeBash: протоколирует команды И применяет heredoc-запись к fs (как реальный
 * bash) — ассерты на содержимое файла проходят; guard'ы мока отклоняют команду вне
 * сужения .fan/code-review/conventions*.md. Валидация итогового файла — через
 * parseConventions из conventions.js (F-5, уже реализован).
 *
 * Red-ожидание (roadmap + constraint задачи): все 3 теста падают одинаково —
 * «Cannot find module ../conventions-lifecycle.js» (статический import сверху файла):
 * regenerateConventions ещё не существует, и это ЕДИНСТВЕННО допустимая причина падения.
 * Green-фаза создаёт модуль ровно по зафиксированному пути — тесты зеленеют без правок.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConventions } from "../conventions.js";
import { regenerateConventions } from "../conventions-lifecycle.js";

/** Roadmap-фикстура просроченной даты: 2026-07-01 — 64 дня до «сегодня» (2026-09-03), > 30 дней. */
const STALE_DATE = "2026-07-01T00:00:00Z";

/** Допуск для «last_analyzed = сейчас»: полный ISO-таймстамп или date-only полночь сегодня. */
const NOW_TOLERANCE_MS = 26 * 60 * 60 * 1000;

/** Срок жизни профиля (roadmap F-6, триггер 2): last_analyzed старше 30 дней → регенерация. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Стандартные секции тела (формат F-5: ## Style, ## Architecture, ## Patterns со списками). */
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

/** Ручная секция пользователя (data contract F-5: parseConventions отдаёт её в customSections). */
const CUSTOM_NOTES_SECTION = ["## Custom Notes", "", "- Никогда не использовать `any` без явного обоснования в public API."].join(
    "\n",
);

/** Уникальный маркер ручной секции для ассерта «пережила регенерацию». */
const CUSTOM_NOTES_MARKER = "без явного обоснования";

/**
 * Fixture: tmp-директория проекта (паттерн F-3/F-5: mkdtemp + rmSync в cleanup).
 * writeConventions(content) кладёт .fan/code-review/conventions.md — относительный путь,
 * по которому воркер читает/пишет файл в реальном проекте (roadmap F-5/F-6).
 * createSourceFile(relPath) создаёт файл «на диске» — актуальный review scope.
 */
function makeTmpProject(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const conventionsPath = path.join(dir, ".fan", "code-review", "conventions.md");
    return {
        dir,
        conventionsPath,
        writeConventions(content) {
            fs.mkdirSync(path.dirname(conventionsPath), { recursive: true });
            fs.writeFileSync(conventionsPath, content, "utf-8");
        },
        createSourceFile(relPath) {
            const abs = path.join(dir, relPath);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, `// ${relPath}\n`, "utf-8");
        },
        readConventionsRaw() {
            return fs.readFileSync(conventionsPath, "utf-8");
        },
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 * Мок bash-исполнителя (контракт F-6): (1) протоколирует каждую команду;
 * (2) применяет heredoc-запись к fs — как реальный bash, чтобы ассерты на файл проходили;
 * (3) guard'ы: только «cat > <rel> << 'EOF' … EOF», относительный путь строго внутри
 * сужения .fan/code-review/conventions*.md (без абсолютных путей и «..»).
 */
function makeExecuteBashMock(projectDir) {
    const commands = [];
    const executeBash = (command) => {
        commands.push(command);
        const lines = command.split("\n");
        const header = lines[0].match(/^cat > (\S+) << 'EOF'$/);
        if (!header) {
            throw new Error(
                `mock executeBash: ожидалась одна heredoc-команда "cat > <path> << 'EOF' … EOF", получено: ${JSON.stringify(command.slice(0, 120))}`,
            );
        }
        const relPath = header[1];
        if (!/^\.fan\/code-review\/conventions[a-z0-9.-]*\.md$/.test(relPath)) {
            throw new Error(
                `mock executeBash: heredoc-путь должен быть относительным и сужён до .fan/code-review/conventions*.md, получено: "${relPath}"`,
            );
        }
        if (lines[lines.length - 1] !== "EOF") {
            throw new Error(`mock executeBash: heredoc должен заканчиваться строкой "EOF"`);
        }
        const content = lines.slice(1, -1).join("\n");
        const absPath = path.join(projectDir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
    };
    return { commands, executeBash };
}

/** Свежий frontmatter (last_analyzed = сейчас): триггер «>30 дней» гарантированно молчит. */
function freshFrontmatter(analyzedFiles) {
    return [
        "---",
        "stack: typescript",
        `last_analyzed: ${new Date().toISOString()}`,
        "analyzed_files:",
        ...analyzedFiles.map((file) => `  - ${file}`),
        "---",
    ].join("\n");
}

describe("F-6: Conventions auto-profile lifecycle (conventions-lifecycle.js)", () => {
    it("TC-F-6-1: файл отсутствует ИЛИ last_analyzed > 30 дней → регенерация, customSections сохраняются", async () => {
        // ── (a) conventions.md не существует → файл создан с валидным frontmatter ──
        const projectA = makeTmpProject("f6-lifecycle-missing-");
        projectA.createSourceFile("src/index.ts");
        const bashA = makeExecuteBashMock(projectA.dir);
        try {
            const resultA = await regenerateConventions(projectA.dir, {
                stack: "typescript",
                analyzedFiles: ["src/index.ts"],
                executeBash: bashA.executeBash,
            });
            expect(
                resultA.regenerated,
                "триггер «файл отсутствует» должен дать regenerated: true (roadmap TC-F-6-1a)",
            ).toBe(true);
            expect(
                fs.existsSync(projectA.conventionsPath),
                "после регенерации .fan/code-review/conventions.md должен существовать (roadmap TC-F-6-1a)",
            ).toBe(true);

            const parsedA = parseConventions(projectA.conventionsPath);
            expect(
                parsedA.stack,
                "frontmatter созданного файла должен содержать stack: typescript (roadmap TC-F-6-1a)",
            ).toBe("typescript");
            expect(
                parsedA.lastAnalyzed.getTime(),
                "last_analyzed созданного файла — текущий момент (roadmap TC-F-6-1a: last_analyzed — текущая дата)",
            ).toBeGreaterThan(Date.now() - NOW_TOLERANCE_MS);
            expect(
                parsedA.lastAnalyzed.getTime(),
                "last_analyzed не может быть из будущего",
            ).toBeLessThanOrEqual(Date.now() + 60_000);
            expect(
                parsedA.analyzedFiles.length,
                "analyzed_files созданного файла — непустой массив (roadmap TC-F-6-1a)",
            ).toBeGreaterThan(0);
            expect(parsedA.analyzedFiles).toContain("src/index.ts");
            // heredoc-путь записал файл в projectDir-локальный conventions.md
            expect(
                bashA.commands.length,
                "запись через мок executeBash — ровно одна heredoc-команда",
            ).toBe(1);
        } finally {
            projectA.cleanup();
        }

        // ── (b) last_analyzed: 2026-07-01 (> 30 дней) + ## Custom Notes → обновление + merge ──
        const projectB = makeTmpProject("f6-lifecycle-stale-");
        projectB.createSourceFile("src/a.ts");
        projectB.writeConventions(
            [
                "---",
                "stack: typescript",
                `last_analyzed: ${STALE_DATE}`,
                "analyzed_files:",
                "  - src/a.ts",
                "---",
                "",
                STANDARD_SECTIONS,
                "",
                CUSTOM_NOTES_SECTION,
                "",
            ].join("\n"),
        );
        const bashB = makeExecuteBashMock(projectB.dir);
        try {
            const resultB = await regenerateConventions(projectB.dir, {
                stack: "typescript",
                analyzedFiles: ["src/a.ts"], // совпадает с frontmatter — срабатывает ТОЛЬКО триггер «>30 дней»
                executeBash: bashB.executeBash,
            });
            expect(
                resultB.regenerated,
                "триггер «last_analyzed > 30 дней» должен дать regenerated: true (roadmap TC-F-6-1b)",
            ).toBe(true);

            const parsedB = parseConventions(projectB.conventionsPath);
            expect(
                parsedB.lastAnalyzed.getTime(),
                "last_analyzed должен быть обновлён до текущего момента, а не 2026-07-01 (roadmap TC-F-6-1b)",
            ).toBeGreaterThan(Date.now() - NOW_TOLERANCE_MS);
            expect(
                parsedB.lastAnalyzed.getTime(),
                "обновлённый last_analyzed не может быть из будущего",
            ).toBeLessThanOrEqual(Date.now() + 60_000);
            expect(
                parsedB.customSections["Custom Notes"],
                "ручная секция ## Custom Notes должна пережить регенерацию (roadmap F-6: merge customSections обратно)",
            ).toContain(CUSTOM_NOTES_MARKER);
            expect(
                parsedB.stack,
                "stack при регенерации берётся из options.stack",
            ).toBe("typescript");
        } finally {
            projectB.cleanup();
        }
    });

    it("TC-F-6-2: analyzed_files изменились → регенерация; heredoc-команда ровно одна, путь сужен до conventions*.md", async () => {
        const project = makeTmpProject("f6-lifecycle-files-diff-");
        project.createSourceFile("src/a.ts");
        project.createSourceFile("src/b.ts"); // воркер видит новый файл
        project.writeConventions(
            [
                freshFrontmatter(["src/a.ts"]), // last_analyzed свежий — триггер «>30 дней» молчит
                "",
                STANDARD_SECTIONS,
                "",
            ].join("\n"),
        );
        const bash = makeExecuteBashMock(project.dir);
        try {
            const result = await regenerateConventions(project.dir, {
                stack: "typescript",
                analyzedFiles: ["src/a.ts", "src/b.ts"], // отличается от frontmatter [src/a.ts]
                executeBash: bash.executeBash,
            });
            expect(
                result.regenerated,
                "триггер «analyzed_files изменились» должен дать regenerated: true (roadmap TC-F-6-2)",
            ).toBe(true);

            // В моке ровно ОДНА команда — и это heredoc-запись с сужённым путём
            expect(
                bash.commands.length,
                "bash-мок должен получить РОВНО ОДНУ команду (roadmap TC-F-6-2: одна heredoc-запись)",
            ).toBe(1);
            expect(
                bash.commands[0],
                "единственная bash-команда — cat > .fan/code-review/conventions.md << 'EOF' (путь сужен до conventions*.md)",
            ).toMatch(/^cat > \.fan\/code-review\/conventions[a-z0-9.-]*\.md << 'EOF'\n[\s\S]*\nEOF$/);

            // Мок применил heredoc к fs → новый файл читается парсером F-5
            const parsed = parseConventions(project.conventionsPath);
            expect(
                [...parsed.analyzedFiles].sort(),
                "analyzed_files в обновлённом файле должен содержать оба файла: src/a.ts и src/b.ts (roadmap TC-F-6-2)",
            ).toEqual(["src/a.ts", "src/b.ts"]);
            expect(
                parsed.lastAnalyzed.getTime(),
                "last_analyzed при регенерации обновляется до текущего момента",
            ).toBeGreaterThan(Date.now() - NOW_TOLERANCE_MS);
        } finally {
            project.cleanup();
        }
    });

    it("TC-F-6-3: все триггеры ложны → файл байт-в-байт не изменён, executeBash НЕ вызван, {regenerated: false}", async () => {
        const project = makeTmpProject("f6-lifecycle-cache-hit-");
        project.createSourceFile("src/a.ts");
        const before = [
            freshFrontmatter(["src/a.ts"]), // last_analyzed = сейчас (триггер «>30 дней» молчит)
            "",
            STANDARD_SECTIONS,
            "",
            CUSTOM_NOTES_SECTION,
            "",
        ].join("\n");
        project.writeConventions(before);
        const bytesBefore = fs.readFileSync(project.conventionsPath);
        const bash = makeExecuteBashMock(project.dir);
        try {
            const result = await regenerateConventions(project.dir, {
                stack: "typescript",
                analyzedFiles: ["src/a.ts"], // совпадает с frontmatter — триггер «analyzed_files изменились» молчит
                executeBash: bash.executeBash,
            });

            expect(
                result.regenerated,
                "cache-hit: ни один триггер не сработал → regenerated: false (roadmap TC-F-6-3)",
            ).toBe(false);
            expect(
                typeof result.reason === "string" && result.reason.length > 0,
                "результат должен содержать непустую reason (roadmap TC-F-6-3: «no triggers fired» или эквивалент)",
            ).toBe(true);
            expect(
                bash.commands.length,
                "executeBash НЕ должен вызываться при cache-hit (воркер не делает лишних записей, roadmap TC-F-6-3)",
            ).toBe(0);
            expect(
                fs.readFileSync(project.conventionsPath).equals(bytesBefore),
                "conventions.md должен остаться байт-в-байт тем же (roadmap TC-F-6-3: файл НЕ перезаписан)",
            ).toBe(true);

            // кэш остаётся валидным для парсера F-5 и customSections не тронуты
            const parsed = parseConventions(project.conventionsPath);
            expect(parsed.customSections["Custom Notes"], "ручная секция в кэше не тронута").toContain(
                CUSTOM_NOTES_MARKER,
            );
            expect(
                Date.now() - parsed.lastAnalyzed.getTime(),
                "свежий last_analyzed (возраст < 30 дней) — триггер «>30 дней» обязан молчать",
            ).toBeLessThan(THIRTY_DAYS_MS);
        } finally {
            project.cleanup();
        }
    });
});
