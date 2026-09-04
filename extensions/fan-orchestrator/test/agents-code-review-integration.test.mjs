/**
 * TDD RED tests for F-8 «Diff-only review workflow (git diff → findings → verdict)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-8» (TC-F-8-1, TC-F-8-2, TC-F-8-3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md → «F-4. Diff-only ревью» + MANDATORY OUTPUT
 * FORMAT (Review Scope → Findings → Summary Table → Security Handoffs → VERDICT).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/review-runner.js с экспортом runReview. Модуль лежит ПЛОСКО
 *   в корне extension (конвенция репо: rules-loader.js, findings.js, stack-detection.js — F-4/F-9/F-3);
 *   имя review-runner.js зафиксировано roadmap-карточкой F-8 («Refactor-цели: вынести runReview в
 *   отдельный модуль review-runner.js»).
 *
 *   runReview(options, deps?) → Promise<ReviewResult>   — ASYNC-контракт (тесты await/rejects).
 *
 *     options:
 *       - projectDir?: string — директория проекта, сценарий (b) спеки «base + cwd»;
 *       - path?: string       — локальный путь к ДРУГОМУ проекту, сценарий (c) спеки; работает в
 *                               целевой директории БЕЗ клонирования (git clone — только F-7/gitUrl);
 *                               целевая директория = path ?? projectDir (ровно одна обязательна);
 *       - base: string        — ОБЯЗАТЕЛЬНЫЙ ref (commit/branch/tag); diff = git diff <base>...HEAD;
 *       - gitUrl?: string     — внешний репо (сценарий (a), F-7 Green): делегируется в
 *                               cloneExternalRepo (external-repo-clone.js) — shallow clone-cache
 *                               .fan/git/<slug> (--depth 200); стек/правила/diff — внутри кэш-директории;
 *       - rulesDir?: string   — корень review-rules corpus (F-1/F-4); по умолчанию env
 *                               CODE_REVIEW_RULES_DIR (F-13), затем <корень extension>/review-rules.
 *
 *     deps:
 *       - execGit?: (args: string[], cwd: string) => string — инжект-точка git-исполнителя (шпион
 *         для тестов, аналог «мок bash для отслеживания команд» из карточки). Дефолт: синхронный
 *         child_process execFileSync("git", args, { cwd, encoding: "utf-8" }); возвращает stdout,
 *         при не-нулевом коде бросает Error с stderr в сообщении. Diff вызывается как
 *         execGit(["diff", `${base}...HEAD`], targetDir).
 *
 *   Пайплайн (СКЕЛЕТ — реальный git над реальными tmp-репо, БЕЗ LLM-анализа кода):
 *     1. Целевая директория: path ?? projectDir; отсутствуют обе → throw (сообщение упоминает
 *        «projectDir»/«path»); отсутствует base → throw (сообщение содержит «base»).
 *     2. STEP 1 — стек: detectStack(dir) (F-3, stack-detection.js).
 *     3. STEP 2 — правила: loadRules(dir, stack, rulesDir) (F-4, rules-loader.js) → {files, warning?}.
 *     4. git diff: execGit(["diff", `${base}...HEAD`], dir) — без clone, без сети.
 *     5. Пустой stdout → EARLY RETURN: scope с пометкой «no changes detected», findings: [],
 *        verdict "APPROVED". Это СПЕЦ-СЛУЧАЙ поверх severityToVerdict: тот на [] возвращает
 *        NEEDS_DISCUSSION («ambiguity», F-10), но пустой DIFF — это «нечего ревьюить» = APPROVED
 *        (roadmap TC-F-8-2). Двойная семантика зафиксирована в TC-F-8-2.
 *     6. Пофайловый парсинг unified diff: файлы — по заголовкам «diff --git a/<p> b/<p>» (путь из
 *        b/<p>, относительный, POSIX-разделители); номера строк нового файла — из хунк-заголовков
 *        «@@ -a,b +c,d @@» (1-based); added-строки — префикс «+» (строки «+++» не считаются).
 *     7. Анализ (заглушка LLM-шага, документированная эвристика): added-строка содержит
 *        /user\.id\b/ И НЕ содержит null-safety на той же строке (нет «user?.», «== null»,
 *        «!= null», «typeof user») → finding MAJOR:
 *        { severity: "MAJOR", file: <путь из diff>, line: <1-based строка нового файла>,
 *          category: "correctness",
 *          problem: "Possible access to user.id without a null-check",
 *          suggestion: "Add a null/undefined check for user before accessing user.id" }.
 *        (LLM-анализ по правилам в unit не воспроизводим — тестируется СКЕЛЕТ: diff retrieval,
 *        парсинг, применение правил-заглушек, структура вывода, verdict; constraint задачи.)
 *     8. VERDICT: severityToVerdict(findings) (F-10, agents.js); пустой diff — шаг 5.
 *     9. report — полный markdown, порядок секций СТРОГОЙ (roadmap F-8, 5 секций):
 *        «## Review Scope» → «## Findings» → «## Summary Table» → [«## Security Handoffs»] →
 *        «VERDICT: <verdict>» в конце.
 *
 *   ReviewResult:
 *     - scope: string        — секция «## Review Scope» (что проверено): загруженные правила
 *                              (пути из loadRules().files) + список файлов диффа; при пустом diff —
 *                              пометка «no changes detected»;
 *     - findings: Finding[]  — формат F-9 (findings.js): {severity, file, line, category?, problem,
 *                              suggestion}; строки findings в report проходят round-trip через
 *                              parseFindings() без потерь;
 *     - summaryTable: string — секция «## Summary Table»: распределение findings по severity;
 *     - handoffs?: string    — undefined, когда среди findings нет security-проблем (заполнение
 *                              секции — зона F-11; здесь фиксируется отсутствие);
 *     - report: string       — полный отчёт (все секции в порядке п.9);
 *     - verdict: "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION";
 *     - rulesLoaded: string[] — абсолютные пути loadRules().files (структурный доступ для TC-F-8-3b).
 *
 * TC-F-8-1: tmp git-репо, 2 коммита: base — package.json + src/auth.ts (safe); HEAD — правка
 *           src/auth.ts (+ «user.id» без null-check) + добавление src/b.ts, src/c.ts → 3 файла в
 *           diff. runReview({projectDir, base: "HEAD~1"}) → в report секция «## Review Scope» идёт
 *           ПЕРЕД «## Findings» (обе — перед Summary и VERDICT); scope содержит все 3 файла диффа;
 *           ≥1 finding severity "MAJOR" c file "src/auth.ts"; verdict === severityToVerdict(findings)
 *           === "CHANGES_REQUESTED"; summaryTable содержит «## Summary Table» и "MAJOR";
 *           handoffs === undefined; report заканчивается «VERDICT: CHANGES_REQUESTED»;
 *           parseFindings(report) ≡ findings (F-9 round-trip).
 * TC-F-8-2: tmp-репо с 1 коммитом, base = "HEAD" → пустой diff → scope содержит «no changes
 *           detected»; findings: []; verdict "APPROVED" (при этом severityToVerdict([]) ===
 *           "NEEDS_DISCUSSION" — спец-случай пустого diff ПОВЕРХ F-10-маппинга); summaryTable
 *           присутствует; report заканчивается «VERDICT: APPROVED».
 * TC-F-8-3: ВТОРОЕ tmp-репо «other-project» (2 коммита, изменён src/db.ts с «user.id»), конвенции
 *           <other>/.fan/code-review/conventions.md + ловушка conventions.other-project.md
 *           (slug-конвенции зарезервированы за gitUrl/F-7 — не должны грузиться для локального
 *           path). runReview({path: <other>, base: "HEAD~1"}, {execGit: spy}) →
 *           (a) ни одна git-команда не является «clone»; git diff исполнен с cwd = целевая
 *               директория и аргументом «HEAD~1...HEAD»; .fan/git НЕ создан;
 *           (b) rulesLoaded = common.md + typescript.md + <other>/.fan/code-review/conventions.md
 *               (общий файл), НЕ conventions.other-project.md;
 *           (c) findings ≥ 1 (в т.ч. src/db.ts), verdict "CHANGES_REQUESTED".
 * (+) Контракт-пины входа: gitUrl → делегация clone-cache (F-7 Green, clone через deps,
 *     БЕЗ throw «reserved»); без base → rejects /base/; без projectDir и path →
 *     rejects /projectDir|path/.
 *
 * Фикстуры (constraint карточки: реальные tmp-git-репо, git в PATH): fs.mkdtemp + execFileSync
 * ("git", ...) — init + локальный config (user.name/user.email, core.autocrlf=false) + 1-2 коммита;
 * cleanup — rmSync recursive force (паттерн makeTmpDir из rules-loading.test.mjs F-4 /
 * agents-code-review-stack-detection.test.mjs F-3). rulesDir — tmp-фикстура common.md +
 * typescript.md (зеркало review-rules/, F-1; паттерн F-4).
 *
 * Red-ожидание (roadmap F-8 «Red-тест: TC-F-8-1» + constraint задачи: runReview НЕ существует,
 * модуль НЕ создавать): ВСЕ тесты падают одинаково — «Cannot find module .../review-runner.js»
 * (статический import сверху файла, паттерн rules-loading.test.mjs F-4: для целого нового модуля
 * это единственная допустимая причина падения). Green-фаза создаёт review-runner.js ровно по
 * контракту выше — тесты зеленеют без правок тест-кода.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { severityToVerdict } from "../agents.js";
import { parseFindings } from "../findings.js";
import { runReview } from "../review-runner.js";

// ─── Фикстуры: tmp git-репо + review-rules (паттерн F-3/F-4: mkdtemp + rmSync) ───

const PACKAGE_JSON = JSON.stringify({ name: "mock-project", version: "0.0.1", private: true }, null, 2) + "\n";

/** src/auth.ts в base-коммите — безопасная версия (без обращения к user.id). */
const AUTH_BASE = "export function getRaw(raw) {\n  return raw;\n}\n";

