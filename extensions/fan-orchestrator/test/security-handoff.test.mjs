/**
 * TDD RED tests for F-11 «Security-handoff tagging (security-note + delegate)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-11» (TC-F-11-1, TC-F-11-2,
 * TC-F-11-3). Расширение runReview (F-8, review-runner.js): воркер НЕ проводит глубокий
 * security-аудит (D7 спеки) — только МАРКИРУЕТ подозрительные security-проблемы для передачи
 * security-воркеру через координатора.
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза) — расширение runReview,
 * секция Security Handoffs вставляется МЕЖДУ «## Summary Table» и «VERDICT:» (порядок секций
 * отчёта становится: Review Scope → Findings → Summary Table → [Security Handoffs] → VERDICT):
 *
 *   1. SECURITY_PATTERNS — экспортируемая константа review-runner.js: список security-маркеров
 *      (roadmap F-11 Refactor-цель): SQL injection, XSS, hardcoded secret, weak crypto,
 *      path traversal, insecure deserialization, missing auth, IDOR. Каждый маркер —
 *      { name: string, pattern: RegExp }.
 *   2. Детекция (скелет-эвристика над added-строками диффа + findings, шаг 7 контракта F-8):
 *      added-строка анализируемого файла (не binary/renamed/deleted) совпала хотя бы с одним
 *      SECURITY_PATTERNS → ДОПОЛНИТЕЛЬНЫЙ finding поверх существующих эвристик:
 *        { severity: "CRITICAL", file, line, category: "security",
 *          problem: <включает name маркера + краткое описание>, suggestion: <непустая строка>,
 *          securityNote: true }.
 *      securityNote: true — дополнительное ПОЛЕ в finding-структуре F-9 (в памяти; F-9-строка
 *      отчёта его не кодирует — round-trip parseFindings() на security-findings не пинуется).
 *   3. Секция «## Security Handoffs» — строится ТОЛЬКО когда ≥ 1 finding имеет securityNote: true:
 *        ## Security Handoffs
 *
 *        - <file>:<line> — <problem>          (по одной строке на каждый security-finding)
 *        ...
 *
 *        Recommend delegating to security worker
 *
 *      Формат записи: `- <file>:<line> — <problem>` (file:line + краткое описание — roadmap F-11);
 *      явная строка-рекомендация «Recommend delegating to security worker» — РЕКОМЕНДАЦИЯ, а НЕ
 *      auto-call: code-review не вызывает security-воркера сам (изоляция воркера, TC-F-11-2).
 *   4. ReviewResult.handoffs: string | undefined — ПОЛНЫЙ текст секции (с заголовком
 *      «## Security Handoffs», report.includes(handoffs) === true), когда security-findings есть;
 *      undefined, когда нет — секция в report ОТСУТСТВУЕТ (пин уже зафиксирован TC-F-8-1:
 *      не-security diff → handoffs === undefined и report НЕ содержит «## Security Handoffs»).
 *      Допустимый альтернативный GREEN-вариант (roadmap TC-F-11-3 «пуста»): секция присутствует,
 *      но содержит плейсхолдер «_No security issues detected._» без записей о findings.
 *   5. Non-security findings (correctness/naming/magic numbers/…) НИКОГДА не получают
 *      securityNote: true и не попадают в Handoffs (TC-F-11-3).
 *   6. В report НЕТ вызова delegate_task (и иных tool-call маркеров делегации) — handoff
 *      выражен только текстом рекомендации (TC-F-11-2).
 *
 * TC-F-11-1: tmp git-репо, src/auth.ts: base — параметризованный запрос (безопасно); HEAD —
 *            db.query("SELECT * FROM users WHERE id = " + userId) (SQL injection, конкатенация).
 *            runReview({projectDir, base: "HEAD~1"}) → ≥ 1 finding с securityNote: true;
 *            секция «## Security Handoffs» в report МЕЖДУ «## Summary Table» и «VERDICT:»,
 *            содержит «src/auth.ts» и номер строки (формат file:line).
 * TC-F-11-2: тот же setup (security-issue в диффе) → report содержит фразу
 *            «Recommend delegating to security worker»; report НЕ содержит «delegate_task»
 *            (code-review не вызывает security-воркера напрямую — только рекомендация).
 * TC-F-11-3: tmp git-репо только с non-security findings: src/calc.ts c «user.id» без
 *            null-check (единственный генератор findings скелета — category "correctness",
 *            НЕ security) + src/config.ts с code smells (magic numbers, naming — findings
 *            не даёт). runReview() → ни один finding не помечен securityNote: true; секция
 *            «## Security Handoffs» отсутствует ИЛИ содержит «_No security issues detected._».
 *
 * Фикстуры (паттерн agents-code-review-integration.test.mjs F-8: реальные tmp-git-репо):
 * fs.mkdtemp + git init + локальный config + 2 коммита; review-rules — tmp common.md +
 * typescript.md; conventions — <repo>/.fan/code-review/conventions.md. cleanup — rmSync.
 *
 * Red-ожидание (roadmap F-11 «Red-тест: TC-F-11-1» + constraint задачи: security-handoff
 * функциональности в review-runner.js НЕТ — СЕКЦИЯ не выводится, securityNote НЕ ставится):
 *   - TC-F-11-1 и TC-F-11-2 падают НА ASSERT (не на import): review-runner.js существует и
 *     экспортирует runReview, но SECURITY_PATTERNS-детекции нет → security-finding не создаётся
 *     (в RED findings = []: SQL-конкатенация не матчится скелет-эвристикой /user\.id\b/),
 *     securityNote негде стоять, секция и рекомендация не выводятся;
 *   - TC-F-11-3 — guard-тест: «нет security → секции нет» УЖЕ выполняется скелетом (и закреплено
 *     TC-F-8-1 для handoffs === undefined); он фиксирует инвариант против регрессии Green-фазы
 *     (не-security findings не размываются в Handoffs). Красную фазу несут TC-F-11-1/TC-F-11-2.
 * Green-фаза реализует SECURITY_PATTERNS + секцию ровно по контракту выше — тесты зеленеют
 * без правок тест-кода.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { severityToVerdict } from "../agents.js";
import { runReview, SECURITY_PATTERNS } from "../review-runner.js";

// ─── Фикстуры: tmp git-репо + review-rules (паттерн F-8: mkdtemp + rmSync) ───

const PACKAGE_JSON = JSON.stringify({ name: "security-mock", version: "0.0.1", private: true }, null, 2) + "\n";

/** src/auth.ts в base — безопасная версия: параметризованный запрос (без конкатенации). */
const AUTH_SAFE = 'export function findUser(db, userId) {\n  return db.query("SELECT * FROM users WHERE id = ?", [userId]);\n}\n';

