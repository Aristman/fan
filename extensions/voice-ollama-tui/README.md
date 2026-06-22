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
4. Убедитесь, что в PATH доступны `ffmpeg` (или `sox` / `arecord`), `whisper-cli`, и опционально Ollama.
5. Перезапустите FAN или выполните `/reload` в TUI.

## Первоначальная настройка (/voice init)

Для полного цикла настройки выполните в TUI команду:

```
/voice init
```

Wizard последовательно проведёт через все этапы:

1. **Проверка зависимостей** — ffmpeg/sox/arecord и whisper-cli.
2. **Автоматическая установка whisper-cli** — если `whisper-cli` не найден, wizard предложит скачать готовый бинарник whisper.cpp из FAN Store для текущей платформы.
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

## Планы на будущее

- Voice Activity Detection (VAD) для автоматической остановки записи по тишине.
