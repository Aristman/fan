# Архитектура супер-оркестратора FAN v2 (depth-4)

> **Статус:** locking — все решения финальные, согласованы 2026-08-20.
> **Заменяет:** частичную depth-2 логику в `extensions/fan-super-orchestrator/index.ts`.
> **Контекст:** depth-2 работает (48/48 фич + F-48.5, бэклог #16–#39); depth-3+4 — новое.
> **Scope:** архитектура, контракты, фазы реализации. Конкретные PR-описания — в фазах.

---

## 1. Обзор и цели

Depth-4 архитектура — рекурсивная иерархия супер-оркестраторов с оркестраторами-sink'ами.
Каждый уровень декомпозиции — отдельный процесс (`fan server`), спавнящийся через
`process-manager`. Оркестратор — терминальный узел: исполняет работу через in-session
workers (`delegate_task`), не порождает новых узлов дерева.

**Три роли:**

- **Coordinator** (d=0) — UI, состояние миссии, ROADMAP, планировщик. Единственный экземпляр.
- **Super-Orchestrator** (d=1..4) — декомпозиция work-package, верификация поддерева.
- **Orchestrator** (d=2..5) — разбиение пакета на задачи, спавн in-session workers. Sink в дереве.

**Текущее состояние (depth-2):**

- 48 функций реализованы (этапы 0–3, коммиты `dcdde97`..`22df4a1`).
- 716 тестов `fan-super-orchestrator` + phase-gates A3/B3/C3.
- Бэклог #16–#39: transport-bug (Block-4), PID-коллизии, health-check gap, event-gap при reconnect.
- Ralph-loop (S1–S7) завершён: fresh-session per iteration, 808 тестов fan-mission.

**Цели depth-4:**

1. Рекурсивная декомпозиция до 4 уровней Super-Orch ниже Coordinator.
2. Каталог ролей с наследованием и трёхслойным приоритетом (проектный > глобальный > дефолтный).
3. Пирамида ширины 8/6/4/2 с абсолютными потолками 12/10/8/4.
4. Lineage-эскалация с walk-up протоколом и orphan-report storage.
5. Встроенная верификация поддерева (`verify_subtree`) на каждом уровне.

---

## 2. Дерево ролей

### 2.1 Роли

| Роль | Depth | Назначение | Кого спавнит |
|---|---|---|---|
| Coordinator | 0 | UI, mission state, ROADMAP, scheduler | Super-Orch (d=1) |
| Super-Orchestrator | 1..4 | Декомпозирует work-package; верифицирует своё поддерево | Super-Orch (d+1) или Orch (d+1) |
| Orchestrator | 2..5 | Разбивает пакет на задачи; спавнит in-session workers | in-session workers через `delegate_task` (без изменений) |

Workers — in-session subagent'ы, не узлы дерева. Depth не увеличивают.
Порождаются через `delegate_task` (текущее поведение `fan-orchestrator`, обкатано на depth-2).

### 2.2 Инварианты

- Coordinator — один, всегда d=0.
- Depth limit: 4 уровня Super-Orch ниже Coordinator (d=1..d=4).
- На d=4 Super-Orch спавнит ТОЛЬКО Orchestrator (d=5+ запрещён лимитом).
- Orchestrator — sink в дереве узлов. НЕ спавнит новые узлы.
- Каждый Super-Orch верифицирует СВОЁ поддерево (§7).
- `HARD_DEPTH_LIMIT = 12` (инфраструктурный предохранитель, `depth-width-guard.ts`) остаётся как аварийный стоп.

### 2.3 Форма дерева

**Плоская миссия (2 домена):**

```
Coordinator (d=0)
└── Super-Orch d=1 (pm) — декомпозирует
    ├── Orch d=2 (research)
    │   ├── worker: парсинг UIDs
    │   └── worker: классификация
    └── Orch d=2 (devops)
        └── worker: POST sendMessage
```

**Трёхдоменный признак (depth 3):**

```
Coordinator (d=0)
└── Super-Orch d=1 (pm)
    ├── Super-Orch d=2 (architect)
    │   ├── Orch d=3 (backend)
    │   │   ├── worker: API endpoint
    │   │   └── worker: миграция БД
    │   └── Orch d=3 (frontend)
    │       └── worker: компонент UI
    └── Orch d=2 (qa)
        ├── worker: unit-тесты backend
        └── worker: E2E-сценарий
```

**Ralph-loop (итеративный, depth 4):**

```
Coordinator (d=0)
└── Super-Orch d=1 (pm)
    └── Super-Orch d=2 (architect)
        └── Super-Orch d=3 (backend)
            └── Orch d=4 (qa)
                ├── worker: прогон тестов
                └── worker: отчёт о регрессии
```

**Ширина через глубину (кейс размножения):**

```
Coordinator (d=0)
└── Super-Orch d=1 (pm) — 8 детей
    ├── Super-Orch d=2 — 6 детей         │
    │   ├── Orch d=3 — 4 workers         │ рабочая ширина
    │   ├── Orch d=3 — 4 workers         │ уменьшается
    │   ├── ...                           │ с глубиной
    │   └── Orch d=3 — 4 workers         │
    ├── Super-Orch d=2 — 6 детей         │
    │   └── ...                           │
    └── Super-Orch d=2 — 6 детей         │
        └── ...                           │
```

Пиковая параллельность: 8 × 6 × 4 = 192 in-session workers на уровне d=3.

---

## 3. Каталог ролей

### 3.1 Расположение (3 слоя, приоритет сверху вниз)

1. **Проектный:** `<project_root>/roles/*.yaml` — переопределение под проект.
2. **Глобальный:** `~/.fan/agent/roles/*.yaml` — пользовательские профили.
3. **Дефолтный:** `extensions/fan-super-orchestrator/roles/*.yaml` — shipped в репо супер-оркестратора.

Установка расширения копирует только дефолтный каталог в
`~/.fan/agent/extensions/fan-super-orchestrator/roles/`. Глобальный слой создаётся
пользователем вручную.

Загрузка: при старте супер-оркестратора — скан всех трёх слоёв, merge по `id`
с приоритетом проектный > глобальный > дефолтный. Дубликаты `id` в пределах
одного слоя — конфигурационная ошибка, halt с понятным сообщением.

### 3.2 Схема role.yaml

```yaml
id: string              # уникальный ID, lowercase, kebab-case
name: string            # человекочитаемое имя
description: string     # краткое описание
allowed_depths: int[]   # [1..4], валидация при спавне
extends: string         # ID профиля-родителя (опционально)

system_prompt: string   # многострочный, грузится как system message

decision_style:
  decompose: enum       # none | conservative | balanced | aggressive
  verify: enum          # none | permissive | balanced | strict

escalation_triggers: string[]  # условия для эскалации наверх

verification_approach: string  # как профиль верифицирует свою работу

default_tools: string[]        # инструменты по умолчанию
default_extensions: string[]   # id расширений по умолчанию
```

### 3.3 Наследование (extends)

- Наследник переопределяет любое поле.
- Не указанные поля берутся из родителя (глубокий merge для вложенных объектов).
- Цепочка `extends` ≤ 3 уровня.
- Циклы детектируются при загрузке — конфигурационная ошибка, halt.

### 3.4 Стартовый каталог (10 профилей)

| id | name | allowed_depths | назначение |
|---|---|---|---|
| pm | Project Manager | [1] | Верхний уровень: декомпозиция миссии, координация доменов |
| architect | Architect | [1, 2] | Архитектурные решения, выбор стека, разбиение на модули |
| research | Researcher | [2, 3] | Поиск, разведка, чтение, анализ |
| backend | Backend Engineer | [2, 3, 4] | Серверный код, API, БД |
| frontend | Frontend Engineer | [2, 3, 4] | UI, компоненты, стили |
| mobile | Mobile Engineer | [2, 3, 4] | iOS/Android |
| qa | QA / Verifier | [2, 3, 4] | Тесты, E2E, регрессии |
| refactor | Refactor Engineer | [2, 3] | Реструктуризация кода |
| docs | Documentation Engineer | [3, 4] | Документация, спеки |
| devops | DevOps | [2, 3, 4] | CI/CD, инфра, деплой |

---

## 4. Spawn protocol

### 4.1 Расширенный work-package

```ts
interface SpawnWorkPackage {
  // Существующие (depth-2, из work-package.ts):
  task: string
  correlationId: string
  tokenBudget: number
  costBudgetUsd: number
  toolManifest: string[]
  deadline: string

  // Новые (depth-4):
  role: "super-orchestrator" | "orchestrator"
  role_profile: string                  // id из каталога ролей
  parent_correlation_id: string
  parent_url: string                    // для эскалации
  parent_token: string                  // auth для parent
  parent_report_id: string              // генерируется parent'ом (UUID)
  lineage: Array<{
    correlationId: string
    url: string
    token: string
    role: string
    role_profile?: string
  }>
  depth: number                         // 1..4
}
```

### 4.2 Поток спавна

1. Parent (Super-Orch) принимает решение о декомпозиции.
2. Для каждого ребёнка parent формирует work-package:
   - выбирает `role` (super-orch | orch);
   - выбирает `role_profile` (учитывая `allowed_depths`);
   - считает `depth = parent_depth + 1`;
   - генерирует `parent_report_id` (UUID);
   - добавляет себя в конец `lineage` (свои URL, token, role, role_profile).
3. Parent вызывает `canSpawnBatch(new_depth, batch_size, pyramid)` — проверка лимитов.
4. Если ОК — спавнит child через `process-manager` (`fan server`).
5. Child стартует, валидирует lineage, приступает к работе.

### 4.3 Валидации

- `depth ≤ 4` (рабочий лимит).
- `role_profile` существует в каталоге.
- `depth ∈ role_profile.allowed_depths`.
- `batch_size ≤ working_width[depth]`.
- `batch_size ≤ max_width[depth]`.
- Orchestrator никогда не спавнит узел (sink).

---

## 5. Пирамида ширины

| Уровень | working_width | max_width |
|---|---|---|
| d=1 (top Super-Orch) | 8 | 12 |
| d=2 | 6 | 10 |
| d=3 | 4 | 8 |
| d=4 (leaf Super-Orch) | 2 | 4 |

`working_width` — рекомендация планирования (сколько детей стоит заводить).
`max_width` — абсолютный потолок per-batch (защита от жирных пакетов).

### Orchestrator concurrency

In-session workers через `delegate_task` — текущее поведение, новых лимитов нет.
Обкатано на depth-2 (fan-orchestrator, 186 тестов).

---

## 6. Lineage escalation

### 6.1 Структура lineage

Child при старте получает `lineage` — список предков с URL+token.
Child добавляет свой entry (формирует полный lineage для будущих детей).

### 6.2 Персистентность

`lineage`, `parent_url`, `parent_token`, `parent_report_id` дублируются
в `.mission-loop.json` child'а. При rotation/restart — восстановление из файла.

### 6.3 Walk-up протокол

```
1. child → POST report на parent_url/parent_token (с parent_report_id)
   ├── 2xx + ack → завершение
   └── timeout / 5xx / connection refused
       ↓
2. child → POST report на lineage[len-2] (grandparent)
   ├── 2xx + ack → завершение
   └── fail
       ↓
3. ... до Coordinator (lineage[0])
   ├── 2xx + ack → завершение
   └── fail
       ↓
4. child пишет orphan-report, завершается
```

Per-hop timeout: 30 сек. Max hops = depth+1 (вся цепочка).
После fail на каждом шаге — backoff 1 сек.

### 6.4 Идемпотентность

Каждый отчёт имеет `parent_report_id` (генерируется parent'ом).
Получатель проверяет наличие `report_id` в обработанных.
Если уже видел — игнор (эскалация дошла дважды). Если нет — обработка + ack.

### 6.5 Orphan-report storage

Persistent + recoverable:

- Child пишет orphan-report в `<mission_dir>/orphan-reports/<report_id>.json`:

```json
{
  "report_id": "uuid",
  "child_correlation_id": "uuid",
  "child_role": "orchestrator | super-orchestrator",
  "child_role_profile": "backend | ...",
  "attempted_ancestors": ["parent_id", "grandparent_id", "..."],
  "last_error": "connection refused | timeout | ...",
  "report": {},
  "results": {},
  "timestamp": "ISO-8601",
  "mission_id": "uuid"
}
```

- Атомарная запись (write to `.tmp`, rename).
- На `session_start` любого узла миссии — скан `orphan-reports/`.
  Если нашлись — попытка доставить (предок теперь доступен) или
  пометить «needs human review».
- На `mission_rejoin` (Coordinator) — полный скан всех mission-dirs.
- Параллельный index: `<mission_dir>/orphan-reports/_index.json`
  для быстрого листинга без скан-всего.

---

## 7. Верификация

### 7.1 verify_subtree — встроенный tool

Каждый Super-Orchestrator имеет tool `verify_subtree(reports: NodeReport[]): VerificationResult`.

### 7.2 Когда вызывается

После агрегации отчётов своих детей, ДО перехода к следующей фазе
или финализации. Вызов обязателен (не опциональный) — гарантирует
верификацию на каждом уровне.

### 7.3 Что проверяет

- Все задачи выполнены (нет дыр в отчётах).
- Интерфейсы между отчётами согласованы (если дети делали смежные части).
- Бюджет не превышен.
- Качество соответствует `role_profile.verification_approach`.
- Нет orphan-отчётов среди текущего батча (если есть — флаг).

Если `verify_subtree` возвращает `issues[]` — Super-Orch решает:
retry / re-plan / escalate.

### 7.4 Рекурсивность

Верификация встроена в поток Super-Orch. На каждом уровне иерархии
свой `verify_subtree`. Сверху-вниз: отчёт о верификации включается
в отчёт parent'у.

---

## 8. Use cases

### A. Flat mission (gmail-watch) — depth 2

```
Coordinator (d=0)
│   mission: gmail-watch
│   ROADMAP: [проверить почту, ответить на письма]
│
└── Super-Orch d=1 (pm)
    │   role_profile: pm
    │   decompose: balanced
    │
    ├── Orch d=2 (research)
    │   │   task: "проверить входящие, классифицировать"
    │   │
    │   ├── worker: парсинг UID'ов
    │   └── worker: классификация по важности
    │
    └── Orch d=2 (devops)
        │   task: "отправить ответы через API"
        │
        └── worker: POST sendMessage
```

### B. Three-domain feature — depth 3

```
Coordinator (d=0)
│   mission: add-user-dashboard
│
└── Super-Orch d=1 (pm)
    │   decompose: balanced, 2 ребёнка
    │
    ├── Super-Orch d=2 (architect)
    │   │   role_profile: architect
    │   │   decompose: conservative
    │   │
    │   ├── Orch d=3 (backend)
    │   │   │   task: "API /dashboard + миграция"
    │   │   │
    │   │   ├── worker: GET /api/dashboard
    │   │   └── worker: CREATE TABLE dashboard_data
    │   │
    │   └── Orch d=3 (frontend)
    │       │   task: "компонент Dashboard"
    │       │
    │       ├── worker: dashboard.tsx
    │       └── worker: стили + адаптив
    │
    └── Orch d=2 (qa)
        │   role_profile: qa
        │   task: "тесты нового функционала"
        │
        ├── worker: unit-тесты API
        └── worker: E2E-сценарий dashboard
```

### C. Ralph-loop in depth — depth 4, итеративный

```
Coordinator (d=0)
│   mission: refactor-auth-module
│   session_mode: fresh
│
└── Super-Orch d=1 (pm)
    │   role_profile: pm
    │
    └── Super-Orch d=2 (architect)
        │   role_profile: architect
        │
        └── Super-Orch d=3 (backend)
            │   role_profile: backend
            │   task: "итерация рефакторинга"
            │
            └── Orch d=4 (qa)
                │   role_profile: qa
                │   task: "проверить рефакторинг"
                │
                ├── worker: прогон тестов
                └── worker: отчёт о регрессии
```

Итерация завершается → fresh-session rotation → новая итерация с чистой сессией.
Depth-4 позволяет глубоко специализированному Super-Orch (backend) контролировать
свой домен через Orch-sink (qa).

### D. Width via depth — depth 4, размножение ширины

```
Coordinator (d=0)
│   mission: mass-migration (500 файлов)
│
└── Super-Orch d=1 (pm) — working_width=8
    │
    ├── Super-Orch d=2 (architect) — working_width=6
    │   │
    │   ├── Orch d=3 (backend) — 4 workers
    │   │   ├── worker: миграция модуля A
    │   │   ├── worker: миграция модуля B
    │   │   ├── worker: миграция модуля C
    │   │   └── worker: миграция модуля D
    │   │
    │   ├── Orch d=3 (backend) — 4 workers
    │   │   ├── worker: миграция модуля E
    │   │   ├── worker: миграция модуля F
    │   │   ├── worker: миграция модуля G
    │   │   └── worker: миграция модуля H
    │   │
    │   └── ... (ещё 4 Orch по 4 workers)
    │
    ├── Super-Orch d=2 (architect) — working_width=6
    │   └── ... (6 Orch × 4 workers)
    │
    └── ... (ещё 6 Super-Orch d=2)
```

Пиковая параллельность: 8 (d=1) × 6 (d=2) × 4 (workers d=3) = **192 workers** одновременно.
Каждый Super-Orch d=2 верифицирует своих 6 детей через `verify_subtree`.

### E. Partial failure с walk-up эскалацией

```
Coordinator (d=0)
│
└── Super-Orch d=1 (pm)
    │
    ├── Super-Orch d=2 (architect)     ← parent для Orch d=3
    │   │
    │   └── Orch d=3 (backend)         ← child, parent_url = d=2
    │       │   lineage: [d=0, d=1, d=2]
    │       │
    │       └── worker: миграция БД    ← КРАХ
    │
    └── Orch d=2 (qa)                  ← работает нормально
        └── worker: тесты
```

**Sequence:**

```
Orch d=3 (backend)
  │
  ├─ 1. POST report → Super-Orch d=2 (parent_url)
  │     └─ timeout 30s (parent crashed)
  │
  ├─ 2. POST report → Super-Orch d=1 (lineage[len-2])
  │     └─ 200 OK + ack ✓
  │
  └─ завершение (эскалация на d=1 успешна)
```

Если бы и d=1 был недоступен:

```
Orch d=3 (backend)
  │
  ├─ 1. POST → d=2: timeout 30s
  ├─ 2. POST → d=1: connection refused
  ├─ 3. POST → d=0 (Coordinator, lineage[0]): timeout 30s
  │
  └─ 4. orphan-report → <mission_dir>/orphan-reports/<report_id>.json
        └─ _index.json обновлён
```

На следующем `session_start` Coordinator сканирует `orphan-reports/`,
находит недоставленный отчёт, пытается доставить снова или помечает
«needs human review».

---

## 9. Фазы реализации

| Phase | Название | Блокирует | Зависит от |
|---|---|---|---|
| **0** | **Transport fix (Bun server: WS + Hono compat) + transport smoke test** | **A, B, C, D, E, F, H** | — |
| A | SPEC (этот документ) | B, C | 0 |
| B | Role loader (YAML schema, layered, extends) | D | A |
| C | Width pyramid 8/6/4/2 + max 12/10/8/4 + port registry init | D | A |
| D | Spawn protocol (role, role_profile, lineage, depth + port allocation) | E, F | B, C |
| E | Lineage escalation (walk-up + orphan-reports + fail-fast) | H | D |
| F | verify_subtree tool | H | D |
| H | Integration test (depth-4 flow с mock children) | merge | E, F |

**Зависимости:**

```
0 ──→ A ──→ B ──→ D ──→ E ──→ H ──→ merge
        └──→ C ──↗   └──→ F ──↗
```

Phase 0 (transport fix) — pre-requisite для всех остальных фаз.
Бэклог #39 (b): Bun health-check отдаёт fallback-страницу вместо JSON —
транспортный баг, блокирует Block-4 (EPIC delegation e2e).
Без зелёного transport smoke test (§13.3) Phase B-H не стартуют.

---

## 10. Открытые вопросы / будущее

- **Observer** — отдельный узел, если `verify_subtree` не справится с E2E координированием.
- **Per-role spawn limits** — если узкоспециализированные профили начнут конкурировать за ресурсы.
- **Cross-mission coordination** — общий Coordinator для нескольких миссий.
- **Динамическое расширение каталога** через FAN Store (после стабилизации v2).
- **Динамическая балансировка ширины** по фактическому потреблению (сейчас статическая пирамида).
- **Hot-reload каталога ролей** без перезапуска супер-оркестратора.
- **Migration существующих миссий** при включении port registry — однократный скан активных fan.exe + запись их PID/портов в реестр. Без миграции — port conflicts при первом depth-4 спавне в существующих миссиях.
- **Cross-process port visibility** — реестр один на пользователя, но несколько fan.exe процессов одновременно. Нужен file-locking (flock) или SQLite-based registry вместо JSON-файла для concurrent safety.
- **Port range exhaustion** — если миссия исчерпала свой range (depth-4 × 8 = больше 100) — нужен overflow в следующий range (расширяемый pool).
- **Webhook port isolation** — webhook трафик может быть sensitive (Telegram tokens); проверять что webhook range не пересекается с API range при allocation.

---

## 11. Глоссарий

| Термин | Определение |
|---|---|
| **Coordinator** | d=0, UI + планирование. Единственный экземпляр на миссию. |
| **Super-Orchestrator** | Узел декомпозиции и делегирования. Depth 1..4. Верифицирует своё поддерево. |
| **Orchestrator** | Sink-узел. Исполняет через in-session workers. Не спавнит узлы. |
| **Worker** | In-session subagent (не узел дерева). Depth не увеличивает. |
| **Lineage** | Цепочка предков с URL+token для эскалации. |
| **Role profile** | Именованный профиль из каталога ролей (YAML). |
| **Orphan report** | Отчёт ребёнка, не доставленный ни одному предку. Сохраняется в `orphan-reports/`. |
| **Verification subtree** | Рекурсивная проверка своего поддерева Super-Orch'ом через `verify_subtree`. |
| **Work package** | Пакет заданий: task, лимиты, lineage, depth, role. |
| **Walk-up** | Протокол эскалации отчёта вверх по lineage при недоступности parent. |
| **Pyramid width** | Убывающая ширина на каждом уровне: 8/6/4/2 (working), 12/10/8/4 (max). |
| **Port registry** | Глобальный файл `~/.fan/agent/port-registry.json` с выделенными диапазонами и занятыми портами. |
| **Mission port range** | Диапазон портов (API + webhook), выделенный миссии при init. |
| **Orphan PID** | PID процесса, оставшийся в реестре после crash без cleanup. |
| **Transport smoke test** | E2E-проверка HTTP/WS под Bun-binary, gate для Phase 0. |

---

## 12. Распределение портов

### 12.1 Проблема

- API: пул 7001-7099 (99 портов, глобально на ВСЕ миссии).
- Webhook: скан 9090-9110 (20 портов, глобально).
- При depth-4 (десятки одновременных процессов на миссию, несколько миссий параллельно) — упираемся в порты.
- При перезапуске процессов — порт может быть ещё занят предыдущим инстансом (orphan PID).

### 12.2 Стратегия: per-mission ranges + глобальный реестр

| Ресурс | Стратегия | Диапазон |
|---|---|---|
| API порт | Per-mission range из глобального пула | 7001-19999 (~128 миссий × 100 портов) |
| Webhook порт | Per-mission range из глобального пула | 9090-11999 (~128 миссий × 20 портов) |
| OS PID | OS-назначение, реестр для dedup | — |
| Health endpoint | = API port (`/api/health`) | — |

### 12.3 Глобальный реестр

Файл: `~/.fan/agent/port-registry.json`.

```json
{
  "version": 1,
  "api_pools": {
    "mission-uuid-1": { "start": 7001, "end": 7099, "allocated": [7001, 7002] },
    "mission-uuid-2": { "start": 7101, "end": 7199, "allocated": [7101] }
  },
  "webhook_pools": {
    "mission-uuid-1": { "start": 9090, "end": 9109, "allocated": [9090] },
    "mission-uuid-2": { "start": 9190, "end": 9209, "allocated": [] }
  },
  "orphan_pids": [12345, 67890]
}
```

Атомарная запись (write to `.tmp`, rename).

### 12.4 Lifecycle

| Событие | Действие |
|---|---|
| `mission init` | Выделить range из глобального пула, записать в реестр |
| `fan server --port N` спавн | PortPool проверяет реестр, помечает порт занятым |
| `fan server` clean shutdown (SIGTERM) | Cleanup handler снимает порт с регистрации |
| `fan server` SIGKILL / orphan | На следующем старте — сканирование `orphan_pids`, проверка `kill -0`, освобождение мёртвых |
| `mission end` (завершение / archive) | Освободить range в реестре (пометить available для следующей миссии) |

### 12.5 Per-process pool

Существующий PortPool в `extensions/fan-super-orchestrator/port-pool.ts` расширяется:

- `portRangeStart`/`portRangeEnd` уже есть, default 7001/7099.
- В depth-4 конфигурации передаётся диапазон миссии (например 7101-7199).
- Внутри миссии — линейный поиск свободного порта в её диапазоне.

### 12.6 Webhook port (fan-webhook)

Текущее: `start: 9090` (хотя сканирует 9090-9110). Заменить:

- Принимать `port` из PortPool (mission webhook range).
- Если не задан → запросить у реестра следующий свободный в mission webhook range.
- Логировать фактический занятый порт (для диагностики).

### 12.7 Что меняется в фазах

| Фаза | Изменение |
|---|---|
| B (role loader) | Без изменений |
| C (width pyramid) | + port registry init в mission init |
| D (spawn protocol) | При спавне — port allocation через реестр (не рандом) |
| G (transport) | + webhook port fix |

---

## 13. Транспортный слой (pre-requisite)

### 13.1 Проблема (Block-4 из backlog #39)

Текущая Bun-ветка `packages/api-gateway/src/http-server.ts:475-485`:

```ts
const server = bunGlobal.serve({ port, hostname: host, fetch: app.fetch });
```

Сломано на скомпилированном бинаре:

- WS-обработчик не прикрепляется (он только в Node-ветке через `ws` package).
- Hono-ответы несовместимы с этим Bun (`/api/health` отдаёт 200 с fallback-страницей «Welcome to Bun!»).

Итог: дочерний узел по WebSocket недостижим. Depth-2+ делегирование невозможно на production-бинаре.

### 13.2 Решение (Phase G → Phase 0)

**Вариант A (рекомендуемый):** убрать Bun-ветку, всегда использовать `@hono/node-server` + `ws`. Bun поддерживает `node:http`; `ws` package работает под Bun.

Изменения в `packages/api-gateway/src/http-server.ts`:

- Удалить `if (hasBun)` ветку.
- Всегда использовать `serve({fetch: app.fetch, port, hostname: host})` из `@hono/node-server`.
- Под Bun (fan.exe) и под Node (dev) — один путь.

**Проверки:**

- `ws` и `@hono/node-server` зашиты в бинарь при `bun build --compile` (динамический import).
- Smoke test под Bun-binary (см. §13.3).

### 13.3 Transport smoke test (Phase 0 gate)

Без зелёного smoke — Phase 0 не закрыта, Phase A-H не стартуют.

```ts
test("depth-4 transport smoke (Bun binary)", async () => {
  const parent = await spawnFanServer({ port: 7001 });
  await waitForReady(parent, 30_000);

  // HTTP endpoint returns real JSON, not Bun fallback
  const health = await fetch("http://127.0.0.1:7001/api/health");
  const body = await health.json();
  assert(body.status === "ok");
  assert(health.headers.get("content-type")?.includes("application/json"));

  // WS upgrade works
  const ws = new WebSocket("ws://127.0.0.1:7001/api/ws");
  await once(ws, "open");
  ws.close();

  await parent.kill();
});
```

Прогон под `bun` runtime (не только Node). Проверяет реальный бинарь fan.exe.

### 13.4 Webhook port fix

В `extensions/fan-webhook/index.ts`:

- Убрать hardcoded `9090`.
- Принимать `port` из opts или реестра.
- Default scan 9090-9110 → расширить до mission webhook range.

---

## 14. Диагностика (обязательное требование)

### 14.1 Видимые сообщения в чат

Каждый узел при `session_start` шлёт в чат:

```
[<correlation_id>] <role>:<role_profile> initialized, depth=N, lineage_len=M
```

При входе в handler (mission_delegate):

```
[handler:<correlation_id>] received packages=3, role_profile=backend
```

При error-reply:

```
[<correlation_id>] delegation failed: <error message>
attempted escalation to grandparent=<correlation_id>
```

### 14.2 Extension health-check

На `session_start`:

- Smoke-проверка критичных init-функций (initCircuit для super-orch).
- Если упало → видимая ошибка в чат + halt с actionable message («super-orchestrator не загрузился — проверьте ~/.fan/agent/extensions/fan-super-orchestrator/»).

### 14.3 Логи в debug-консоль

При каждом входе в handler:

```ts
console.error(`[fan-super-orchestrator] delegate handler entered: corr=${id}, packages=${n}`);
```

При каждой ошибке:

```ts
console.error(`[fan-super-orchestrator] error in handler:`, err);
```

---

## 15. Fail-fast

### 15.1 Per-hop timeout

- Timeout на parent hop: 30 сек.
- На каждом fail hop — backoff 1 сек, переход к следующему предку.
- НЕ ждать 30 мин на parent перед эскалацией.

### 15.2 Mission-loop timeout (fan-mission)

- Если tick застрял на `await delegation reply` > 2 минут → запись в STATE.md blockers + видимое предупреждение в чат.
- 2 минуты — настраиваемый параметр `DELEGATION_FAIL_FAST_MS`.

### 15.3 Максимальное время на цепочку

- Per-hop 30 сек × max hops (depth+1 ≤ 5) = 150 сек ≈ 2.5 мин.
- С backoff (1 сек × 4 hops = 4 сек) ≈ 2.5 мин суммарно.
- Если все hops exhausted — orphan-report + chat warning.

**Сравнение с текущим:** текущая схема даёт до 30 мин × N hops (1.5-2 часа на depth-4). Новая — 2.5 мин + orphan-report.
