/**
 * TDD RED tests for F-1 «Review-rules corpus» (feature-pipeline, code-review-worker).
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-1» (TC-F-1-1, TC-F-1-2, TC-F-1-3).
 *
 * Целевой контракт (спецификация для implement-воркера, этап 1 «Rules corpus»):
 *   Статический контент-корпус правил код-ревью в extensions/fan-orchestrator/review-rules/:
 *   6 файлов — common.md, typescript.md, python.md, kotlin.md, rust.md, README.md.
 *   Каждый файл ≤ 5000 bytes (CI-валидация, контекст-бюджет воркера 22500 chars).
 *
 * TC-F-1-1 «common.md: severity-модель + маппинг на verdict» —
 *   review-rules/common.md существует; regex /Severity:\s*(CRITICAL|MAJOR|MINOR|INFO)/g
 *   находит все 4 severity (≥ 1 совпадение каждого → toHaveLength(4));
 *   вердикт-маркеры CHANGES_REQUESTED|APPROVED|NEEDS_DISCUSSION присутствуют
 *   (≥ 1 совпадение каждого → toHaveLength(3)).
 *
 * TC-F-1-2 «Стек-файлы: Stack Detection Hints + чеклист ≥ 10 пунктов» —
 *   каждый из 4 stack-файлов (typescript/python/kotlin/rust) содержит
 *   секцию /Stack Detection Hints/ (1+) и ≥ 10 нумерованных чек-пунктов
 *   (regex /^\d+\.\s/gm).
 *
 * TC-F-1-3 «Контекст-бюджет: wc -c review-rules/*.md ≤ 5000 на файл» —
 *   fs.readdirSync(reviewRulesDir) → все *.md → statSync().size →
 *   Math.max(...sizes) ≤ 5000 (эквивалент CI-проверки wc -c).
 *
 * RED-фаза: директории review-rules/ ещё НЕТ — fs.readFileSync/readDirSync бросают
 * ENOENT на arrange. Это честное падение по TC-F-1 «Red-тест» из roadmap.
 * Green-шаг (следующий воркер) создаёт 6 файлов — тесты становятся зелёными.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Корень extension: extensions/fan-orchestrator/test/*.test.mjs → ../review-rules */
const EXTENSION_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_RULES_DIR = path.join(EXTENSION_ROOT, "review-rules");

const STACKS = ["typescript", "python", "kotlin", "rust"];
const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR", "INFO"];
const VERDICTS = ["CHANGES_REQUESTED", "APPROVED", "NEEDS_DISCUSSION"];

/** Загружает файл правил относительно корня extension (бросает ENOENT, если файла нет). */
function loadRuleFile(name) {
  return fs.readFileSync(path.join(REVIEW_RULES_DIR, name), "utf-8");
}

describe("review-rules corpus (F-1, code-review-worker)", () => {
  it("TC-F-1-1: common.md существует, содержит все 4 severity + 3 verdict-маркера", () => {
    // arrange/act: загрузить review-rules/common.md
    const text = loadRuleFile("common.md");

    // act: severity-модель — /Severity:\s*(CRITICAL|MAJOR|MINOR|INFO)/g
    const severityMatches = [...text.matchAll(/Severity:\s*(CRITICAL|MAJOR|MINOR|INFO)/g)].map(
      (m) => m[1],
    );
    const uniqueSeverities = [...new Set(severityMatches)];

    // assert: ≥ 1 совпадение каждого severity → 4 уникальных
    expect(uniqueSeverities).toHaveLength(4);
    for (const severity of SEVERITIES) {
      expect(severityMatches).toContain(severity);
    }

    // act: маппинг на verdict — маркеры CHANGES_REQUESTED|APPROVED|NEEDS_DISCUSSION
    const verdictMatches = [...new Set(text.match(/CHANGES_REQUESTED|APPROVED|NEEDS_DISCUSSION/g))];

    // assert: ≥ 1 совпадение каждого из 3 verdict-маркеров
    expect(verdictMatches).toHaveLength(3);
    for (const verdict of VERDICTS) {
      expect(verdictMatches).toContain(verdict);
    }
  });

  it("TC-F-1-2: каждый из 4 stack-файлов имеет Stack Detection Hints + ≥ 10 чек-пунктов", () => {
    const stackFiles = STACKS.map((stack) => {
      const text = loadRuleFile(`${stack}.md`);

      // act: секция Stack Detection Hints (1+ совпадение)
      const hintsCount = (text.match(/Stack Detection Hints/g) ?? []).length;

      // act: нумерованные чек-пункты (regex /^\d+\.\s/gm)
      const checklistItems = text.match(/^\d+\.\s/gm) ?? [];

      return { stack, hintsCount, checklistCount: checklistItems.length };
    });

    // assert: все 4 стека загружены и каждый проходит оба условия
    expect(stackFiles).toHaveLength(4);
    for (const { stack, hintsCount, checklistCount } of stackFiles) {
      expect(hintsCount, `${stack}.md: секция 'Stack Detection Hints' отсутствует`).toBeGreaterThanOrEqual(1);
      expect(
        checklistCount,
        `${stack}.md: ожидалось ≥ 10 нумерованных чек-пунктов, найдено ${checklistCount}`,
      ).toBeGreaterThanOrEqual(10);
    }
  });

  it("TC-F-1-3: все *.md в review-rules/ ≤ 5000 bytes (контекст-бюджет)", () => {
    // arrange: все *.md в review-rules/ + размеры (эквивалент wc -c)
    const files = fs.readdirSync(REVIEW_RULES_DIR).filter((f) => f.endsWith(".md"));
    const sizes = files.map((f) => fs.statSync(path.join(REVIEW_RULES_DIR, f)).size);
    const max = Math.max(...sizes);

    // assert: максимальный размер ≤ 5000 (бюджет воркера 22500 на 4–5 файлов правил)
    expect(max).toBeLessThanOrEqual(5000);
  });
});
