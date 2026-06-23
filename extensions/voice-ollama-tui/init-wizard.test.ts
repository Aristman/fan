/**
 * Tests for voice-ollama-tui init-wizard (/voice-init command).
 *
 * Tests the wizard state machine:
 *   TC-VI-1: Happy path — all steps complete successfully, .env saved.
 *   TC-VI-2: Cancel on step 0 (dependencies missing) — no .env saved.
 *   TC-VI-3: Ollama enabled with reachable server — model selected.
 *   TC-VI-4: Ollama unreachable — falls back to disabled.
 *   TC-VI-5: .env content after full run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ENV_PATH = path.join(EXT_DIR, ".env");

function mockCtx(mocks?: {
  ui?: Record<string, any>;
  hasUI?: boolean;
}) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const confirm = vi.fn();
  const select = vi.fn();
  const input = vi.fn();

  return {
    ui: {
      notify,
      setStatus,
      confirm,
      select,
      input,
      setEditorText: vi.fn(),
      getEditorText: vi.fn(),
      custom: vi.fn(),
      ...(mocks?.ui ?? {}),
    },
    hasUI: mocks?.hasUI ?? true,
    cwd: "/tmp",
    sessionManager: {} as any,
    modelRegistry: {} as any,
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
  } as any;
}

/** Remove .env if it exists (backup/restore managed by caller) */
function removeEnv() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      fs.rmSync(ENV_PATH);
    }
  } catch {
    // ignore
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui init-wizard (TC-VI)", () => {
  // Backup existing .env before tests
  let hadEnv = false;
  let envBackup = "";

  beforeAll(() => {
    if (fs.existsSync(ENV_PATH)) {
      hadEnv = true;
      envBackup = fs.readFileSync(ENV_PATH, "utf-8");
      removeEnv();
    }
  });

  afterAll(() => {
    if (hadEnv) {
      fs.writeFileSync(ENV_PATH, envBackup, "utf-8");
    } else {
      removeEnv();
    }
  });

  beforeEach(() => {
    removeEnv();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-VI-1: Happy path ──────────────────────────────────────────────
  it("TC-VI-1: happy path — completes all steps and saves .env", async () => {
    const ctx = mockCtx({
      ui: {
        // Step 0: deps ok → confirm yes
        confirm: vi
          .fn()
          .mockResolvedValueOnce(true) // Step 0: начать настройку
          .mockResolvedValueOnce(true) // Step 6: скачать модель
          .mockResolvedValueOnce(true), // (ollama confirm — но мы не доходим до ollama)
        // Step 1: device not checked — mock select/input for rest
        select: vi
          .fn()
          .mockResolvedValueOnce("Русский (ru)") // Step 2: язык
          .mockResolvedValueOnce("60 секунд (по умолчанию)"), // Step 3: длительность
        // Step 4: Ollama — confirm yes in stepOllama, but our confirm mock already used
        // We need to carefully order mocks.
        input: vi
          .fn()
          .mockResolvedValueOnce("ctrl+shift+space"), // Step 5: шорткат
      },
    });

    // Redo with precise ordering: Step0 confirm, Step2 select, Step3 select,
    // Step4 confirm (Ollama), Step4 select/input, Step5 input, Step6 confirm (download model)
    const notify = vi.fn();
    const setStatus = vi.fn();
    let confirmCall = 0;
    let selectCall = 0;
    let inputCall = 0;

    const confirmMock = vi.fn().mockImplementation(() => {
      confirmCall++;
      // Step 0: yes, Step 4 (ollama): no, Step 6 (download): yes
      if (confirmCall === 1) return Promise.resolve(true); // step 0
      if (confirmCall === 2) return Promise.resolve(false); // step 4 — ollama no
      if (confirmCall === 3) return Promise.resolve(true); // step 6 — download
      return Promise.resolve(false);
    });

    const selectMock = vi.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return Promise.resolve("Русский (ru)"); // step 2
      if (selectCall === 2) return Promise.resolve("60 секунд (по умолчанию)"); // step 3
      return Promise.resolve("auto");
    });

    const inputMock = vi.fn().mockImplementation(() => {
      inputCall++;
      return Promise.resolve("ctrl+shift+space"); // step 5
    });

    const customCtx = mockCtx({
      ui: {
        notify,
        setStatus,
        confirm: confirmMock,
        select: selectMock,
        input: inputMock,
      },
    });

    // Mock dependencies to pass
    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
      checkAudioDevice: () => true,
    }));

    // Mock ollama — unused since we skip ollama
    vi.doMock("./ollama-service.js", () => ({
      listOllamaModels: vi.fn(),
    }));

    // Mock model-downloader — skip actual download
    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn().mockResolvedValue("/home/user/.fan/models/speech/ggml-base.bin"),
    }));

    const { runVoiceInitWizard } = await import("./init-wizard.js");
    await runVoiceInitWizard(customCtx);

    // .env should exist
    expect(fs.existsSync(ENV_PATH)).toBe(true);
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");

    // Verify key values
    expect(envContent).toContain("WHISPER_LANGUAGE=ru");
    expect(envContent).toContain("RECORD_DURATION_MAX=60");
    expect(envContent).toContain("OLLAMA_ENABLED=false");
    expect(envContent).toContain("SHORTCUT=ctrl+shift+space");

    // Final notification
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Настройка завершена"),
      "info",
    );
  });

  // ── TC-VI-2: Cancel on step 0 ────────────────────────────────────────
  it("TC-VI-2: cancels on step 0 when dependencies missing", async () => {
    const notify = vi.fn();
    const setStatus = vi.fn();
    const confirmMock = vi.fn().mockResolvedValue(false); // step 0: cancel
    const selectMock = vi.fn();
    const inputMock = vi.fn();

    const ctx = mockCtx({
      ui: {
        notify,
        setStatus,
        confirm: confirmMock,
        select: selectMock,
        input: inputMock,
      },
    });

    // Mock dependencies to fail
    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: false,
        missing: ["ffmpeg", "whisper-cli"],
        instructions: ["Install ffmpeg", "Install whisper.cpp"],
      }),
      checkAudioDevice: () => false,
    }));

    vi.doMock("./ollama-service.js", () => ({
      listOllamaModels: vi.fn(),
    }));

    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn(),
    }));

    const { runVoiceInitWizard } = await import("./init-wizard.js");
    await runVoiceInitWizard(ctx);

    // Should see dependency warning
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Отсутствуют зависимости"),
      "warning",
    );

    // confirm may be called once for the whisper-cli download offer (when missing),
    // and once for step 0. Since we cancel step 0, at most 2 confirm calls are expected.
    expect(confirmMock).toHaveBeenCalled();

    // No further steps
    expect(selectMock).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();

    // .env should NOT exist
    expect(fs.existsSync(ENV_PATH)).toBe(false);
  });

  // ── TC-VI-3: Ollama enabled with reachable server ────────────────────
  it("TC-VI-3: Ollama enabled with reachable server and model selection", async () => {
    const notify = vi.fn();
    const setStatus = vi.fn();
    let confirmCall = 0;
    let selectCall = 0;
    let inputCall = 0;

    const confirmMock = vi.fn().mockImplementation(() => {
      confirmCall++;
      if (confirmCall === 1) return Promise.resolve(true); // step 0: start
      if (confirmCall === 2) return Promise.resolve(true); // step 4: enable ollama
      if (confirmCall === 3) return Promise.resolve(true); // step 6: download model
      return Promise.resolve(false);
    });

    const selectMock = vi.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return Promise.resolve("Русский (ru)"); // step 2
      if (selectCall === 2) return Promise.resolve("60 секунд (по умолчанию)"); // step 3
      if (selectCall === 3) return Promise.resolve("llama3.2:latest"); // step 4: model
      return Promise.resolve("auto");
    });

    const inputMock = vi.fn().mockImplementation(() => {
      inputCall++;
      if (inputCall === 1) return Promise.resolve(""); // step 5: shortcut (empty → default)
      return Promise.resolve("");
    });

    const ctx = mockCtx({
      ui: {
        notify,
        setStatus,
        confirm: confirmMock,
        select: selectMock,
        input: inputMock,
      },
    });

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
      checkAudioDevice: () => true,
    }));

    vi.doMock("./ollama-service.js", () => ({
      listOllamaModels: vi.fn().mockResolvedValue({
        models: ["llama3.2:latest", "qwen2.5:latest"],
        reachable: true,
      }),
    }));

    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn().mockResolvedValue("/home/user/.fan/models/speech/ggml-base.bin"),
    }));

    const { runVoiceInitWizard } = await import("./init-wizard.js");
    await runVoiceInitWizard(ctx);

    // .env should exist with ollama enabled
    expect(fs.existsSync(ENV_PATH)).toBe(true);
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");

    expect(envContent).toContain("OLLAMA_ENABLED=true");
    expect(envContent).toContain("OLLAMA_MODEL=llama3.2:latest");
    expect(envContent).toContain("OLLAMA_BASE_URL=http://localhost:11434");

    // Ollama model selected via select
    expect(selectMock).toHaveBeenCalledWith(
      "Выберите модель Ollama",
      ["llama3.2:latest", "qwen2.5:latest"],
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Настройка завершена"),
      "info",
    );
  });

  // ── TC-VI-4: Ollama unreachable → falls back ─────────────────────────
  it("TC-VI-4: Ollama unreachable — falls back to disabled", async () => {
    const notify = vi.fn();
    const setStatus = vi.fn();
    let confirmCall = 0;
    let selectCall = 0;
    let inputCall = 0;

    const confirmMock = vi.fn().mockImplementation(() => {
      confirmCall++;
      if (confirmCall === 1) return Promise.resolve(true); // step 0: start
      if (confirmCall === 2) return Promise.resolve(true); // step 4: enable ollama
      if (confirmCall === 3) return Promise.resolve(true); // step 6: download model
      return Promise.resolve(false);
    });

    const selectMock = vi.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return Promise.resolve("Русский (ru)"); // step 2
      if (selectCall === 2) return Promise.resolve("60 секунд (по умолчанию)"); // step 3
      return Promise.resolve("auto");
    });

    const inputMock = vi.fn().mockImplementation(() => {
      inputCall++;
      if (inputCall === 1) return Promise.resolve("http://localhost:11434"); // step 4: baseUrl
      if (inputCall === 2) return Promise.resolve("ctrl+shift+space"); // step 5: shortcut
      return Promise.resolve("");
    });

    const ctx = mockCtx({
      ui: {
        notify,
        setStatus,
        confirm: confirmMock,
        select: selectMock,
        input: inputMock,
      },
    });

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
      checkAudioDevice: () => true,
    }));

    // Ollama unreachable
    vi.doMock("./ollama-service.js", () => ({
      listOllamaModels: vi.fn().mockResolvedValue({
        models: [],
        reachable: false,
      }),
    }));

    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn().mockResolvedValue("/home/user/.fan/models/speech/ggml-base.bin"),
    }));

    const { runVoiceInitWizard } = await import("./init-wizard.js");
    await runVoiceInitWizard(ctx);

    expect(fs.existsSync(ENV_PATH)).toBe(true);
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");

    // Ollama should be disabled since unreachable
    expect(envContent).toContain("OLLAMA_ENABLED=false");

    // User should have been warned
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Ollama недоступна"),
      "warning",
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Настройка завершена"),
      "info",
    );
  });

  // ── TC-VI-5: .env content after full run ─────────────────────────────
  it("TC-VI-5: .env file contains all expected keys with correct values", async () => {
    const notify = vi.fn();
    const setStatus = vi.fn();
    let confirmCall = 0;
    let selectCall = 0;
    let inputCall = 0;

    const confirmMock = vi.fn().mockImplementation(() => {
      confirmCall++;
      if (confirmCall === 1) return Promise.resolve(true); // step 0: start
      if (confirmCall === 2) return Promise.resolve(true); // step 4: enable ollama
      if (confirmCall === 3) return Promise.resolve(true); // step 6: download model
      return Promise.resolve(false);
    });

    const selectMock = vi.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return Promise.resolve("Английский (en)"); // step 2
      if (selectCall === 2) return Promise.resolve("30 секунд"); // step 3
      if (selectCall === 3) return Promise.resolve("qwen2.5:latest"); // step 4: model
      return Promise.resolve("auto");
    });

    const inputMock = vi.fn().mockImplementation(() => {
      inputCall++;
      if (inputCall === 1) return Promise.resolve(""); // step 4: baseUrl empty → default
      if (inputCall === 2) return Promise.resolve(""); // step 4: system prompt empty
      if (inputCall === 3) return Promise.resolve("ctrl+alt+v"); // step 5: custom shortcut
      return Promise.resolve("");
    });

    const ctx = mockCtx({
      ui: {
        notify,
        setStatus,
        confirm: confirmMock,
        select: selectMock,
        input: inputMock,
      },
    });

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
      checkAudioDevice: () => true,
    }));

    vi.doMock("./ollama-service.js", () => ({
      listOllamaModels: vi.fn().mockResolvedValue({
        models: ["llama3.2:latest", "qwen2.5:latest"],
        reachable: true,
      }),
    }));

    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn().mockResolvedValue("/home/user/.fan/models/speech/ggml-base.bin"),
    }));

    const { runVoiceInitWizard } = await import("./init-wizard.js");
    await runVoiceInitWizard(ctx);

    expect(fs.existsSync(ENV_PATH)).toBe(true);
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");

    // All expected keys present
    expect(envContent).toContain("WHISPER_MODEL_PATH=");
    expect(envContent).toContain("WHISPER_LANGUAGE=en");
    expect(envContent).toContain("OLLAMA_ENABLED=true");
    expect(envContent).toContain("OLLAMA_BASE_URL=http://localhost:11434");
    expect(envContent).toContain("OLLAMA_MODEL=qwen2.5:latest");
    expect(envContent).toContain("SHORTCUT=ctrl+alt+v");
    expect(envContent).toContain("RECORD_DURATION_MAX=30");
    expect(envContent).toContain("AUDIO_DEVICE=default");

    // Ollama system prompt should be the default (since we left it empty)
    expect(envContent).toContain("OLLAMA_SYSTEM_PROMPT=");
    expect(envContent).toContain("Fix punctuation");

    // Comment header exists
    expect(envContent).toContain("# Generated by /voice-init wizard");

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Настройка завершена"),
      "info",
    );
  });
});
