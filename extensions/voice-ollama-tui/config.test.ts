/**
 * Tests for voice-ollama-tui config module (F-1.2) and entry point (F-1.1)
 *
 * Roadmap test cases:
 *   TC-F-1.2-1: Load from .env with valid values
 *   TC-F-1.2-2: Defaults when no config file exists
 *   TC-F-1.2-3: Invalid RECORD_DURATION_MAX clamped to default + warning
 *   TC-F-1.1-1: /voice command registered
 *   TC-F-1.1-2: f12 shortcut registered
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
  mkdirSync,
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
const TEST_DIR = join(EXT_DIR, ".test-config-tmp");
const ORIG_ENV = join(TEST_DIR, ".env");
const ORIG_JSON = join(TEST_DIR, "config.json");
const BACKUP_ENV = join(EXT_DIR, ".env.testbak");
const BACKUP_JSON = join(EXT_DIR, "config.json.testbak");

interface ConfigFiles {
  env: boolean;
  json: boolean;
}

function backupConfig(): ConfigFiles {
  // Clean isolated test directory
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Backup any real config files in the extension dir so we can restore them later
  const env = existsSync(join(EXT_DIR, ".env"));
  const json = existsSync(join(EXT_DIR, "config.json"));
  if (env) {
    writeFileSync(BACKUP_ENV, readFileSync(join(EXT_DIR, ".env"), "utf-8"), "utf-8");
    rmSync(join(EXT_DIR, ".env"));
  }
  if (json) {
    writeFileSync(BACKUP_JSON, readFileSync(join(EXT_DIR, "config.json"), "utf-8"), "utf-8");
    rmSync(join(EXT_DIR, "config.json"));
  }
  return { env, json };
}

function restoreConfig(had: ConfigFiles) {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(join(EXT_DIR, ".env"), { force: true });
  rmSync(join(EXT_DIR, "config.json"), { force: true });
  if (had.env && existsSync(BACKUP_ENV)) {
    writeFileSync(join(EXT_DIR, ".env"), readFileSync(BACKUP_ENV, "utf-8"), "utf-8");
    rmSync(BACKUP_ENV);
  }
  if (had.json && existsSync(BACKUP_JSON)) {
    writeFileSync(join(EXT_DIR, "config.json"), readFileSync(BACKUP_JSON, "utf-8"), "utf-8");
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
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    vi.resetModules();
  });

  // ── TC-F-1.2-2: defaults when no config file ──────────────────────────
  it("TC-F-1.2-2: uses defaults when no config file exists", async () => {
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.recordDurationMax).toBe(60);
    expect(cfg.ollamaEnabled).toBe(false);
    expect(cfg.shortcut).toBe("f12");
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
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.recordDurationMax).toBe(60);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ── Boundary: exactly at minimum (5) ─────────────────────────────────
  it("accepts RECORD_DURATION_MAX exactly at minimum boundary (5)", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=5\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.recordDurationMax).toBe(5);
  });

  // ── Boundary: exactly at maximum (300) ───────────────────────────────
  it("accepts RECORD_DURATION_MAX exactly at maximum boundary (300)", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=300\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("de");
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.ollamaModel).toBe("qwen2.5");
  });

  // ── config.json with invalid JSON → defaults ─────────────────────────
  it("uses defaults when config.json contains invalid JSON", async () => {
    writeFileSync(ORIG_JSON, "not-json{broken", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("fr");
    expect(cfg.ollamaSystemPrompt).toBe("Fix text");
  });

  // ── single-quoted values ─────────────────────────────────────────────
  it("handles single-quoted values in .env", async () => {
    writeFileSync(ORIG_ENV, "WHISPER_LANGUAGE='pt'\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

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
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("ja");
    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── OLLAMA_ENABLED=1 ─────────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=1 as true", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=1\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.ollamaEnabled).toBe(true);
  });

  // ── OLLAMA_ENABLED=FALSE ─────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=FALSE as false", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=FALSE\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── OLLAMA_ENABLED=0 ─────────────────────────────────────────────────
  it("handles OLLAMA_ENABLED=0 as false", async () => {
    writeFileSync(ORIG_ENV, "OLLAMA_ENABLED=0\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.ollamaEnabled).toBe(false);
  });

  // ── .env takes precedence over config.json ───────────────────────────
  it("prefers .env over config.json when both exist", async () => {
    writeFileSync(ORIG_ENV, "WHISPER_LANGUAGE=ru\n", "utf-8");
    writeFileSync(ORIG_JSON, JSON.stringify({ WHISPER_LANGUAGE: "de" }), "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("ru"); // from .env, not config.json
  });

  // ── non-numeric duration → default ──────────────────────────────────
  it("handles non-numeric RECORD_DURATION_MAX as default", async () => {
    writeFileSync(ORIG_ENV, "RECORD_DURATION_MAX=abc\n", "utf-8");

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.recordDurationMax).toBe(60);
  });

  // ── LOW-01: handles inline comments ─────────────────────────────────
  it("strips inline comments from .env values", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        "WHISPER_LANGUAGE=de # German language",
        'OLLAMA_MODEL="llama3.2" # latest version',
        "OLLAMA_ENABLED=true",
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("de");
    expect(cfg.ollamaModel).toBe("llama3.2");
    expect(cfg.ollamaEnabled).toBe(true);
  });

  // ── LOW-01: handles export prefix ───────────────────────────────────
  it("strips export prefix from .env lines", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        "export WHISPER_LANGUAGE=fr",
        "export OLLAMA_ENABLED=true",
        "export RECORD_DURATION_MAX=45",
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.whisperLanguage).toBe("fr");
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.recordDurationMax).toBe(45);
  });

  // ── LOW-01: handles values with = sign inside ───────────────────────
  it("preserves values containing = sign", async () => {
    writeFileSync(
      ORIG_ENV,
      [
        'OLLAMA_SYSTEM_PROMPT="Fix punctuation. Always check: a=b and c=d"',
        'WHISPER_MODEL_PATH="/path/to/model=base.bin"',
      ].join("\n"),
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.ollamaSystemPrompt).toBe("Fix punctuation. Always check: a=b and c=d");
    expect(cfg.whisperModelPath).toBe("/path/to/model=base.bin");
  });

  // ── LOW-01: comment character inside quoted value ───────────────────
  it("does not treat # inside quoted value as comment", async () => {
    writeFileSync(
      ORIG_ENV,
      'OLLAMA_SYSTEM_PROMPT="Fix #1: check punctuation"\n',
      "utf-8",
    );

    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(TEST_DIR);

    expect(cfg.ollamaSystemPrompt).toBe("Fix #1: check punctuation");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F-1.1: extension entry point — command & shortcut registration
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui extension entry (F-1.1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers /voice command and f12 shortcut (default export)", async () => {
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
        shortcut: "f12",
      }),
    }));

    const mod = await import("./index.js");
    await mod.default(mockPi as any);

    // Command registration: /voice handles both voice input and /voice init subcommand
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
      "f12",
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
    const setEditorText = vi.fn();
    const getEditorText = vi.fn().mockReturnValue("");
    // custom must return a promise resolving with { accepted: true } for the new pipeline
    const custom = vi.fn().mockResolvedValue({ accepted: true });

    const mockPi = {
      registerCommand,
      registerShortcut,
      on,
      ui: { notify, setStatus, custom, setEditorText, getEditorText },
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
        shortcut: "f12",
      }),
    }));

    // Mock dependencies so the handler proceeds past the check
    vi.doMock("./dependencies.js", () => ({
      getFfmpegPath: vi.fn().mockReturnValue("ffmpeg"),
      setDependencyNotify: vi.fn(),
      checkDependencies: () => ({
        ok: true,
        missing: [],
        instructions: [],
      }),
    }));

    // Mock ui-overlay so recording does not spawn real ffmpeg.
    // showRecordingOverlay now returns the recorded file directly.
    vi.doMock("./ui-overlay.js", () => ({
      showRecordingOverlay: vi.fn().mockResolvedValue({ accepted: true, audioFile: "/tmp/test-recording.wav" }),
      showProcessingOverlay: vi.fn().mockReturnValue({ update: vi.fn(), close: vi.fn() }),
    }));

    // Mock audio-recorder to avoid actual ffmpeg calls
    vi.doMock("./audio-recorder.js", () => ({
      recordAudio: vi.fn().mockResolvedValue("/tmp/test-recording.wav"),
      setRecorderNotify: vi.fn(),
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

    // Mock whisper-service to return a recognised text
    vi.doMock("./whisper-service.js", () => ({
      transcribe: vi.fn().mockResolvedValue("привет мир"),
      setWhisperNotify: vi.fn(),
    }));

    // Mock model-downloader to skip actual download
    vi.doMock("./model-downloader.js", () => ({
      ensureWhisperModel: vi.fn().mockResolvedValue("/home/user/.fan/models/speech/ggml-base.bin"),
    }));

    const mod = await import("./index.js");
    await mod.default(mockPi as any);

    // Invoke the shortcut handler
    const shortcutHandler = registerShortcut.mock.calls[0][1].handler;
    await shortcutHandler({ ui: { notify, setStatus, custom, setEditorText, getEditorText } });



    // The pipeline now records inside showRecordingOverlay, then shows
    // showProcessingOverlay(model) and showProcessingOverlay(transcribing).
    // Since we mocked showRecordingOverlay/showProcessingOverlay to resolve
    // immediately, ctx.ui.custom is not invoked by the pipeline itself.
    expect(setEditorText).toHaveBeenCalledWith("привет мир");
    expect(getEditorText).toHaveBeenCalledTimes(1);
    // Shortcut handler no longer emits a debug notify; it runs the pipeline silently.

    // resetModules before the next test so doMock is not reused
    vi.resetModules();
  });
});
