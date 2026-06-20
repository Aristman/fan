import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VoiceError, AudioRecorderError, WhisperError } from "./errors.js";

// Re-export for backward compatibility
export { VoiceError, AudioRecorderError, WhisperError };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RecordAudioOptions {
  /** Maximum recording duration in seconds (ffmpeg -t flag) */
  duration?: number;
  /** Audio device string (platform-specific) */
  audioDevice?: string;
  /** Output file path (default: temp dir with timestamp) */
  outputPath?: string;
  /** AbortSignal to cancel recording */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Recorder interface
// ---------------------------------------------------------------------------

interface RecorderContext {
  outputPath: string;
  tempDir?: string;
  options: RecordAudioOptions;
}

interface Recorder {
  name: string;
  /** Build the spawn args for this recorder. Returns null if platform is unsupported. */
  buildArgs(ctx: RecorderContext): string[] | null;
}

// ---------------------------------------------------------------------------
// Recorder implementations
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg device input arguments for the current platform.
 * Returns `null` to use the default device.
 */
function getDeviceArgs(device?: string): string[] | null {
  if (!device) return null;

  const platform = process.platform;
  if (platform === "darwin") {
    return ["-f", "avfoundation", "-i", `:${device}`];
  }
  if (platform === "linux") {
    return ["-f", "alsa", "-i", device];
  }
  if (platform === "win32") {
    return ["-f", "dshow", "-i", device];
  }
  return null;
}

/**
 * Build the ffmpeg default device arguments for the current platform.
 * Returns `null` if the platform isn't recognised.
 */
function getDefaultDeviceArgs(): string[] | null {
  const platform = process.platform;
  if (platform === "darwin") {
    return ["-f", "avfoundation", "-i", ":default"];
  }
  if (platform === "linux") {
    return ["-f", "alsa", "-i", "default"];
  }
  if (platform === "win32") {
    return ["-f", "dshow", "-i", "audio=default"];
  }
  return null;
}

const ffmpegRecorder: Recorder = {
  name: "ffmpeg",
  buildArgs(ctx: RecorderContext): string[] | null {
    const deviceArgs = ctx.options.audioDevice
      ? getDeviceArgs(ctx.options.audioDevice)
      : getDefaultDeviceArgs();

    if (!deviceArgs) return null;

    return [
      ...deviceArgs,
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      ...(ctx.options.duration !== undefined ? ["-t", String(ctx.options.duration)] : []),
      "-y",
      ctx.outputPath,
    ];
  },
};

const soxRecorder: Recorder = {
  name: "sox",
  buildArgs(ctx: RecorderContext): string[] | null {
    // sox -d -t wav -r 16000 -c 1 -b 16 <output.wav> [trim 0 <duration>]
    const args = [
      "-d",
      "-t", "wav",
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      ctx.outputPath,
    ];
    if (ctx.options.duration !== undefined) {
      args.push("trim", "0", String(ctx.options.duration));
    }
    return args;
  },
};

const arecordRecorder: Recorder = {
  name: "arecord",
  buildArgs(ctx: RecorderContext): string[] | null {
    // Linux-only; return null on other platforms
    if (process.platform !== "linux") return null;

    // arecord -r 16000 -c 1 -f S16_LE -t wav -D <device> --duration=<sec> <output.wav>
    const args: string[] = [];

    if (ctx.options.audioDevice) {
      args.push("-D", ctx.options.audioDevice);
    }

    args.push("-r", "16000");     // 16 kHz
    args.push("-c", "1");         // mono
    args.push("-f", "S16_LE");    // 16-bit PCM little-endian
    args.push("-t", "wav");       // WAV format

    if (ctx.options.duration !== undefined) {
      args.push("--duration", String(ctx.options.duration));
    }

    args.push(ctx.outputPath);

    return args;
  },
};

// Order of fallback: ffmpeg → sox → arecord
const recorders: Recorder[] = [ffmpegRecorder, soxRecorder, arecordRecorder];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateTempPath(): { filePath: string; dirPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ollama-"));
  const timestamp = Date.now();
  return {
    dirPath: dir,
    filePath: path.join(dir, `recording-${timestamp}.wav`),
  };
}

function removePath(p: string): void {
  try {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p);
      }
    }
  } catch {
    // Best-effort cleanup; don't throw from cleanup.
  }
}

// ---------------------------------------------------------------------------
// Spawn wrapper — returns a promise that resolves with stderr on success
// ---------------------------------------------------------------------------

