# Голосовой ввод для TUI (Ollama)

Расширение FAN, добавляющее голосовой ввод в TUI: запись аудио с микрофона, локальное распознавание речи через `whisper.cpp`, опциональное улучшение текста через Ollama и вставка результата в строку ввода.

## Возможности

- Команда `/voice` и шорткат `Ctrl+Shift+V` (настраивается)
- Локальная запись аудио через `ffmpeg` (с fallback на `sox`/`arecord`)
- Локальное распознавание речи через `whisper.cpp`
- Автоматическая загрузка модели `ggml-base.bin`
- Опциональная постобработка текста через Ollama `/api/chat`
- Автообнаружение доступных моделей Ollama
- Настройка через `.env` или `config.json`
- Поддержка отмены длительных операций по `Escape`

## Установка

1. Скопируйте или прилинкуйте директорию расширения в папку FAN extensions:
   ```bash
   mkdir -p ~/.fan/agent/extensions
   ln -s /path/to/extensions/voice-ollama-tui ~/.fan/agent/extensions/voice-ollama-tui
   ```
2. Установите зависимости:
   ```bash
   cd ~/.fan/agent/extensions/voice-ollama-tui
   npm install
   ```
3. Скопируйте `.env.example` в `.env` и настройте параметры:
   ```bash
   cp .env.example .env
   ```
4. Убедитесь, что в PATH доступны `ffmpeg` (или `sox` / `arecord`). `whisper-cli` можно установить вручную или скачать автоматически через `/voice init`.
5. Перезапустите FAN или выполните `/reload` в TUI.

## Первоначальная настройка (/voice init)

Для полного цикла настройки выполните в TUI команду:

```
/voice init
```

Wizard последовательно проведёт через все этапы:

1. **Проверка зависимостей** — ffmpeg/sox/arecord и whisper-cli.
2. **Автоматическая установка whisper-cli** — если `whisper-cli` не найден, wizard покажет платформу, размер бинарника и попросит подтверждение перед скачиванием из FAN Store.
3. **Проверка аудиоустройства** — обнаружение микрофона.
4. **Выбор языка распознавания** — auto, ru, en, de, fr, es, zh, ja или другой.
5. **Максимальная длительность записи** — от 5 до 300 секунд.
6. **Подключение Ollama** (опционально) — ввод адреса сервера, выбор модели, настройка system prompt.
7. **Горячая клавиша** — по умолчанию `Ctrl+Shift+V`.
8. **Скачивание whisper модели** — ggml-base.bin (~142 МБ).
9. **Сохранение конфигурации** — `.env` в директории расширения.

Поддерживаемые платформы для автозагрузки бинарника:
- linux-x64
- linux-arm64
- darwin-arm64 (Apple Silicon)
- darwin-x64 (Intel Mac)
- windows-x64

После завершения выполните `/reload` для применения нового шортката.

## Использование

В TUI нажмите `Ctrl+Shift+V` или введите команду `/voice`:

1. Появится overlay записи с таймером и индикатором активности.
2. Говорите в микрофон.
3. Нажмите `Enter`, чтобы завершить запись.
4. Нажмите `Escape` в любой момент, чтобы отменить запись или обработку.
5. Распознанный текст появится в строке ввода.

## Конфигурация

Основные параметры (в `.env`):

| Переменная | Значение по умолчанию | Описание |
|------------|----------------------|----------|
| `WHISPER_MODEL_PATH` | `~/.fan/models/speech/ggml-base.bin` | Путь к модели whisper |
| `WHISPER_LANGUAGE` | `auto` | Код языка: `ru`, `en`, `auto` |
| `WHISPER_FLAGS` | — | Дополнительные флаги для `whisper-cli` |
| `OLLAMA_ENABLED` | `false` | Включить постобработку через Ollama |
| `OLLAMA_MODEL` | `llama3.2` | Модель для улучшения текста |
| `OLLAMA_SYSTEM_PROMPT` | см. `.env.example` | Промпт для исправления пунктуации и опечаток |
| `SHORTCUT` | `ctrl+shift+v` | Горячая клавиша |
| `RECORD_DURATION_MAX` | `60` | Максимальная длительность записи в секундах |
| `AUDIO_DEVICE` | — | Имя аудиоустройства (опционально) |

Пример `.env`:

```bash
WHISPER_MODEL_PATH=/home/user/.fan/models/speech/ggml-base.bin
WHISPER_LANGUAGE=ru
OLLAMA_ENABLED=true
OLLAMA_MODEL=llama3.2
SHORTCUT=ctrl+shift+v
```

## Архитектура

```
index.ts
  └── runVoicePipeline(ctx, config)
        ├── checkDependencies()      # проверка ffmpeg/whisper-cli
        ├── showRecordingOverlay()   # overlay записи
        ├── recordAudio()            # ffmpeg → sox → arecord fallback
        ├── ensureWhisperModel()     # авто-загрузка ggml-base.bin
        ├── transcribe()             # whisper.cpp CLI
        ├── improveText()            # Ollama /api/chat (опционально)
        └── insertTranscript()       # ctx.ui.setEditorText()
```

## Зависимости

