# fan-mission

> Bundle для автономных миссий FAN — файловое хранилище состояния, периодические тики, делегирование эпиков в иерархию узлов с рекурсивным spawn (глубина до 4), приём внешних событий через webhook.

**fan-mission** объединяет четыре расширения FAN, которые вместе реализуют полный контур долгоживущей автономной работы: от планировщика тиков и файлового state-store до супер-оркестратора с HTTP-иерархией узлов и webhook-приёмника внешних событий.

---

## Что включено

| Extension | Версия | Что даёт |
|-----------|--------|----------|
| **fan-mission** | 1.0.0 | 7-шаговый цикл миссии (FSM), файловое хранилище (`MISSION.md`, `ROADMAP.md`, `STATE.md`, `BACKLOG.md`, `DECISIONS.md`), тиковый мост к scheduler, 13 шаблонов миссий (`templates/default`, `templates/refactor`), scoring идей, метрики, slash-команды |
| **fan-scheduler** | 1.0.0 | Периодическое пробуждение миссионного контура (setInterval/cron), доставка tick-промпта в `actions.sendMessage` как `followUp` (I4 heartbeat) |
| **fan-super-orchestrator** | 1.0.0 | HTTP-иерархия узлов `fan server`: порождение дочерних узлов, аутентификация, бюджет, журнал дерева (`tree-journal`), рекурсивный spawn с depth-4 и role-aware маршрутизацией (10 role profiles в `roles/*.yaml`) |
| **fan-webhook** | 1.0.0 | Микро-Hono сервер, принимающий POST-запросы от внешних систем (CI, git-push, мониторинг) и маршрутизирующий их как `steer`/`followUp`-сообщения в активную миссию |

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

### Бюджет миссии и дочерних узлов

В бюджетной модели бандла действуют два разных уровня:

| Уровень | Лимит | Где настраивается |
|---------|-------|-------------------|
| **L0 (главный процесс миссии)** | Не ограничен | `budget_tokens` / `budget_usd` в frontmatter `MISSION.md` — информационные поля; enforcement отсутствует. Расход трекается в `.mission-loop.json` (`budgetUsed`) и отображается в mission-widget. Статус `budget_exhausted` остаётся в типах и FSM для обратной совместимости со старыми миссиями, но L0 его больше не выставляет. |
| **L1+ (дочерние узлы fan-super-orchestrator)** | `childBudgetTokens` на ребёнка | `childBudgetTokens` (wire option) → env `FAN_CHILD_BUDGET_TOKENS` → default `1_000_000`. Применяется per-hop и к L1, и к рекурсивно-порождённым L2–L4 (см. `fan-super-orchestrator/index.ts` → `resolveChildBudgetTokens`). |

#### Переменные окружения

| Переменная | Назначение | Default |
|------------|------------|---------|
| `FAN_CHILD_BUDGET_TOKENS` | Лимит токенов на дочерний узел супер-оркестратора. Используется, если wire option `childBudgetTokens` не передан. Невалидные/неположительные значения игнорируются. | `1_000_000` |

#### Программный конфиг (wire option)

```ts
// Владелец узла передаёт childBudgetTokens при инициализации супер-оркестратора.
// Приоритет: wire option > env > default.
import { resolveChildBudgetTokens } from "@fan/fan-super-orchestrator";
const perChildLimit = resolveChildBudgetTokens(opts.childBudgetTokens); // → number
```

#### Поведение `budget_usd`

`budget_usd` в `MISSION.md` остаётся USD-пулом для аллокации детей: super-orchestrator распределяет USD между дочерними узлами, наследуя общий пул. Это поле трактуется как информационное для L0 (сам процесс миссии не ограничен) и как мягкий пул для L1+.

---

### Таймаут runAgent (deprecated)

Per-step таймаут `runAgent` убран (до появления watchdog'а для сабагентов): без него агент не прерывается по таймеру, поэтому невозможны ложные FAILED, при которых следующий промпт миссии утекал в ещё живого агента через followUp. Старый ключ `runagent_timeout_min` в существующих `MISSION.md` игнорируется (attach проходит без ошибок); новые шаблоны его не пишут. Длинные шаги предотвращаются декомпозицией — см. «Размер пунктов ROADMAP».

### Размер пунктов ROADMAP (анти-длинные шаги)

Итерация миссии должна укладываться примерно в 20–30 минут, поэтому пункты ROADMAP делаются атомарными: один пункт — одно сфокусированное изменение, которое можно выполнить и проверить за одну итерацию. Исполнитель получает правило размера (ITEM_SIZE_GUIDANCE в промпте шага): явно крупный пункт он НЕ пытается сделать целиком — дробит его на атомарные проверяемые подпункты, вставляет их в ROADMAP ниже исходного, помечает исходный пункт `[x]` (decomposed) и завершает итерацию; цикл выполняет подпункты по одному. Пункты, которые и так помещаются в одну итерацию, не дробятся — холостых split-итераций нет. Правило не применяется к planning-итерациям, promoted-идеям (у них своя эвристика размера F-22), `[EPIC]`-пунктам (свой путь делегирования) и recurring-пунктам.

### STATE.md и компактизация

`STATE.md` — основной файл хода выполнения миссии. Размер контролируется двухуровневой политикой:

| Порог | Поведение |
|-------|-----------|
| **100 KB** (мягкий) | Плановая компактизация: при смене текущего пункта ROADMAP и при перезапуске/attach миссии старые записи секции «Сделано» переносятся в `ARCHIVE.md`. |
| **150 KB** (жёсткий) | Аварийный каскад: `ARCHIVE.md` → усечение → статус `failed` (если уменьшить не удалось). |

### Пауза вместо аборта

Закрытие или переключение сессии во время работы миссии больше не приводит к `aborted`. Вместо этого миссия переходит в статус `paused`, а текущий тик дорабатывает до конца текущего пункта ROADMAP. При новой сессии или `/mission:resume` миссия возвращается в `active` и тик запускается заново. Явная остановка — только через `/mission:stop` или `fan mission stop`.

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
