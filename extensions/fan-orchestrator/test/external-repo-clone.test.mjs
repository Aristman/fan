/**
 * TDD RED tests for F-7 «External repo clone-cache (.fan/git/<slug>, --depth 200)»
 * (feature-pipeline, code-review-worker).
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-7»
 * (TC-F-7-1, TC-F-7-2, TC-F-7-3; слои [INTEG], приоритет P1).
 *
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза):
 *   Создать extensions/fan-orchestrator/external-repo-clone.js с экспортом
 *   cloneExternalRepo(options, deps).
 *
 *   ВЫБОР ПУТИ МОДУЛЯ (конвенция репо, как в F-6): вспомогательные модули orchestrator
 *   лежат ПЛОСКО в корне extensions/fan-orchestrator/ (review-runner.js, rules-loader.js,
 *   conventions-lifecycle.js, …); имя тест-файла external-repo-clone.test.mjs зеркалит
 *   имя модуля.
 *
 *   Контракт: cloneExternalRepo({url, base, projectDir?}, deps?)
 *     - url: string (required) — внешний репо (https://… или git@…), STEP 0 сценарий (a);
 *     - base: string (required) — commit/branch/tag; без base → throw (карточка, шаг 5);
 *     - projectDir: string (optional) — корень проекта; по умолчанию process.cwd().
 *   deps — инжект (паттерн review-runner.js / defaultExecGit):
 *     - deps.execGit(args, cwd) → stdout: string; не-zero exit → throw с stderr git'а
 *       (в тестах — spy, протоколирующий {args, cwd});
 *     - deps.existsSync(path) → boolean — проверка кэша .fan/git/<slug>;
 *     - deps.fs.mkdirSync(path, opts) — ensure .fan/git (карточка, шаг 2).
 *
 *   Алгоритм (карточка F-7, шаги 1-7):
 *     1) slug = owner-repo из URL (базовый https-кейс: https://github.com/owner/repo →
 *        owner-repo; edge-кейсы .git-суффикс / git@ SSH — Refactor-цель repoSlug(url),
 *        в Red НЕ пинятся — constraint задачи);
 *     2) mkdir -p <projectDir>/.fan/git;
 *     3) кэша нет → execGit(["clone", "--depth", "200", url, ".fan/git/<slug>"], projectDir);
 *     4) кэш есть → execGit(["fetch", "--prune"], cacheDir) + execGit(["checkout", base], cacheDir),
 *        где cacheDir = <projectDir>/.fan/git/<slug> («cd» из карточки = cwd-аргумент execGit);
 *     5) base обязателен;
 *     6) git diff <base>...HEAD; «fatal: bad revision» (base старше depth 200 shallow-копии) →
 *        рекомендация git fetch --unshallow; при невозможности unshallow →
 *        VERDICT: NEEDS_DISCUSSION с описанием (graceful fallback);
 *     7) конвенции внешнего репо → .fan/code-review/conventions.<slug>.md (схема F-5).
 *   Возвращаемое значение в Red сознательно НЕ пинится: задача ассертит только
 *   execGit-команды и кэш-путь через deps.existsSync.
 *
 *   Точка входа сценария (a): карточка TC-F-7-3 ведёт вход через
 *   runReview({gitUrl, base}) — сейчас review-runner.js бросает
 *   «gitUrl … reserved for F-7»; wiring gitUrl → cloneExternalRepo + обработка
 *   bad-revision делается Green-шагом F-7 (docstring review-runner.js, сценарий (a)).
 *
 * TC-F-7-1 «Первый запуск — clone external repo в .fan/git/<slug> с --depth 200»:
 *   deps.existsSync → false (кэша нет). act: cloneExternalRepo({url, base, projectDir}, deps).
 *   assert: execGit получил РОВНО ["clone", "--depth", "200", "https://github.com/owner/repo",
 *   ".fan/git/owner-repo"] с cwd = projectDir; deps.existsSync спрошен про
 *   <projectDir>/.fan/git/owner-repo; fetch/checkout на первом запуске НЕ вызываются.
 *
 * TC-F-7-2 «Повторный запуск — cache hit через git fetch --prune && git checkout <base>»:
 *   deps.existsSync → true. act: cloneExternalRepo({url, base: "main", projectDir}, deps).
 *   assert: НЕТ ни одного clone; есть execGit(["fetch", "--prune"], cacheDir) и
 *   execGit(["checkout", "main"], cacheDir), оба с cwd = <projectDir>/.fan/git/owner-repo.
 *
 * TC-F-7-3 «Edge case — base не в shallow-копии → git fetch --unshallow, при невозможности
 *   → VERDICT: NEEDS_DISCUSSION»: mock execGit бросает «fatal: bad revision» на
 *   git diff <base>...HEAD и «unable to access» на unshallow-fetch (unshallow невозможен).
 *   act: runReview({gitUrl, base, projectDir, rulesDir}, deps) (карточка: вход через runReview).
 *   assert: report содержит инструкцию «git fetch --unshallow» и «VERDICT: NEEDS_DISCUSSION»;
 *   result.verdict === "NEEDS_DISCUSSION". rulesDir = <extension>/review-rules (корпус F-1)
 *   — STEP 2 runReview не зависит от диска projectDir (мок-сценарий без реального репо).
 *
 * Фикстуры URL-вариантов (constraint задачи): базовый https-кейс пинится жёстко,
 * SSH- и .git-варианты — матрица для Green/Refactor repoSlug(url), в Red не ассертятся.
 *
 * Red-ожидание (roadmap «Red-тест: TC-F-7-1» + constraint задачи: модуль НЕ создавать):
 *   все 3 теста падают одинаково — «Cannot find module ../external-repo-clone.js»
 *   (статический import сверху файла): cloneExternalRepo ещё не существует, и это
 *   ЕДИНСТВЕННО допустимая причина падения. Green-шаг создаёт модуль ровно по
 *   зафиксированному пути — тесты зеленеют без правок тест-файла.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloneExternalRepo, repoSlug } from "../external-repo-clone.js";
import { runReview } from "../review-runner.js";

/** Корень extension: extensions/fan-orchestrator/test/*.test.mjs → ../ */
const EXTENSION_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Реальный корпус правил F-1 — rulesDir для STEP 2 runReview в TC-F-7-3. */
const REVIEW_RULES_DIR = path.join(EXTENSION_ROOT, "review-rules");

