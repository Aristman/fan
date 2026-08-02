# DEPLOY — fan-session-analytics

Расширение FAN для анализа истории сессий: читает JSONL-сессии, считает детерминированные метрики (12 детекторов D1–D11, D13), формирует markdown-отчёты и балл качества 0–100.

Спецификация: `docs/specs/spec_session-analytics_2026-08-02.md` (корень репозитория).

## Требования

- FAN установлен и работает (расширение грузится через jiti, сборка не нужна)
- Bun — только для smoke-теста и fallback D9 (`bun:sqlite`); само расширение в рантайме FAN Bun не требует
- Наличие сессий в `~/.fan/agent/sessions/`

## Структура

```
extensions/fan-session-analytics/
├── package.json            # манифест (секция fan: name/type/entry/extensions)
├── index.ts                # ExtensionFactory: tool session_analyze + /session-analytics
├── src/
│   ├── parser.ts           # чтение JSONL (read-only), фильтры мусора, поиск сессий
│   ├── normalizer.ts       # FileEntry[] → Trajectory
│   ├── detectors/          # D1–D11, D13 (по модулю на детектор)
│   ├── registry.ts         # реестр встроенных/extension инструментов
│   ├── report.ts           # markdown-отчёт, атомарная запись
│   ├── score.ts            # балл 0–100
│   ├── config.ts           # дефолты + config.json + проектный override
│   ├── pipeline.ts         # parse → normalize → detect → score → report
│   └── types.ts
└── scripts/smoke.ts        # автономный тест на реальных сессиях
```

## Установка

### Вариант 1 — глобально (рекомендуется)

Скопировать каталог расширения в глобальный каталог расширений FAN:

```powershell
# Windows
xcopy /E /I extensions\fan-session-analytics "%USERPROFILE%\.fan\agent\extensions\fan-session-analytics"
```

```bash
# Linux/macOS
cp -r extensions/fan-session-analytics ~/.fan/agent/extensions/
```

Перезапустить FAN — расширение обнаружится автоматически (auto-discovery по `~/.fan/agent/extensions/`).

### Вариант 2 — проектно

Скопировать в `.fan/extensions/` внутри проекта — расширение будет активно только для сессий этого проекта.

### Вариант 3 — FAN Store (будущее)

Публикация в FAN Store по `tools/fan-store-server/GUIDE.md` — после завершения этапа B.

## Проверка установки

В сессии FAN:

```
/session-analytics last
```

Ожидается: сводка метрик последней сессии текущего проекта + путь к отчёту в `.fan/reports/session-analytics/`.

## Использование

| Вызов | Что делает |
|-------|-----------|
| `/session-analytics last` | Анализ последней сессии текущего каталога |
| `/session-analytics dir` | Пакетный анализ всех валидных сессий текущего каталога |
| `/session-analytics <путь>` | Анализ конкретного JSONL-файла |
| tool `session_analyze` | То же из промпта; параметры: `target`, `mode`, `since`, `batchSize` |

Параметр `mode: "full"` в этапе A возвращает метрики с пометкой, что LLM-судья появится в этапе B.

## Конфигурация

Необязательно. Источники по приоритету (поздний переопределяет ранний):

1. Дефолты в `src/config.ts`
2. `config.json` рядом с расширением
3. `<проект>/.fan/session-analytics.config.json`

Ключи: `filters` (мусорные сессии), `orchestration` (пороги D11/D13, список heavySkills), `reports.dir`. Зарезервировано под этапы B/C: `judge`, `autoAnalyze`, `weeklyBatch`.

## Smoke-тест

Автономная проверка на реальных сессиях (без запуска FAN):

```bash
cd extensions/fan-session-analytics
bun run scripts/smoke.ts
```

Проверяет: санитизацию путей, подсчёт toolCalls, целостность файлов сессий (read-only), полный пайплайн на 3 сессиях. Ожидается `10/10 PASS`.

## Безопасность данных

- Файлы сессий **только читаются** (BR1; проверяется smoke-тестом по mtime/size)
- Запись — только отчёты в `.fan/reports/session-analytics/` и `config.json` расширения
- Парсинг — только через `parseSessionEntries()` (BR2; `SessionManager.open()` не используется, т.к. может перезаписать файл при миграции)

## Известные ограничения (этап A)

- D9 (токены/стоимость): `@fan/db` недоступен из расширений — best-effort через `bun:sqlite` и поле `usage` в JSONL; при недоступности обоих — `n/a` с пометкой об источнике
- D13: воркеры без явного `VERDICT:` в выводе считаются провалившимися (консервативно)
- LLM-судья (рубрики качества) — этап B, требует API вызова модели из расширений
- Авто-триггеры, дашборд, майнинг паттернов (F13) — этап C
