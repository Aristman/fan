/**
 * LoopController — логика loop-цикла
 *
 * Итеративно выполняет задачу через RPC-воркеров, проверяя критерии приёмки
 * после каждой итерации. Останавливается при:
 * - Выполнении критериев (pass)
 * - Превышении максимального числа итераций
 * - Обнаружении тупика (stalemate — последние 3 итерации с одинаковым результатом)
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopState, LoopConfig, LoopIteration } from "./types.js";

/** Определяем путь к fan binary */
let _cachedInvocation: { command: string; baseArgs: string[] } | null = null;

function getFnaInvocation(args: string[]): { command: string; args: string[] } {
  if (!_cachedInvocation) {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript)) {
      _cachedInvocation = { command: process.execPath, baseArgs: [currentScript] };
    } else {
      const execName = path.basename(process.execPath).toLowerCase();
      const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
      if (!isGenericRuntime) {
        _cachedInvocation = { command: process.execPath, baseArgs: [] };
      } else {
        _cachedInvocation = { command: "fan", baseArgs: [] };
      }
    }
  }
  return { command: _cachedInvocation.command, args: [..._cachedInvocation.baseArgs, ...args] };
}

/**
 * Запускает fan как RPC-воркера, отправляет задачу, ждёт результат.
 * Упрощённая версия протокола из fan-orchestrator/subagent-runner.js.
 */
async function runAgent(
  task: string,
  cwd: string,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const PROMPT_ID = "loop-prompt";
    const STATE_ID = "loop-state";
    const TEXT_ID = "loop-result";

    // Формируем аргументы для RPC-режима
    const rpcArgs = [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ];
    if (model) {
      rpcArgs.push("--model", model);
    }

    const invocation = getFnaInvocation(rpcArgs);

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: process.platform === "win32",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let resolved = false;
    let wasStreaming = false;
    let lastText = "";

    const cleanup = () => {
      try { child.stdin?.end(); } catch { /* игнор */ }
      try { child.kill("SIGTERM"); } catch { /* игнор */ }
    };

    const cleanupAbort = () => {
      if (signal) {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
    };

    const finish = (result: string) => {
      if (resolved) return;
      resolved = true;
      if (stallTimer) clearTimeout(stallTimer);
      cleanupAbort();
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (resolved) return;
      resolved = true;
      if (stallTimer) clearTimeout(stallTimer);
      cleanupAbort();
      cleanup();
      reject(err);
    };

    // Stall-таймер: 5 минут бездействия → kill
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        fail(new Error("Worker stalled: нет данных более 5 минут"));
      }, 300_000);
    };

    resetStallTimer();

    // Обработка abort-сигнала
    const onAbort = () => fail(new Error("Прервано пользователем"));
    signal?.addEventListener("abort", onAbort, { once: true });

    // Stderr — собираем для диагностики
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      // Ограничиваем 2048 байтами
      if (stderrBuf.length > 4096) {
        stderrBuf = stderrBuf.slice(-2048);
      }
    });

    // Stdout — JSONL
    child.stdout?.on("data", (chunk: Buffer) => {
      resetStallTimer();
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch { /* игнорируем не-JSON строки */ }
      }
    });

    function send(data: Record<string, unknown>) {
      if (!resolved) {
        try {
          child.stdin?.write(JSON.stringify(data) + "\n");
        } catch { /* игнор */ }
      }
    }

    function schedulePoll() {
      if (resolved) return;
      setTimeout(() => {
        if (!resolved) send({ type: "get_state", id: STATE_ID });
      }, 2000);
    }

    function handleMessage(data: Record<string, unknown>) {
      // Ответ на prompt
      if (data.type === "response" && data.id === PROMPT_ID) {
        if (!data.success) {
          fail(new Error(`Prompt failed: ${(data.error as string) || (data.message as string) || "unknown"}`));
          return;
        }
        // Начинаем опрос через 1 секунду
        setTimeout(() => schedulePoll(), 1000);
        return;
      }

      // Ответ на get_state
      if (data.type === "response" && data.id === STATE_ID && data.success && data.data) {
        const stateData = data.data as Record<string, unknown>;
        if (stateData.isStreaming) {
          wasStreaming = true;
          schedulePoll();
        } else if (wasStreaming) {
          // Стриминг закончился — получаем результат
          send({ type: "get_last_assistant_text", id: TEXT_ID });
          // Fallback: если ответ не придёт за 15 секунд
          setTimeout(() => { if (!resolved) finish(lastText); }, 15_000);
        } else {
          schedulePoll();
        }
        return;
      }

      // Ответ на get_last_assistant_text
      if (data.type === "response" && data.id === TEXT_ID && data.success) {
        const textData = data.data as Record<string, unknown> | undefined;
        lastText = (textData?.text as string) ?? "";
        finish(lastText);
        return;
      }
    }

    child.on("error", (err: Error) => {
      fail(new Error(`Ошибка запуска воркера: ${err.message}`));
    });

    child.on("exit", (code: number | null) => {
      if (resolved) return;
      if (code !== 0 && code !== null) {
        fail(new Error(`Воркер завершился с кодом ${code}\n${stderrBuf.slice(-500)}`));
      } else {
        setTimeout(() => { if (!resolved) finish(lastText); }, 2000);
      }
    });

    // Отправляем задачу через 500мс
    setTimeout(() => {
      send({
        type: "prompt",
        message: task,
        id: PROMPT_ID,
      });
    }, 500);
  });
}