/**
 * URL-варианты (constraint задачи). В Red жёстко пинится ТОЛЬКО базовый https-кейс
 * (BASE_URL → slug «owner-repo»); .git-суффикс и git@ SSH — Refactor-цель repoSlug(url).
 */
const URL_VARIANTS = Object.freeze([
    { url: "https://github.com/owner/repo", expectedSlug: "owner-repo" }, // базовый — пинится
    { url: "https://github.com/owner/repo.git", expectedSlug: "owner-repo" }, // .git суффикс — не пинить
    { url: "git@github.com:owner/repo.git", expectedSlug: "owner-repo" }, // git@ SSH — не пинить
]);
const BASE_URL = URL_VARIANTS[0].url;

/**
 * deps-инжект с протоколированием (паттерн review-runner.js: execGit(args, cwd) → stdout,
 * throw при ошибке git). existsSync отвечает согласно cacheExists; fs.mkdirSync — no-op spy.
 */
function makeDeps({ cacheExists = false } = {}) {
    const gitCalls = [];
    const existsCalls = [];
    const mkdirCalls = [];
    const deps = {
        execGit(args, cwd) {
            gitCalls.push({ args, cwd });
            return "";
        },
        existsSync(p) {
            existsCalls.push(p);
            return cacheExists;
        },
        fs: {
            mkdirSync(p) {
                mkdirCalls.push(p);
            },
        },
    };
    return { deps, gitCalls, existsCalls, mkdirCalls };
}

