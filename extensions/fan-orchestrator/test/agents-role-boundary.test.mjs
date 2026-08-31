/**
 * TDD RED tests for F-1.4 «Разграничение ролей verify и security в промптах».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-1.4» (TC-F-1.4-1, TC-F-1.4-2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md (verify = свежий дифф, security = полный аудит).
 *
 * Целевой контракт (спецификация для implement-воркера, Green-фаза):
 *   В verify.js (поле prompt) и verify.md (body) появляется boundary-секция из трёх смысловых частей:
 *     (1) РОЛЬ — verify проверяет свежий дифф / только что внесённые изменения
 *         (fresh diff / after implementation);
 *     (2) ПЕРЕДАЧА — глубокие аудиты (уязвимости/OWASP/CWE, секреты, зависимости, IaC, конфиги)
 *         явно передаются security-воркеру;
 *     (3) ГРАНИЦА — явное отрицание: verify НЕ выполняет глубокий аудит как собственную роль.
 *   useFor security (security.js/.md) уже содержит зеркальную формулировку «глубокий аудит,
 *   не дифф-проверка» (сделано в F-1.1) — здесь контракт ФИКСИРУЕТСЯ как regression-guard.
 *
 * TC-F-1.4-1 «verify-промпт содержит границу роли»: 3 boundary-маркера присутствуют
 *   в verify.js prompt И в verify.md body. Сейчас (Red): секции нет — в verify.js/.md
 *   нет ни «diff/fresh», ни «audit/аудит» (проверено grep-ом перед написанием).
 * TC-F-1.4-2 «useFor security и verify не пересекаются по триггерам»:
 *   - в security.useFor НЕТ дифф-триггеров verify (после имплементации / after implement /
 *     always run after / after a write);
 *   - в verify.useFor НЕТ deep-audit-триггеров security (аудит/audit + OWASP/CWE/
 *     secret scanning/IaC). Сейчас: оба условия уже выполнены → тесты зелёные СРАЗУ.
 *
 * Зафиксированные решения (расхождения/уточнения постановки):
 *   1. СТРОГОЕ «нет слова аудит в verify.useFor». Boundary-секция с передачей аудитов
 *      живёт в ПРОМПТЕ (TC-F-1.4-1), roadmap F-1.4 verify.useFor не меняет. Если после
 *      Green в verify.useFor появится «аудит/audit» — это триггер-пересечение: координатор,
 *      читающий useFor, может направить задачу глубокого аудита воркеру verify.
 *      Ссылку на security в useFor формулировать БЕЗ слова «аудит»
 *      (напр. «security checks beyond the fresh diff → security worker»).
 *   2. Слово «diff» в security.useFor («verify covers build/test diff checks instead») —
 *      это ПЕРЕДАЧА, а не триггер. Негативная проверка security идёт по конкретным
 *      дифф-триггерам verify, а не по голому слову «diff».
 *   3. useFor js ↔ md должны быть посимвольно равны (паттерн проекта: двойное
 *      определение по F-1.1 TC-F-1.1-2; расхождение = расхождение подсказок координатору).
 *   4. Маркеры — AND-конъюнкции связанных слов (как в agents-security-definition.test.mjs):
 *      заставляют Green-воркера написать осмысленный текст, а не keyword-soup.
 *
 * Red-ожидание: TC-F-1.4-1 — падают все 6 тестов (3 маркера × 2 источника):
 *   «boundary-секции в verify не существует». TC-F-1.4-2 — зелёные сразу (контракт
 *   useFor уже выполнен F-1.1/F-1.3); их падение означало бы регрессию, а не Red F-1.4.
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentDefinition, getAgentTypes } from "../agents/index.js";
import { parseFrontmatter } from "@seaagents/fan-coding-agent";

const VERIFY_TYPE = "verify";
const SECURITY_TYPE = "security";
const VERIFY_MD_URL = new URL("../agents/verify.md", import.meta.url);
const SECURITY_MD_URL = new URL("../agents/security.md", import.meta.url);

/* ============================================================================
 * Guards: определения и .md-файлы. Красная причина всегда читаема
 * (паттерн agents-security-definition.test.mjs).
 * ========================================================================== */