/**
 * src/auth.ts в HEAD — SQL injection: строка запроса склеивается с userId (маркер
 * «SQL injection» из SECURITY_PATTERNS; скелет-эвристика /user\.id\b/ здесь НЕ матчится —
 * «userId» без точки, поэтому в RED findings = []).
 */
const AUTH_SQL_INJECTION = 'export function findUser(db, userId) {\n  return db.query("SELECT * FROM users WHERE id = " + userId);\n}\n';

/** src/calc.ts в base — без обращения к user.id (не генерирует findings). */
const CALC_BASE = "export function add(a, b) {\n  return a + b;\n}\n";

/** src/calc.ts в HEAD — «user.id» без null-check → non-security finding (correctness, скелет). */
const CALC_USER_ID = "export function getUserId(user) {\n  return user.id;\n}\n";

/** src/config.ts — code smells (magic numbers, naming), findings НЕ генерирует. */
const CONFIG_SMELLS = "export const MAX_RETRIES = 3;\nexport function calcTotal(price) {\n  const TAX_VALUE = 0.2;\n  return price * TAX_VALUE;\n}\n";

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

/** tmp git-репо: base-коммит из baseFiles + HEAD-коммит из headFiles (base = "HEAD~1"). */
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
        writeFiles(dir, headFiles);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-m", "head"]);
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

/** cleanup-хелпер: гарантированно убирает обе tmp-фикстуры (правила + репо). */
function cleanupFixtures(...fixtures) {
    for (const fixture of fixtures) {
        fixture.cleanup();
    }
}

// ─── Тесты ───