function spawnRecorder(
  command: string,
  args: string[],
  ctx: RecorderContext,
  signal?: AbortSignal,
): Promise<{ child: ChildProcess; stderr: string }> {
  return new Promise<{ child: ChildProcess; stderr: string }>((resolve, reject) => {
    // Handle already-aborted signal before spawn
    if (signal?.aborted) {
      reject(new AudioRecorderError(
        "Recording was aborted before starting.",
        "RECORDER_ABORTED",
      ));
      return;
    }

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let finished = false;

    child.stdout?.on("data", () => {
      // ignore stdout
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    let removeAbortListener: (() => void) | undefined;

    const finalize = () => {
      removeAbortListener?.();
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      finalize();
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      finalize();
      if (code === 0) {
        resolve({ child, stderr });
      } else {
        const msg = stderr.trim()
          ? `${command} exited with code ${code}: ${stderr.slice(0, 500)}`
          : `${command} exited with code ${code}`;
        const error = new AudioRecorderError(msg, "RECORDER_FAILED");
        reject(error);
      }
    });

    // Support abort signal
    if (signal) {
      const onAbort = () => {
        if (finished) return;
        finished = true;
        child.kill("SIGTERM");
        const error = new AudioRecorderError(
          "Recording was aborted.",
          "RECORDER_ABORTED",
        );
        reject(error);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try a single recorder by spawning its process and waiting for completion.
 * Returns the output path on success. On ENOENT (not found) returns null,
 * allowing the caller to fall through to the next recorder.
 * On other failures throws AudioRecorderError.
 */
async function tryRecorder(
  recorder: Recorder,
  ctx: RecorderContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const args = recorder.buildArgs(ctx);
  if (args === null) {
    // Platform not supported by this recorder — skip
    return null;
  }

  try {
    const { child, stderr } = await spawnRecorder(recorder.name, args, ctx, signal);

    // Verify the output file exists and has content
    try {
      const stat = fs.statSync(ctx.outputPath);
      if (stat.size === 0) {
        throw new AudioRecorderError(
          `${recorder.name} produced an empty file.`,
          "RECORDER_FAILED",
        );
      }
    } catch (err) {
      if (err instanceof AudioRecorderError) throw err;
      throw new AudioRecorderError(
        `${recorder.name} completed but output file was not created.`,
        "RECORDER_FAILED",
      );
    }

    return ctx.outputPath;
  } catch (err: unknown) {
    // If it's an AudioRecorderError (process ran but failed), re-throw
    if (err instanceof AudioRecorderError) {
      throw err;
    }

    // If it's ENOENT (tool not found), return null to try next recorder
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    // Unknown error — re-throw as RECORDER_FAILED
    throw new AudioRecorderError(
      err instanceof Error ? err.message : String(err),
      "RECORDER_FAILED",
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Record audio from the microphone using the first available recorder.
 *
 * Tries recorders in order: ffmpeg → sox → arecord (Linux-only).
 * If a recorder is not installed (ENOENT), falls through to the next.
 * If a recorder is installed but fails, throws AudioRecorderError with RECORDER_FAILED.
 * If no recorder is available at all, throws AudioRecorderError with RECORDER_NOT_FOUND
 * and instructions to install ffmpeg.
 *
 * @param options - Recording options
 * @returns The path to the recorded WAV file
 * @throws {AudioRecorderError} If no recorder is available or recording fails
 */
export async function recordAudio(options: RecordAudioOptions = {}): Promise<string> {
  const tempPaths = options.outputPath ? null : generateTempPath();
  const outputPath = options.outputPath ?? tempPaths!.filePath;
  const tempDir = tempPaths?.dirPath;

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const ctx: RecorderContext = {
    outputPath,
    tempDir,
    options,
  };

  // Handle abort before any recorder starts
  if (options.signal?.aborted) {
    if (tempDir) removePath(tempDir);
    throw new AudioRecorderError(
      "Recording was aborted before starting.",
      "RECORDER_ABORTED",
    );
  }

  let lastError: Error | null = null;

  for (const recorder of recorders) {
    try {
      const result = await tryRecorder(recorder, ctx, options.signal);
      if (result !== null) {
        // Success — return path, no cleanup needed
        return result;
      }
      // recorder returned null (platform not supported), try next
    } catch (err) {
      if (err instanceof AudioRecorderError && err.code === "RECORDER_NOT_FOUND") {
        // This shouldn't happen since tryRecorder returns null for ENOENT
        continue;
      }
      // If recording was aborted, propagate immediately
      if (err instanceof AudioRecorderError && err.code === "RECORDER_ABORTED") {
        if (tempDir) removePath(tempDir);
        throw err;
      }
      // Recorder ran but failed — try next
      lastError = err instanceof Error ? err : new Error(String(err));
      // Clean up any partial output from this recorder
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch { /* best-effort */ }
      }
      continue;
    }
  }

  // All recorders exhausted
  if (tempDir) removePath(tempDir);

  if (lastError) {
    // A recorder was found but failed
    throw lastError;
  }

  // No recorder available at all
  throw new AudioRecorderError(
    "No audio recording tool found. Install ffmpeg for cross-platform audio recording:\n" +
    "  • macOS: brew install ffmpeg\n" +
    "  • Ubuntu/Debian: sudo apt install ffmpeg\n" +
    "  • Fedora: sudo dnf install ffmpeg\n" +
    "  • Windows (winget): winget install ffmpeg",
    "RECORDER_NOT_FOUND",
  );
}