function requireDefinition(type) {
  const def = getAgentDefinition(type);
  if (!def) {
    throw new Error(
      `agents/index.js не содержит тип "${type}" ` +
        `(зарегистрировано: ${getAgentTypes().join(", ")}). ` +
        `${type === VERIFY_TYPE ? "verify.js — база, не предмет F-1.4" : `создай agents/${type}.js по образцу verify.js (roadmap F-1.1)`}.`,
    );
  }
  return def;
}

/** Guard + парсинг .md-агента штатным frontmatter-парсером проекта (как F-1.1). */
function requireAgentMd(url, label, roadmapHint) {
  if (!fs.existsSync(url)) {
    throw new Error(
      `${label} не существует — ${roadmapHint}`,
    );
  }
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(url, "utf-8"));
  return { frontmatter, body };
}

function requireVerifyMd() {
  return requireAgentMd(
    VERIFY_MD_URL,
    "agents/verify.md",
    "базовый файл, не предмет F-1.4 (двойное определение по образцу проекта)",
  );
}

function requireSecurityMd() {
  return requireAgentMd(
    SECURITY_MD_URL,
    "agents/security.md",
    "создай по образцу verify.md (roadmap F-1.1, Red-фаза той задачи)",
  );
}

/** Текст промпта JS-определения: поле `prompt` во всех агентах проекта (roadmap оперирует «systemPrompt»). */
function getPromptText(def) {
  return def?.prompt ?? def?.systemPrompt;
}

/** Guard: useFor определён и непуст (строка-подсказка для координаторского роутинга). */
function requireUseFor(useFor, source) {
  if (typeof useFor !== "string" || useFor.length === 0) {
    throw new Error(
      `useFor не найден или пуст в ${source} — координатор роутит задачи по этой строке, ` +
        "поле обязательно (roadmap F-1.4, TC-F-1.4-2).",
    );
  }
  return useFor;
}

const verifyDef = () => requireDefinition(VERIFY_TYPE);
const securityDef = () => requireDefinition(SECURITY_TYPE);
const verifyJsUseFor = () => requireUseFor(verifyDef().useFor, "verify.js");
const securityJsUseFor = () => requireUseFor(securityDef().useFor, "security.js");
const verifyMdUseFor = () => requireUseFor(requireVerifyMd().frontmatter.useFor, "verify.md (frontmatter)");
const securityMdUseFor = () => requireUseFor(requireSecurityMd().frontmatter.useFor, "security.md (frontmatter)");

/* ============================================================================
 * TC-F-1.4-1: три boundary-маркера (roadmap F-1.4). Каждый — AND-конъюнкция
 * связанных слов, case-insensitive; проверяются в ОБОИХ источниках
 * (verify.js prompt и verify.md body).
 * ========================================================================== */

// Маркер 1, часть A: слово «дифф/изменения» (RU или EN)
const RE_DIFF_WORD = /diff|дифф|изменени|изменен/i;
// Маркер 1, часть B: «свежести» — fresh/recent/«после имплементации»/after implementation.
// Голое «after» слишком частотно — берём только связные формулировки.
const RE_FRESH_CONTEXT =
  /fresh|recent|newly|just|свеж|недавн|только\s+что|после\s+(?:имплементации|реализации|внесения)|after\s+(?:the\s+)?implementation|after\s+a\s+write/i;

// Маркер 2, части: security + «глубокий» + «аудит» + делегационная формулировка.
const RE_SECURITY_MENTION = /security|безопасност/i;
const RE_DEEP_QUALIFIER = /deep|глубок|полн|full[-\s]?scope|comprehensive|всесторон/i;
const RE_AUDIT_WORD = /аудит|audit/i;
// Делегация: стрелка, delegate/hand off, «переда/отда», route, «воркер/worker».
const RE_DELEGATION =
  /→|->|=>|делегир|delegat|hand(?:ed)?[-\s]?off|переда|отда|rout(?:e|ed|ing)|escala|воркер|worker/i;