/** src/auth.ts в HEAD — «user.id» без null-check → единственный MAJOR finding (эвристика п.7). */
const AUTH_HEAD = "export function getName(user) {\n  return user.id;\n}\n";

/** Синхронный git-раннер фикстур: локальный config ставится сразу после init. */
function git(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

function writeFiles(dir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
    }
}

/**
 * tmp git-репо: base-коммит из baseFiles, опциональный HEAD-коммит из headFiles.
 * Ровно 2 коммита → base = "HEAD~1"; 1 коммит → base = "HEAD" (TC-F-8-2).
 */
function makeGitRepo(prefix, { baseFiles, headFiles }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        writeFiles(dir, { "package.json": PACKAGE_JSON, ...baseFiles });
        git(dir, ["init"]);
        git(dir, ["config", "core.autocrlf", "false"]);
        git(dir, ["config", "user.name", "FAN Test"]);
        git(dir, ["config", "user.email", "test@fan.local"]);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-m", "base"]);
        if (headFiles) {
            writeFiles(dir, headFiles);
            git(dir, ["add", "-A"]);
            git(dir, ["commit", "-m", "head"]);
        }
        return {
            dir,
            cleanup() {
                fs.rmSync(dir, { recursive: true, force: true });
            },
        };
    } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
    }
}

