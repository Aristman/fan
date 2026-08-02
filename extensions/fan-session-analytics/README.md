# fan-session-analytics

Расширение FAN для анализа истории сессий: читает JSONL-сессии (read-only), считает детерминированные метрики (12 детекторов D1–D11, D13), формирует markdown-отчёты и балл качества 0–100.

Спецификация: `docs/specs/spec_session-analytics_2026-08-02.md` (в монорепозитории FAN).

## Возможности (этап A)

- **Парсер сессий** — потоковое чтение JSONL через `parseSessionEntries()`, фильтрация мусорных сессий, толерантность к битым строкам
- **Нормализатор траекторий** — восстановление main branch по `id`/`parentId`, детекция скилов и воркеров оркестратора
- **12 детекторов**:
  - D1 ошибки инструментов · D2 петли · D3 длительность шагов · D4 эффективность пути
  - D5 флоу оркестратора (implement без verify и др.) · D6 использование скилов · D7 инструменты расширений
  - D8 уплотнения контекста · D9 токены/стоимость · D10 брошенные вызовы
  - D11 пропорциональность флоу (тяжёлый пайплайн на мелкой задаче) · D13 пустые ретраи
- **Отчёты** — markdown в `.fan/reports/session-analytics/`, балл 0–100, находки по severity с доказательствами
- **Интерфейсы** — инструмент `session_analyze` + slash-команда `/session-analytics`

## Установка

Скопировать в каталог расширений FAN и перезапустить:

```powershell
# Windows (глобально)
xcopy /E /I extensions\fan-session-analytics "%USERPROFILE%\.fan\agent\extensions\fan-session-analytics"
```

```bash
# Linux/macOS (глобально)
cp -r extensions/fan-session-analytics ~/.fan/agent/extensions/
```

Проектная установка: в `.fan/extensions/` внутри проекта.

## Использование

| Вызов | Что делает |
|-------|-----------|
| `/session-analytics last` | Анализ последней сессии текущего каталога |
| `/session-analytics dir` | Пакетный анализ всех валидных сессий каталога |
| `/session-analytics <путь>` | Анализ конкретного JSONL-файла |
| tool `session_analyze` | То же из промпта; параметры: `target`, `mode`, `since`, `batchSize` |

`mode: "full"` в этапе A возвращает метрики с пометкой, что LLM-судья появится в этапе B.

## Конфигурация

Необязательна — работает на дефолтах. Для переопределения скопируйте `config.example.json` → `config.json` рядом с расширением. Проектный override: `<проект>/.fan/session-analytics.config.json` (приоритет выше).

При обновлении через FAN Store `config.json` сохраняется (preserve в DEPLOY.toml).

## Безопасность данных

- Файлы сессий **только читаются** (проверяется smoke-тестом по mtime/size)
- Запись — только отчёты и `config.json`
- Парсинг — только `parseSessionEntries()`; `SessionManager.open()` не используется (может перезаписать файл при миграции)

## Smoke-тест

```bash
cd extensions/fan-session-analytics
bun run scripts/smoke.ts   # ожидается 10/10 PASS
```

## Ограничения этапа A

- D9: `@fan/db` недоступен из расширений — best-effort через `bun:sqlite` и поле `usage` в JSONL
- D13: воркеры без `VERDICT:` в выводе считаются провалившимися (консервативно)
- LLM-судья (рубрики качества, D12) — этап B; авто-триггеры, дашборд, майнинг паттернов (F13) — этап C
