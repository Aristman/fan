/**
 * Model auto-downloader (F-3.2)
 *
 * Downloads the whisper.cpp ggml-base.bin model from HuggingFace if it
 * doesn't already exist locally.
 *
 * Roadmap TDD:
 *   TC-F-3.2-1: When model is missing, download starts and file appears.
 *   TC-F-3.2-2: If model already exists, no download is performed.
 *   TC-F-3.2-3: On network error, returns error with manual download instructions.
 */

import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { VoiceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnsureModelOptions {
  /** Local path where the model should be saved.
   *  Default: ~/.fan/models/speech/ggml-base.bin */
  modelPath?: string;

  /** URL to download the model from.
   *  Default: HuggingFace ggerganov/whisper.cpp ggml-base.bin */
  modelUrl?: string;

  /** Optional progress callback invoked with (downloadedBytes, totalBytes).
   *  totalBytes may be 0 if the server did not provide Content-Length. */
  onProgress?: (downloaded: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

/**
 * Determine the default model path: ~/.fan/models/speech/ggml-base.bin
 */
function defaultModelPath(): string {
  const home =
    (process.platform === "win32"
      ? process.env.USERPROFILE
      : process.env.HOME) ?? "/tmp";
  return path.join(home, ".fan", "models", "speech", "ggml-base.bin");
}

/**
 * Human-readable HuggingFace manual download instructions.
 */
const MANUAL_DOWNLOAD_INSTRUCTIONS = `\
You can download the model manually:

  1. Open https://huggingface.co/ggerganov/whisper.cpp
  2. Download ggml-base.bin (~142 MB)
  3. Save it to the model path and re-run voice input.

Or use curl:
  curl -L -o <model-path> https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the whisper model exists at the given path.
 *
 * If the file already exists, returns the path immediately without any
 * network requests.  Otherwise, downloads the model from `modelUrl` (which
 * defaults to the HuggingFace ggml-base.bin release).
 *
 * @param options — Optional model path, URL, and progress callback.
 * @returns The absolute path to the model file.
 * @throws {VoiceError} On network failure, with manual download instructions.
 */
export async function ensureWhisperModel(
  options?: EnsureModelOptions,
): Promise<string> {
  const modelPath = options?.modelPath ?? defaultModelPath();
  const modelUrl = options?.modelUrl ?? DEFAULT_MODEL_URL;
  const onProgress = options?.onProgress;

  // ── If the model already exists, return immediately ────────────────
  try {
    if (fs.existsSync(modelPath)) {
      const stat = fs.statSync(modelPath);
      if (stat.size > 0) {
        return modelPath;
      }
    }
  } catch {
    // Stat failed — proceed to download anyway
  }

  // ── Ensure the target directory exists ─────────────────────────────
  const dir = path.dirname(modelPath);
  fs.mkdirSync(dir, { recursive: true });

  // ── Download the model ─────────────────────────────────────────────
  try {
    await downloadFile(modelUrl, modelPath, onProgress);
  } catch (err: unknown) {
    // Clean up partial download on failure
    try {
      if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
      }
    } catch {
      // Best-effort cleanup
    }

    const cause = err instanceof Error ? err.message : String(err);
    throw new VoiceError(
      `Failed to download whisper model from ${modelUrl}.\n${cause}\n\n${MANUAL_DOWNLOAD_INSTRUCTIONS.replace("<model-path>", modelPath)}`,
    );
  }

  return modelPath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Download a file from `url` to `destination`.
 *
 * Uses the streaming fetch API (available in Node ≥18 / Bun).  Reports
 * download progress via `onProgress`.
 *
 * On network / HTTP errors the error propagates to the caller.
 */
async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} — ${url}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Fetch response body is not readable");
  }

  // Write the stream to disk
  const writeStream = fs.createWriteStream(destination);
  let downloaded = 0;
  let writeError: Error | undefined;

  writeStream.on("error", (err) => {
    writeError = err;
    writeStream.destroy();
  });

  try {
    while (true) {
      if (writeError) {
        throw writeError;
      }

      const { done, value } = await reader.read();
      if (done) break;

      downloaded += value.byteLength;
      await new Promise<void>((resolve, reject) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        writeStream.write(Buffer.from(value.buffer), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      if (onProgress) {
        onProgress(downloaded, total);
      }
    }

    if (writeError) {
      throw writeError;
    }

    // Finalise the stream and wait for it to be fully flushed/closed.
    writeStream.end();
    await finished(writeStream);

    // Final progress report at 100%
    if (onProgress) {
      onProgress(downloaded, total || downloaded);
    }
  } catch (err) {
    writeStream.destroy();
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort — MEDIUM-05 */ }
  }
}
