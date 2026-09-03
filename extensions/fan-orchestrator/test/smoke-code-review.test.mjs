/**
 * Smoke G.2 — ОДИН сквозной happy-path тест фичи «code-review worker» через ВСЕ
 * ключевые модули последовательно.
 * Roadmap: docs/features/code-review-worker/roadmap.md (фазы F-0…F-15);
 * спека: docs/specs/spec_code-review-worker_2026-09-03.md.
 *
 * Пайплайн теста (= реальный путь фичи в рантайме):
 *   (1) Регистрация воркера: getAgentTypes (agents/index.js) содержит code-review
 *       (10 зарегистрированных типов; определение — read-only).
 *   (2) Routing: classify_task (orchestrator-tools.js → classifyTaskByDescription,
 *       правило №2 F-12) — «code review of the changes» → worker type code-review.
 *   (3) F-13: enrichWorkerContext инъектирует constraint CODE_REVIEW_RULES_DIR=<abs>
 *       (абсолютный путь к review-rules extension; иммутабельный enrich).
 *   (4) F-6: regenerateConventions создаёт .fan/code-review/conventions.md
 *       в tmp-проекте (файла нет → триггер 1 «missing or unparsable»).
 *   (5) F-4: loadRules отдаёт ровно 3 файла в строгом порядке:
 *       common.md → typescript.md → conventions.md (последний — файл из шага 4).
 *   (6) F-8 (+F-11): runReview на tmp git-репо (base → HEAD: «user.id» без null-check
 *       + SQL-конкатенация) → findings ≥ 2 (MAJOR correctness + CRITICAL security с
 *       securityNote: true), handoffs содержит «Recommend delegating to security worker»,
 *       5 секций отчёта в строгом порядке, verdict = CHANGES_REQUESTED (F-10).
 *   (7) D4: parseVerdict (agents.js) последней строки report → CHANGES_REQUESTED
 *       (round-trip отчёт → вердикт).
 *
 * Паттерн фикстур — реальные tmp git-репо (1:1 как в integration-тестах F-8/F-11:
 * security-handoff.test.mjs): fs.mkdtemp + git init + локальный config + 2 коммита,
 * cleanup — rmSync. Без сети: внешний runReview-сценарий (gitUrl) здесь не гоняется —
 * deps-моки для него покрыты unit-тестами external-repo-clone.test.mjs.
 *
 * Модули импортируются БЕЗ vi.mock: smoke гоняет реальный код (тяжёлые @seaagents/*
 * импорты orchestrator-tools.js резолвятся из корневого node_modules монорепо —
 * проверено), классификация вызывается через публичный инструмент classify_task
 * с моком fan API (паттерн agents-code-review-routing.test.mjs).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDefinition, getAgentTypes } from "../agents/index.js";
import { parseVerdict, severityToVerdict } from "../agents.js";
import { enrichWorkerContext, registerOrchestratorTools } from "../orchestrator-tools.js";
import { regenerateConventions } from "../conventions-lifecycle.js";
import { loadRules } from "../rules-loader.js";
import { runReview } from "../review-runner.js";

/* ============================================================================
 * Фикстуры: tmp-проект = tmp git-репо (base + HEAD с тестируемыми проблемами)
 * ========================================================================== */