- `ffmpeg` (предпочтительно), или `sox`, или `arecord`
- `whisper.cpp` CLI (`whisper-cli`)
- Ollama (опционально, для постобработки текста)

## Разработка

```bash
cd extensions/voice-ollama-tui
npx tsc --noEmit
npx vitest run
```

## Безопасность и приватность

- Все данные обрабатываются локально.
- Аудиофайл временно сохраняется в системной временной директории и удаляется сразу после обработки.
- Ollama вызывается только если явно включён в конфигурации.
- Не используется `shell: true`, внешние команды запускаются через `spawn` с массивом аргументов.

## Возможные проблемы

**whisper-cli не найден**
- Убедитесь, что `whisper-cli` доступен в PATH.

**ffmpeg не может записать аудио**
- Проверьте список устройств: `ffmpeg -f avfoundation -list_devices true -i ""` (macOS) или `arecord -l` (Linux).

**Ollama недоступна**
- Расширение вставит сырой распознанный текст без постобработки.

## Сборка бинарников whisper-cli

Расширение может автоматически скачивать готовые бинарники `whisper-cli` из FAN Store. Исходные бинарники собираются из [whisper.cpp](https://github.com/ggml-org/whisper.cpp) и публикуются как отдельные asset-пакеты.

### Поддерживаемые платформы

| Платформа | Скрипт сборки | Хост |
|-----------|---------------|------|
| `linux-x64` | `scripts/build-whisper-binaries-linux.sh` | Linux |
| `linux-arm64` | `scripts/build-whisper-binaries-linux.sh` | Linux |
| `windows-x64` | `scripts/build-whisper-binaries-linux.sh` | Linux (MinGW) |
| `darwin-arm64` | `scripts/build-whisper-binaries-macos.sh` | macOS |
| `darwin-x64` | `scripts/build-whisper-binaries-macos.sh` | macOS |

### Сборка на Linux

Установите зависимости:

```bash
sudo apt-get update
sudo apt-get install -y cmake build-essential gcc-aarch64-linux-gnu g++-aarch64-linux-gnu mingw-w64 zip
```

Собрать все доступные с Linux платформы:

```bash
./scripts/build-whisper-binaries-linux.sh
```

Собрать только одну платформу:

```bash
./scripts/build-whisper-binaries-linux.sh --platform linux-x64
./scripts/build-whisper-binaries-linux.sh --platform linux-arm64
./scripts/build-whisper-binaries-linux.sh --platform windows-x64
```

Артефакты появятся в `/tmp/`:

```
/tmp/voice-ollama-tui-whisper-bin-linux-x64-1.9.1.tar.gz
/tmp/voice-ollama-tui-whisper-bin-linux-arm64-1.9.1.tar.gz
/tmp/voice-ollama-tui-whisper-bin-windows-x64-1.9.1.zip
```

### Сборка на macOS

Установите зависимости:

```bash
xcode-select --install
brew install cmake
```

Собрать обе macOS-платформы:

```bash
./scripts/build-whisper-binaries-macos.sh
```

Собрать только одну:

```bash
./scripts/build-whisper-binaries-macos.sh --platform darwin-arm64
./scripts/build-whisper-binaries-macos.sh --platform darwin-x64
```

Артефакты появятся в `/tmp/`:

```
/tmp/voice-ollama-tui-whisper-bin-darwin-arm64-1.9.1.tar.gz
/tmp/voice-ollama-tui-whisper-bin-darwin-x64-1.9.1.tar.gz
```

### Публикация в FAN Store

Для Windows-архива нужно конвертировать `.zip` в `.tar.gz`, потому что `fan-store add` принимает только tar.gz:

```bash
cd /tmp
unzip -q voice-ollama-tui-whisper-bin-windows-x64-1.9.1.zip
tar -czf voice-ollama-tui-whisper-bin-windows-x64-1.9.1.tar.gz voice-ollama-tui-whisper-bin-windows-x64
```

Добавить пакеты в локальный репозиторий FAN Store:

```bash
export FAN_REPO_DIR=~/fan-store

./tools/fan-store-server/fan-store add /tmp/voice-ollama-tui-whisper-bin-linux-x64-1.9.1.tar.gz
./tools/fan-store-server/fan-store add /tmp/voice-ollama-tui-whisper-bin-linux-arm64-1.9.1.tar.gz
./tools/fan-store-server/fan-store add /tmp/voice-ollama-tui-whisper-bin-windows-x64-1.9.1.tar.gz
./tools/fan-store-server/fan-store add /tmp/voice-ollama-tui-whisper-bin-darwin-arm64-1.9.1.tar.gz
./tools/fan-store-server/fan-store add /tmp/voice-ollama-tui-whisper-bin-darwin-x64-1.9.1.tar.gz
```

Опубликовать на сервер:

```bash
./tools/fan-store-server/fan-store publish
```

### Версионирование

Версия asset-пакетов соответствует версии whisper.cpp (например, `1.9.1`). Если нужно обновить whisper.cpp — измените `WHISPER_BIN_VERSION` в скриптах или передайте `--version`.

## Планы на будущее

- Voice Activity Detection (VAD) для автоматической остановки записи по тишине.
