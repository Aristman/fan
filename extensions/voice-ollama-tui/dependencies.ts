import { execSync } from "node:child_process";
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

/** Reset the cache — called on session_shutdown to ensure a fresh check per session. */
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
	return checkTool("ffmpeg", "-version");
}

function checkSox(): boolean {
	return checkTool("sox", "--version");
}

function checkArecord(): boolean {
	// Use --version instead of plain invocation
	try {
		return checkTool("arecord", "--version");
	} catch {
		return false;
	}
}

function checkWhisperCli(): boolean {
	// whisper-cli supports both -h and --help
	return checkTool("whisper-cli", "-h");
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

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
