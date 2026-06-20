import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class VoiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceError";
  }
}

export class AudioRecorderError extends VoiceError {
  constructor(
    message: string,
    public readonly code: "RECORDER_NOT_FOUND" | "RECORDER_FAILED" | "RECORDER_ABORTED",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioRecorderError";
  }
}

export class WhisperError extends VoiceError {
  constructor(
    message: string,
    public readonly code: "WHISPER_NOT_FOUND" | "WHISPER_MODEL_NOT_FOUND" | "WHISPER_FAILED",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WhisperError";
  }
}

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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg device input arguments for the current platform.
 * Returns `null` to use the default device.
 */
function getDeviceArgs(device?: string): string[] | null {
  if (!device) return null;

  const platform = process.platform;
  if (platform === "darwin") {
    // macOS: -f avfoundation -i :<device>
    return ["-f", "avfoundation", "-i", `:${device}`];
  }
  if (platform === "linux") {
    // Linux: -f alsa -i <device>
    return ["-f", "alsa", "-i", device];
  }
  if (platform === "win32") {
    // Windows: -f dshow -i <device>
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
    // macOS: use default audio device via avfoundation
    return ["-f", "avfoundation", "-i", ":default"];
  }
  if (platform === "linux") {
    // Linux: use default ALSA device
    return ["-f", "alsa", "-i", "default"];
  }
  if (platform === "win32") {
    // Windows: use default DirectShow device
    return ["-f", "dshow", "-i", "audio=default"];
  }
  return null;
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Record audio from the microphone using ffmpeg.
 *
 * Uses ffmpeg to capture audio in WAV format (16 kHz, mono, 16-bit).
 *
 * @param options - Recording options
 * @returns The path to the recorded WAV file
 * @throws {AudioRecorderError} If ffmpeg is not found or recording fails
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

  // Resolve device args
  const deviceArgs = options.audioDevice
    ? getDeviceArgs(options.audioDevice)
    : getDefaultDeviceArgs();

  if (!deviceArgs) {
    if (tempDir) removePath(tempDir);
    throw new AudioRecorderError(
      `Unsupported platform: ${process.platform}. Audio recording is not supported on this platform.`,
      "RECORDER_FAILED",
    );
  }

  // Build ffmpeg args: record to WAV 16kHz mono 16-bit
  const ffmpegArgs = [
    ...deviceArgs,
    "-acodec",
    "pcm_s16le", // 16-bit PCM
    "-ac",
    "1", // mono
    "-ar",
    "16000", // 16 kHz
    ...(options.duration !== undefined ? ["-t", String(options.duration)] : []),
    "-y", // overwrite output
    outputPath,
  ];

  return new Promise<string>((resolve, reject) => {
    let finished = false;
    let removeAbortListener: (() => void) | undefined;

    const cleanup = (dispose: boolean) => {
      if (finished) return;
      finished = true;
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = undefined;
      }
      if (dispose && tempDir) {
        removePath(tempDir);
      }
    };

    const child = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stdout?.on("data", () => {
      // ignore stdout
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const fail = (err: Error, code: "RECORDER_NOT_FOUND" | "RECORDER_FAILED") => {
      cleanup(/* dispose */ true);
      reject(new AudioRecorderError(err.message, code, { cause: err }));
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        fail(
          new Error("ffmpeg is not installed or not found in PATH. Install ffmpeg to record audio."),
          "RECORDER_NOT_FOUND",
        );
      } else {
        fail(err, "RECORDER_FAILED");
      }
    });

    child.on("close", (code) => {
      if (finished) return;
      if (code === 0) {
        // Verify the output file exists and has content
        try {
          const stat = fs.statSync(outputPath);
          if (stat.size === 0) {
            cleanup(/* dispose */ true);
            reject(new AudioRecorderError("Recording produced an empty file.", "RECORDER_FAILED"));
            return;
          }
        } catch {
          cleanup(/* dispose */ true);
          reject(
            new AudioRecorderError(
              "Recording completed but output file was not created.",
              "RECORDER_FAILED",
            ),
          );
          return;
        }
        cleanup(/* dispose */ false);
        resolve(outputPath);
      } else {
        const msg = stderr.trim()
          ? `ffmpeg exited with code ${code}: ${stderr.slice(0, 500)}`
          : `ffmpeg exited with code ${code}`;
        cleanup(/* dispose */ true);
        reject(new AudioRecorderError(msg, "RECORDER_FAILED"));
      }
    });

    // Support abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
        cleanup(/* dispose */ true);
        reject(new AudioRecorderError("Recording was aborted before starting.", "RECORDER_ABORTED"));
        return;
      }

      const onAbort = () => {
        child.kill("SIGTERM");
        cleanup(/* dispose */ true);
        reject(new AudioRecorderError("Recording was aborted.", "RECORDER_ABORTED"));
      };

      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        options.signal?.removeEventListener("abort", onAbort);
      };
    }
  });
}
