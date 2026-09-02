/**
 * TDD RED tests for F-0.1 «Динамические списки агентных типов из реестра».
 * Spec: docs/features/security-worker/roadmap.md → «#### ☐ F-0.1» (TC-F-0.1-1, TC-F-0.1-2).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   1. types.js экспортирует WORKER_TYPES как ФУНКЦИЮ: WORKER_TYPES() возвращает актуальный
 *      список агентов реестра (getAgentTypes() из ./agents/index.js), а не статичный массив.
 *   2. model-editor.js экспортирует AGENT_TYPES как ФУНКЦИЮ: AGENT_TYPES() — тот же
 *      единственный источник (реестр), без собственных констант.
 *   3. orchestrator-extension.js реэкспортирует getAgentTypes из ./agents/index.js
 *      (single source of truth); локальные массивы agentTypes (~строки 494 и 1210) удалены.
 *
 * TC-F-0.1-1: фиктивный агент «test-fake», добавленный в реестр (vi.doMock agents/index.js),
 *             появляется во всех трёх источниках без правок кода
 *             (vi.resetModules + dynamic import — обход кеша модулей).
 * TC-F-0.1-2: списки трёх источников идентичны реестру (состав И порядок);
 *             кастомные user/project .md-агенты НЕ попадают в списки
 *             (fixture: временный каталог с .fan/agents/*.md).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_REGISTRY, getAgentTypes } from "../agents/index.js";
import { discoverAgents } from "../agents.js";

/** Определение фиктивного агента — форма повторяет реальные определения (agents/explore.js). */
const FAKE_AGENT_DEF = {
  type: "test-fake",
  label: "Test Fake",
  prompt: "You are a fake agent used by the F-0.1 tests.",
  tools: ["read"],
  readOnly: true,
  description: "Fake agent injected by F-0.1 tests",
  useFor: "verifying that type lists are registry-driven",
  icon: "🧯",
};

const REAL_AGENT_TYPES = getAgentTypes();
const FAKE_TYPE = "test-fake";

/**
 * Динамически импортирует все три потребителя с дополненным реестром:
 * AGENT_REGISTRY расширен фиктивным агентом test-fake (без правки исходников).
 * vi.resetModules сбрасывает кеш модулей, vi.doMock подменяет реестр
 * только на время импорта — потребители инициализируются уже с test-fake.
 */
async function importConsumersWithFakeRegistry() {
  vi.resetModules();
  vi.doMock("../agents/index.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      AGENT_REGISTRY: { ...actual.AGENT_REGISTRY, [FAKE_TYPE]: FAKE_AGENT_DEF },
      getAgentTypes: () => [...actual.getAgentTypes(), FAKE_TYPE],
    };
  });
  try {
    const types = await import("../types.js");
    const editor = await import("../model-editor.js");
    const extension = await import("../orchestrator-extension.js");
    return { types, editor, extension };
  } finally {
    vi.doUnmock("../agents/index.js");
  }
}

/** Чистый (без моков) динамический импорт модуля потребителя. */
async function cleanImport(spec) {
  vi.resetModules();
  return import(spec);
}

/**
 * Fixture: временный каталог проекта с кастомным .md-агентом (.fan/agents/).
 * discoverAgents() обязан его находить (санити fixture), но built-in списки
 * типов (WORKER_TYPES / AGENT_TYPES) его содержать не должны.
 */
function makeProjectCustomAgentFixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "f0-1-custom-agent-"));
  const agentsDir = path.join(projectDir, ".fan", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "f0-1-custom-agent.md"),
    [
      "---",
      "name: f0-1-custom-agent",
      'description: "Custom agent fixture for F-0.1 — must not leak into built-in type lists"',
      "tools: read",
      "---",
      "",
      "You are a custom project agent used by the F-0.1 tests.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    projectDir,
    customName: "f0-1-custom-agent",
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

// Спецификация F-0.1: три файла-потребителя не должны содержать захардкоженный
// список из 8 типов (Refactor-цель: «удалить три дублирующихся массива»).
const CONSUMER_FILES = ["../types.js", "../model-editor.js", "../orchestrator-extension.js"].map(
  (spec) => ({ spec, url: new URL(spec, import.meta.url) }),
);
const HARDCODED_LIST_RE =
  /["']explore["']\s*,\s*["']plan["']\s*,\s*["']implement["']\s*,\s*["']verify["']\s*,\s*["']bug-fix["']\s*,\s*["']code-research["']\s*,\s*["']tests-impl["']\s*,\s*["']docs-impl["']/;

afterEach(() => {
  vi.resetModules();
});

describe("F-0.1: динамические списки агентных типов из реестра", () => {
  describe("TC-F-0.1-1: фиктивный агент из реестра появляется во всех трёх источниках", () => {
    it("types.js — WORKER_TYPES() содержит test-fake без правок types.js", async () => {
      const { types } = await importConsumersWithFakeRegistry();

      // Целевой контракт: WORKER_TYPES — функция-аксессор над реестром, не статичный массив.
      expect(typeof types.WORKER_TYPES).toBe("function");

      const list = types.WORKER_TYPES();
      expect(list).toContain(FAKE_TYPE);
      // Дополнение реестра, а не подмена: built-in типы остаются на месте.
      for (const t of REAL_AGENT_TYPES) expect(list).toContain(t);
    });

    it("model-editor.js — AGENT_TYPES() содержит test-fake без правок model-editor.js", async () => {
      const { editor } = await importConsumersWithFakeRegistry();

      // Целевой контракт: AGENT_TYPES — функция-аксессор над реестром.
      expect(typeof editor.AGENT_TYPES).toBe("function");

      const list = editor.AGENT_TYPES();
      expect(list).toContain(FAKE_TYPE);
      for (const t of REAL_AGENT_TYPES) expect(list).toContain(t);
    });

    it("orchestrator-extension.js — список типов содержит test-fake (реэкспорт getAgentTypes из реестра)", async () => {
      const { extension } = await importConsumersWithFakeRegistry();

      // Целевой контракт: orchestrator-extension.js реэкспортирует getAgentTypes
      // из ./agents/index.js — локальные agentTypes-массивы удалены.
      expect(typeof extension.getAgentTypes).toBe("function");

      const list = extension.getAgentTypes();
      expect(list).toContain(FAKE_TYPE);
      for (const t of REAL_AGENT_TYPES) expect(list).toContain(t);
    });
  });

  describe("TC-F-0.1-2: списки трёх источников идентичны реестру", () => {
    it("types.js — WORKER_TYPES() равен getAgentTypes() (состав и порядок)", async () => {
      const { WORKER_TYPES } = await cleanImport("../types.js");

      expect(typeof WORKER_TYPES).toBe("function");
      expect(WORKER_TYPES()).toEqual(REAL_AGENT_TYPES);
    });

    it("model-editor.js — AGENT_TYPES() равен getAgentTypes() (состав и порядок)", async () => {
      const { AGENT_TYPES } = await cleanImport("../model-editor.js");

      expect(typeof AGENT_TYPES).toBe("function");
      expect(AGENT_TYPES()).toEqual(REAL_AGENT_TYPES);
    });

    it("orchestrator-extension.js — getAgentTypes() равен реестру (состав и порядок)", async () => {
      const { getAgentTypes: extensionTypes } = await cleanImport("../orchestrator-extension.js");

      expect(typeof extensionTypes).toBe("function");
      expect(extensionTypes()).toEqual(REAL_AGENT_TYPES);
    });

    it("кастомные project .md-агенты не попадают в списки (fixture: временный .fan/agents)", async () => {
      const fixture = makeProjectCustomAgentFixture();
      try {
        // Санити fixture: discoverAgents() видит кастомного агента проекта
        // (scope "project" — не зависит от ~/.fan тестовой машины).
        const discovered = discoverAgents(fixture.projectDir, "project").agents.map((a) => a.name);
        expect(discovered).toContain(fixture.customName);

        const { WORKER_TYPES } = await cleanImport("../types.js");
        const { AGENT_TYPES } = await cleanImport("../model-editor.js");

        // Оба источника — только built-in из реестра: ровно реестр, без кастомных.
        expect(typeof WORKER_TYPES).toBe("function");
        expect(WORKER_TYPES()).toEqual(REAL_AGENT_TYPES);
        expect(WORKER_TYPES()).not.toContain(fixture.customName);

        expect(typeof AGENT_TYPES).toBe("function");
        expect(AGENT_TYPES()).toEqual(REAL_AGENT_TYPES);
        expect(AGENT_TYPES()).not.toContain(fixture.customName);
      } finally {
        fixture.cleanup();
      }
    });
  });

  it("спецификация F-0.1: захардкоженные списки 8 типов удалены из всех трёх источников", () => {
    const offenders = CONSUMER_FILES
      .filter(({ url }) => HARDCODED_LIST_RE.test(fs.readFileSync(url, "utf-8")))
      .map(({ spec }) => spec);
    expect(offenders).toEqual([]);
  });
});
