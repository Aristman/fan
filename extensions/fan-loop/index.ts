/**
 * fan-loop — Главный entry point расширения
 *
 * Регистрирует слэш-команду /loop для итеративного выполнения задач
 * до выполнения критериев приёмки.
 *
 * Использование:
 *   /loop                                          — интерактивный опрос
 *   /loop --interactive                            — интерактивный опрос
 *   /loop "описание задачи" -c "критерии" -m 10    — прямой запуск
 *   /loop --help                                   — справка
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LoopController } from "./loop-controller.js";
import type { ParsedLoopArgs, LoopConfig } from "./types.js";

// ── Конфигурация по умолчанию ──────────────────────────────────────────────

interface Config {
  defaultMaxIterations: number;
  defaultModel: string;
}

const DEFAULT_CONFIG: Config = {
  defaultMaxIterations: 10,
  defaultModel: "",
};

function loadConfig(): Config {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(__dirname, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Игнорируем ошибки загрузки конфига
  }
  return DEFAULT_CONFIG;
}

// ── Парсинг аргументов ─────────────────────────────────────────────────────

/**
 * Парсит аргументы команды /loop.
 *
 * Форматы:
 *   /loop "описание задачи" --criteria "критерии" --max-iterations 10 --model "model"
 *   /loop "задача" -c "критерии" -m 5
 *   /loop --interactive
 *   /loop --help
 */
function parseArgs(args: string): ParsedLoopArgs {
  const result: ParsedLoopArgs = {};
  const tokens = tokenize(args);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === "--help" || token === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (token === "--interactive" || token === "-i") {
      result.interactive = true;
      i++;
      continue;
    }

    if (token === "--criteria" || token === "-c") {
      result.criteria = tokens[++i] || "";
      i++;
      continue;
    }

    if (token === "--max-iterations" || token === "-m") {
      result.maxIterations = parseInt(tokens[++i] || "10", 10);
      if (isNaN(result.maxIterations) || result.maxIterations < 1) {
        result.maxIterations = 10;
      }
      if (result.maxIterations > 50) result.maxIterations = 50;
      i++;
      continue;
    }

    if (token === "--model") {
      result.model = tokens[++i] || "";
      i++;
      continue;
    }

    // Первый аргумент без флага = task
    if (!result.task && !token.startsWith("-")) {
      result.task = token;
      i++;
      continue;
    }

    i++;
  }

  return result;
}