describe("F-11: Security-handoff tagging (securityNote + ## Security Handoffs, review-runner.js)", () => {
    it("TC-F-11-1: SQL injection в added-строке → finding с securityNote: true + секция Handoffs (file:line) между Summary Table и VERDICT", async () => {
        const rules = makeRulesFixture("f11-rules-sqli-");
        const repo = makeGitRepo("f11-sqli-", {
            baseFiles: { "src/auth.ts": AUTH_SAFE },
            headFiles: { "src/auth.ts": AUTH_SQL_INJECTION },
        });
        try {
            makeConventions(repo.dir);

            const result = await runReview({ projectDir: repo.dir, base: "HEAD~1", rulesDir: rules.rulesDir });

            // ≥ 1 finding помечен securityNote: true (roadmap TC-F-11-1: security-issue → тег)
            const securityFindings = result.findings.filter((f) => f.securityNote === true);
            expect(
                securityFindings.length,
                "SQL-конкатенация в added-строке должна дать ≥ 1 finding с securityNote: true (roadmap TC-F-11-1: securityNote не ставится в RED — детекции SECURITY_PATTERNS нет)",
            ).toBeGreaterThanOrEqual(1);

            const securityFinding = securityFindings.find((f) => f.file === "src/auth.ts");
            expect(
                securityFinding,
                "security-finding ссылается на src/auth.ts (файл диффа с SQL-конкатенацией)",
            ).toBeTruthy();
            expect(
                Number.isInteger(securityFinding.line) && securityFinding.line >= 1,
                "security-finding.line — 1-based номер строки нового файла (формат F-9)",
            ).toBe(true);
            expect(
                securityFinding.problem,
                "security-finding.problem — непустое описание проблемы (roadmap F-11: file:line + краткое описание)",
            ).toBeTruthy();

            // Секция «## Security Handoffs» присутствует в report
            const iSummary = result.report.indexOf("## Summary Table");
            const iHandoffs = result.report.indexOf("## Security Handoffs");
            const iVerdict = result.report.indexOf("VERDICT:");
            expect(
                iHandoffs,
                "report должен содержать секцию «## Security Handoffs» (roadmap TC-F-11-1; в RED секция не выводится)",
            ).toBeGreaterThanOrEqual(0);

            // Контракт F-11: секция вставлена МЕЖДУ «## Summary Table» и «VERDICT:»
            expect(
                iHandoffs,
                "«## Security Handoffs» должна идти ПОСЛЕ «## Summary Table» (контракт F-11: вставка между Summary Table и VERDICT)",
            ).toBeGreaterThan(iSummary);
            expect(
                iVerdict,
                "«VERDICT:» должен идти ПОСЛЕ «## Security Handoffs» (контракт F-11: вставка между Summary Table и VERDICT)",
            ).toBeGreaterThan(iHandoffs);

            // Секция содержит file:line с упоминанием src/auth.ts и номера строки
            const handoffsSection = result.report.slice(iHandoffs, iVerdict);
            expect(
                handoffsSection,
                "секция Handoffs должна упоминать src/auth.ts (roadmap TC-F-11-1: список file:line)",
            ).toContain("src/auth.ts");
            expect(
                handoffsSection,
                "запись в Handoffs имеет формат file:line — «src/auth.ts:<номер>» (roadmap TC-F-11-1: file + номер строки)",
            ).toMatch(/src\/auth\.ts:\d+/);
            expect(
                result.handoffs,
                "result.handoffs — полный текст секции (с заголовком), дословно входящий в report (контракт ReviewResult.handoffs)",
            ).toBe(result.report.slice(iHandoffs, iVerdict).replace(/\s*$/, ""));

            // VERDICT согласован с findings через F-10 (security-finding ≥ MAJOR → CHANGES_REQUESTED)
            expect(
                result.verdict,
                "verdict должен совпадать с severityToVerdict(findings) — F-10 как единственный источник маппинга",
            ).toBe(severityToVerdict(result.findings));
            expect(
                result.verdict,
                "security-finding (severity ≥ MAJOR) → VERDICT: CHANGES_REQUESTED (F-10 маппинг)",
            ).toBe("CHANGES_REQUESTED");
        } finally {
            cleanupFixtures(rules, repo);
        }
    });

    it("TC-F-11-2: security-issue → report содержит «Recommend delegating to security worker», НЕ содержит delegate_task (рекомендация, не auto-call)", async () => {
        const rules = makeRulesFixture("f11-rules-delegate-");
        const repo = makeGitRepo("f11-delegate-", {
            baseFiles: { "src/auth.ts": AUTH_SAFE },
            headFiles: { "src/auth.ts": AUTH_SQL_INJECTION },
        });
        try {
            makeConventions(repo.dir);

            const result = await runReview({ projectDir: repo.dir, base: "HEAD~1", rulesDir: rules.rulesDir });

            // Явная рекомендация делегировать аудит security-воркеру (roadmap TC-F-11-2)
            expect(
                result.report,
                "report должен содержать фразу «Recommend delegating to security worker» (roadmap TC-F-11-2; в RED секции/рекомендации нет)",
            ).toContain("Recommend delegating to security worker");

            // НЕ auto-call: ни одного вызова delegate_task от code-review в отчёте быть не должно
            expect(
                result.report,
                "report НЕ должен содержать вызов delegate_task (roadmap TC-F-11-2: code-review не вызывает security-воркера напрямую — только рекомендация)",
            ).not.toContain("delegate_task");
        } finally {
            cleanupFixtures(rules, repo);
        }
    });

    it("TC-F-11-3: только non-security findings (user.id + magic numbers/naming) → без securityNote, Handoffs отсутствует ИЛИ «_No security issues detected._»", async () => {
        const rules = makeRulesFixture("f11-rules-clean-");
        const repo = makeGitRepo("f11-clean-", {
            baseFiles: { "src/calc.ts": CALC_BASE },
            headFiles: {
                "src/calc.ts": CALC_USER_ID, // non-security finding (correctness, скелет-эвристика)
                "src/config.ts": CONFIG_SMELLS, // code smells: magic numbers, naming — findings не даёт
            },
        });
        try {
            makeConventions(repo.dir);

            const result = await runReview({ projectDir: repo.dir, base: "HEAD~1", rulesDir: rules.rulesDir });

            // Предусловие: non-security findings существуют (иначе тест вырожден)
            expect(
                result.findings.length,
                "в диффе есть non-security finding (user.id без null-check — correctness-эвристика скелета); magic numbers/naming findings не дают",
            ).toBeGreaterThanOrEqual(1);

            // Ни один non-security finding не помечен securityNote: true (контракт F-11 п.5)
            for (const finding of result.findings) {
                expect(
                    finding.securityNote,
                    `non-security finding (${finding.file}:${finding.line}) не должен иметь securityNote: true (roadmap TC-F-11-3)`,
                ).not.toBe(true);
            }

            // Секция Handoffs отсутствует ИЛИ пустая-плейсхолдер (roadmap TC-F-11-3: «отсутствует ИЛИ пуста»)
            const hasSection = result.report.includes("## Security Handoffs");
            if (hasSection) {
                expect(
                    result.report,
                    "если секция «## Security Handoffs» выведена без security-findings — она содержит плейсхолдер «_No security issues detected._» (roadmap TC-F-11-3)",
                ).toContain("_No security issues detected._");
            }
            expect(
                result.handoffs === undefined ||
                    (typeof result.handoffs === "string" && result.handoffs.includes("_No security issues detected._")),
                "result.handoffs — undefined (секции нет; пин TC-F-8-1) ИЛИ пустой плейсхолдер «_No security issues detected._» (roadmap TC-F-11-3)",
            ).toBe(true);
        } finally {
            cleanupFixtures(rules, repo);
        }
    });
});

