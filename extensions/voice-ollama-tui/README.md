# Voice Input for TUI (Ollama)

FAN extension that adds voice input to the TUI: record audio from the microphone, transcribe it locally with `whisper.cpp`, optionally improve the text via Ollama, and insert the result into the editor.

## Features

- `/voice` slash command + `Ctrl+Shift+V` shortcut (configurable)
- Local audio recording via `ffmpeg` (with `sox`/`arecord` fallback)
- Local speech-to-text via `whisper.cpp`
- Automatic download of the `ggml-base.bin` whisper model
- Optional text post-processing through Ollama `/api/chat`
- Auto-detection of available Ollama models
- Configurable through `.env` or `config.json`

## Installation

1. Copy or symlink this directory into your FAN extensions folder:
   ```bash
   mkdir -p ~/.fan/agent/extensions
   ln -s /path/to/extensions/voice-ollama-tui ~/.fan/agent/extensions/voice-ollama-tui
   ```
2. Install dependencies:
   ```bash
   cd ~/.fan/agent/extensions/voice-ollama-tui
   npm install
   ```
3. Copy `.env.example` to `.env` and adjust values.
4. Make sure `ffmpeg` (or `sox` / `arecord`), `whisper-cli`, and (optionally) Ollama are available in your PATH.
5. Restart FAN or run `/reload` in the TUI.

## Configuration

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

Key options:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL_PATH` | `~/.fan/models/speech/ggml-base.bin` | Path to the whisper model |
| `WHISPER_LANGUAGE` | `auto` | Language code, e.g. `ru`, `en` |
| `OLLAMA_ENABLED` | `false` | Enable Ollama post-processing |
| `OLLAMA_MODEL` | `llama3.2` | Model name for text improvement |
| `OLLAMA_SYSTEM_PROMPT` | *(see `.env.example`)* | Prompt for punctuation/typo fixing |
| `SHORTCUT` | `ctrl+shift+v` | Keyboard shortcut |
| `RECORD_DURATION_MAX` | `60` | Maximum recording duration in seconds |

## Dependencies

- `ffmpeg` (preferred), or `sox`, or `arecord`
- `whisper.cpp` CLI (`whisper-cli`)
- Ollama (optional, for text post-processing)

## Architecture

```
index.ts
  └── runVoicePipeline(ctx, config)
        ├── checkDependencies()
        ├── showRecordingOverlay()
        ├── recordAudio()          # ffmpeg → sox → arecord fallback
        ├── ensureWhisperModel()   # auto-download ggml-base.bin
        ├── transcribe()           # whisper.cpp CLI
        ├── improveText()          # Ollama /api/chat (optional)
        └── insertTranscript()     # ctx.ui.setEditorText()
```

## Development

```bash
cd extensions/voice-ollama-tui
npx tsc --noEmit
npx vitest run
```

## Future Enhancements

- Voice Activity Detection (VAD) for automatic recording stop.
