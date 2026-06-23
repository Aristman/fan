import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { getCurrentPlatform, getLocalBinaryPath, hasLocalFfmpegBinary, getLocalFfmpegPath } from "./bin-manager.js";
import type { VoiceOllamaConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyStatus {
	/** true when all required tools are available */
	ok: boolean;
	/** Names of missing tools */
	missing: string[];
	/** Human-readable installation instructions */
	instructions: string[];
}

// ---------------------------------------------------------------------------
// Per-session cache (cleared on session_shutdown)
// ---------------------------------------------------------------------------

let cachedResult: DependencyStatus | null = null;

let _depNotifyFn: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;

/** Set a notify callback so dependency checks can surface diagnostics in the TUI. */
export function setDependencyNotify(notify: (message: string, type?: "info" | "warning" | "error") => void): void {
	_depNotifyFn = notify;
}

function depNotify(message: string, type?: "info" | "warning" | "error"): void {
	try {
		_depNotifyFn?.(message, type);
	} catch {
		// ignore
	}
}

/** Reset the cache — — called on session_shutdown to ensure a fresh check per session. */
export function resetDependencyCache(): void {
	cachedResult = null;
}

// ---------------------------------------------------------------------------
// Individual tool checkers
// ---------------------------------------------------------------------------

function checkTool(command: string, versionFlag: string): boolean {
	try {
		execSync(`${command} ${versionFlag}`, {
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

const FFMPEG_INSTRUCTIONS = [
	"ffmpeg, sox, or arecord is required for audio recording.",
	"",
	"Install ffmpeg (recommended, cross-platform):",
	"  • macOS: brew install ffmpeg",
	"  • Ubuntu/Debian: sudo apt install ffmpeg",
	"  • Fedora: sudo dnf install ffmpeg",
	"  • Windows (winget): winget install ffmpeg",
	"  • Windows (choco): choco install ffmpeg",
	"",
	"Or install sox (cross-platform):",
	"  • macOS: brew install sox",
	"  • Ubuntu/Debian: sudo apt install sox",
	"  • Fedora: sudo dnf install sox",
	"",
	"Or install arecord (alsa-utils, Linux-only):",
	"  • Ubuntu/Debian: sudo apt install alsa-utils",
	"  • Fedora: sudo dnf install alsa-utils",
];

const WHISPER_INSTRUCTIONS = [
	"whisper-cli (whisper.cpp) is required for speech recognition.",
	"",
	"Install whisper.cpp:",
	"  1. Clone: git clone https://github.com/ggerganov/whisper.cpp.git",
	"  2. Build: cd whisper.cpp && make",
	"  3. Copy the binary: cp whisper-cli /usr/local/bin/ (or add to PATH)",
	"",
	"Or download a pre-built release from:",
	"  https://github.com/ggerganov/whisper.cpp/releases",
];

function checkFfmpeg(): boolean {
	const inPath = checkTool("ffmpeg", "-version");
	const localExists = hasLocalFfmpegBinary();
	let localPath: string | undefined;
	try {
		localPath = getLocalFfmpegPath();
	} catch {
		localPath = undefined;
	}
	depNotify(`🎙 checkFfmpeg pathInPath=${inPath} localPath=${localPath ?? "(none)"} localExists=${localExists}`, "info");
	return inPath || localExists;
}

function checkSox(): boolean {
	return checkTool("sox", "--version");
}

function checkArecord(): boolean {
	return checkTool("arecord", "--version");
}

function checkWhisperCliInPath(): boolean {
	// whisper-cli supports both -h and --help
	return checkTool("whisper-cli", "-h");
}

/**
 * Check whether a prebuilt whisper-cli binary was downloaded locally by the
 * `/voice init` wizard. The binary is stored under the extension directory at
 * bin/<platform>/whisper-cli (or whisper-cli.exe on Windows).
 */
function hasLocalWhisperCli(): boolean {
	try {
		const platform = getCurrentPlatform();
		if (!platform) return false;
		const binPath = getLocalBinaryPath(platform);
		const stat = fs.statSync(binPath);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

/**
 * Check whether whisper-cli is available, either in PATH or as a locally
 * downloaded binary.
 */
function checkWhisperCli(): boolean {
	return checkWhisperCliInPath() || hasLocalWhisperCli();
}

// ---------------------------------------------------------------------------
// Audio device accessibility check (LOW-03)
// ---------------------------------------------------------------------------

/**
 * Best-effort debug log to a temp file. Mirrors the helper in audio-recorder.ts
 * so dependency diagnostics are also observable in the system temp directory.
 */
function debugLog(message: string): void {
	try {
		const lines = `${new Date().toISOString()} ${message}\n`;
		// Try multiple locations for cross-platform observability.
		for (const dir of [os.tmpdir(), path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir(), ".fan")]) {
			try {
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				fs.appendFileSync(path.join(dir, "voice-ollama-debug.log"), lines);
				break;
			} catch {
				// try next location
			}
		}
	} catch {
		// ignore
	}
}

/**
 * Execute a command and capture stdout+stderr. On Windows, `LC_ALL=C` is not
 * passed because it is not a valid cmd.exe construct and may cause the spawn
 * to fail before ffmpeg even starts.
 */
function execWithFallback(command: string, options: { encoding: "utf-8"; timeout: number; env?: NodeJS.ProcessEnv }): string {
	return execSync(command, {
		encoding: options.encoding,
		timeout: options.timeout,
		env: options.env,
		windowsHide: true,
	});
}

/**
 * Perform a basic check that the system has an accessible audio input device.
 * Uses platform-specific commands. Returns true if a device was found,
 * false on error or if the command is unavailable.
 * Results are NOT cached since device state can change.
 *
 * Commands are run with `LC_ALL=C` on Unix to avoid locale-dependent parsing,
 * with additional locale-agnostic fallbacks where available. On Windows the
 * command is run directly (no shell locale prefix) because cmd.exe does not
 * support it.
 */
export function checkAudioDevice(): boolean {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			// macOS: list avfoundation devices
			const out = execWithFallback(
				"ffmpeg -f avfoundation -list_devices true -i \"\" 2>&1",
				{ encoding: "utf-8", timeout: 10_000, env: { ...process.env, LC_ALL: "C" } },
			);
			// If output contains an audio device entry, it's likely working
			return out.includes("Audio") || out.includes("microphone");
		}
		if (platform === "linux") {
			// Locale-agnostic fallback: /proc/asound/cards lists ALSA cards
			// regardless of the user's locale.
			try {
				const cards = fs.readFileSync("/proc/asound/cards", "utf-8");
				if (cards.trim().length > 0 && /\[/.test(cards)) {
					return true;
				}
			} catch {
				// ignore and continue with command-based checks
			}

			// Linux: list alsa capture devices with forced C locale.
			const out = execWithFallback("arecord -l", {
				encoding: "utf-8",
				timeout: 10_000,
				env: { ...process.env, LC_ALL: "C" },
			});
			return /\bcard\b/i.test(out);
		}
		if (platform === "win32") {
			// Resolve the ffmpeg binary to use: prefer locally downloaded, then PATH.
			// After a clean install ffmpeg is not in PATH yet, so the local binary
			// is the only way to enumerate devices without requiring a manual install.
			const rawFfmpegPath = getFfmpegPath() ?? "ffmpeg";
			// Quote the path on Windows so spaces/slashes do not break cmd.exe.
			const ffmpegPath = rawFfmpegPath.includes(" ") ? `"${rawFfmpegPath}"` : rawFfmpegPath;
			debugLog(`checkAudioDevice using ffmpeg path: ${rawFfmpegPath} (quoted: ${ffmpegPath})`);

			// Windows: list dshow audio capture devices. Do NOT prefix with
			// LC_ALL=C — cmd.exe does not understand it and the spawn fails.
			// The "dummy" input name is the documented placeholder for dshow
			// device enumeration; some ffmpeg builds also accept "audio=dummy".
			try {
				const out = execWithFallback(
					`${ffmpegPath} -f dshow -list_devices true -i dummy 2>&1`,
					{ encoding: "utf-8", timeout: 10_000 },
				);
				debugLog(`checkAudioDevice dshow output:\n${out}`);

				// ffmpeg dshow output on Windows looks like:
				// [dshow @ ...] DirectShow audio devices
				// [dshow @ ...]  "Microphone (Realtek(R) Audio)"
				// [dshow @ ...]    Alternative name "..."
				// Some builds append "(audio)" after the device name.
				const hasAudioSection = /DirectShow audio devices/i.test(out);
				const hasQuotedDevice = /"[^"]+"/.test(out);
				const hasAudioPin = /\[dshow @/.test(out);
				const hasAudioLabel = /\(audio\)/i.test(out);

				// Be permissive: if we see the audio section and at least one
				// quoted device name or audio label, assume an input exists.
				const found = hasAudioSection && (hasQuotedDevice || hasAudioLabel || hasAudioPin);
				debugLog(`checkAudioDevice dshow parsed: audioSection=${hasAudioSection} quoted=${hasQuotedDevice} audioLabel=${hasAudioLabel} pin=${hasAudioPin} => ${found}`);
				if (found) return true;
			} catch (dshowErr) {
				debugLog(`checkAudioDevice dshow failed: ${(dshowErr as Error).message}`);
			}

			// Fallback: use PowerShell to enumerate sound devices. This works on
			// modern Windows even when ffmpeg's dshow enumeration is broken.
			try {
				const out = execWithFallback(
					'powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Select-Object Name"',
					{ encoding: "utf-8", timeout: 10_000 },
				);
				debugLog(`checkAudioDevice powershell output:\n${out}`);
				const lines = out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
				// Header "Name" plus at least one device line means audio hardware exists.
				const hasDevice = lines.length > 1 && lines.some((l) => l !== "Name");
				debugLog(`checkAudioDevice powershell sound devices found=${hasDevice}`);
				return hasDevice;
			} catch (psErr) {
				debugLog(`checkAudioDevice powershell fallback failed: ${(psErr as Error).message}`);
			}
		}
		return false;
	} catch (err) {
		debugLog(`checkAudioDevice unexpected error: ${(err as Error).message}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Return the path to a usable ffmpeg binary.
 *
 * Prefers a locally downloaded binary (via FAN Store asset), falling back to
 * the system ffmpeg in PATH if available.
 *
 * @returns Absolute path to local ffmpeg, "ffmpeg" if it is in PATH, or
 *          undefined if ffmpeg is not available at all.
 */
export function getFfmpegPath(): string | undefined {
	if (hasLocalFfmpegBinary()) {
		try {
			const localPath = getLocalFfmpegPath();
			depNotify(`🎙 getFfmpegPath local=${localPath} exists=true`, "info");
			return localPath;
		} catch {
			// fall through to PATH check
		}
	}
	const localPath = (() => {
		try { return getLocalFfmpegPath(); } catch { return undefined; }
	})();
	depNotify(`🎙 getFfmpegPath local=${localPath ?? "(none)"} exists=false`, "info");
	if (checkTool("ffmpeg", "-version")) {
		depNotify("🎙 getFfmpegPath falling back to ffmpeg in PATH", "warning");
		return "ffmpeg";
	}
	depNotify("🎙 getFfmpegPath: no ffmpeg available", "error");
	return undefined;
}

/**
 * Check whether all external tools (ffmpeg/sox/arecord, whisper-cli) are available.
 *
 * For audio recording, at least one of ffmpeg, sox, or arecord (Linux) must be present.
 * Results are cached for the duration of the session and reset on session_shutdown.
 * Call {@link resetDependencyCache} to clear the cache in tests.
 *
 * @param _config — currently unused, reserved for future per-config checks
 */
export function checkDependencies(_config?: VoiceOllamaConfig): DependencyStatus {
	if (cachedResult) {
		return cachedResult;
	}

	const missing: string[] = [];
	const instructions: string[] = [];

	// Audio recorder: at least one of ffmpeg / sox / arecord must be present
	const hasFfmpeg = checkFfmpeg();
	const hasSox = checkSox();
	const hasArecord = checkArecord();

	if (!hasFfmpeg && !hasSox && !hasArecord) {
		missing.push("ffmpeg");
		instructions.push(...FFMPEG_INSTRUCTIONS);
	}

	if (!checkWhisperCli()) {
		missing.push("whisper-cli");
		instructions.push(...WHISPER_INSTRUCTIONS);
	}

	const ok = missing.length === 0;

	cachedResult = { ok, missing, instructions };
	return cachedResult;
}
