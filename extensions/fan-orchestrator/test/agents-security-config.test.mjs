/**
 * TDD RED tests for F-1.2 «Регистрация security в реестре и конфиге» (конфиг-часть).
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-1.2» (TC-F-1.2-1, TC-F-1.2-2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md (config.example.json: models + agentTemperature.security: 0.1).
 *
 * Целевой контракт (спецификация для implement-воркера):
 *   config.example.json получает ключ «security» в models (cloud И local — как у 8 существующих
 *   агентов) и «security»: 0.1 в agentTemperature — чтобы resolveWorkerModel/resolveWorkerTemperature
 *   работали для security по тем же цепочкам, что и для остальных воркеров.
 *
 * TC-F-1.2-1: discoverAgents находит security среди built-in
 *             (name="security", source="builtin", readOnly=true).
 *             ВАЖНО: реестр уже содержит security (F-1.1, commit 518e2fb) — этот блок
 *             зелёный сразу и ФИКСИРУЕТ контракт discovery. Это не нарушение Red:
 *             roadmap прямо допускает зелёный TC-F-1.2-1 при выполненной F-1.1.
 *             Примечание к API: в roadmap указан scope 'builtin', но фактический
 *             AgentScope = "user" | "project" | "both"; built-in агенты загружаются
 *             всегда, поэтому «чистый built-in набор» = изолированный временный cwd
 *             (без .fan/agents вверх по дереву) + scope "project" (user-агенты пропускаются).
 *
 * TC-F-1.2-2: конфиг резолвит модель и температуру для security
 *   (a) config.example.json валиден (JSON.parse) и содержит ОБА ключа security
 *       (cloud.models + local.models + agentTemperature === 0.1) — критерий приёмки №2;
 *   (b) resolveWorkerModel('security', config, mode) и resolveWorkerTemperature('security', config)
 *       не бросают исключений и возвращают per-agent значения.
 *
 * Red-ожидание (roadmap + constraint задачи): красной обязана быть конфиг-часть —
 * config.example.json ещё не содержит security-ключей. Подводный камень ложной зелени:
 * глобальная temperature в примере равна 0.1 — совпадает с целевой per-agent температурой,
 * поэтому resolveWorkerTemperature зелёный «случайно» (fallback). Дискриминатор — тест с
 * отличающейся глобальной temperature (0.7): без per-agent ключа он падает, с ключом — зелёный.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "../agents.js";
import { resolveWorkerModel, resolveWorkerTemperature } from "../config.js";

const SECURITY_TYPE = "security";
const EXAMPLE_URL = new URL("../config.example.json", import.meta.url);

/**
 * Guard: config.example.json существует и парсится. При нарушении бросает понятную
 * ошибку — причина Red всегда читаема (это база, а не предмет F-1.2).
 */
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
        "Почини JSON прежде чем добавлять security-ключи (roadmap F-1.2).",
    );
  }
}

/**
 * Fixture: изолированный временный cwd вне репозитория. В нём и вверх по дереву нет
 * .fan/agents → project-агенты пусты; scope "project" пропускает user-агенты →
 * discoverAgents возвращает ровно built-in набор (см. agents.js: merge builtin → user → project).
 */
function makeIsolatedCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-2-discovery-"));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Guard: security среди discovered-агентов. Без него — понятная ошибка с составом набора. */
function requireSecurityAgent(agents) {
  const found = agents.find((a) => a.name === SECURITY_TYPE);
  if (!found) {
    throw new Error(
      `discoverAgents не находит "${SECURITY_TYPE}" среди built-in ` +
        `(найдено: ${agents.map((a) => a.name).join(", ")}). ` +
        "Проверь agents/security.md (frontmatter name) и регистрацию в реестре (roadmap F-1.1/F-1.2).",
    );
  }
  return found;
}