/** Синхронный git-раннер фикстур (паттерн security-handoff.test.mjs). */
function git(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

/** src/db.ts в base — безопасная версия: параметризованный запрос (без конкатенации). */
const DB_SAFE = 'export function findUser(db, userId) {\n  return db.query("SELECT * FROM users WHERE id = ?", [userId]);\n}\n';

/**
 * src/db.ts в HEAD — обе проблемы happy path:
 *   строка 2 «const id = user.id;»        → MAJOR correctness (user.id без null-check);
 *   строка 3 SQL-конкатенация с запросом  → CRITICAL security (маркер «SQL injection», F-11).
 */
const DB_VULNERABLE = 'export function findUser(db, user) {\n  const id = user.id;\n  return db.query("SELECT * FROM users WHERE id = " + id);\n}\n';

/**
 * tmp-проект-репо: package.json (manifest → detectStack = typescript) + src/db.ts,
 * base-коммит (safe) + HEAD-коммит (vulnerable). Один каталог обслуживает шаги 4–6:
 * conventions.md (шаг 4) пишется ПОСЛЕ коммитов → untracked, git diff не загрязняет.
 */
function makeSmokeProject(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        const write = (rel, content) => {
            const abs = path.join(dir, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, "utf-8");
        };
        write("package.json", JSON.stringify({ name: "smoke-code-review", version: "0.0.1", private: true }, null, 2) + "\n");
        write(path.join("src", "db.ts"), DB_SAFE);
        git(dir, ["init"]);
        git(dir, ["config", "core.autocrlf", "false"]);
        git(dir, ["config", "user.name", "FAN Smoke"]);
        git(dir, ["config", "user.email", "smoke@fan.local"]);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-m", "base"]);
        write(path.join("src", "db.ts"), DB_VULNERABLE);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-m", "head: user.id без null-check + SQL-конкатенация"]);
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

/* ============================================================================
 * Smoke: один it() — весь happy path последовательно
 * ========================================================================== */

describe("Smoke G.2: code-review worker — сквозной happy path через все ключевые модули", () => {
    it("регистрация (F-0) → routing (F-12) → enrich (F-13) → conventions (F-6) → rules (F-4) → runReview (F-8/F-11) → parseVerdict (D4)", async () => {
        /* ── (1) Регистрация воркера: getAgentTypes содержит code-review ── */
        const agentTypes = getAgentTypes();
        expect(
            agentTypes,
            "getAgentTypes должен содержать 'code-review' — воркер зарегистрирован в AGENT_REGISTRY (агенты/index.js)",
        ).toContain("code-review");
        expect(
            agentTypes,
            "реестр — 10 агентов (explore, plan, implement, verify, security, bug-fix, code-research, tests-impl, docs-impl, code-review)",
        ).toHaveLength(10);
        const codeReviewDef = getAgentDefinition("code-review");
        expect(codeReviewDef, "определение code-review из реестра существует").toBeTruthy();
        expect(codeReviewDef.readOnly, "code-review — read-only воркер (makeReadOnlyAgent, F-0)").toBe(true);

        /* ── (2) Routing: classify_task('code review of the changes') → code-review ── */
        const registeredTools = [];
        const mockFan = {
            registerTool: (def) => registeredTools.push(def),
            registerCommand: () => {},
            registerAgent: () => {},
        };
        registerOrchestratorTools(mockFan, null, {});
        const classifyTool = registeredTools.find((def) => def.name === "classify_task");
        expect(
            classifyTool?.execute,
            "инструмент classify_task зарегистрирован registerOrchestratorTools (мок fan.registerTool)",
        ).toBeTypeOf("function");
        const classification = await classifyTool.execute("smoke-classify", { description: "code review of the changes" }, {}, undefined, {});
        const workerType = /Worker type:\s*(\S+)/.exec(classification?.content?.[0]?.text ?? "")?.[1];
        expect(
            workerType,
            "«code review of the changes» уходит на code-review: правило №2 классификатора специфичнее verify (F-12)",
        ).toBe("code-review");

        /* ── (3) F-13: enrichWorkerContext инъектирует CODE_REVIEW_RULES_DIR ── */
        const workerContext = { constraints: [] };
        const enriched = enrichWorkerContext("code-review", workerContext);
        const constraint = enriched.constraints.find((c) => c.startsWith("CODE_REVIEW_RULES_DIR="));
        expect(constraint, "constraints обогащённого контекста содержат CODE_REVIEW_RULES_DIR=<abs> (F-13)").toBeTruthy();
        const rulesDir = constraint.slice("CODE_REVIEW_RULES_DIR=".length);
        expect(path.isAbsolute(rulesDir), "значение constraint — абсолютный путь (ESM-резолв от orchestrator-tools.js)").toBe(true);
        expect(path.basename(rulesDir), "путь указывает на каталог review-rules extension").toBe("review-rules");
        expect(fs.existsSync(rulesDir), "каталог правил физически существует (воркер сможет загрузить правила)").toBe(true);
        expect(workerContext.constraints, "иммутабельный enrich: входной context не мутируется (фикс F-13)").toEqual([]);

        /* ── tmp-проект-репо: общий мир для шагов 4–6 ── */
        const project = makeSmokeProject("smoke-code-review-");
        try {
            /* ── (4) F-6: regenerateConventions создаёт conventions.md в tmp-проекте ── */
            const conventionsPath = path.join(project.dir, ".fan", "code-review", "conventions.md");
            const regen = await regenerateConventions(project.dir, { stack: "typescript", analyzedFiles: ["src/db.ts"] });
            expect(regen.regenerated, "файла не было → триггер 1 («missing or unparsable») → регенерация").toBe(true);
            expect(fs.existsSync(conventionsPath), ".fan/code-review/conventions.md создан в tmp-проекте (прямой fs-запись)").toBe(true);
            expect(fs.readFileSync(conventionsPath, "utf-8"), "frontmatter регенерированного профиля фиксирует stack").toContain("stack: typescript");

            /* ── (5) F-4: loadRules — ровно 3 файла в порядке common → stack → conventions ── */
            const rules = loadRules(project.dir, "typescript", rulesDir);
            expect(rules.files, "3 файла — по одному на каждую ступень пайплайна (F-4)").toHaveLength(3);
            expect(rules.files[0], "ступень 1 — common.md из rulesDir").toBe(path.join(rulesDir, "common.md"));
            expect(rules.files[1], "ступень 2 — typescript.md из rulesDir").toBe(path.join(rulesDir, "typescript.md"));
            expect(rules.files[2], "ступень 3 — conventions.md проекта, файл из шага 4 (F-5 контракт пути)").toBe(conventionsPath);
            expect(rules.warning, "все ступени на месте → fallback-предупреждений нет").toBeUndefined();

            /* ── (6) F-8 + F-11: runReview на tmp git-репо ── */
            const result = await runReview({ projectDir: project.dir, base: "HEAD~1", rulesDir });

            // findings ≥ 2: MAJOR (user.id без check) + CRITICAL security (SQL-конкатенация)
            expect(result.findings.length, "HEAD-дифф несёт ≥ 2 findings: user.id-эвристика + security-маркер").toBeGreaterThanOrEqual(2);
            const major = result.findings.find((f) => f.severity === "MAJOR");
            expect(major, "MAJOR-finding (user.id без null-check) присутствует").toBeTruthy();
            expect(major.category, "user.id-эвристика даёт category correctness").toBe("correctness");
            expect(major.file, "MAJOR-finding ссылается на src/db.ts (b/-путь диффа, POSIX)").toBe("src/db.ts");
            expect(major.line, "MAJOR-finding — 1-based строка нового файла").toBe(2);
            const critical = result.findings.find((f) => f.severity === "CRITICAL" && f.securityNote === true);
            expect(critical, "CRITICAL security-finding с securityNote: true присутствует (F-11)").toBeTruthy();
            expect(critical.category, "security-finding имеет category security").toBe("security");
            expect(critical.problem, "security-finding называет маркер «SQL injection»").toContain("SQL injection");
            expect(critical.line, "security-finding — строка SQL-конкатенации в новом файле").toBe(3);

            // Handoffs: явная рекомендация делегации (текст, не tool-call)
            expect(result.handoffs, "handoffs содержит явную рекомендацию (F-11, TC-F-11-2)").toContain(
                "Recommend delegating to security worker",
            );

            // Строгий порядок 5 секций отчёта: Scope → Findings → Summary → Handoffs → VERDICT
            const sectionOrder = ["## Review Scope", "## Findings", "## Summary Table", "## Security Handoffs", "VERDICT:"].map((section) =>
                result.report.indexOf(section),
            );
            expect(
                sectionOrder.every((idx) => idx >= 0) &&
                    [...sectionOrder].sort((a, b) => a - b).every((idx, i) => idx === sectionOrder[i]),
                "секции отчёта идут в строгом порядке: Review Scope → Findings → Summary Table → Security Handoffs → VERDICT",
            ).toBe(true);

            // Verdict: F-10 — единственный источник маппинга; блокирующие severity → CHANGES_REQUESTED
            expect(result.verdict, "verdict совпадает с severityToVerdict(findings) (F-10)").toBe(severityToVerdict(result.findings));
            expect(result.verdict, "MAJOR + CRITICAL в findings → CHANGES_REQUESTED").toBe("CHANGES_REQUESTED");
            expect(result.rulesLoaded, "runReview загрузил те же правила, что и loadRules в шаге 5 (связка шагов)").toEqual(rules.files);

            /* ── (7) D4: parseVerdict последней строки report → CHANGES_REQUESTED ── */
            const lastLine = result.report.trimEnd().split("\n").pop();
            expect(lastLine, "последняя строка отчёта — VERDICT-строка").toMatch(/^VERDICT:/);
            expect(parseVerdict(lastLine), "parseVerdict последней строки восстанавливает вердикт (round-trip отчёт → verdict)").toBe(
                "CHANGES_REQUESTED",
            );
            expect(parseVerdict(result.report), "parseVerdict по полному отчёту — тот же вердикт").toBe("CHANGES_REQUESTED");
        } finally {
            project.cleanup();
        }
    });
});