// ─── Mini-фикстуры SECURITY_PATTERNS (roadmap F-11 Refactor-цель: по 1 фикстуре на маркер) ───

/** PLACEHOLDER base-строка — заменяется «опасной» added-строкой в каждой мини-фикстуре. */
const PATTERN_BASE = "export const placeholder = 0;\n";

/**
 * По одной added-строке на каждый маркер SECURITY_PATTERNS (roadmap F-11: SQL injection,
 * XSS, hardcoded secret, weak crypto, path traversal, insecure deserialization,
 * missing auth, IDOR). Каждая строка ДОЛЖНА матчиться ровно своим маркером в
 * review-runner.js — эскейп-чувствительность проверяется реальным матчингом runReview ниже.
 */
const PATTERN_MINI_FIXTURES = [
    { marker: "SQL injection", file: "src/queries.ts", added: 'export const findLogs = (db, level) => db.query("SELECT * FROM logs WHERE level = " + level);' },
    { marker: "XSS", file: "src/render.ts", added: "export const render = (el, input) => { el.innerHTML = input; };" },
    { marker: "hardcoded secret", file: "src/credentials.ts", added: 'export const API_KEY = "sk-live-1234567890abcdef";' },
    { marker: "weak crypto", file: "src/hash.ts", added: 'export const digest = (pw) => crypto.createHash("md5").update(pw).digest("hex");' },
    { marker: "path traversal", file: "src/files.ts", added: 'export const read = (name) => fs.readFileSync(baseDir + "/" + name + "/../../../etc/passwd");' },
    { marker: "insecure deserialization", file: "src/hydrate.ts", added: 'export const hydrate = (raw) => eval("(" + raw + ")");' },
    { marker: "missing auth", file: "src/routes.ts", added: 'export const setup = (app) => app.get("/api/admin/users", (req, res) => res.json(listAllUsers()));' },
    { marker: "IDOR", file: "src/profile.ts", added: "export const getProfile = (req) => User.findById(req.params.id);" },
];