// Маркер 3: отрицание в одном предложении с «глубокий аудит» (в обе стороны).
// Для кириллицы \b не работает (ASCII-\w) — границы слова задаём явно.
const RU_NOT = String.raw`(?:^|[^а-яёa-z0-9])не(?=[^а-яёa-z0-9]|$)`;
const EN_NOT = String.raw`\b(?:not|never|no)\b|don't|doesn't|won't|mustn't|shouldn't`;
// ВАЖНО: отрицание — единая группа. Без обёртки (?:…) конкатенация `EN_NOT|RU_NOT` + хвост
// даёт приоритет |: ветка «not/never/no» матчится БЕЗ требования аудита рядом
// (ловили «NEVER modify project files» из verify.js — ложный green маркера 3).
const RE_NEGATION = new RegExp(`(?:${EN_NOT}|${RU_NOT})`, "i");
const DEEP_AUDIT_TERM = String.raw`(?:deep|глубок|полн|full[-\s]?scope|comprehensive|всесторон)[^\n.!?]{0,25}?(?:аудит|audit)`;
const RE_NEGATION_SRC = `(?:${EN_NOT}|${RU_NOT})`;
// «… NOT <…80> deep <…25> audit …»
const RE_NEGATION_THEN_DEEP_AUDIT = new RegExp(
  RE_NEGATION_SRC + String.raw`[^\n.!?]{0,80}?` + DEEP_AUDIT_TERM,
  "i",
);
// «deep <…25> audit <…80> NOT …»
const RE_DEEP_AUDIT_THEN_NEGATION = new RegExp(
  DEEP_AUDIT_TERM + String.raw`[^\n.!?]{0,80}?` + RE_NEGATION_SRC,
  "i",
);

/**
 * 3 boundary-маркера (roadmap F-1.4 → TC-F-1.4-1).
 * hint объясняет Green-воркеру, какой текст ожидается.
 */
const BOUNDARY_MARKERS = [
  {
    id: "FRESH_DIFF_ROLE",
    label: "роль: проверка свежего диффа / только что внесённых изменений",
    hint:
      "boundary-секция должна определять скоуп verify как «свежий дифф»: слово diff/дифф/изменения " +
      "В СОСТАВЕ с fresh/recent/«после имплементации»/after implementation " +
      "(напр. «Your scope is the FRESH DIFF — the changes just implemented»)",
    match: (text) => RE_DIFF_WORD.test(text) && RE_FRESH_CONTEXT.test(text),
  },
  {
    id: "DEEP_AUDIT_HANDOFF",
    label: "передача: глубокие аудиты → security-воркер",
    hint:
      "boundary-секция должна явно ПЕРЕДАВАТЬ глубокие аудиты security-воркеру: упоминание security + " +
      "«глубокий/full-scope» + «аудит/audit» + делегационная формулировка " +
      "(→, delegate, hand off, «переда…», security worker/воркер)",
    match: (text) =>
      RE_SECURITY_MENTION.test(text) &&
      RE_DEEP_QUALIFIER.test(text) &&
      RE_AUDIT_WORD.test(text) &&
      RE_DELEGATION.test(text),
  },
  {
    id: "NO_DEEP_AUDIT_OWN_ROLE",
    label: "граница: verify НЕ выполняет глубокий аудит (явное отрицание)",
    hint:
      "boundary-секция должна содержать явное отрицание собственной роли: «не/not/never» в одном " +
      "предложении с «(глубокий) аудит» — напр. «Verify does NOT perform deep audits» / " +
      "«глубокий аудит verify НЕ выполняет» (roadmap: «verify НЕ выполняет глубокий аудит»)",
    match: (text) => RE_NEGATION_THEN_DEEP_AUDIT.test(text) || RE_DEEP_AUDIT_THEN_NEGATION.test(text),
  },
];

/* ============================================================================
 * TC-F-1.4-2: триггеры useFor. Списки триггеров НЕ симметричны — каждый агент
 * получает отрицательную проверку по КОНКРЕТНЫМ фразам чужой роли (решение №2 шапки).
 * ========================================================================== */