/**
 * Формирует промпт для проверки критериев приёмки.
 * Отправляет задачу + критерии + результат итерации верификатору.
 */
function buildVerificationPrompt(
  task: string,
  criteria: string,
  iterationResult: string,
  iterationNumber: number,
  previousFailures: string[],
): string {
  const prevContext = previousFailures.length > 0
    ? `\n\n## Предыдущие неудачные попытки (кратко):\n${previousFailures.map((f, i) => `- Попытка ${i + 1}: ${f.slice(0, 200)}`).join("\n")}`
    : "";

  return `Ты — верификатор. Твоя задача — проверить, выполнены ли критерии приёмки для данной задачи.

## Задача
${task}

## Критерии приёмки
${criteria}

## Результат итерации #${iterationNumber}
${iterationResult}
${prevContext}

## Инструкция
Проанализируй результат и ответь СТРОГО в одном из форматов:
- PASS: <краткое обоснование> — если ВСЕ критерии выполнены
- FAIL: <что не выполнено и почему> — если хотя бы один критерий НЕ выполнен
- PARTIAL: <что выполнено, а что нет> — если часть критериев выполнена, но не все

Ответь ОДНОЙ строкой в формате выше.`;
}

/**
 * Формирует промпт для выполнения задачи с учётом предыдущих итераций.
 */
function buildTaskPrompt(
  task: string,
  criteria: string,
  iterationNumber: number,
  previousResults: Array<{ number: number; result: string; verdict?: string }>,
): string {
  const prevContext = previousResults.length > 0
    ? `\n\n## Предыдущие итерации:\n${previousResults.map(r =>
        `### Итерация ${r.number} (${r.verdict ?? "unknown"}):\n${r.result?.slice(0, 500) || "(нет результата)"}`,
      ).join("\n\n")}`
    : "";

  const improvementHint = previousResults.length > 0
    ? `\n\nВажно: предыдущие итерации не прошли проверку. Учти ошибки и попробуй другой подход.`
    : "";

  return `## Задача
${task}

## Критерии приёмки
${criteria}
${prevContext}${improvementHint}

