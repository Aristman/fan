# Архив расширений (deprecated)

Эти расширения объявлены **deprecated с 2026-08-24** и заархивированы.

## Что здесь

| Директория | Описание |
|-----------|----------|
| `fan-mission/` | Long-running autonomous missions (standalone extension) |
| `fan-super-orchestrator/` | HTTP-иерархия узлов `fan server` (standalone extension) |
| `fan-scheduler/` | Периодические тики миссий (standalone extension) |
| `fan-webhook/` | Приём внешних событий (standalone extension) |

## Замена

Все четыре расширения заменены бандлом [`bundles/fan-mission/`](../../bundles/fan-mission/), который содержит 4 расширения:

- `fan-mission`
- `fan-super-orchestrator`
- `fan-scheduler`
- `fan-webhook`

**Развитие идёт только в бандле.** Индивидуальные DEPLOY.toml-манифесты в этом архиве не используются.

## Зачем сохранён архив

Архив сохранён для истории git и для тестов (test/, vitest.config.ts, fixtures). Не редактировать, не публиковать, не включать в сборку.

## Технические пометки

- Расширения не входили в npm workspaces (`packages/*` only) и в root `tsconfig.json` — сборка монорепо от перемещения не зависит.
- `biome.json` обновлён: include-паттерны указывают на `archive/extensions/...`.
- `.gitignore` обновлён: паттерны `argv-*.txt` / `env-*.txt` (runtime-мусор e2e) перенесены на новые пути.
- Runtime-мусор (`argv-7001.txt`, `env-*.txt`, `node_modules/`, `.fan/`) перемещён вместе с директориями, в git не отслеживается.