/** tmp-фикстура review-rules (F-1/F-4): common.md + typescript.md — минимум для loadRules. */
function makeRulesFixture(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const rulesDir = path.join(dir, "review-rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "common.md"), "# Common review rules\n\n- Check error handling on every public API boundary.\n", "utf-8");
    fs.writeFileSync(path.join(rulesDir, "typescript.md"), "# TypeScript rules\n\n- No implicit any; prefer readonly for public fields.\n", "utf-8");
    return {
        rulesDir,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Конвенции проекта (F-5): <projectDir>/.fan/code-review/conventions.md — валидный frontmatter. */
function makeConventions(projectDir) {
    const conventionsPath = path.join(projectDir, ".fan", "code-review", "conventions.md");
    fs.mkdirSync(path.dirname(conventionsPath), { recursive: true });
    fs.writeFileSync(
        conventionsPath,
        [
            "---",
            "stack: typescript",
            "last_analyzed: 2026-09-03T12:00:00Z",
            "analyzed_files:",
            "  - src/auth.ts",
            "---",
            "",
            "## Style",
            "",
            "- Prefer named exports.",
        ].join("\n") + "\n",
        "utf-8",
    );
}

/** Дефолтный git-исполнитель (тот же контракт, что deps.execGit) — для шпиона TC-F-8-3. */
function defaultExecGit(args, cwd) {
    return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** cleanup-хелпер: гарантированно убирает обе tmp-фикстуры (правила + репо). */
function cleanupFixtures(...fixtures) {
    for (const fixture of fixtures) {
        fixture.cleanup();
    }
}

// ─── Тесты ───

describe("F-8: Diff-only review workflow (git diff → findings → verdict, review-runner.js)", () => {
    it("TC-F-8-1: review tmp-репо (3 файла в diff, 1 MAJOR) — Scope → Findings → Summary → VERDICT: CHANGES_REQUESTED", async () => {
        const rules = makeRulesFixture("f8-rules-review-");
        const repo = makeGitRepo("f8-review-", {
            baseFiles: { "src/auth.ts": AUTH_BASE },
            headFiles: {
                "src/auth.ts": AUTH_HEAD,
                "src/b.ts": "export const b = 1;\n",
                "src/c.ts": "export const c = 2;\n",
            },
        });
        try {
            makeConventions(repo.dir);

            const result = await runReview({ projectDir: repo.dir, base: "HEAD~1", rulesDir: rules.rulesDir });

            // Порядок секций отчёта: Review Scope → Findings → Summary Table → VERDICT
            // (roadmap F-8: 5 секций; Security Handoffs здесь отсутствует — нет security-findings).
            const iScope = result.report.indexOf("## Review Scope");
            const iFindings = result.report.indexOf("## Findings");
            const iSummary = result.report.indexOf("## Summary Table");
            const iVerdict = result.report.indexOf("VERDICT:");
            expect(
                iScope,
                "report должен содержать секцию «## Review Scope» — идёт первой (roadmap F-8, TC-F-8-1)",
            ).toBeGreaterThanOrEqual(0);
            expect(
                iFindings,
                "«## Findings» должна идти ПОСЛЕ «## Review Scope» (roadmap F-8: Review Scope идёт первым)",
            ).toBeGreaterThan(iScope);
            expect(
                iSummary,
                "«## Summary Table» должна идти ПОСЛЕ «## Findings» (roadmap F-8, порядок 5 секций)",
            ).toBeGreaterThan(iFindings);
            expect(
                iVerdict,
                "«VERDICT:» должен идти ПОСЛЕ «## Summary Table» (roadmap F-8: финальный VERDICT)",
            ).toBeGreaterThan(iSummary);
            expect(
                result.report,
                "report заканчивается «VERDICT: CHANGES_REQUESTED» (roadmap F-8: финальная строка отчёта)",
            ).toMatch(/VERDICT:\s*CHANGES_REQUESTED\s*$/);

            // Review Scope: список всех 3 файлов диффа
            for (const changedFile of ["src/auth.ts", "src/b.ts", "src/c.ts"]) {
                expect(
                    result.scope,
                    `Review Scope должен перечислять изменённый файл ${changedFile} (roadmap F-8: «что проверено» — файлы диффа)`,
                ).toContain(changedFile);
            }
            expect(
                result.report.includes(result.scope),
                "result.scope — дословная секция внутри result.report (контракт ReviewResult)",
            ).toBe(true);

            // ≥1 finding severity MAJOR в src/auth.ts (формат F-9)
            const major = result.findings.find((f) => f.severity === "MAJOR" && f.file === "src/auth.ts");
            expect(
                major,
                "должен быть ≥1 finding MAJOR в src/auth.ts («user.id» без null-check — эвристика-заглушка контракта)",
            ).toBeTruthy();
            expect(
                Number.isInteger(major.line) && major.line >= 1,
                "finding.line — 1-based номер строки нового файла из хунк-заголовков diff (контракт п.6)",
            ).toBe(true);
            expect(typeof major.problem, "finding.problem — непустая строка (формат F-9)").toBe("string");
            expect(typeof major.suggestion, "finding.suggestion — непустая строка (формат F-9)").toBe("string");

            // F-9 round-trip: findings-строки в report парсятся findings.js без потерь
            expect(
                parseFindings(result.report),
                "findings в report должны проходить round-trip через parseFindings() (формат F-9 — roadmap F-8: «генерирует findings в формате F-9»)",
            ).toEqual(result.findings);

            // VERDICT: маппинг severity → verdict через severityToVerdict (F-10)
            expect(
                result.verdict,
                "≥1 MAJOR → VERDICT: CHANGES_REQUESTED (TC-F-10-1 маппинг, roadmap F-8)",
            ).toBe("CHANGES_REQUESTED");
            expect(
                result.verdict,
                "verdict должен совпадать с severityToVerdict(findings) — F-10 как единственный источник маппинга",
            ).toBe(severityToVerdict(result.findings));

            // Summary Table: распределение по severity
            expect(
                result.summaryTable,
                "summaryTable содержит заголовок «## Summary Table» (roadmap F-8, секция 3)",
            ).toContain("## Summary Table");
            expect(
                result.summaryTable,
                "summaryTable отражает распределение: MAJOR присутствует (1 finding)",
            ).toContain("MAJOR");
            expect(
                result.report.includes(result.summaryTable),
                "result.summaryTable — дословная секция внутри result.report (контракт ReviewResult)",
            ).toBe(true);

            // Security Handoffs: без security-findings секции нет (заполнение — F-11)
            expect(
                result.handoffs,
                "handoffs === undefined, когда нет security-findings (контракт ReviewResult; заполнение — F-11)",
            ).toBeUndefined();
            expect(
                result.report,
                "секция «## Security Handoffs» не выводится без security-findings на этапе F-8",
            ).not.toContain("## Security Handoffs");
        } finally {
            cleanupFixtures(rules, repo);
        }
    });

    it("TC-F-8-2: пустой diff (base = HEAD) → VERDICT: APPROVED + «no changes detected» + findings []", async () => {
        const rules = makeRulesFixture("f8-rules-empty-");
        const repo = makeGitRepo("f8-empty-", {
            baseFiles: { "src/auth.ts": AUTH_BASE },
            headFiles: null, // 1 коммит → git diff HEAD...HEAD пуст
        });
        try {
            const result = await runReview({ projectDir: repo.dir, base: "HEAD", rulesDir: rules.rulesDir });

            expect(
                result.scope,
                "Review Scope при пустом diff содержит пометку «no changes detected» (roadmap TC-F-8-2)",
            ).toContain("no changes detected");
            expect(
                result.findings,
                "пустой diff → findings: [] (roadmap TC-F-8-2)",
            ).toEqual([]);
            expect(
                result.verdict,
                "пустой diff → VERDICT: APPROVED (roadmap TC-F-8-2: обрабатывается gracefully)",
            ).toBe("APPROVED");
            expect(
                result.report,
                "report заканчивается «VERDICT: APPROVED»",
            ).toMatch(/VERDICT:\s*APPROVED\s*$/);
            expect(
                result.summaryTable,
                "summaryTable присутствует даже при пустом diff (5-секционная структура сохраняется)",
            ).toContain("## Summary Table");

            // Спец-случай задокументирован контрактом (п.5): пустой diff — это «нечего ревьюить»,
            // а не «ambiguity» — ПОВЕРХ severityToVerdict, который на [] даёт NEEDS_DISCUSSION.
            expect(
                severityToVerdict(result.findings),
                "предусловие спец-случая: severityToVerdict([]) === NEEDS_DISCUSSION (F-10) — runReview обязан его ПЕРЕКРЫТЬ",
            ).toBe("NEEDS_DISCUSSION");
        } finally {
            cleanupFixtures(rules, repo);
        }
    });

    it("TC-F-8-3: path → работает в целевой директории, git clone НЕ вызван, общий conventions.md", async () => {
        const rules = makeRulesFixture("f8-rules-path-");
        const other = makeGitRepo("f8-other-project-", {
            baseFiles: { "src/db.ts": "export function load(id) {\n  return id;\n}\n" },
            headFiles: { "src/db.ts": "export function load(id) {\n  return user.id;\n}\n" },
        });
        try {
            makeConventions(other.dir);
            // Ловушка: slug-конвенции зарезервированы за gitUrl (F-7) — для локального path
            // грузится ТОЛЬКО общий .fan/code-review/conventions.md (roadmap TC-F-8-3).
            fs.writeFileSync(
                path.join(other.dir, ".fan", "code-review", "conventions.other-project.md"),
                "# Decoy: slug conventions must NOT be loaded for a local path\n",
                "utf-8",
            );

            // Шпион-обёртка над дефолтным исполнителем: отслеживаем команды + cwd («мок bash» карточки)
            const calls = [];
            const execGit = (args, cwd) => {
                calls.push({ args, cwd });
                return defaultExecGit(args, cwd);
            };

            const result = await runReview(
                { path: other.dir, base: "HEAD~1", rulesDir: rules.rulesDir },
                { execGit },
            );

            // (a) git clone НЕ вызван; diff исполнен в целевой директории
            expect(
                calls.filter((c) => c.args.includes("clone")),
                "локальный path ревьюится БЕЗ клонирования — git clone запрещён (roadmap TC-F-8-3a; clone — только F-7/gitUrl)",
            ).toHaveLength(0);
            const diffCalls = calls.filter((c) => c.args[0] === "diff");
            expect(diffCalls.length, "git diff должен быть исполнен ровно через deps.execGit").toBeGreaterThan(0);
            for (const call of diffCalls) {
                expect(
                    path.resolve(call.cwd),
                    "git diff исполнен в целевой директории (path), а не в cwd процесса (roadmap TC-F-8-3: работает в целевой директории)",
                ).toBe(path.resolve(other.dir));
                expect(
                    call.args,
                    "diff-аргументы содержат <base>...HEAD (контракт: execGit([\"diff\", `${base}...HEAD`], dir))",
                ).toContain("HEAD~1...HEAD");
            }
            expect(
                fs.existsSync(path.join(other.dir, ".fan", "git")),
                "clone-cache .fan/git НЕ создан для локального path (зарезервирован за F-7)",
            ).toBe(false);

            // (b) правила: common.md + typescript.md + ОБЩИЙ conventions целевого проекта
            expect(
                result.rulesLoaded.some((p) => p.endsWith("common.md")),
                "rulesLoaded включает common.md (F-4: минимальное требование)",
            ).toBe(true);
            expect(
                result.rulesLoaded.some((p) => p.endsWith("typescript.md")),
                "rulesLoaded включает typescript.md (стек определён по package.json, F-3)",
            ).toBe(true);
            expect(
                result.rulesLoaded.some((p) => p.endsWith(path.join(".fan", "code-review", "conventions.md"))),
                "конвенции — общий <path>/.fan/code-review/conventions.md (roadmap TC-F-8-3b)",
            ).toBe(true);
            expect(
                result.rulesLoaded.some((p) => p.endsWith("conventions.other-project.md")),
                "slug-конвенции conventions.<name>.md НЕ грузятся для локального path — reserved за gitUrl (roadmap TC-F-8-3)",
            ).toBe(false);

            // (c) findings + VERDICT по диффу целевого проекта
            expect(
                result.findings.length,
                "дифф целевого проекта даёт findings (эвристика-заглушка на src/db.ts)",
            ).toBeGreaterThan(0);
            expect(
                result.findings.some((f) => f.file === "src/db.ts"),
                "finding ссылается на файл целевого проекта src/db.ts (работа в целевой директории)",
            ).toBe(true);
            expect(
                result.verdict,
                "MAJOR-находка в целевом проекте → VERDICT: CHANGES_REQUESTED (F-10 маппинг)",
            ).toBe("CHANGES_REQUESTED");
        } finally {
            cleanupFixtures(rules, other);
        }
    });
});

describe("F-8: контракт входа runReview (валидация опций)", () => {
    it("gitUrl → F-7 clone-cache: делегация cloneExternalRepo (clone через deps), НЕ throw «reserved»", async () => {
        // F-7 Green: throw «reserved for F-7» заменён на делегацию (карточка TC-F-7-3:
        // вход через runReview). deps-шпион: кэша нет → clone-путь; пустой diff →
        // EARLY RETURN APPROVED (никакой сети и реального git).
        const calls = [];
        const result = await runReview(
            { projectDir: ".", base: "HEAD", gitUrl: "https://github.com/owner/repo" },
            {
                execGit(args, cwd) {
                    calls.push({ args, cwd });
                    return "";
                },
                existsSync: () => false,
                fs: { mkdirSync() {} },
            },
        );
        const cloneCalls = calls.filter((c) => c.args[0] === "clone");
        expect(
            cloneCalls,
            "gitUrl больше не reserved: runReview делегирует клон в cloneExternalRepo (F-7 Green)",
        ).toHaveLength(1);
        expect(cloneCalls[0].args).toEqual(["clone", "--depth", "200", "https://github.com/owner/repo", ".fan/git/owner-repo"]);
        expect(cloneCalls[0].cwd).toBe(".");
        expect(result.verdict, "пустой mock-diff → EARLY RETURN APPROVED (F-8 TC-F-8-2)").toBe("APPROVED");
    });

    it("без base → throw с упоминанием «base»; без projectDir/path → throw с упоминанием цели", async () => {
        await expect(
            runReview({ projectDir: "." }),
            "base — обязательный аргумент (roadmap F-7/F-8: base обязателен), throw содержит «base»",
        ).rejects.toThrow(/base/);
        await expect(
            runReview({ base: "HEAD" }),
            "нужна ровно одна цель: projectDir или path — throw упоминает «projectDir»/«path»",
        ).rejects.toThrow(/projectDir|path/);
    });
});
