/**
 * TDD RED tests for F-14 «Agent profile config (read-only + 0.2/900s + DEPLOY)».
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-14» (TC-F-14-1/2/3).
 * Спека: docs/specs/spec_code-review-worker_2026-09-03.md (read-only слот, 0.2/900s, DEPLOY-манифест).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   broker-handler.js:PROFILES_BY_AGENT — "code-review" → "read-only" (КРИТИЧНО: отсутствие
 *   ключа = DEFAULT_LEVEL "all" → воркер получает write-MCP) + "security" → "read-only"
 *   (regression guard той же permissions-дырки).
 *   config.js:DEFAULTS — agentTemperature["code-review"] = 0.2 (стабильный verdict),
 *   agentTimeouts["code-review"] = 900 (git clone + большой diff).
 *   config.example.json — cloud.models["code-review"] = "" + local.models["code-review"] = ""
 *   (× 2 секции, по образцу 9 существующих агентов).
 *   orchestrator-extension.js — agentIcons["code-review"] = "🔎" ×2 (декларации ~:500 и ~:1218),
 *   WORKER_PROFILES["code-review"] существует, ASSIGNMENT_ORDER содержит "code-review".
 *   DEPLOY.toml — include += "review-rules/*.md", "review-adapters.d.ts", "review-adapters.md"
 *   (файлов адаптеров ещё нет — include опережает F-15, это ок).
 *
 * Как тестируем: PROFILES_BY_AGENT не экспортируется (module-private const в broker-handler.js),
 * поэтому контракт TC-F-14-1 проверяется через экспортируемый brokerHandler.getPermissionLevel(name):
 * он возвращает PROFILES_BY_AGENT[name] ?? DEFAULT_LEVEL, т.е. "read-only" тогда и только тогда,
 * когда ключ есть в карте (DEFAULT_LEVEL = "all" фиксируется отдельным guard-тестом — иначе
 * смена DEFAULT_LEVEL дала бы ложную зелень без правки карты).
 *
 * Red-статус (честная фиксация на момент RED, constraint задачи):
 *   - TC-F-14-1: RED — в PROFILES_BY_AGENT (broker-handler.js:26) нет ни "code-review", ни
 *     "security" (карта: explore, plan, verify, code-research, implement, bug-fix, tests-impl).
 *     Оба агента падают в default "all" → дырка подтверждена. Security-доля карточки
 *     («заодно добить security») НЕ закрыта заранее — read-only у security есть только в
 *     discovery-реестре (agents.js, readOnly=true), но не в permissions-карте MCP-профилей.
 *   - TC-F-14-2: RED — DEFAULTS.agentTemperature/agentTimeouts без "code-review";
 *     config.example.json без "code-review" в cloud.models и local.models.
 *   - TC-F-14-3: частично GREEN с F-2 — agentIcons["code-review"]="🔎" ×2 (строки ~503 и ~1219)
 *     и WORKER_PROFILES["code-review"] (~761) уже есть (F-2 Green, критерий частично закрыт
 *     заранее — roadmap это допускает). RED-доли: ASSIGNMENT_ORDER (~764) без "code-review"
 *     и DEPLOY.toml include без всех трёх паттернов (review-rules/, оба adapters-файла).
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { brokerHandler } from "../broker-handler.js";
import { DEFAULTS } from "../config.js";

const REVIEW_TYPE = "code-review";
const EXAMPLE_URL = new URL("../config.example.json", import.meta.url);
const EXTENSION_URL = new URL("../orchestrator-extension.js", import.meta.url);
const DEPLOY_URL = new URL("../DEPLOY.toml", import.meta.url);

/** 1-индексированный номер строки вхождения regex в исходнике (для диагностики). */
function lineOf(source, regex) {
  const match = source.match(regex);
  if (!match) return null;
  return source.slice(0, match.index).split("\n").length;
}

/** Guard: config.example.json существует и парсится (база, не предмет F-14). */
function loadExampleConfig() {
  if (!fs.existsSync(EXAMPLE_URL)) {
    throw new Error(
      "config.example.json не существует — ожидается в extensions/fan-orchestrator/ рядом с config.js.",
    );
  }
  try {
    return JSON.parse(fs.readFileSync(EXAMPLE_URL, "utf-8"));
  } catch (e) {
    throw new Error(
      `config.example.json не парсится (JSON.parse): ${e.message}. ` +
        "Почини JSON прежде чем добавлять code-review-ключи (roadmap F-14).",
    );
  }
}