Выполни задачу максимально качественно, чтобы результат соответствовал ВСЕМ критериям приёмки.`;
}

export class LoopController {
  private state: LoopState;
  private cwd: string;
  private abortController: AbortController;
  private onProgress?: (state: LoopState) => void;

  constructor(
    task: string,
    criteria: string,
    config: LoopConfig,
    cwd: string,
    onProgress?: (state: LoopState) => void,
  ) {
    this.state = {
      id: crypto.randomUUID(),
      task,
      criteria,
      config,
      status: "running",
      iterations: [],
      startedAt: Date.now(),
    };
    this.cwd = cwd;
    this.abortController = new AbortController();
    this.onProgress = onProgress;
  }

  /** Получить текущее состояние */
  getState(): LoopState {
    return { ...this.state };
  }

  /** Прервать выполнение */
  abort(): void {
    this.state.status = "aborted";
    this.abortController.abort();
  }

  /** Уведомить о прогрессе */
  private notifyProgress(): void {
    this.onProgress?.(this.getState());
  }

  /**
   * Запустить основной loop-цикл.
   * Выполняет итерации до выполнения критериев или превышения лимита.
   */
  async start(): Promise<LoopState> {
    const cwd = this.cwd || process.cwd();
    const model = this.state.config.model;
    const maxIterations = this.state.config.maxIterations;

    for (let i = 0; i < maxIterations; i++) {
      // Проверяем, не был ли цикл прерван
      if (this.state.status === "aborted") break;

      // Запускаем итерацию
      const iteration = await this.runIteration(i + 1, cwd, model);
      this.state.iterations.push(iteration);
      this.notifyProgress();

      // Если критерии выполнены — завершаем
      if (iteration.verdict === "pass") {
        this.state.status = "completed";
        this.state.finalVerdict = "pass";
        this.state.completedAt = Date.now();
        return this.state;
      }

      // Обнаружение тупика: последние 3 итерации с одинаковым результатом
      if (this.isStale()) {
        this.state.status = "failed";
        this.state.finalVerdict = "stalemate";
        this.state.completedAt = Date.now();
        return this.state;
      }
    }

    // Превышен лимит итераций
    if (this.state.status === "running") {
      this.state.status = "failed";
      this.state.finalVerdict = "max_iterations_exceeded";
      this.state.completedAt = Date.now();
    }

    return this.state;
  }

  /**
   * Выполнить одну итерацию:
   * 1. Запустить задачу через RPC-воркера
   * 2. Проверить критерии приёмки
   */
  private async runIteration(
    number: number,
    cwd: string,
    model?: string,
  ): Promise<LoopIteration> {
    const iteration: LoopIteration = {
      number,
      status: "running",
      startedAt: Date.now(),
      attemptCount: 0,
    };

    try {
      // Собираем контекст предыдущих итераций
      const previousResults = this.state.iterations.map(it => ({
        number: it.number,
        result: it.result || "",
        verdict: it.verdict,
      }));

      // Формируем промпт для выполнения задачи
      const taskPrompt = buildTaskPrompt(
        this.state.task,
        this.state.criteria,
        number,
        previousResults,
      );

      // Запускаем агента для выполнения задачи
      iteration.attemptCount = 1;
      const taskResult = await runAgent(
        taskPrompt,
        cwd,
        model,
        this.abortController.signal,
      );

      iteration.result = taskResult;
      iteration.status = "completed";

      // Проверяем критерии приёмки
      const previousFailures = this.state.iterations
        .filter(it => it.verdict === "fail")
        .map(it => it.error || it.result || "неизвестная ошибка");

      const verificationPrompt = buildVerificationPrompt(
        this.state.task,
        this.state.criteria,
        taskResult,
        number,
        previousFailures,
      );

      const verificationResult = await runAgent(
        verificationPrompt,
        cwd,
        model,
        this.abortController.signal,
      );

      // Парсим вердикт
      const trimmedResult = verificationResult.trim().toUpperCase();
      if (trimmedResult.startsWith("PASS")) {
        iteration.verdict = "pass";
      } else if (trimmedResult.startsWith("PARTIAL")) {
        iteration.verdict = "partial";
      } else {
        iteration.verdict = "fail";
        iteration.error = verificationResult;
      }
    } catch (err) {
      iteration.status = "failed";
      iteration.verdict = "fail";
      iteration.error = err instanceof Error ? err.message : String(err);
    }

    iteration.completedAt = Date.now();
    return iteration;
  }

  /**
   * Обнаружение тупика: если последние 3 итерации
   * имеют одинаковый результат и вердикт — значит мы в тупике.
   */
  private isStale(): boolean {
    const iters = this.state.iterations;
    if (iters.length < 3) return false;
    const last = iters.slice(-3);
    return last.every(
      i => i.result === last[0].result && i.verdict === last[0].verdict,
    );
  }
}
