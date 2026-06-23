import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export interface VoiceOllamaConfig {
  // Audio
  audioDevice?: string;
  recordDurationMax: number;
  recordFormat: "wav";

  // Whisper
  whisperBinPath: string;
  whisperModelPath: string;
  whisperLanguage: string;

  // Ollama
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel?: string;
  ollamaSystemPrompt: string;

  // UI
  shortcut: string;
}

const DEFAULT_RECORD_DURATION_MAX = 60;
const MIN_RECORD_DURATION = 5;
const MAX_RECORD_DURATION = 300;

function parseEnvFile(filePath: string): Record<string, string | undefined> | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const result: Record<string, string | undefined> = {};
    for (const line of content.split(/\r?\n/)) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Strip `export ` prefix (used in some .env conventions)
      trimmed = trimmed.replace(/^export\s+/, "");
      // Strip inline comments (respecting quoted values)
      let commentStart = -1;
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble) { commentStart = i; break; }
      }
      if (commentStart >= 0) {
        trimmed = trimmed.slice(0, commentStart).trimEnd();
      }
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return undefined;
  }
}

const DEFAULT_CONFIG: VoiceOllamaConfig = {
  recordDurationMax: DEFAULT_RECORD_DURATION_MAX,
  recordFormat: "wav",
  whisperBinPath: "whisper-cli",
  whisperModelPath: path.join(os.homedir(), ".fan", "models", "speech", "ggml-base.bin"),
  whisperLanguage: "auto",
  ollamaEnabled: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaSystemPrompt:
    "You are a helpful assistant. Fix punctuation and obvious typos in the user's dictated text. Preserve the original meaning and language. Return ONLY the corrected text, nothing else.",
  shortcut: "ctrl+shift+space",
};

export function getExtensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function createDefaultConfig(): VoiceOllamaConfig {
  return DEFAULT_CONFIG;
}

function toBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

function normalizeDuration(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_RECORD_DURATION_MAX;
  if (value < MIN_RECORD_DURATION || value > MAX_RECORD_DURATION) return DEFAULT_RECORD_DURATION_MAX;
  return value;
}

export function loadConfig(extensionDir?: string): VoiceOllamaConfig {
  extensionDir = extensionDir ?? getExtensionDir();
  const envPath = path.join(extensionDir, ".env");
  const jsonPath = path.join(extensionDir, "config.json");

  // Prefer .env, fallback to config.json
  let raw: Record<string, string | undefined> = {};
  let source = "defaults";

  if (fs.existsSync(envPath)) {
    const parsed = parseEnvFile(envPath);
    if (parsed) {
      raw = parsed;
      source = ".env";
    }
  } else if (fs.existsSync(jsonPath)) {
    const jsonRaw = fs.readFileSync(jsonPath, "utf-8");
    try {
      const parsedJson = JSON.parse(jsonRaw);
      raw = parsedJson as Record<string, string | undefined>;
      source = "config.json";
    } catch {
      console.warn("[voice-ollama-tui] Failed to parse config.json, using defaults");
    }
  }

  const durationInput = raw["RECORD_DURATION_MAX"] ?? raw["recordDurationMax"];
  const durationNum = durationInput !== undefined ? Number.parseInt(durationInput, 10) : DEFAULT_RECORD_DURATION_MAX;
  const duration = normalizeDuration(durationNum);

  if (duration !== durationNum && !Number.isNaN(durationNum)) {
    console.warn(
      `[voice-ollama-tui] RECORD_DURATION_MAX ${durationNum} is out of range [${MIN_RECORD_DURATION}, ${MAX_RECORD_DURATION}], using ${DEFAULT_RECORD_DURATION_MAX}`,
    );
  }

  const cfg: VoiceOllamaConfig = {
    audioDevice: raw["AUDIO_DEVICE"] ?? raw["audioDevice"],
    recordDurationMax: duration,
    recordFormat: "wav",
    whisperBinPath: raw["WHISPER_BIN_PATH"] ?? raw["whisperBinPath"] ?? DEFAULT_CONFIG.whisperBinPath,
    whisperModelPath: raw["WHISPER_MODEL_PATH"] ?? raw["whisperModelPath"] ?? DEFAULT_CONFIG.whisperModelPath,
    whisperLanguage: raw["WHISPER_LANGUAGE"] ?? raw["whisperLanguage"] ?? DEFAULT_CONFIG.whisperLanguage,
    ollamaEnabled: toBoolean(raw["OLLAMA_ENABLED"] ?? raw["ollamaEnabled"], DEFAULT_CONFIG.ollamaEnabled),
    ollamaBaseUrl: raw["OLLAMA_BASE_URL"] ?? raw["ollamaBaseUrl"] ?? DEFAULT_CONFIG.ollamaBaseUrl,
    ollamaModel: raw["OLLAMA_MODEL"] ?? raw["ollamaModel"],
    ollamaSystemPrompt:
      raw["OLLAMA_SYSTEM_PROMPT"] ?? raw["ollamaSystemPrompt"] ?? DEFAULT_CONFIG.ollamaSystemPrompt,
    shortcut: raw["SHORTCUT"] ?? raw["shortcut"] ?? DEFAULT_CONFIG.shortcut,
  };

  console.log(`[voice-ollama-tui] Config loaded from ${source}`);
  return cfg;
}
