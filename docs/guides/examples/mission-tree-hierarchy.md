# Пример: иерархия дерева из 3 L1-узлов

> Демонстрация дерева узлов L0 → 3×L1 с разными манифестами и бюджетами.

## Сценарий

Миссия «Исследование кодовой базы» — L0 координирует 3 направления анализа:

```
L0 (корень, координатор)
├── L1/node-1: Анализ API         ✓  $0.45  tools: [read, grep, bash]
├── L1/node-2: Анализ БД          ✓  $0.30  tools: [read, bash]
│   └── L2/node-2.1: Схема БД     ✓  $0.12  tools: [read]
└── L1/node-3: Анализ тестов       ●  $0.33  tools: [read, bash, grep]
```

## Пакеты работ

### L1/node-1: Анализ API

```json
{
  "task": "Проанализировать REST API: эндпоинты, middleware, аутентификация",
  "correlationId": "mission-uuid/L1/node-1",
  "depth": 1,
  "tokenBudget": 50000,
  "costBudgetUsd": 1.00,
  "toolManifest": ["read", "grep", "bash"],
  "deadline": "2026-08-15T14:00:00Z",
  "maxRetries": 2,
  "context": {
    "parentSummary": "Исследуем кодовую базу для документации",
    "relevantFiles": ["packages/api-gateway/src/", "packages/coding-agent/src/cli/"]
  }
}
```

### L1/node-2: Анализ БД

```json
{
  "task": "Проанализировать схему базы данных: модели, миграции, связи",
  "correlationId": "mission-uuid/L1/node-2",
  "depth": 1,
  "tokenBudget": 40000,
  "costBudgetUsd": 0.80,
  "toolManifest": ["read", "bash"],
  "deadline": "2026-08-15T14:00:00Z",
  "maxRetries": 2,
  "context": {
    "relevantFiles": ["packages/db/", "packages/db/prisma/"]
  }
}
```

### L2/node-2.1: Схема БД (вложенный узел)

L1/node-2 декомпозирует свою задачу и порождает L2:

```json
{
  "task": "Построить диаграмму связей между моделями Prisma",
  "correlationId": "mission-uuid/L2/node-2.1",
  "depth": 2,
  "tokenBudget": 15000,
  "costBudgetUsd": 0.30,
  "toolManifest": ["read"],
  "deadline": "2026-08-15T13:00:00Z",
  "maxRetries": 1
}
```

### L1/node-3: Анализ тестов

```json
{
  "task": "Проанализировать покрытие тестами: какие модули покрыты, какие нет",
  "correlationId": "mission-uuid/L1/node-3",
  "depth": 1,
  "tokenBudget": 45000,
  "costBudgetUsd": 0.90,
  "toolManifest": ["read", "bash", "grep"],
  "deadline": "2026-08-15T14:00:00Z",
  "maxRetries": 2
}
```

## Бюджет

**Формула аллокации** (при порождении L1 из L0):

```
remaining = 300000 токенов (общий бюджет миссии)
planned_children = 3
allocation = min(0.8 × 300000 / 3, 30000) = min(80000, 30000) = 30000
```

Каждый L1-узел получает 30 000 токенов. Резерв 20% (60 000) остаётся у L0 на синтез.

**Фактический расход:**

| Узел | Аллокация | Расход | Статус |
|------|-----------|--------|--------|
| L1/node-1 | 30 000 | 25 000 ($0.45) | ✓ completed |
| L1/node-2 | 30 000 | 18 000 ($0.30) | ✓ completed |
| L2/node-2.1 | 15 000 | 8 000 ($0.12) | ✓ completed |
| L1/node-3 | 30 000 | 20 000 ($0.33) | ● active |
| **Итого** | **105 000** | **71 000 ($1.20)** | 24% бюджета |

## Tree-journal (фрагмент)

```jsonl
{"timestamp":"2026-08-15T10:00:00Z","event":"spawn","nodeId":"L1/node-1","parentId":"L0","depth":1,"port":7001,"correlationId":"mission-uuid/L1/node-1"}
{"timestamp":"2026-08-15T10:00:01Z","event":"spawn","nodeId":"L1/node-2","parentId":"L0","depth":1,"port":7002,"correlationId":"mission-uuid/L1/node-2"}
{"timestamp":"2026-08-15T10:00:02Z","event":"spawn","nodeId":"L1/node-3","parentId":"L0","depth":1,"port":7003,"correlationId":"mission-uuid/L1/node-3"}
{"timestamp":"2026-08-15T10:05:00Z","event":"complete","nodeId":"L1/node-1","usage":{"tokens":25000,"usd":0.45}}
{"timestamp":"2026-08-15T10:03:00Z","event":"spawn","nodeId":"L2/node-2.1","parentId":"L1/node-2","depth":2,"port":7004,"correlationId":"mission-uuid/L2/node-2.1"}
{"timestamp":"2026-08-15T10:06:00Z","event":"complete","nodeId":"L2/node-2.1","usage":{"tokens":8000,"usd":0.12}}
{"timestamp":"2026-08-15T10:07:00Z","event":"complete","nodeId":"L1/node-2","usage":{"tokens":18000,"usd":0.30}}
```

## Наблюдение

```bash
# CLI
fan mission tree codebase-research
# Mission: codebase-research
# Status:  active
# ├── L0 (root) ● $0.15
# │   ├── L1/node-1 ✓ $0.45
# │   ├── L1/node-2 ✓ $0.30
# │   │   └── L2/node-2.1 ✓ $0.12
# │   └── L1/node-3 ● $0.33
# └── Total: $1.20 / $5.00 (24%)

# REST API
curl -H "Authorization: Bearer <token>" \
  http://localhost:3456/api/missions/codebase-research/tree

# Dashboard — компонент <mission-tree> обновляется через WS mission_event
```

## Манифесты и безопасность

Обратите внимание на различие манифестов:

- **L1/node-1** (API): `["read", "grep", "bash"]` — может искать по коду и запускать команды
- **L1/node-2** (БД): `["read", "bash"]` — только чтение + команды
- **L2/node-2.1** (схема): `["read"]` — **только чтение**, не может писать или выполнять команды
- **L1/node-3** (тесты): `["read", "bash", "grep"]` — может запускать тесты

Если L2/node-2.1 попытается вызвать `bash` — запрос будет отклонён на уровне
аргументов `fan server --tools read` (инструмент не зарегистрирован в сессии).