describe("external repo clone-cache (F-7, code-review-worker)", () => {
    it("TC-F-7-1: первый запуск (кэша нет) → execGit получил ['clone','--depth','200',url,'.fan/git/owner-repo']", () => {
        // arrange: проект и пустой кэш (existsSync → false); все зависимости инжектированы
        const projectDir = path.join(os.tmpdir(), "fan-f7-tc1-project");
        const { deps, gitCalls, existsCalls } = makeDeps({ cacheExists: false });

        // act
        cloneExternalRepo({ url: BASE_URL, base: "main", projectDir }, deps);

        // assert: clone-команда — ровно карточечная, ровно одна
        const cloneCalls = gitCalls.filter((c) => c.args[0] === "clone");
        expect(cloneCalls).toHaveLength(1);
        expect(cloneCalls[0].args).toEqual(["clone", "--depth", "200", BASE_URL, ".fan/git/owner-repo"]);
        expect(cloneCalls[0].cwd).toBe(projectDir);

        // assert: кэш-проверка по контракту <projectDir>/.fan/git/<slug> (deps.existsSync)
        const expectedCacheDir = path.join(projectDir, ".fan", "git", "owner-repo");
        expect(existsCalls).toContain(expectedCacheDir);

        // assert: первый запуск — БЕЗ fetch/checkout (это путь cache-hit, TC-F-7-2)
        const hitCalls = gitCalls.filter((c) => c.args[0] === "fetch" || c.args[0] === "checkout");
        expect(hitCalls).toHaveLength(0);
    });

    it("TC-F-7-2: кэш существует (existsSync true) → fetch --prune + checkout main, clone НЕ вызван", () => {
        // arrange: .fan/git/owner-repo уже существует (cache hit от прошлого запуска)
        const projectDir = path.join(os.tmpdir(), "fan-f7-tc2-project");
        const cacheDir = path.join(projectDir, ".fan", "git", "owner-repo");
        const { deps, gitCalls } = makeDeps({ cacheExists: true });

        // act
        cloneExternalRepo({ url: BASE_URL, base: "main", projectDir }, deps);

        // assert: повторный запуск — БЕЗ clone (cache hit)
        const cloneCalls = gitCalls.filter((c) => c.args[0] === "clone");
        expect(cloneCalls).toHaveLength(0);

        // assert: fetch --prune внутри кэш-директории (cd .fan/git/owner-repo = cwd)
        const fetchCalls = gitCalls.filter((c) => c.args.includes("fetch") && c.args.includes("--prune"));
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].cwd).toBe(cacheDir);

        // assert: checkout <base> внутри кэш-директории
        const checkoutCalls = gitCalls.filter((c) => c.args[0] === "checkout");
        expect(checkoutCalls).toHaveLength(1);
        expect(checkoutCalls[0].args[1]).toBe("main");
        expect(checkoutCalls[0].cwd).toBe(cacheDir);
    });

    it("TC-F-7-3: 'fatal: bad revision' на diff → инструкция git fetch --unshallow; unshallow невозможен → VERDICT: NEEDS_DISCUSSION", async () => {
        // arrange: shallow clone (depth 200), base старше глубины → diff бросает
        // «fatal: bad revision»; повторный unshallow-fetch невозможен (сеть недоступна) —
        // ожидаем graceful fallback, не throw.
        const gitCalls = [];
        const deps = {
            execGit(args, cwd) {
                gitCalls.push({ args, cwd });
                if (args[0] === "diff") {
                    throw new Error(`git ${args.join(" ")} failed: fatal: bad revision 'main...HEAD'`);
                }
                if (args[0] === "fetch" && args.includes("--unshallow")) {
                    throw new Error(
                        "fatal: unable to access 'https://github.com/owner/repo/': Could not resolve host: github.com",
                    );
                }
                return ""; // clone / fetch --prune / checkout — успех
            },
            existsSync: () => false, // первый запуск → clone
        };

        // act: карточка TC-F-7-3 — вход через runReview({gitUrl, base}) (сценарий (a) STEP 0);
        // в текущей фазе runReview бросает «gitUrl … reserved for F-7», wiring — Green-шаг.
        const result = await runReview(
            { gitUrl: BASE_URL, base: "main", projectDir: path.join(os.tmpdir(), "fan-f7-tc3-project"), rulesDir: REVIEW_RULES_DIR },
            deps,
        );

        // assert: инструкция unshallow присутствует в отчёте
        expect(result.report).toContain("git fetch --unshallow");

        // assert: graceful fallback — NEEDS_DISCUSSION в вердикте и в отчёте
        expect(result.verdict).toBe("NEEDS_DISCUSSION");
        expect(result.report).toContain("VERDICT: NEEDS_DISCUSSION");
    });
});

describe("F-7 Refactor: repoSlug edge cases + .cloned-at cache-age stamp", () => {
    it("repoSlug: .git-суффикс срезается, git@ SSH → owner-repo, self-hosted deep path → последние 2 сегмента", () => {
        // Матрица Refactor-целей (roadmap F-7 «Refactor-цели»); базовый https-кейс
        // уже запинен в TC-F-7-1 (BASE_URL → «owner-repo») — здесь только добавленные кейсы.
        /** @type {[string, string][]} */
        const CASES = [
            ["https://github.com/owner/repo.git", "owner-repo"], // .git-суффикс срезается
            ["git@github.com:owner/repo.git", "owner-repo"], // git@ SSH-формат → owner-repo
            ["https://git.corp.example/team/proj/repo", "proj-repo"], // self-hosted deep path — последние 2 сегмента
        ];
        for (const [url, expected] of CASES) {
            expect(repoSlug(url)).toBe(expected);
        }
    });

    it(".cloned-at: ISO-штамп в <cacheDir>/.cloned-at после clone (cache miss) и обновляется после fetch/checkout (cache hit)", () => {
        const projectDir = path.join(os.tmpdir(), "fan-f7-stamp-project");
        const expectedStampPath = path.join(projectDir, ".fan", "git", "owner-repo", ".cloned-at");
        const isoRe = /^\d{4}-\d{2}-\d{2}T/; // ISO-дата (new Date().toISOString())

        // Cache miss: clone → штамп через deps.fs.writeFileSync
        const miss = makeDeps({ cacheExists: false });
        const missWrites = [];
        miss.deps.fs.writeFileSync = (p, data) => missWrites.push({ p, data });
        cloneExternalRepo({ url: BASE_URL, base: "main", projectDir }, miss.deps);
        expect(missWrites).toHaveLength(1);
        expect(missWrites[0].p).toBe(expectedStampPath);
        expect(missWrites[0].data).toMatch(isoRe);

        // Cache hit: fetch --prune + checkout (clone НЕ вызван) → штамп обновлён
        const hit = makeDeps({ cacheExists: true });
        const hitWrites = [];
        hit.deps.fs.writeFileSync = (p, data) => hitWrites.push({ p, data });
        cloneExternalRepo({ url: BASE_URL, base: "main", projectDir }, hit.deps);
        expect(hit.gitCalls.some((c) => c.args[0] === "clone")).toBe(false);
        expect(hitWrites).toHaveLength(1);
        expect(hitWrites[0].p).toBe(expectedStampPath);
        expect(hitWrites[0].data).toMatch(isoRe);
    });
});
