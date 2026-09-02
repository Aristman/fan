/**
 * TDD RED tests for F-1.1 «Определение агента security с промпт-методологией».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-1.1» (TC-F-1.1-1, TC-F-1.1-2, TC-F-1.1-3).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.1 (F1.1, F1.2, F1.6), §5.2 (двойное определение).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   Создать extensions/fan-orchestrator/agents/security.js + security.md — двойное определение
 *   по образцу существующих verify.js/verify.md (JS-модуль в AGENT_REGISTRY + MD с YAML frontmatter).
 *
 * TC-F-1.1-1: getAgentDefinition('security') возвращает определение:
 *             type="security", label="Security Auditor", icon="🔒", readOnly=true,
 *             tools ровно ["read","bash","grep","find","ls"],
 *             useFor — глубокий аудит (НЕ дифф-проверка), промпт — методология полного скоупа.
 * TC-F-1.1-2: agents/security.md парсится frontmatter-парсером проекта (parseFrontmatter из
 *             @seaagents/fan-coding-agent): name="security", description ≤ 1024 chars,
 *             tools согласованы с JS-версией.
 * TC-F-1.1-3: промпт содержит 9 обязательных маркеров методологии (roadmap F-1.1) —
 *             проверяются в ОБОИХ определениях (js prompt и md body):
 *             OWASP, CWE, secret scanning (regex+entropy), dependency audit (через bash),
 *             IaC (Dockerfile/compose/k8s), configuration audit (CORS/CSP/debug/TLS/cookie flags),
 *             severity-модель (CRITICAL..INFO + needs-verification), маскирование секретов
 *             (4+4 символа), запрет изменения кода (read-only).
 *
 * Red-ожидание (roadmap): «TC-F-1.1-1 — падает первым: getAgentDefinition('security')
 * возвращает undefined, файла не существует». Все падения должны читаться как
 * «агента/файла нет», а не «тест сломан» — guard-хелперы дают понятные сообщения.
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentDefinition, getAgentTypes } from "../agents/index.js";
import { parseFrontmatter } from "@seaagents/fan-coding-agent";

const SECURITY_TYPE = "security";
const SECURITY_MD_URL = new URL("../agents/security.md", import.meta.url);

/** Ожидаемые tools — ровно как в roadmap F-1.1 (и как в read-only эталоне verify.js). */
const EXPECTED_TOOLS = ["read", "bash", "grep", "find", "ls"];

/**
 * Guard: определение security в реестре. При отсутствии бросает понятную ошибку
 * с текущим составом реестра — причина Red всегда читаема.
 */
function requireSecurityDefinition() {
  const def = getAgentDefinition(SECURITY_TYPE);
  if (!def) {
    throw new Error(
      `agents/index.js не содержит тип "${SECURITY_TYPE}" ` +
        `(зарегистрировано: ${getAgentTypes().join(", ")}). ` +
        `Создай agents/security.js по образцу verify.js и зарегистрируй в AGENT_REGISTRY ` +
        `(roadmap F-1.1, Red-фаза).`,
    );
  }
  return def;
}

/**
 * Guard: MD-определение. Читает agents/security.md напрямую fs-ом и парсит
 * штатным frontmatter-парсером проекта (как это делает discoverAgents → loadAgentsFromDir).
 */
