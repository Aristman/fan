/**
 * Tests for voice-ollama-tui config module (F-1.2) and entry point (F-1.1)
 *
 * Roadmap test cases:
 *   TC-F-1.2-1: Load from .env with valid values
 *   TC-F-1.2-2: Defaults when no config file exists
 *   TC-F-1.2-3: Invalid RECORD_DURATION_MAX clamped to default + warning
 *   TC-F-1.1-1: /voice command registered
 *   TC-F-1.1-2: ctrl+shift+v shortcut registered
 *
 * Strategy:
 *   loadConfig() resolves its extension directory via import.meta.url,
 *   pointing to the real extension dir.  We cannot mock node:fs or
 *   node:path effectively for imported modules, so we use the real
 *   filesystem: backup/restore the actual .env and config.json files
 *   and write our own test configurations.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Real extension directory detection
// ---------------------------------------------------------------------------

const EXT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ORIG_ENV = join(EXT_DIR, ".env");
const ORIG_JSON = join(EXT_DIR, "config.json");
const BACKUP_ENV = join(EXT_DIR, ".env.testbak");
const BACKUP_JSON = join(EXT_DIR, "config.json.testbak");

interface ConfigFiles {
  env: boolean;
  json: boolean;
}

function backupConfig(): ConfigFiles {
  const env = existsSync(ORIG_ENV);
  const json = existsSync(ORIG_JSON);
  if (env) {
    writeFileSync(BACKUP_ENV, readFileSync(ORIG_ENV, "utf-8"), "utf-8");
    rmSync(ORIG_ENV);
  }
  if (json) {
    writeFileSync(BACKUP_JSON, readFileSync(ORIG_JSON, "utf-8"), "utf-8");
    rmSync(ORIG_JSON);
  }
  return { env, json };
}

function restoreConfig(had: ConfigFiles) {
  rmSync(ORIG_ENV, { force: true });
  rmSync(ORIG_JSON, { force: true });
  if (had.env && existsSync(BACKUP_ENV)) {
    writeFileSync(ORIG_ENV, readFileSync(BACKUP_ENV, "utf-8"), "utf-8");
    rmSync(BACKUP_ENV);
  }
  if (had.json && existsSync(BACKUP_JSON)) {
    writeFileSync(ORIG_JSON, readFileSync(BACKUP_JSON, "utf-8"), "utf-8");
    rmSync(BACKUP_JSON);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-1.2: config loading
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui config (F-1.2)", () => {
  let hadConfig: ConfigFiles;

  beforeAll(() => {
    hadConfig = backupConfig();
  });

  afterAll(() => {
    restoreConfig(hadConfig);
  });

  beforeEach(() => {
    // Remove any leftover test config from previous test
    rmSync(ORIG_ENV, { force: true });
    rmSync(ORIG_JSON, { force: true });
    vi.resetModules();
  });

  // ── TC-F-1.2-2: defaults when no config file ──────────────────────────
  it("TC-F-1.2-2: uses defaults when no config file exists", async () => {
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(60);
    expect(cfg.ollamaEnabled).toBe(false);
    expect(cfg.shortcut).toBe("ctrl+shift+v");
    expect(cfg.recordFormat).toBe("wav");
    expect(cfg.whisperBinPath).toBe("whisper-cli");
    expect(cfg.whisperLanguage).toBe("auto");
    expect(cfg.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(cfg.ollamaModel).toBeUndefined();
    expect(cfg.audioDevice).toBeUndefined();
  });

  // ── TC-F-1.2-1: .env with valid values ────────────────────────────────
  it("TC-F-1.2-1: loads config from .env with valid values", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        "WHISPER_LANGUAGE=ru",
        "OLLAMA_ENABLED=true",
        "OLLAMA_MODEL=llama3.2",
        "AUDIO_DEVICE=default",
        "RECORD_DURATION_MAX=30",
        'OLLAMA_SYSTEM_PROMPT="Fix stuff"',
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("ru");
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.ollamaModel).toBe("llama3.2");
    expect(cfg.audioDevice).toBe("default");
    expect(cfg.recordDurationMax).toBe(30);
    expect(cfg.ollamaSystemPrompt).toBe("Fix stuff");
  });

  // ── TC-F-1.2-3: RECORD_DURATION_MAX=400 → default 60 ────────────────
  it("TC-F-1.2-3: invalid RECORD_DURATION_MAX (400) is replaced with default 60", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=400\n", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(60);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RECORD_DURATION_MAX 400 is out of range"),
    );

    warnSpy.mockRestore();
  });

  // ── Boundary: below minimum (1) → default 60 ─────────────────────────
  it("replaces RECORD_DURATION_MAX=1 with default 60", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=1\n", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(60);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ── Boundary: exactly at minimum (5) ─────────────────────────────────
  it("accepts RECORD_DURATION_MAX exactly at minimum boundary (5)", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=5\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(5);
  });

  // ── Boundary: exactly at maximum (300) ───────────────────────────────
  it("accepts RECORD_DURATION_MAX exactly at maximum boundary (300)", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=300\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(300);
  });

  // ── camelCase keys in .env ────────────────────────────────────────────
  it("loads camelCase keys from .env", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        "whisperLanguage=en",
        "ollamaEnabled=1",
        "recordDurationMax=90",
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("en");
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.recordDurationMax).toBe(90);
  });

  // ── config.json fallback ─────────────────────────────────────────────
  it("loads from config.json when .env is absent", async () => {
    writeFileSync(
      ORIG_JSON,
      JSON.stringify({
        WHISPER_LANGUAGE: "de",
        OLLAMA_ENABLED: "true",
        OLLAMA_MODEL: "qwen2.5",
      }),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("de");
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.ollamaModel).toBe("qwen2.5");
  });

  // ── config.json with invalid JSON → defaults ─────────────────────────
  it("uses defaults when config.json contains invalid JSON", async () => {
    writeFileSync(ORIG_JSON, "not-json{broken", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(60);
    expect(cfg.ollamaEnabled).toBe(false);

    warnSpy.mockRestore();
  });

  // ── double-quoted values ─────────────────────────────────────────────
  it("handles double-quoted values in .env", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        'WHISPER_LANGUAGE="fr"',
        'OLLAMA_SYSTEM_PROMPT="Fix text"',
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("fr");
    expect(cfg.ollamaSystemPrompt).toBe("Fix text");
  });

  // ── single-quoted values ─────────────────────────────────────────────
  it("handles single-quoted values in .env", async () => {
    writeFileSync(ORIG_ENV, "WHISPER_LANGUAGE='pt'\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("pt");
  });

  // ── comments / empty lines ───────────────────────────────────────────
  it("skips comments, blank lines, and whitespace-only lines in .env", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        "# This is a comment",
        "",
        "WHISPER_LANGUAGE=ja",
        "   ",
        "# Another comment",
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("ja");
    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── OLLAMA_ENABLED=1 ─────────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=1 as true", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=1\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.ollamaEnabled).toBe(true);
  });

  // ── OLLAMA_ENABLED=FALSE ─────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=FALSE as false", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=FALSE\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── OLLAMA_ENABLED=0 ─────────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=0 as false", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=0\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── .env takes precedence over config.json ───────────────────────────
  it("prefers .env over config.json when both exist", async () => {
    writeFileSync(ORIG_ENV, "WHISPER_LANGUAGE=ru\n", "utf-8");
    writeFileSync(ORIG_JSON, JSON.stringify({ WHISPER_LANGUAGE: "de" }), "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.whisperLanguage).toBe("ru"); // from .env, not config.json
  });

  // ── non-numeric duration → default ──────────────────────────────────
  it("handles non-numeric RECORD_DURATION_MAX as default", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=abc\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();

    expect(cfg.recordDurationMax).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F-1.1: extension entry point — command & shortcut registration
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui extension entry (F-1.1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers /voice command and ctrl+shift+v shortcut (default export)", async () => {
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const custom = vi.fn();

    const mockPi = {
      registerCommand,
      registerShortcut,
      on,
      ui: { notify, setStatus, custom },
    };

    // Mock config to return predictable shortcut (avoid reading real .env)
    vi.doMock("./config.js", () => ({
      loadConfig: () => ({
        audioDevice: undefined,
        recordDurationMax: 60,
        recordFormat: "wav" as const,
        whisperBinPath: "whisper-cli",
        whisperModelPath: "/home/user/.fan/models/speech/ggml-base.bin",
        whisperLanguage: "auto",
        ollamaEnabled: false,
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: undefined,
        ollamaSystemPrompt: "Fix punctuation.",
        shortcut: "ctrl+shift+v",
      }),
    }));

    const mod = await import("./index.js");
    await mod.default(mockPi as any);

    // Command registration
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith(
      "voice",
      expect.objectContaining({
        description: expect.stringContaining("voice input"),
      }),
    );

    const cmdArg = registerCommand.mock.calls[0][1];
    expect(typeof cmdArg.handler).toBe("function");

    // Shortcut registration
    expect(registerShortcut).toHaveBeenCalledTimes(1);
    expect(registerShortcut).toHaveBeenCalledWith(
      "ctrl+shift+v",
      expect.objectContaining({
        description: expect.stringContaining("voice input"),
      }),
    );

    const shortcutArg = registerShortcut.mock.calls[0][1];
    expect(typeof shortcutArg.handler).toBe("function");

    // Event handlers registered
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("shortcut handler runs voice pipeline", async () => {
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    // custom must return a promise resolving with { accepted: true } for the new pipeline
    const custom = vi.fn().mockResolvedValue({ accepted: true });

    const mockPi = {
      registerCommand,
      registerShortcut,
      on,
      ui: { notify, setStatus, custom },
    };

    vi.doMock("./config.js", () => ({
      loadConfig: () => ({
        audioDevice: undefined,
        recordDurationMax: 60,
        recordFormat: "wav" as const,
        whisperBinPath: "whisper-cli",
        whisperModelPath: "/home/user/.fan/models/speech/ggml-base.bin",
        whisperLanguage: "auto",
        ollamaEnabled: false,
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: undefined,
        ollamaSystemPrompt: "Fix punctuation.",
        shortcut: "ctrl+shift+v",
      }),
    }));

    // Mock dependencies so the handler proceeds past the check
    vi.doMock("./dependencies.js", () => ({
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
    }));

    // Mock audio-recorder to avoid actual ffmpeg calls
    vi.doMock("./audio-recorder.js", () => ({
      recordAudio: vi.fn().mockResolvedValue("/tmp/test-recording.wav"),
      AudioRecorderError: class AudioRecorderError extends Error {
        constructor(msg: string, public code: string) {
          super(msg);
          this.name = "AudioRecorderError";
        }
      },
      VoiceError: class VoiceError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "VoiceError";
        }
      },
      WhisperError: class WhisperError extends Error {
        constructor(msg: string, public code: string) {
          super(msg);
          this.name = "WhisperError";
        }
      },
    }));

    const mod = await import("./index.js");
    await mod.default(mockPi as any);

    // Invoke the shortcut handler
    const shortcutHandler = registerShortcut.mock.calls[0][1].handler;
    await shortcutHandler({ ui: { notify, setStatus, custom } });

    // The pipeline: showRecordingOverlay → recordAudio → showProcessingOverlay → notify
    expect(custom).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Audio recorded"),
      "info",
    );
  });
});
