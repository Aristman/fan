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
  /** Resolved WASAPI capture device name (Windows). */
  wasapiDevice?: string;
  /**
   * Resolved path to the ffmpeg binary. Populated from options.binPath
   * if provided and the file exists, otherwise defaults to "ffmpeg".
   */
  binPath?: string;
  /**
   * Whether the resolved ffmpeg binary supports the dshow input device.
   * Probed once via `ffmpeg -devices`. When false, the dshow recorder is
   * skipped to avoid a noisy spawn that would just fail with
   * "Unknown input format".
   */
  dshowSupported?: boolean;
  /**
   * Whether the resolved ffmpeg binary supports the wasapi input device.
   * Probed once via `ffmpeg -devices`. When false, the wasapi recorder is
   * skipped.
   */
  wasapiSupported?: boolean;
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
    // "audio=default" is a legacy fallback that may or may not be accepted by
    // the ffmpeg dshow input depending on the build. recordAudio() prefers a
    // real device discovered via findWindowsAudioDevice(); only if discovery
    // fails does it fall back to audio=default. Returning null here lets
    // buildArgs() rely on ctx.effectiveAudioDevice.
    return null;
  }
  return null;
}

const ffmpegRecorder: Recorder = {
  name: "ffmpeg",
  buildArgs(ctx: RecorderContext): string[] | null {
    // On Windows we need dshow support; skip the recorder entirely if the
    // binary is known to lack it (probed once via ffmpeg -devices).
    if (process.platform === "win32" && ctx.dshowSupported === false) {
      return null;
    }

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

const wasapiRecorder: Recorder = {
  name: "ffmpeg",
  buildArgs(ctx: RecorderContext): string[] | null {
    if (process.platform !== "win32") return null;
    // Skip if we already know the binary lacks wasapi support.
    if (ctx.wasapiSupported === false) return null;

    // wasapi uses Windows endpoint names, not dshow "audio=..." names.
    // Use the discovered capture endpoint, or a user-provided wasapi device.
    const userWasapi =
      ctx.options.audioDevice && ctx.options.audioDevice !== "default" && ctx.options.audioDevice !== "audio=default"
        ? ctx.options.audioDevice
        : undefined;
    const input = ctx.wasapiDevice ?? userWasapi ?? "default";

    return [
      "-f", "wasapi",
      "-i", input,
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", "16000",
      ...(ctx.options.duration !== undefined ? ["-t", String(ctx.options.duration)] : []),
      "-y",
      ctx.outputPath,
    ];
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

// Order of fallback: dshow ffmpeg → wasapi ffmpeg → sox → arecord
const recorders: Recorder[] = [ffmpegRecorder, wasapiRecorder, soxRecorder, arecordRecorder];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Best-effort debug log to a temp file. */
let _notifyFn: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;

/** Set a notify callback so the recorder can surface diagnostics in the TUI. */
export function setRecorderNotify(notify: (message: string, type?: "info" | "warning" | "error") => void): void {
  _notifyFn = notify;
}

function notifyUser(message: string, type?: "info" | "warning" | "error"): void {
  try {
    _notifyFn?.(message, type);
  } catch {
    // ignore
  }
}

function debugLog(message: string): void {
  try {
    const logPath = path.join(os.tmpdir(), "voice-ollama-debug.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}

/**
 * Extract the most useful error line(s) from ffmpeg stderr.
 *
 * ffmpeg prints a version banner + build configuration at the start, which
 * is noise. The actual error is usually on lines starting with "[dshow @",
 * "[wasapi @", "Could not", "No such", "Unknown", or the last non-empty line.
 */
function extractFfmpegError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  // Prefer lines that look like actual ffmpeg errors.
  const errorLines = lines.filter((l) =>
    /^\[(dshow|wasapi|avfoundation|alsa|lavfi|openal) @/.test(l) ||
    /^(Could not|No such|Unknown|Invalid|Error|Permission|Device|Cannot|Failed)/i.test(l),
  );
  if (errorLines.length > 0) {
    return errorLines.slice(-3).join(" | ");
  }
  // Fall back to last 3 non-empty lines (skip the banner).
  return lines.slice(-3).join(" | ");
}

/**
 * Enumerate DirectShow audio capture devices on Windows using ffmpeg.
 * Returns the first audio device name suitable for ffmpeg's -i argument,
 * e.g. "audio=Microphone". Returns null if enumeration fails or no device found.
 *
 * Uses spawn instead of execSync to avoid shell redirection issues on Windows
 * and to capture stderr (where ffmpeg prints the device list) reliably.
 */
/**
 * Parse ffmpeg `-f dshow -list_devices` output into a list of audio device
 * names (without the `audio=` prefix). Supports both output formats:
 *
 *   New (gyan.dev full build):
 *     [in#0 @ ...] "Microphone (GM303)" (audio)
 *     [in#0 @ ...]   Alternative name "@device_cm_{...}"
 *
 *   Classic (older / other builds):
 *     [dshow @ ...] DirectShow audio devices
 *     [dshow @ ...]   "Microphone (Realtek Audio)"
 *     [dshow @ ...]     Alternative name "..."
 */
function parseDshowDevices(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const devices: string[] = [];

  // New format: lines tagged with (audio).
  for (const line of lines) {
    const m = line.match(/\[in#\d+[^\]]*\]\s*"([^"]+)"\s+\((audio|video)\)/i);
    if (m && m[2].toLowerCase() === "audio") {
      devices.push(m[1].trim());
    }
  }

  // Classic format: inside the "DirectShow audio devices" section.
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
      if (line.includes("Alternative name")) continue;
      // Device name in double quotes, optionally indented.
      const m = line.match(/^\s+"([^"]+)"\s*$/);
      if (m && m[1].trim().length > 0) {
        devices.push(m[1].trim());
      }
    }
  }

  // Deduplicate while preserving order.
  return [...new Set(devices)];
}

/**
 * Run `ffmpeg -f dshow -list_devices true -i dummy` with a specific binary
 * and parse the audio device names from the output. Returns an empty array
 * on failure or if no audio devices are found.
 */
function enumerateDshowDevices(command: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let output = "";
    let finished = false;

    const child = spawn(command, ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onDone = (devices: string[]) => {
      if (finished) return;
      finished = true;
      resolve(devices);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("error", () => onDone([]));
    child.on("close", () => {
      onDone(parseDshowDevices(output));
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      onDone([]);
    }, 8_000).unref?.();
  });
}

/**
 * List all DirectShow audio capture device names available on Windows.
 *
 * Tries the provided ffmpeg binary first (typically the locally downloaded
 * one), then falls back to `ffmpeg` in PATH. This maximises the chance of
 * finding devices even before the local binary is (re)downloaded, e.g. when
 * a working ffmpeg is already installed system-wide.
 *
 * @returns Array of device names (without `audio=` prefix). Empty on non-Windows
 *          or when no devices are found.
 */
export async function listWindowsAudioDevices(ffmpegPath?: string): Promise<string[]> {
  if (process.platform !== "win32") return [];

  const commands: string[] = [];
  if (ffmpegPath && fs.existsSync(ffmpegPath)) commands.push(ffmpegPath);
  if (ffmpegPath !== "ffmpeg") commands.push("ffmpeg");

  const seen = new Set<string>();
  for (const cmd of commands) {
    const devices = await enumerateDshowDevices(cmd);
    for (const d of devices) seen.add(d);
    if (seen.size > 0) break; // Found devices with a working binary — stop.
  }

  return [...seen];
}

/**
 * Enumerate DirectShow audio capture devices on Windows using ffmpeg and
 * return the preferred device name (preferring microphone-like names).
 * Returns a string suitable for ffmpeg's `-i` argument, e.g.
 * `audio=Microphone (GM303)`, or null if no device is found.
 */
function findWindowsAudioDevice(ffmpegPath?: string): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return listWindowsAudioDevices(ffmpegPath).then((candidates) => {
    notifyUser(`🎙 Parsed dshow audio candidates: ${candidates.join("; ") || "(none)"}`, "info");
    if (candidates.length === 0) return null;
    const mic = candidates.find((name) => /microphone|mic|микрофон/i.test(name));
    const chosen = mic ?? candidates[0];
    debugLog(`findWindowsAudioDevice selected: ${chosen}`);
    return `audio=${chosen}`;
  });
}

/**
 * Enumerate WASAPI audio capture devices on Windows using ffmpeg.
 * Returns the first capture endpoint name, e.g. "Microphone (Realtek Audio)".
 * Returns null if enumeration fails or no device found.
 */
function findWasapiAudioDevice(ffmpegPath?: string): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  const command = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : "ffmpeg";

  return new Promise<string | null>((resolve) => {
    let output = "";
    let finished = false;

    notifyUser(`🎙 Поиск микрофона WASAPI: ${command}`, "info");

    const child = spawn(command, ["-list_devices", "true", "-f", "wasapi", "-i", "dummy"], {
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
      const msg = `findWasapiAudioDevice spawn error: ${err.message}`;
      debugLog(msg);
      notifyUser(`🎙 ${msg}`, "error");
      onDone(null);
    });

    child.on("close", (code) => {
      const rawPreview = output.slice(0, 3000).replace(/\r?\n/g, " | ");
      debugLog(`findWasapiAudioDevice raw output (code=${code}):\n${output}`);
      notifyUser(`🎙 wasapi-list exit=${code} out=${rawPreview || "(empty)"}`, "info");

      // Detect missing wasapi support: ffmpeg prints "Unknown input format: 'wasapi'".
      if (/Unknown input format/i.test(output)) {
        notifyUser("🎙 ffmpeg собран БЕЗ поддержки wasapi", "error");
        onDone(null);
        return;
      }

      const lines = output.split(/\r?\n/);
      let inCapture = false;
      const candidates: string[] = [];
      for (const line of lines) {
        // ffmpeg wasapi prints two sections:
        //   "[wasapi @ ...] Output devices:"
        //   "[wasapi @ ...] Input devices:" (capture)
        if (/Output devices:/i.test(line)) {
          inCapture = false;
          continue;
        }
        if (/Input devices:/i.test(line)) {
          inCapture = true;
          continue;
        }
        if (inCapture) {
          // Lines look like:  "[wasapi @ ...] "Microphone (Realtek Audio)""
          const match = line.match(/"([^"]+)"\s*$/);
          if (match && match[1].trim().length > 0) {
            candidates.push(match[1].trim());
          }
        }
      }

      notifyUser(`🎙 Parsed wasapi input candidates: ${candidates.join("; ") || "(none)"}`, "info");

      const mic = candidates.find((name) => /microphone|mic|микрофон/i.test(name));
      const chosen = mic ?? candidates[0];
      if (chosen) {
        debugLog(`findWasapiAudioDevice selected: ${chosen}`);
        onDone(chosen);
        return;
      }
      onDone(null);
    });

    setTimeout(() => {
      debugLog("findWasapiAudioDevice enumeration timed out");
      try { child.kill(); } catch { /* ignore */ }
      onDone(null);
    }, 8_000).unref?.();
  });
}

/**
 * Probe which input device formats the resolved ffmpeg binary supports by
 * running `ffmpeg -devices`. Returns flags for the Windows-relevant indevs
 * (dshow, wasapi). Both flags default to `true` on non-Windows / when the
 * probe fails, so that recorders are still attempted.
 */
function probeFfmpegIndevs(ffmpegPath?: string): Promise<{ dshow: boolean; wasapi: boolean }> {
  if (process.platform !== "win32") {
    return Promise.resolve({ dshow: true, wasapi: true });
  }

  const command = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : "ffmpeg";

  return new Promise<{ dshow: boolean; wasapi: boolean }>((resolve) => {
    let output = "";
    const child = spawn(command, ["-devices"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("error", () => resolve({ dshow: true, wasapi: true }));
    child.on("close", () => {
      // ffmpeg -devices prints lines like:
      //   D  dshow           DirectShow capture
      //   D  wasapi          WASAPI input
      resolve({
        dshow: /^D\s+dshow\b/im.test(output),
        wasapi: /^D\s+wasapi\b/im.test(output),
      });
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ dshow: true, wasapi: true });
    }, 5_000).unref?.();
  });
}

/**
 * Check whether a given ffmpeg binary supports the DirectShow (dshow) input
 * device, which is required for audio capture on Windows. Runs `ffmpeg
 * -devices` and looks for a `D  dshow` line under input devices.
 */
export function checkFfmpegSupportsDshow(ffmpegPath?: string): Promise<boolean> {
  const command = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : "ffmpeg";

  return new Promise<boolean>((resolve) => {
    let output = "";
    const child = spawn(command, ["-devices"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("error", () => resolve(false));
    child.on("close", () => {
      // ffmpeg -devices prints lines like:
      //   D  dshow           DirectShow capture
      resolve(/^D\s+dshow\b/im.test(output));
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 5_000).unref?.();
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

    notifyUser(`🎙 Recorder: starting ${command} ${args.join(" ")}`, "info");
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
          notifyUser(`🎙 Recorder: abort produced file size=${outputSize}`, "info");
          debugLog(`spawnRecorder treating non-zero exit as success due to abort + existing file`);
          resolve({ child, stderr });
          return;
        }
      }

      const detail = stderr.trim() ? extractFfmpegError(stderr) : "(no stderr)";
      notifyUser(`🎙 Recorder failed: code=${code} ${detail}`, "error");
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
  // real file, then the dependency-aware getFfmpegPath() (locally downloaded
  // binary or PATH), finally "ffmpeg".
  let binPath: string;
  if (options.binPath && fs.existsSync(options.binPath)) {
    binPath = options.binPath;
  } else {
    try {
      // Dynamic import to avoid a hard dependency cycle in unit tests.
      const { getFfmpegPath } = await import("./dependencies.js");
      binPath = getFfmpegPath() ?? "ffmpeg";
    } catch {
      binPath = "ffmpeg";
    }
  }
  notifyUser(`🎙 recordAudio resolved binPath=${binPath} exists=${fs.existsSync(binPath)}`, "info");
  debugLog(`recordAudio binPath=${binPath}`);

  // On Windows, dshow requires an actual device name. Auto-discover one now.
  // Treat the legacy "default" / "audio=default" values as unset because they
  // are not valid dshow device names.
  const userDevice =
    options.audioDevice && options.audioDevice !== "default" && options.audioDevice !== "audio=default"
      ? options.audioDevice
      : undefined;

  let effectiveAudioDevice: string | undefined;
  let wasapiDevice: string | undefined;
  let dshowSupported: boolean | undefined;
  let wasapiSupported: boolean | undefined;
  if (process.platform === "win32" && !userDevice) {
    // Probe which input devices this ffmpeg build supports, and log them for
    // diagnostics. The returned flags let recorders skip themselves when the
    // binary lacks dshow/wasapi support (e.g. cross-compiled MinGW builds).
    const indevs = await probeFfmpegIndevs(binPath);
    dshowSupported = indevs.dshow;
    wasapiSupported = indevs.wasapi;
    notifyUser(
      `🎙 ffmpeg indevs: has_dshow=${dshowSupported} has_wasapi=${wasapiSupported}`,
      "info",
    );
    effectiveAudioDevice = (await findWindowsAudioDevice(binPath)) ?? undefined;
    if (!effectiveAudioDevice) {
      notifyUser("🎙 Не удалось определить микрофон через dshow, пробую wasapi", "warning");
      wasapiDevice = (await findWasapiAudioDevice(binPath)) ?? undefined;
      if (!wasapiDevice) {
        notifyUser("🎙 WASAPI устройства тоже не найдены", "warning");
      }
      // Keep effectiveAudioDevice unset so dshow recorder returns null.
    }
  }
  notifyUser(
    `🎙 recordAudio audioDevice=${options.audioDevice ?? "(unset)"} userDevice=${userDevice ?? "(auto)"} effective=${effectiveAudioDevice ?? "(none)"} wasapi=${wasapiDevice ?? "(none)"}`,
    "info",
  );
  debugLog(`recordAudio audioDevice=${options.audioDevice ?? "(unset)"} userDevice=${userDevice ?? "(auto)"} effective=${effectiveAudioDevice ?? "(none)"} wasapi=${wasapiDevice ?? "(none)"}`);

  const ctx: RecorderContext = {
    outputPath,
    tempDir,
    options: { ...options, audioDevice: userDevice },
    effectiveAudioDevice,
    wasapiDevice,
    binPath,
    dshowSupported,
    wasapiSupported,
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