/**
 * Простой токенизатор: учитывает кавычки.
 * "текст в кавычках" → один токен без кавычек.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = "";
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// ── Текст справки ──────────────────────────────────────────────────────────

const HELP_TEXT = `🔄 **FAN Loop** — итеративное выполнение задач

**Использование:**
  /loop                                          — интерактивный опрос
  /loop --interactive                            — интерактивный опрос
  /loop "описание задачи" -c "критерии" -m 10   — прямой запуск
  /loop "задача" --model "model-name"            — с указанием модели

**Параметры:**
  task (первый аргумент)   — описание задачи (обязательно)
  --criteria, -c           — критерии приёмки (обязательно)
  --max-iterations, -m     — макс. итераций (default: 10)
  --model                  — модель для выполнения
  --interactive, -i        — запустить интерактивный опрос
  --help, -h               — показать эту справку

**Примеры:**
  /loop "Рефакторинг модуля auth" -c "Все тесты проходят, билд успешен"
  /loop "Исправить баг #123" -c "Баг воспроизводится" -m 5
  /loop --interactive`;

// ── Интерактивный сбор параметров ──────────────────────────────────────────

async function collectInteractively(
  ctx: ExtensionCommandContext,
  config: Config,
): Promise<{ task: string; criteria: string; maxIterations: number; model: string } | null> {
  // 1. Задача
  const task = await ctx.ui.input(
    "Опиши задачу для loop-выполнения:",
    "например: рефакторинг модуля...",
  );
  if (!task?.trim()) {
    ctx.ui.notify("❌ Задача не указана. Отмена.", "error");
    return null;
  }

  // 2. Критерии приёмки
  const criteria = await ctx.ui.input(
    "Какие критерии приёмки?",
    "например: все тесты проходят, билд успешен",
  );
  if (!criteria?.trim()) {
    ctx.ui.notify("❌ Критерии приёмки не указаны. Отмена.", "error");
    return null;
  }

  // 3. Максимум итераций
  const maxIterStr = await ctx.ui.input(
    "Максимум итераций (default: " + config.defaultMaxIterations + "):",
    String(config.defaultMaxIterations),
  );
  const maxIterations = maxIterStr ? parseInt(maxIterStr, 10) : config.defaultMaxIterations;
  if (isNaN(maxIterations) || maxIterations < 1) {
    ctx.ui.notify("🔄 Используем значение по умолчанию: " + config.defaultMaxIterations + " итераций", "info");
  }

  // 4. Модель (опционально)
  const model = await ctx.ui.input(
    "Модель (пусто = default):",
    config.defaultModel || "",
  );

  return {
    task: task.trim(),
    criteria: criteria.trim(),
    maxIterations: isNaN(maxIterations) || maxIterations < 1 ? config.defaultMaxIterations : Math.min(maxIterations, 50),
    model: model?.trim() || config.defaultModel || "",
  };
}

// ── Главный entry point ────────────────────────────────────────────────────

export default function (fan: ExtensionAPI) {
  const config = loadConfig();
  let activeController: LoopController | null = null;

  fan.registerCommand("loop", {
    description: "🔄 Итеративное выполнение задачи до выполнения критериев приёмки",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const rawArgs = args || "";

      // Парсим аргументы
      const parsed = parseArgs(rawArgs);

      // Справка
      if (parsed.help) {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      let task: string;
      let criteria: string;
      let maxIterations: number;
      let model: string;

      // Если нет аргументов или указан --interactive — интерактивный опрос
      if (!rawArgs.trim() || parsed.interactive || (!parsed.task && !parsed.criteria)) {
        const collected = await collectInteractively(ctx, config);
        if (!collected) return;
        task = collected.task;
        criteria = collected.criteria;
        maxIterations = collected.maxIterations;
        model = collected.model;
      } else {
        // Прямой запуск с аргументами
        if (!parsed.task?.trim()) {
          ctx.ui.notify("❌ Задача не указана. Используй /loop \"описание задачи\" или /loop --interactive", "error");
          return;
        }
        if (!parsed.criteria?.trim()) {
          ctx.ui.notify("❌ Критерии приёмки не указаны. Используй --criteria или -c", "error");
          return;
        }
        task = parsed.task.trim();
        criteria = parsed.criteria.trim();
        maxIterations = parsed.maxIterations || config.defaultMaxIterations;
        model = parsed.model || config.defaultModel || "";
      }

      // Показываем уведомление о запуске
      ctx.ui.notify(
        `🔄 Loop started: "${task}"\n` +
        `   Criteria: ${criteria}\n` +
        `   Max iterations: ${maxIterations}\n` +
        `   Model: ${model || "default"}`,
        "info",
      );

      // Создаём конфигурацию loop-цикла
      const loopConfig: LoopConfig = {
        maxIterations,
        model: model || undefined,
      };

      // Если есть активный контроллер — прерываем его
      if (activeController) {
        activeController.abort();
        activeController = null;
      }

      // Создаём и запускаем LoopController асинхронно
      const controller = new LoopController(
        task,
        criteria,
        loopConfig,
        ctx.cwd,
        (state) => {
          // Колбэк прогресса — обновляем статус
          const currentIter = state.iterations[state.iterations.length - 1];
          const iterInfo = currentIter
            ? ` | Итерация ${currentIter.number}: ${currentIter.verdict ?? currentIter.status}`
            : "";
          ctx.ui.notify(
            `🔄 Loop [${state.status}]${iterInfo}`,
            state.status === "completed" ? "info" : state.status === "failed" ? "error" : "info",
          );
        },
      );

      activeController = controller;

      // Запускаем без блокировки TUI
      controller.start().then((finalState) => {
        activeController = null;
        // Итоговый результат
        if (finalState.status === "completed") {
          ctx.ui.notify(
            `✅ Loop ЗАВЕРШЁН успешно!\n` +
            `   Итераций: ${finalState.iterations.length}\n` +
            `   Время: ${formatDuration(finalState.completedAt! - finalState.startedAt)}\n` +
            `   Вердикт: ${finalState.finalVerdict}`,
            "info",
          );
        } else if (finalState.status === "failed") {
          ctx.ui.notify(
            `❌ Loop ЗАВЕРШЁН с ошибкой.\n` +
            `   Итераций: ${finalState.iterations.length}\n` +
            `   Причина: ${finalState.finalVerdict}\n` +
            `   Время: ${formatDuration(finalState.completedAt! - finalState.startedAt)}`,
            "error",
          );
        } else if (finalState.status === "aborted") {
          ctx.ui.notify("⏹ Loop прерван пользователем.", "info");
        }
      }).catch((err: Error) => {
        activeController = null;
        ctx.ui.notify(`❌ Loop ошибка: ${err.message}`, "error");
      });
    },
  });
}

// ── Утилиты ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins >= 60) {
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