/** Дифф-триггеры verify (источник: текущий verify.useFor «AFTER a write worker. Always run after implement…»). */
const VERIFY_DIFF_TRIGGERS = [
  { re: /после\s+имплементации/i, label: "«после имплементации» (RU)" },
  { re: /after\s+implement/i, label: "«after implement» (EN)" },
  { re: /always\s+run\s+after/i, label: "«always run after» (точная фраза verify.useFor)" },
  { re: /after\s+a\s+write/i, label: "«after a write (worker)» (точная фраза verify.useFor)" },
];

/** Deep-audit-триггеры security в useFor verify: голое слово «аудит/audit» (решение №1 шапки) + методология. */
const RE_AUDIT_TRIGGER = /аудит|audit/i;
const RE_AUDIT_METHODOLOGY = /owasp|\bcwe\b|secret\s+scanning|\biac\b/i;

/** Собственная роль verify должна СОХРАНИТЬСЯ в useFor (regression-guard Green-фазы:
 * устранение пересечения не должно «зачистить» легитимный дифф-триггер verify). */
const RE_VERIFY_OWN_ROLE = /after\s+a\s+write|always\s+run\s+after|after\s+implement|после\s+имплементации/i;

describe("F-1.4: разграничение ролей verify и security в промптах", () => {
  describe("TC-F-1.4-1: verify-промпт содержит границу роли (3 boundary-маркера)", () => {
    describe("JS-определение (prompt в verify.js)", () => {
      for (const marker of BOUNDARY_MARKERS) {
        it(`маркер: ${marker.label} (сейчас: секции нет → RED)`, () => {
          const def = verifyDef();
          const text = getPromptText(def) ?? "";
          expect(text.length, "промпт verify.js должен быть непустым (база)").toBeGreaterThan(0);
          expect(
            marker.match(text),
            `маркер «${marker.label}» (roadmap F-1.4, TC-F-1.4-1) не найден в prompt verify.js: ${marker.hint}`,
          ).toBe(true);
        });
      }
    });

    describe("MD-определение (body verify.md; frontmatter в проверку не входит)", () => {
      for (const marker of BOUNDARY_MARKERS) {
        it(`маркер: ${marker.label} (сейчас: секции нет → RED)`, () => {
          const { body } = requireVerifyMd();
          expect(body.trim().length, "body verify.md должен содержать методологию (база)").toBeGreaterThan(0);
          expect(
            marker.match(body),
            `маркер «${marker.label}» (roadmap F-1.4, TC-F-1.4-1) не найден в body verify.md: ${marker.hint}`,
          ).toBe(true);
        });
      }
    });
  });

  describe("TC-F-1.4-2: useFor security и verify не пересекаются по триггерам", () => {
    describe("security: глубокий аудит как роль, без дифф-триггеров verify (уже выполнено F-1.1 → зелёный regression-guard)", () => {
      it("security.js useFor формулирует глубокий аудит (deep + аудит)", () => {
        const useFor = securityJsUseFor();
        expect(
          RE_AUDIT_WORD.test(useFor) && RE_DEEP_QUALIFIER.test(useFor),
          "useFor security должен формулировать «глубокий аудит» (deep + audit; roadmap F-1.1/F-1.4)",
        ).toBe(true);
      });

      it("security.js useFor не содержит ни одного дифф-триггера verify", () => {
        const useFor = securityJsUseFor();
        for (const { re, label } of VERIFY_DIFF_TRIGGERS) {
          expect(re.test(useFor), `дифф-триггер verify ${label} не должен попадать в useFor security — ` +
            "иначе координатор направит «проверку после имплементации» аудиторам (TC-F-1.4-2)").toBe(false);
        }
      });

      it("security.md useFor формулирует глубокий аудит (deep + аудит)", () => {
        const useFor = securityMdUseFor();
        expect(
          RE_AUDIT_WORD.test(useFor) && RE_DEEP_QUALIFIER.test(useFor),
          "useFor из security.md должен зеркалить js-версию (глубокий аудит)",
        ).toBe(true);
      });

      it("security.md useFor не содержит ни одного дифф-триггера verify", () => {
        const useFor = securityMdUseFor();
        for (const { re, label } of VERIFY_DIFF_TRIGGERS) {
          expect(re.test(useFor), `дифф-триггер verify ${label} в useFor security.md (TC-F-1.4-2)`).toBe(false);
        }
      });
    });

    describe("verify: свежий дифф как роль, без deep-audit-триггеров security (зелёный regression-guard)", () => {
      it("verify.js useFor сохраняет собственную дифф-роль («после write-воркера»)", () => {
        const useFor = verifyJsUseFor();
        expect(
          RE_VERIFY_OWN_ROLE.test(useFor),
          "устранение пересечения не должно удалить легитимный триггер verify «после write-воркера» — " +
            "это его собственная роль (regression-guard Green-фазы F-1.4)",
        ).toBe(true);
      });

      it("verify.js useFor не содержит слово «аудит/audit» (строго, решение №1 шапки)", () => {
        const useFor = verifyJsUseFor();
        expect(
          RE_AUDIT_TRIGGER.test(useFor),
          "слово «аудит/audit» в verify.useFor — триггер-пересечение: координатор может направить " +
            "глубокий аудит воркеру verify. Передачу аудитов формулировать в ПРОМПТЕ (TC-F-1.4-1); " +
            "в useFor ссылку на security писать без слова «аудит»",
        ).toBe(false);
      });

      it("verify.js useFor не содержит deep-audit-методологию security (OWASP/CWE/secret scanning/IaC)", () => {
        const useFor = verifyJsUseFor();
        expect(
          RE_AUDIT_METHODOLOGY.test(useFor),
          "методологические слова security (OWASP/CWE/secret scanning/IaC) не должны появляться в useFor verify",
        ).toBe(false);
      });

      it("verify.md useFor сохраняет собственную дифф-роль («после write-воркера»)", () => {
        const useFor = verifyMdUseFor();
        expect(
          RE_VERIFY_OWN_ROLE.test(useFor),
          "легитимный триггер verify должен остаться и в md-версии useFor",
        ).toBe(true);
      });

      it("verify.md useFor не содержит слово «аудит/audit» (строго, решение №1 шапки)", () => {
        const useFor = verifyMdUseFor();
        expect(
          RE_AUDIT_TRIGGER.test(useFor),
          "слово «аудит/audit» в verify.useFor (md) — триггер-пересечение (TC-F-1.4-2)",
        ).toBe(false);
      });

      it("verify.md useFor не содержит deep-audit-методологию security (OWASP/CWE/secret scanning/IaC)", () => {
        const useFor = verifyMdUseFor();
        expect(
          RE_AUDIT_METHODOLOGY.test(useFor),
          "методологические слова security не должны появляться в useFor verify (md)",
        ).toBe(false);
      });
    });

    describe("взаимная непересекаемость и согласованность источников", () => {
      it("слово «аудит/audit» в useFor встречается только у security (0 пересечений по аудит-триггеру)", () => {
        const vJs = verifyJsUseFor();
        const vMd = verifyMdUseFor();
        const sJs = securityJsUseFor();
        const sMd = securityMdUseFor();
        expect(RE_AUDIT_TRIGGER.test(vJs) || RE_AUDIT_TRIGGER.test(vMd), "у verify «аудит» быть не должно").toBe(false);
        expect(RE_AUDIT_TRIGGER.test(sJs) && RE_AUDIT_TRIGGER.test(sMd), "у security «аудит» обязан быть").toBe(true);
      });

      it("useFor verify: js и md посимвольно равны (двойное определение, решение №3 шапки)", () => {
        expect(verifyMdUseFor(), "useFor в verify.md должен совпадать с verify.js").toBe(verifyJsUseFor());
      });

      it("useFor security: js и md посимвольно равны (двойное определение, решение №3 шапки)", () => {
        expect(securityMdUseFor(), "useFor в security.md должен совпадать с security.js").toBe(securityJsUseFor());
      });
    });
  });
});