describe("F-11 Refactor: SECURITY_PATTERNS — 8 маркеров, по одной мини-фикстуре на каждый", () => {
    it("SECURITY_PATTERNS — экспортируемая константа с 8 контрактными маркерами", () => {
        expect(Array.isArray(SECURITY_PATTERNS), "SECURITY_PATTERNS экспортируется как список").toBe(true);
        expect(
            SECURITY_PATTERNS.map((p) => p.name),
            "порядок и имена маркеров — ровно по контракту F-11 (roadmap: SQL injection, XSS, hardcoded secret, weak crypto, path traversal, insecure deserialization, missing auth, IDOR)",
        ).toEqual([
            "SQL injection",
            "XSS",
            "hardcoded secret",
            "weak crypto",
            "path traversal",
            "insecure deserialization",
            "missing auth",
            "IDOR",
        ]);
        for (const marker of SECURITY_PATTERNS) {
            expect(marker.pattern instanceof RegExp, `маркер «${marker.name}» — pattern является RegExp`).toBe(true);
        }
    });

    for (const fixture of PATTERN_MINI_FIXTURES) {
        it(`мини-фикстура «${fixture.marker}»: added-строка → CRITICAL security-finding (securityNote: true) + запись в Handoffs`, async () => {
            const rules = makeRulesFixture("f11-pattern-rules-");
            const repo = makeGitRepo("f11-pattern-repo-", {
                baseFiles: { [fixture.file]: PATTERN_BASE },
                headFiles: { [fixture.file]: fixture.added + "\n" },
            });
            try {
                makeConventions(repo.dir);

                const result = await runReview({ projectDir: repo.dir, base: "HEAD~1", rulesDir: rules.rulesDir });

                // added-строка сматчила маркер → security-finding с securityNote: true
                const securityFindings = result.findings.filter((f) => f.securityNote === true);
                expect(
                    securityFindings.length,
                    `«${fixture.marker}»: added-строка должна дать ≥ 1 finding с securityNote: true`,
                ).toBeGreaterThanOrEqual(1);

                const finding = securityFindings.find((f) => f.file === fixture.file);
                expect(finding, `«${fixture.marker}»: security-finding ссылается на ${fixture.file}`).toBeTruthy();
                expect(finding.severity, `«${fixture.marker}»: severity CRITICAL (контракт F-11)`).toBe("CRITICAL");
                expect(finding.category, `«${fixture.marker}»: category security (контракт F-11)`).toBe("security");
                expect(
                    Number.isInteger(finding.line) && finding.line >= 1,
                    `«${fixture.marker}»: line — 1-based номер из hunk-счётчика`,
                ).toBe(true);
                expect(
                    finding.problem,
                    `«${fixture.marker}»: problem включает name маркера`,
                ).toContain(fixture.marker);
                expect(
                    typeof finding.suggestion === "string" && finding.suggestion.length > 0,
                    `«${fixture.marker}»: suggestion — непустая строка`,
                ).toBe(true);

                // Запись в Handoffs (file:line), секция между Summary Table и VERDICT
                expect(result.report.indexOf("## Security Handoffs")).toBeGreaterThan(result.report.indexOf("## Summary Table"));
                expect(result.report.indexOf("VERDICT:")).toBeGreaterThan(result.report.indexOf("## Security Handoffs"));
                expect(
                    result.handoffs,
                    `«${fixture.marker}»: Handoffs содержат ${fixture.file}:line`,
                ).toMatch(new RegExp(`${fixture.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+`));
            } finally {
                cleanupFixtures(rules, repo);
            }
        });
    }
});