function requireSecurityMd() {
  if (!fs.existsSync(SECURITY_MD_URL)) {
    throw new Error(
      "agents/security.md не существует — создай по образцу verify.md " +
        "(YAML frontmatter: name/description/useFor/tools/icon + body-методология; roadmap F-1.1, Red-фаза).",
    );
  }
  const content = fs.readFileSync(SECURITY_MD_URL, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  return { frontmatter, body };
}

/**
 * Текст промпта JS-определения. Поле называется `prompt` во всех 8 существующих
 * агентах (verify.js и др.); roadmap оперирует термином «systemPrompt» — принимаем
 * любое из двух имён, но требуем непустую строку.
 */
function getPromptText(def) {
  return def?.prompt ?? def?.systemPrompt;
}

/** tools из frontmatter MD — comma-separated строка, как парсит loadAgentsFromDir (agents.js). */
function parseMdTools(rawTools) {
  return String(rawTools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 9 обязательных маркеров методологии (roadmap F-1.1 → TC-F-1.1-3).
 * Каждый — case-insensitive проверка по телу промпта; hint объясняет, чего не хватает.
 */
const METHODOLOGY_MARKERS = [
  {
    id: "OWASP",
    label: "OWASP Top 10",
    hint: "методология должна опираться на OWASP Top 10",
    match: (text) => /owasp/i.test(text),
  },
  {
    id: "CWE",
    label: "CWE-паттерны кода",
    hint: "нужна CWE-классификация findings (например, CWE-89)",
    match: (text) => /\bcwe\b|cwe-\d+/i.test(text),
  },
  {
    id: "SECRET_SCANNING",
    label: "secret scanning (regex + entropy)",
    hint: "нужен раздел secret scanning: regex-паттерны + entropy-эвристика",
    match: (text) => /secret/i.test(text) && /regex|pattern/i.test(text) && /entropy/i.test(text),
  },
  {
    id: "DEPENDENCY_AUDIT",
    label: "dependency audit через bash",
    hint: "нужен раздел dependency audit, запускаемый через bash (npm/pip/cargo audit и т.п.)",
    match: (text) => /dependenc/i.test(text) && /audit/i.test(text) && /\bbash\b/i.test(text),
  },
  {
    id: "IAC",
    label: "IaC (Dockerfile/compose/k8s)",
    hint: "нужен раздел IaC: Dockerfile, docker-compose, k8s/kubernetes",
    match: (text) =>
      /\biac\b|infrastructure[- ]as[- ]code/i.test(text) &&
      /dockerfile/i.test(text) &&
      /compose/i.test(text) &&
      /k8s|kubernetes/i.test(text),
  },
  {
    id: "CONFIG_AUDIT",
    label: "configuration audit (CORS/CSP/debug/TLS/cookie flags)",
    hint: "нужен раздел configuration audit: CORS, CSP, debug-режим, TLS, cookie flags",
    match: (text) =>
      /config/i.test(text) &&
      /\bcors\b/i.test(text) &&
      /\bcsp\b/i.test(text) &&
      /\bdebug\b/i.test(text) &&
      /\btls\b/i.test(text) &&
      /cookie/i.test(text),
  },
  {
    id: "SEVERITY_MODEL",
    label: "severity-модель CRITICAL..INFO + needs-verification",
    hint: "нужна severity-модель (CRITICAL/HIGH/MEDIUM/LOW/INFO) и метка needs-verification для неподтверждённых подозрений",
    match: (text) =>
      /critical/i.test(text) &&
      /high/i.test(text) &&
      /medium/i.test(text) &&
      /low/i.test(text) &&
      /\binfo\b/i.test(text) &&
      /needs[- ]verification/i.test(text),
  },
  {
    id: "SECRET_MASKING",
    label: "маскирование секретов (4+4 символа)",
    hint: "правило маскирования: в отчёте видны только первые 4 и последние 4 символа секрета",
    match: (text) =>
      /mask/i.test(text) &&
      /(?:first|last)\s*4\b|4\s*\+\s*4\b|four\s+characters/i.test(text),
  },
  {
    id: "READ_ONLY",
    label: "запрет изменения кода (read-only)",
    hint: "промпт должен запрещать изменение/создание файлов (read-only режим)",
    match: (text) =>
      /read[- ]only/i.test(text) &&
      /(?:never|must not|do not|don't)[^\n]{0,60}(?:modify|change|edit|write|create)/i.test(text),
  },
];

describe("F-1.1: определение агента security с промпт-методологией", () => {
  describe("TC-F-1.1-1: реестр резолвит security с корректным определением", () => {
    it("getAgentDefinition('security') возвращает определение (security.js создан и зарегистрирован)", () => {
      const def = requireSecurityDefinition();
      expect(typeof def).toBe("object");
    });

    it("базовые поля: type='security', label='Security Auditor', icon='🔒', readOnly=true", () => {
      const def = requireSecurityDefinition();
      expect(def.type).toBe("security");
      expect(def.label).toBe("Security Auditor");
      expect(def.icon).toBe("🔒");
      expect(def.readOnly).toBe(true);
    });

    it("tools — ровно [read, bash, grep, find, ls]", () => {
      const def = requireSecurityDefinition();
      expect(def.tools).toEqual(EXPECTED_TOOLS);
    });

    it("useFor — формулировка глубокого аудита, НЕ дифф-проверка после имплементации", () => {
      const def = requireSecurityDefinition();
      expect(typeof def.useFor).toBe("string");
      expect(def.useFor.length).toBeGreaterThan(0);
      expect(def.useFor, "useFor должен формулировать глубокий аудит (roadmap F-1.1 / F-1.5)").toMatch(
        /audit|аудит/i,
      );
      expect(def.useFor.toLowerCase(), "useFor не должен быть дифф-проверкой «после имплементации»").not.toContain(
        "после имплементации",
      );
      expect(def.useFor).not.toMatch(/after\s+(the\s+)?implement/i);
    });

    it("описание и промпт присутствуют (по образцу verify.js)", () => {
      const def = requireSecurityDefinition();
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      const prompt = getPromptText(def);
      expect(typeof prompt).toBe("string");
      expect(prompt.length, "промпт (prompt/systemPrompt) должен быть непустым").toBeGreaterThan(0);
    });
  });

  describe("TC-F-1.1-2: MD-определение парсится и согласовано с JS", () => {
    it("agents/security.md существует, frontmatter парсится штатным парсером, name='security'", () => {
      const { frontmatter } = requireSecurityMd();
      expect(frontmatter.name, "frontmatter name должен быть 'security' (как type в JS)").toBe("security");
    });

    it("description присутствует и ≤ 1024 символов", () => {
      const { frontmatter } = requireSecurityMd();
      expect(typeof frontmatter.description).toBe("string");
      expect(frontmatter.description.length, "description обязателен (loadAgentsFromDir его требует)").toBeGreaterThan(0);
      expect(frontmatter.description.length, "description ≤ 1024 chars (roadmap TC-F-1.1-2)").toBeLessThanOrEqual(1024);
    });

    it("tools из frontmatter согласованы с JS-версией", () => {
      const jsTools = [...requireSecurityDefinition().tools].sort();
      const { frontmatter } = requireSecurityMd();
      const mdTools = parseMdTools(frontmatter.tools).sort();
      expect(mdTools, "tools из security.md должны совпадать с JS-версией (набор)").toEqual(jsTools);
      expect(mdTools.length).toBeGreaterThan(0);
    });

    it("icon согласован с JS-версией (🔒) — виден в /agents", () => {
      const jsIcon = requireSecurityDefinition().icon;
      const { frontmatter } = requireSecurityMd();
      expect(frontmatter.icon, "icon в security.md должен совпадать с JS-версией").toBe(jsIcon);
    });
  });

  describe("TC-F-1.1-3: промпт содержит обязательные секции методологии", () => {
    describe("JS-определение (prompt в security.js)", () => {
      for (const marker of METHODOLOGY_MARKERS) {
        it(`маркер: ${marker.label}`, () => {
          const def = requireSecurityDefinition();
          const text = getPromptText(def) ?? "";
          expect(
            marker.match(text),
            `маркер «${marker.label}» (roadmap F-1.1, TC-F-1.1-3) не найден: ${marker.hint}`,
          ).toBe(true);
        });
      }
    });

    describe("MD-определение (body security.md)", () => {
      for (const marker of METHODOLOGY_MARKERS) {
        it(`маркер: ${marker.label}`, () => {
          const { body } = requireSecurityMd();
          expect(body.trim().length, "body security.md должен содержать методологию").toBeGreaterThan(0);
          expect(
            marker.match(body),
            `маркер «${marker.label}» (roadmap F-1.1, TC-F-1.1-3) не найден в body security.md: ${marker.hint}`,
          ).toBe(true);
        });
      }
    });
  });
});
