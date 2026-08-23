# fan-mission

> Bundle для автономных миссий FAN — файловое хранилище состояния, периодические тики, делегирование эпиков в иерархию узлов с рекурсивным spawn (глубина до 4), приём внешних событий через webhook.

**fan-mission** объединяет четыре расширения FAN, которые вместе реализуют полный контур долгоживущей автономной работы: от планировщика тиков и файлового state-store до супер-оркестратора с HTTP-иерархией узлов и webhook-приёмника внешних событий.

---

## Что включено

| Extension | Версия | Что даёт |
|-----------|--------|----------|
| **fan-mission** | 0.10.8 | 7-шаговый цикл миссии (FSM), файловое хранилище (`MISSION.md`, `ROADMAP.md`, `STATE.md`, `BACKLOG.md`, `DECISIONS.md`), тиковый мост к scheduler, 13 шаблонов миссий (`templates/default`, `templates/refactor`), scoring идей, метрики, slash-команды |
| **fan-scheduler** | 0.3.1 | Периодическое пробуждение миссионного контура (setInterval/cron), доставка tick-промпта в `actions.sendMessage` как `followUp` (I4 heartbeat) |
| **fan-super-orchestrator** | 0.5.2 | HTTP-иерархия узлов `fan server`: порождение дочерних узлов, аутентификация, бюджет, журнал дерева (`tree-journal`), рекурсивный spawn с depth-4 и role-aware маршрутизацией (10 role profiles в `roles/*.yaml`) |
| **fan-webhook** | 0.2.0 | Микро-Hono сервер, принимающий POST-запросы от внешних систем (CI, git-push, мониторинг) и маршрутизирующий их как `steer`/`followUp`-сообщения в активную миссию |

**Связи между расширениями:**

```
fan-webhook ───► fan-mission (steer / followUp delivery)
fan-scheduler ─► fan-mission (tick → mission-loop → runAgent)
fan-mission ───► fan-super-orchestrator (epic-delegation → spawn child nodes)
fan-super-orchestrator ─► fan-mission (depth-2+ children also run missions)
```

---

## Что даёт бандл

1. **Долгоживущие миссии** — `fan-mission` запускает 7-шаговый цикл (planning → decide → dispatch → execute → verify → learn → archive) с файлово-персистентным состоянием. Миссия переживает перезапуск сессии FAN.
2. **Рекуррентные миссии** — `fan-scheduler` будит миссионный контур по интервалу/cron (I4 heartbeat), `RECURRING.md` отслеживает частоту.
3. **EPIC delegation с depth-4** — `fan-super-orchestrator` порождает дочерние узлы `fan server` через HTTP, иерархия до 4 уровней в глубину (pyramid-width guard). Каждый уровень имеет role-profile (`architect`, `backend`, `frontend`, `qa`, `pm`, `devops`, `docs`, `mobile`, `refactor`, `research`) и явный `required_extensions` / `excluded_extensions` через `role-config`.
4. **Webhooks для внешних систем** — `fan-webhook` поднимает микро-Hono на свободном порту, обрабатывает `POST /webhook` с JSON-телом `{type, payload}`, маршрутизирует в активную миссию.

---

## Требования

| Требование | Детали |
|------------|--------|
| FAN | Phase 7+ (текущая версия) |
| Runtime | Bun (≥ 1.1) — для запуска spawned-узлов супер-оркестратора |
| Node.js | ≥ 18 (peer для `@hono/node-server` в webhook) |
| OS | Windows, macOS, Linux |

После установки бандла FAN автоматически выполнит `bun install` для каждого расширения.

---

## Установка

### Вариант 1: FAN Store (рекомендуется)

```bash
fan store install fan-mission
```

После установки перезапустите FAN, чтобы расширения загрузились. Все 4 расширения появятся в `~/.fan/agent/extensions/`.

### Вариант 2: Ручная установка

```bash
# Распаковать архив
tar -xzf fan-mission-1.0.0.tar.gz

# Скопировать каждое расширение в user-level extensions
for ext in fan-mission fan-scheduler fan-super-orchestrator fan-webhook; do
  cp -r "fan-mission/extensions/$ext" ~/.fan/agent/extensions/
done

# Перезапустить FAN
```

---

## Быстрый старт

```
# В FAN TUI — slash-команды расширения fan-mission:
/mission init my-project --template default
/mission start
/mission status

# fan-scheduler подхватывает тики автоматически по cron-секции в MISSION.md
# fan-webhook поднимется на свободном порту и напечатает URL в лог:
#   [fan-webhook] listening on http://localhost:4123
# POST {type: "git-push", payload: {...}} → доставляется в активную миссию как steer

# fan-super-orchestrator порождает дочерние узлы при EPIC-delegation:
#   [fan-super-orchestrator] spawned L1 node: role=backend port=7011
#   [fan-super-orchestrator] spawned L2 node: role=qa     port=7012
```

---

## Конфигурация

Опционально `config.json` в каждой директории расширения:

| Extension | Файл | Что настраивать |
|-----------|------|-----------------|
| `fan-mission` | `~/.fan/agent/extensions/fan-mission/config.json` | Шаблон по умолчанию (`default` / `refactor`), scoring weights, validation ladder |
| `fan-scheduler` | `~/.fan/agent/extensions/fan-scheduler/config.json` | Cron pattern per mission (`RECURRING.md` → scheduler ticks) |
| `fan-super-orchestrator` | `~/.fan/agent/extensions/fan-super-orchestrator/role-config.yaml` | `spawn.excluded_extensions`, `role.<role>.required_extensions` |
| `fan-webhook` | `~/.fan/agent/extensions/fan-webhook/config.json` | Порт webhook-сервера, allowlist источников |

---

## Документация

| Документ | Где |
|----------|-----|
| Гайд по оркестратору | `docs/guides/orchestrator.md` |
| API reference | `docs/guides/api-reference.md` |
| Спецификация runtime-agent | `docs/specs/spec_runtime-agent_2026-04-10.md` |
| Рекурсивный spawn | `docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md` |
| Конфигурация FAN | `docs/guides/configuration.md` |

---

## Что внутри архива

```
fan-mission-1.0.0.tar.gz
└── fan-mission/
    ├── package.json      ← manifest бандла
    ├── DEPLOY.toml       ← deploy manifest
    ├── README.md         ← этот файл
    └── extensions/
        ├── fan-mission/                  (21 .ts + templates/ + package.json)
        ├── fan-scheduler/                (3 .ts + package.json)
        ├── fan-super-orchestrator/       (35 .ts + roles/*.yaml + routes + wiring + package.json)
        └── fan-webhook/                  (4 .ts + package.json)
```

---

## Лицензия

MIT — см. корневой `LICENSE` репозитория FAN.
