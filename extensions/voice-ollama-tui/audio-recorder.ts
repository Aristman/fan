import { spawn, execSync, type ChildProcess } from "node:child_process";
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
  /**
   * Path to a ffmpeg binary. When provided and the file exists, this path
   * is used as the ffmpeg command instead of looking up "ffmpeg" in PATH.
   * Useful when a local ffmpeg binary has been downloaded by `/voice init`.
   */
  binPath?: string;
}

// ---------------------------------------------------------------------------
// Recorder interface
// ---------------------------------------------------------------------------

interface RecorderContext {
  outputPath: string;
  tempDir?: string;
  options: RecordAudioOptions;
  /** Resolved device name (Windows auto-discovery may populate this). */
  effectiveAudioDevice?: string;
  /**
   * Resolved path to the ffmpeg binary. Populated from options.binPath
   * if provided and the file exists, otherwise defaults to "ffmpeg".
   */
  binPath?: string;
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
    // "audio=default" is not a valid dshow device name. Auto-discovery runs in
    // recordAudio() and stores the result in ctx.effectiveAudioDevice.
    return ["-f", "dshow", "-i", "audio=default"];
  }
  return null;
}

const ffmpegRecorder: Recorder = {
  name: "ffmpeg",
  buildArgs(ctx: RecorderContext): string[] | null {
    const deviceArg = ctx.effectiveAudioDevice ?? ctx.options.audioDevice;
    const deviceArgs = deviceArg
      ? getDeviceArgs(deviceArg)
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

/**
 * Check whether a recording was aborted but still produced a non-empty file.
 * This happens when SIGINT lets ffmpeg/sox/arecord flush and close the WAV
 * file before exiting with a non-zero code.
 */
/**
 * Check whether a recording was aborted but still produced a non-empty file.
 * This happens when SIGINT lets ffmpeg/sox/arecord flush and close the WAV
 * file before exiting with a non-zero code.
 */
function isAbortedWithFile(outputPath: string): boolean {
  try {
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

/** Best-effort debug log to a temp file. */
function debugLog(message: string): void {
  try {
    const logPath = path.join(os.tmpdir(), "voice-ollama-debug.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}

/**
 * Enumerate DirectShow audio capture devices on Windows using ffmpeg.
 * Returns the first audio device name suitable for ffmpeg's -i argument,
 * e.g. "audio=Microphone". Returns null if enumeration fails or no device found.
 *
 * Uses spawn instead of execSync to avoid shell redirection issues on Windows
 * and to capture stderr (where ffmpeg prints the device list) reliably.
 */
function findWindowsAudioDevice(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let output = "";
    let finished = false;

    const child = spawn("ffmpeg", ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onDone = (device: string | null) => {
      if (finished) return;
      finished = true;
      resolve(device);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      debugLog(`findWindowsAudioDevice spawn error: ${err.message}`);
      onDone(null);
    });

    child.on("close", () => {
      debugLog(`findWindowsAudioDevice raw output:\n${output}`);

      const lines = output.split(/\r?\n/);
      let inAudioSection = false;
      for (const line of lines) {
        if (/DirectShow audio devices/i.test(line)) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection) {
          if (/DirectShow video devices/i.test(line)) {
            break;
          }
          // ffmpeg prints device names in double quotes with two leading spaces:
          //   "Microphone (Realtek(R) Audio)"
          const match = line.match(/^\s{2}"?([^"]+)"?\s*$/);
          if (match && !line.includes("Alternative name") && match[1].trim().length > 0) {
            const deviceName = match[1].trim();
            debugLog(`findWindowsAudioDevice selected: ${deviceName}`);
            onDone(`audio=${deviceName}`);
            return;
          }
        }
      }
      onDone(null);
    });

    // Hard timeout: kill ffmpeg if it hangs during device enumeration.
    setTimeout(() => {
      debugLog("findWindowsAudioDevice enumeration timed out");
      try { child.kill(); } catch { /* ignore */ }
      onDone(null);
    }, 8_000).unref?.();
  });
}

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

    const isWindows = process.platform === "win32";
    const child = spawn(command, args, {
      // Keep stdin open so we can send 'q' to ffmpeg on Windows for a clean
      // shutdown. SIGINT does not gracefully terminate processes on Windows,
      // so writing 'q\n' to stdin is the only reliable way to flush the WAV.
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let finished = false;

    child.stdout?.on("data", () => {
      // ignore stdout
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    debugLog(`spawnRecorder started command=${command} args=${args.join(" ")} outputPath=${ctx.outputPath}`);

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

    let abortedBySignal = false;

    child.on("close", async (code) => {
      if (finished) return;
      finished = true;
      finalize();

      const outputSize = fs.existsSync(ctx.outputPath) ? fs.statSync(ctx.outputPath).size : -1;
      debugLog(`spawnRecorder close command=${command} code=${code} abortedBySignal=${abortedBySignal} outputPath=${ctx.outputPath} size=${outputSize}`);
      if (stderr.trim()) {
        debugLog(`spawnRecorder stderr: ${stderr.slice(0, 1000)}`);
      }

      if (code === 0) {
        resolve({ child, stderr });
        return;
      }

      // After a user-initiated abort (SIGINT) the recorder may exit with a
      // non-zero code even though it successfully flushed the WAV file.
      // Treat this as success only when we know the abort came from our signal.
      if (abortedBySignal) {
        if (outputSize > 0 || await waitForOutputFile(ctx.outputPath)) {
          debugLog(`spawnRecorder treating non-zero exit as success due to abort + existing file`);
          resolve({ child, stderr });
          return;
        }
      }

      const msg = stderr.trim()
        ? `${command} exited with code ${code}: ${stderr.slice(0, 500)}`
        : `${command} exited with code ${code}`;
      const error = new AudioRecorderError(msg, "RECORDER_FAILED");
      reject(error);
    });

    // Support abort signal
    if (signal) {
      const onAbort = () => {
        if (finished) return;
        abortedBySignal = true;

        if (isWindows) {
          // On Windows, POSIX signals are not reliably delivered to child
          // processes. ffmpeg accepts 'q' on stdin to quit gracefully and
          // flush the output file. sox/arecord are not first-class citizens
          // on Windows, so this path targets ffmpeg.
          debugLog(`spawnRecorder abort received for ${command}, sending 'q' to stdin (Windows)`);
          try {
            child.stdin?.write("q\n");
            child.stdin?.end();
          } catch (err) {
            debugLog(`spawnRecorder stdin write failed: ${(err as Error).message}`);
            // If stdin is closed/unavailable, fall back to terminate.
            try { child.kill(); } catch { /* ignore */ }
          }

          // Safety net: if the process does not exit within 1.5s, force-kill it.
          setTimeout(() => {
            if (!finished) {
              debugLog(`spawnRecorder force-killing ${command} after timeout`);
              try { child.kill(); } catch { /* ignore */ }
            }
          }, 1500).unref?.();
        } else {
          debugLog(`spawnRecorder abort received for ${command}, sending SIGINT`);
          // Use SIGINT so ffmpeg/sox/arecord flush and close the WAV file properly.
          child.kill("SIGINT");
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }
  });
}

/**
 * Wait up to `timeoutMs` for the output file to become non-empty.
 *
 * After sending SIGINT the recorder process exits asynchronously; on a loaded
 * system the WAV file may not be fully flushed by the time our `close` handler
 * runs. This helper gives us a short, bounded window to observe the file.
 */
async function waitForOutputFile(outputPath: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        return true;
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
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

  // For ffmpeg, use ctx.binPath (which may be a local binary) instead of
  // the hardcoded "ffmpeg" name. sox/arecord always use their name.
  const command = recorder.name === "ffmpeg" ? (ctx.binPath ?? "ffmpeg") : recorder.name;

  try {
    const { child, stderr } = await spawnRecorder(command, args, ctx, signal);

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
    // If it's an AudioRecorderError (process ran but failed), check for abort + existing file
    if (err instanceof AudioRecorderError) {
      // If the error is abort-related but the output file already exists with content,
      // the SIGINT likely let the recorder flush before exiting. Return the file.
      // The spawn-level handler now resolves on abort+file, so this path is
      // mainly defensive. Keep it in case the race is lost there.
      if (
        err.code === "RECORDER_ABORTED" &&
        ctx.outputPath &&
        fs.existsSync(ctx.outputPath) &&
        fs.statSync(ctx.outputPath).size > 0
      ) {
        debugLog(`tryRecorder safety net returning ${ctx.outputPath}`);
        return ctx.outputPath;
      }
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

  // Resolve ffmpeg binary path: prefer options.binPath if it points to a
  // real file, otherwise use "ffmpeg" (PATH lookup).
  const binPath =
    options.binPath && fs.existsSync(options.binPath)
      ? options.binPath
      : "ffmpeg";
  debugLog(`recordAudio binPath=${binPath}`);

  // On Windows, dshow requires an actual device name. Auto-discover one now.
  let effectiveAudioDevice: string | undefined;
  if (process.platform === "win32" && !options.audioDevice) {
    effectiveAudioDevice = (await findWindowsAudioDevice()) ?? undefined;
    debugLog(`recordAudio effectiveAudioDevice=${effectiveAudioDevice ?? "(none)"}`);
  }

  const ctx: RecorderContext = {
    outputPath,
    tempDir,
    options,
    effectiveAudioDevice,
    binPath,
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
