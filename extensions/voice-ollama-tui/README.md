# Voice Input for TUI (Ollama)

FAN extension that adds voice input to the TUI: record audio from the microphone, transcribe it locally with `whisper.cpp`, optionally improve the text via Ollama, and insert the result into the editor.

## Features

- `/voice` slash command + `Ctrl+Shift+V` shortcut
- Local audio recording via `ffmpeg` (with `sox`/`arecord` fallback)
- Local speech-to-text via `whisper.cpp`
- Optional text post-processing through Ollama `/api/chat`
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
4. Make sure `ffmpeg`, `whisper-cli`, and (optionally) Ollama are available in your PATH.
5. Restart FAN or run `/reload` in the TUI.

## Dependencies

- `ffmpeg` (preferred), or `sox`, or `arecord`
- `whisper.cpp` CLI (`whisper-cli`)
- Ollama (optional, for text post-processing)

## Development

```bash
cd extensions/voice-ollama-tui
npx tsc --noEmit
npx vitest run
```