/** Guard: исходник orchestrator-extension.js читается (контракт исходников, TC-F-14-3). */
function readExtensionSource() {
  if (!fs.existsSync(EXTENSION_URL)) {
    throw new Error(
      "orchestrator-extension.js не существует — ожидается в extensions/fan-orchestrator/.",
    );
  }
  return fs.readFileSync(EXTENSION_URL, "utf-8");
}

/** Guard: DEPLOY.toml читается (контракт манифеста, TC-F-14-3). */
function readDeployToml() {
  if (!fs.existsSync(DEPLOY_URL)) {
    throw new Error("DEPLOY.toml не существует — ожидается в корне extensions/fan-orchestrator/.");
  }
  return fs.readFileSync(DEPLOY_URL, "utf-8");
}

/**
 * Все декларации `const agentIcons = { ... }` в orchestrator-extension.js (их 2: ~:500 и ~:1218).
 * Контракт F-14: КАЖДАЯ декларация содержит "code-review": "🔎" (дубль обязателен —
 * refactor-цель «унифицировать дубли в один объект» допустима только вместе с правкой теста).
 */
function findAgentIconsDeclarations(source) {
  const declarations = [];
  const regex = /const\s+agentIcons\s*=\s*\{[^}]*\}/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    declarations.push({
      line: source.slice(0, match.index).split("\n").length,
      body: match[0],
    });
  }
  return declarations;
}