describe("F-1.2: регистрация security в реестре и конфиге", () => {
  describe("TC-F-1.2-1: discoverAgents находит security среди built-in", () => {
    it("агент security присутствует в built-in discovery (изолированный cwd → только built-in)", () => {
      const fixture = makeIsolatedCwd();
      try {
        const { agents } = discoverAgents(fixture.dir, "project");
        expect(requireSecurityAgent(agents)).toBeTypeOf("object");
      } finally {
        fixture.cleanup();
      }
    });

    it("source='builtin' — security приходит из встроенного набора, а не из user/project .md", () => {
      const fixture = makeIsolatedCwd();
      try {
        const { agents } = discoverAgents(fixture.dir, "project");
        expect(requireSecurityAgent(agents).source, "source должен быть 'builtin'").toBe("builtin");
      } finally {
        fixture.cleanup();
      }
    });

    it("readOnly=true — security read-only воркер (tools без write/edit)", () => {
      const fixture = makeIsolatedCwd();
      try {
        const { agents } = discoverAgents(fixture.dir, "project");
        expect(requireSecurityAgent(agents).readOnly, "security должен быть read-only (roadmap F-1.1)").toBe(true);
      } finally {
        fixture.cleanup();
      }
    });
  });

  describe("TC-F-1.2-2: конфиг резолвит модель и температуру для security", () => {
    describe("(a) config.example.json содержит оба ключа security (критерий приёмки №2)", () => {
      it("config.example.json существует и валиден (JSON.parse) — база, не предмет F-1.2", () => {
        expect(() => loadExampleConfig()).not.toThrow();
      });

      it("cloud.models содержит ключ security (по образцу 8 существующих агентов)", () => {
        const example = loadExampleConfig();
        expect(
          Object.hasOwn(example.cloud.models, SECURITY_TYPE),
          'config.example.json: cloud.models не содержит ключ "security" — ' +
            'добавь по образцу других агентов (roadmap F-1.2: ключ "security" в models cloud/local)',
        ).toBe(true);
      });

      it("local.models содержит ключ security", () => {
        const example = loadExampleConfig();
        expect(
          Object.hasOwn(example.local.models, SECURITY_TYPE),
          'config.example.json: local.models не содержит ключ "security" — ' +
            "ключ обязан быть в ОБОИХ провайдерах (roadmap F-1.2)",
        ).toBe(true);
      });

      it("agentTemperature.security === 0.1 (own-ключ, а не унаследованный fallback)", () => {
        const example = loadExampleConfig();
        expect(
          Object.hasOwn(example.agentTemperature, SECURITY_TYPE),
          'config.example.json: agentTemperature не содержит ключ "security" — ' +
            'добавь "security": 0.1 (roadmap F-1.2 / спека §F1.3)',
        ).toBe(true);
        expect(
          example.agentTemperature[SECURITY_TYPE],
          "agentTemperature.security должен быть ровно 0.1 (низкая температура для детерминированного аудита)",
        ).toBe(0.1);
      });
    });

    describe("(b) resolveWorkerModel / resolveWorkerTemperature для security", () => {
      // Конфиг «на основе config.example.json» (roadmap: «Условие: config на основе
      // config.example.json») — НЕ loadConfig(): тот читает пользовательский config.json.
      const makeConfigFromExample = () => loadExampleConfig();

      it("resolveWorkerTemperature('security', config) === 0.1 на конфиге-примере as-is", () => {
        const config = makeConfigFromExample();
        // ВНИМАНИЕ: сейчас зелёный «случайно» — глобальная temperature=0.1 совпадает
        // с целевой per-agent. Настоящая Red-проверка per-agent ключа — тест ниже.
        expect(resolveWorkerTemperature(SECURITY_TYPE, config)).toBe(0.1);
      });

      it("per-agent ключ побеждает отличающуюся глобальную temperature (RED-дискриминатор)", () => {
        const config = makeConfigFromExample();
        config.temperature = 0.7; // глобальная ≠ целевой per-agent 0.1
        expect(
          resolveWorkerTemperature(SECURITY_TYPE, config),
          "resolveWorkerTemperature вернул глобальный fallback вместо per-agent 0.1 — " +
            "в config.example.json нет agentTemperature.security (roadmap F-1.2)",
        ).toBe(0.1);
      });

      it("resolveWorkerModel не бросает ни для одного providerMode", () => {
        const config = makeConfigFromExample();
        for (const mode of ["auto", "cloud", "local"]) {
          expect(() => resolveWorkerModel(SECURITY_TYPE, config, mode), `mode=${mode}`).not.toThrow();
        }
      });

      it("per-agent слот модели подключён: override в models/security резолвится по mode (контракт)", () => {
        // Фиксирует цепочку резолва для security, как если модель задана через
        // /orchestrator models (model-editor пишет именно в cloud/local.models[тип]).
        const config = makeConfigFromExample();
        config.cloud.models[SECURITY_TYPE] = "test/cloud-security-model";
        config.local.models[SECURITY_TYPE] = "test/local-security-model";
        expect(resolveWorkerModel(SECURITY_TYPE, config, "cloud")).toBe("test/cloud-security-model");
        expect(resolveWorkerModel(SECURITY_TYPE, config, "local")).toBe("test/local-security-model");
      });

      it("security ведёт себя в цепочке резолва как остальные агенты (сиблинг-консистентность)", () => {
        // На чистом примере (per-agent пустые строки, дефолт пуст) security резолвится
        // ровно так же, как существующий verify: без исключений, единообразный результат.
        const config = makeConfigFromExample();
        for (const mode of ["auto", "cloud", "local"]) {
          expect(resolveWorkerModel(SECURITY_TYPE, config, mode)).toBe(
            resolveWorkerModel("verify", config, mode),
          );
        }
      });
    });
  });
});
