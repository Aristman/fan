/**
 * Error types for voice-ollama-tui extension.
 *
 * Extracted from audio-recorder.ts for shared use across the extension.
 */

// ---------------------------------------------------------------------------
// VoiceError — base class for all voice extension errors
// ---------------------------------------------------------------------------

export class VoiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceError";
  }
}

// ---------------------------------------------------------------------------
// AudioRecorderError — errors during audio recording
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WhisperError — errors during speech transcription
// ---------------------------------------------------------------------------

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