describe("F-14: Agent profile config (read-only + 0.2/900s + DEPLOY)", () => {
  describe("TC-F-14-1: PROFILES_BY_AGENT — read-only профили (контракт permissions)", () => {
    it(`getPermissionLevel("${REVIEW_TYPE}") === "read-only" (иначе default "all" → write-MCP)`, () => {
      expect(
        brokerHandler.getPermissionLevel(REVIEW_TYPE),
        `broker-handler.js:PROFILES_BY_AGENT не содержит "${REVIEW_TYPE}" — воркер падает в ` +
          `DEFAULT_LEVEL "${brokerHandler.getPermissionLevel("nonexistent-f14-probe")}" (write-MCP). ` +
          `Добавь "${REVIEW_TYPE}": "read-only" (roadmap F-14, критично для безопасности).`,
      ).toBe("read-only");
    });

    it('getPermissionLevel("security") === "read-only" (regression guard permissions-дырки)', () => {
      expect(
        brokerHandler.getPermissionLevel("security"),
        'broker-handler.js:PROFILES_BY_AGENT не содержит "security" — security-воркер тоже ' +
          'падает в default "all" (write-MCP). «Заодно добить security» из карточки F-14: ' +
          'добавь "security": "read-only".',
      ).toBe("read-only");
    });

    it('guard: DEFAULT_LEVEL остаётся "all" (иначе предыдущие проверки — ложная зелень)', () => {
      // Дискриминатор: если кто-то «починит» дырку сменой DEFAULT_LEVEL на "read-only",
      // карта фактически не будет содержать ключей, а тесты выше позеленели бы без правки.
      expect(
        brokerHandler.getPermissionLevel("nonexistent-f14-probe"),
        'DEFAULT_LEVEL в broker-handler.js изменился — контракт "map-ключ ИЛИ default all" нарушен: ' +
          "TC-F-14-1 требует явные ключи в PROFILES_BY_AGENT, а не подмену уровня по умолчанию.",
      ).toBe("all");
    });
  });

  describe("TC-F-14-2: DEFAULTS — agentTemperature 0.2 + agentTimeouts 900 + config.example.json", () => {
    it("DEFAULTS.agentTemperature[\"code-review\"] === 0.2 (own-ключ, стабильный verdict)", () => {
      expect(
        Object.hasOwn(DEFAULTS.agentTemperature ?? {}, REVIEW_TYPE),
        `config.js:DEFAULTS.agentTemperature не содержит ключ "${REVIEW_TYPE}" — ` +
          `добавь "${REVIEW_TYPE}": 0.2 (roadmap F-14 / спека §4.1).`,
      ).toBe(true);
      expect(
        DEFAULTS.agentTemperature[REVIEW_TYPE],
        `DEFAULTS.agentTemperature["${REVIEW_TYPE}"] должен быть ровно 0.2 — ` +
          "низкая температура для воспроизводимого verdict (спека §4.1).",
      ).toBe(0.2);
    });

    it("DEFAULTS.agentTimeouts[\"code-review\"] === 900 (own-ключ, clone + большой diff)", () => {
      expect(
        Object.hasOwn(DEFAULTS.agentTimeouts ?? {}, REVIEW_TYPE),
        `config.js:DEFAULTS.agentTimeouts не содержит ключ "${REVIEW_TYPE}" — ` +
          `добавь "${REVIEW_TYPE}": 900 (roadmap F-14 / спека §4.1).`,
      ).toBe(true);
      expect(
        DEFAULTS.agentTimeouts[REVIEW_TYPE],
        `DEFAULTS.agentTimeouts["${REVIEW_TYPE}"] должен быть ровно 900 — ` +
          "бюджет на git clone внешнего репо + большой diff (спека §4.1).",
      ).toBe(900);
    });

    it("config.example.json валиден (JSON.parse) — база, не предмет F-14", () => {
      expect(() => loadExampleConfig()).not.toThrow();
    });

    it("config.example.json: cloud.models содержит ключ code-review", () => {
      const example = loadExampleConfig();
      expect(
        Object.hasOwn(example.cloud?.models ?? {}, REVIEW_TYPE),
        `config.example.json: cloud.models не содержит ключ "${REVIEW_TYPE}" — ` +
          "добавь по образцу 9 существующих агентов (roadmap F-14: × 2 секции cloud/local).",
      ).toBe(true);
    });

    it("config.example.json: local.models содержит ключ code-review", () => {
      const example = loadExampleConfig();
      expect(
        Object.hasOwn(example.local?.models ?? {}, REVIEW_TYPE),
        `config.example.json: local.models не содержит ключ "${REVIEW_TYPE}" — ` +
          "ключ обязан быть в ОБОИХ провайдерах (roadmap F-14: × 2 секции cloud/local).",
      ).toBe(true);
    });
  });

  describe("TC-F-14-3: контракт исходников (orchestrator-extension.js + DEPLOY.toml)", () => {
    it("agentIcons[\"code-review\"]=\"🔎\" присутствует в ОБОИХ декларациях (закрыто F-2 — фиксация)", () => {
      const source = readExtensionSource();
      const declarations = findAgentIconsDeclarations(source);
      expect(
        declarations.length >= 2,
        `Ожидалось ≥ 2 деклараций const agentIcons в orchestrator-extension.js ` +
          `(roadmap: ~:500 и ~:1218), найдено: ${declarations.length}. ` +
          "Если дубли объединены — обнови тест вместе с refactor-целью F-14.",
      ).toBe(true);
      for (const { line, body } of declarations) {
        expect(
          /["']code-review["']\s*:\s*["']🔎["']/.test(body),
          `orchestrator-extension.js:${line}: декларация agentIcons без "code-review": "🔎" — ` +
            "иконка обязана быть в каждом экземпляре карты (roadmap F-14, дубль ~:500 и ~:1218).",
        ).toBe(true);
      }
    });

    it("WORKER_PROFILES содержит \"code-review\" (закрыто F-2 — фиксация)", () => {
      const source = readExtensionSource();
      // ВНИМАНИЕ: WORKER_PROFILES — объект с ВЛОЖЕНными объектами-профилями, поэтому [^}]*
      // обрезался бы на первой внутренней }, а не на конце декларации. Ловим до "\n };".
      const match = source.match(/const\s+WORKER_PROFILES\s*=\s*\{[\s\S]*?\n\s*\};/);
      expect(
        match !== null,
        "orchestrator-extension.js: декларация const WORKER_PROFILES не найдена " +
          "(roadmap: Smart assignment scoring, ~:751).",
      ).toBe(true);
      expect(
        /["']code-review["']\s*:/.test(match[0]),
        `WORKER_PROFILES (orchestrator-extension.js:${lineOf(source, /const\s+WORKER_PROFILES/)}) ` +
          `не содержит ключ "${REVIEW_TYPE}" — добавь запись профиля (roadmap F-14).`,
      ).toBe(true);
    });

    it("ASSIGNMENT_ORDER включает \"code-review\" (RED: порядок назначения моделей)", () => {
      const source = readExtensionSource();
      const match = source.match(/const\s+ASSIGNMENT_ORDER\s*=\s*\[([^\]]*)\]/);
      expect(
        match !== null,
        "orchestrator-extension.js: декларация const ASSIGNMENT_ORDER не найдена (~:764).",
      ).toBe(true);
      const order = match[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      expect(
        order,
        `ASSIGNMENT_ORDER (orchestrator-extension.js:${lineOf(source, /const\s+ASSIGNMENT_ORDER/)}) ` +
          `не содержит "${REVIEW_TYPE}" — добавь в порядок назначения моделей (roadmap F-14). ` +
          `Текущий состав: [${order.join(", ")}].`,
      ).toContain(REVIEW_TYPE);
    });

    it("DEPLOY.toml: include содержит review-rules/*.md (RED: include опережает F-15)", () => {
      const toml = readDeployToml();
      const includeBlock = toml.match(/include\s*=\s*\[([^\]]*)\]/);
      expect(
        includeBlock !== null,
        "DEPLOY.toml: секция include = [...] не найдена.",
      ).toBe(true);
      expect(
        /["']review-rules\/\*\.md["']/.test(includeBlock[1]),
        `DEPLOY.toml (extensions/fan-orchestrator/DEPLOY.toml:${lineOf(toml, /include\s*=/)}): ` +
          'include не содержит "review-rules/*.md" — добавь в include-массив (roadmap F-14; ' +
          "файлов правил пока нет, include опережает наполнение — это ок).",
      ).toBe(true);
    });

    it("DEPLOY.toml: include содержит review-adapters.d.ts (RED: контракт F-15)", () => {
      const toml = readDeployToml();
      const includeBlock = toml.match(/include\s*=\s*\[([^\]]*)\]/);
      expect(
        includeBlock !== null,
        "DEPLOY.toml: секция include = [...] не найдена.",
      ).toBe(true);
      expect(
        /["']review-adapters\.d\.ts["']/.test(includeBlock[1]),
        `DEPLOY.toml (extensions/fan-orchestrator/DEPLOY.toml:${lineOf(toml, /include\s*=/)}): ` +
          'include не содержит "review-adapters.d.ts" — добавь в include-массив (roadmap F-14; ' +
          "файл адаптера появится в F-15, include обязан быть уже сейчас).",
      ).toBe(true);
    });

    it("DEPLOY.toml: include содержит review-adapters.md (RED: контракт F-15)", () => {
      const toml = readDeployToml();
      const includeBlock = toml.match(/include\s*=\s*\[([^\]]*)\]/);
      expect(
        includeBlock !== null,
        "DEPLOY.toml: секция include = [...] не найдена.",
      ).toBe(true);
      expect(
        /["']review-adapters\.md["']/.test(includeBlock[1]),
        `DEPLOY.toml (extensions/fan-orchestrator/DEPLOY.toml:${lineOf(toml, /include\s*=/)}): ` +
          'include не содержит "review-adapters.md" — добавь в include-массив (roadmap F-14; ' +
          "документация адаптера появится в F-15, include обязан быть уже сейчас).",
      ).toBe(true);
    });

    it("aggregate: полный контракт F-14 (одна диагностика со списком всех отсутствующих паттернов)", () => {
      // Служебная сводка для implement-воркера: единый список рассинхронов вместо
      // поэлементных падений. Падает, пока не закрыта хотя бы одна RED-доля контракта.
      const source = readExtensionSource();
      const toml = readDeployToml();
      const missing = [];

      const declarations = findAgentIconsDeclarations(source);
      if (declarations.length < 2 || declarations.some((d) => !/["']code-review["']\s*:\s*["']🔎["']/.test(d.body))) {
        missing.push("orchestrator-extension.js: agentIcons[\"code-review\"]=\"🔎\" ×2 (найдено деклараций с ключом: " +
          `${declarations.filter((d) => /["']code-review["']\s*:\s*["']🔎["']/.test(d.body)).length}/2)`);
      }
      const profiles = source.match(/const\s+WORKER_PROFILES\s*=\s*\{[\s\S]*?\n\s*\};/);
      if (!profiles || !/["']code-review["']\s*:/.test(profiles[0])) {
        missing.push("orchestrator-extension.js: WORKER_PROFILES[\"code-review\"]");
      }
      const order = source.match(/const\s+ASSIGNMENT_ORDER\s*=\s*\[([^\]]*)\]/);
      const orderItems = order
        ? order[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
      if (!orderItems.includes(REVIEW_TYPE)) {
        missing.push(`orchestrator-extension.js: ASSIGNMENT_ORDER без "${REVIEW_TYPE}" (сейчас: [${orderItems.join(", ")}])`);
      }
      const includeBlock = toml.match(/include\s*=\s*\[([^\]]*)\]/);
      for (const pattern of ["review-rules/*.md", "review-adapters.d.ts", "review-adapters.md"]) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!includeBlock || !new RegExp(`["']${escaped}["']`).test(includeBlock[1])) {
          missing.push(`DEPLOY.toml: include без "${pattern}"`);
        }
      }

      expect(
        missing,
        "Контракт F-14 нарушен — отсутствующие паттерны:\n  - " + missing.join("\n  - "),
      ).toEqual([]);
    });
  });
});
