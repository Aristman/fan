/**
 * Whisper transcription service (F-3.1)
 *
 * Wraps whisper.cpp CLI (whisper-cli) for speech-to-text.
 *
 * Launches `whisper-cli` with the given WAV audio file, model path, and
 * language, then extracts the recognised text from stdout.
 *
 * Roadmap TDD:
 *   TC-F-3.1-1: For a test WAV file, returns non-empty text.
 *   TC-F-3.1-2: When whisper-cli is missing, throws WhisperError WHISPER_NOT_FOUND.
 *   TC-F-3.1-3: Invalid model path throws WhisperError WHISPER_MODEL_NOT_FOUND.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { WhisperError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  /** Path to the whisper model file (e.g. ggml-base.bin) */
  modelPath: string;
  /** Language code (e.g. "ru", "en"). Default: "auto" */
  language?: string;
  /** Path to the whisper-cli binary. Default: "whisper-cli" (resolved from PATH) */
  binPath?: string;
  /** Optional custom whisper.cpp CLI flags. Overrides defaults when set. */
  whisperFlags?: string[];
}

export interface WhisperService {
  /**
   * Transcribe an audio file using whisper.cpp CLI.
   *
   * @param audioPath — Path to the WAV audio file
   * @param options — Model path, language, and optional binary path
   * @returns The recognised text
   * @throws {WhisperError} With typed error codes
   */
  transcribe(audioPath: string, options: TranscribeOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Check if the whisper model file exists.
 * Throws WhisperError with WHISPER_MODEL_NOT_FOUND if missing.
 */
function ensureModelExists(modelPath: string): void {
  try {
    if (!fs.existsSync(modelPath)) {
      throw new WhisperError(
        `Whisper model not found at: ${modelPath}. ` +
          `Download it or set WHISPER_MODEL_PATH in .env / config.json.`,
        "WHISPER_MODEL_NOT_FOUND",
      );
    }
  } catch (err: unknown) {
    if (err instanceof WhisperError) throw err;
    throw new WhisperError(
      `Failed to check model path "${modelPath}": ${(err as Error).message}`,
      "WHISPER_MODEL_NOT_FOUND",
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio file using whisper.cpp CLI.
 *
 * Spawns `whisper-cli` with:
 *   -m <model>   – the model file
 *   -l <lang>    – language code
 *   -f <audio>   – input audio file
 *   -nt           – no timestamps (output plain text only)
 *
 * @param audioPath — Path to the WAV audio file
 * @param options — TranscribeOptions
 * @returns Recognised text string
 * @throws {WhisperError} With one of: WHISPER_NOT_FOUND, WHISPER_MODEL_NOT_FOUND, WHISPER_FAILED
 */
export async function transcribe(
  audioPath: string,
  options: TranscribeOptions,
): Promise<string> {
  const { modelPath, language = "auto", binPath = "whisper-cli", whisperFlags } = options;

  // Validate input audio file exists
  if (!fs.existsSync(audioPath)) {
    throw new WhisperError(
      `Audio file not found: ${audioPath}`,
      "WHISPER_FAILED",
    );
  }

  // Validate model file exists
  ensureModelExists(modelPath);

  // Build whisper-cli arguments
  // Use custom flags if provided (LOW-02), otherwise use defaults
  const args: string[] = whisperFlags && whisperFlags.length > 0
    ? whisperFlags
    : [
        "-m", modelPath,
        "-l", language,
        "-f", audioPath,
        "-nt", // no timestamps output
      ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new WhisperError(
            `whisper-cli is not installed or not found in PATH. ` +
              `Install whisper.cpp and ensure whisper-cli is available.`,
            "WHISPER_NOT_FOUND",
            { cause: err },
          ),
        );
      } else {
        reject(
          new WhisperError(
            `whisper-cli process error: ${err.message}`,
            "WHISPER_FAILED",
            { cause: err },
          ),
        );
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim()
          ? `: ${stderr.slice(0, 500)}`
          : "";
        reject(
          new WhisperError(
            `whisper-cli exited with code ${code}${detail}`,
            "WHISPER_FAILED",
          ),
        );
        return;
      }

      resolve(stdout.trim());
    });
  });
}
