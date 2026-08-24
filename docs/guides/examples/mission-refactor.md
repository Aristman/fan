# Пример: миссия рефакторинга с EPIC-делегированием

> Полная миссия рефакторинга auth middleware с делегированием в дерево узлов.

## 1. Инициализация

```bash
fan mission init auth-refactor --template refactor
```

## 2. MISSION.md

```yaml
---
mission_id: f47ac10b-58cc-4372-a567-0e02b2c3d479
created: 2026-08-15T10:00:00Z
status: active
metric_type: code_complexity_reduction
metric_command: npx complexity-report --format json
budget_tokens: 300000
budget_usd: 5.00
max_depth: 3
max_width: 3
template: refactor
---

# Refactor Mission: auth-refactor

## Goal
Снизить сложность auth middleware и выделить token validation в отдельный модуль.

## Scope
Только рефакторинг — без новых функций, без изменения поведения.

## Unbreakable Metric
Все существующие тесты должны оставаться зелёными (green-to-green).

## Constraints
- Без изменений публичного API
- Каждый шаг атомарный и обратимый
- Манифест инструментов для L2: только read + bash (без write)
```

## 3. ROADMAP.md

```markdown
# Refactor Roadmap

- [ ] Проанализировать текущую сложность auth middleware
- [ ] [EPIC] Выделить token validation в отдельный модуль
  - Декомпозиция: 3 подзадачи (парсинг, валидация, refresh)
  - Манифест L1: ["read", "write", "edit", "bash"]
  - Манифест L2: ["read", "bash"] (только чтение и тесты)
- [ ] Обновить импорты во всех зависимых модулях
- [ ] Написать интеграционные тесты на выделенный модуль
- [ ] Проверить: все тесты зелёные, сложность снижена
```

## 4. Запуск и наблюдение

```bash
# Запуск миссии
fan mission start

# Наблюдение за деревом (после EPIC-делегирования)
fan mission tree auth-refactor

# Вывод:
# Mission: auth-refactor
# Status:  active
# ├── L0 (root) ● $0.15
# │   ├── L1/node-1 ✓ $0.45  (парсинг JWT)
# │   ├── L1/node-2 ✓ $0.30  (валидация)
# │   │   └── L2/node-2.1 ✓ $0.08  (тесты валидации)
# │   └── L1/node-3 ● $0.22  (refresh tokens)
# └── Total: $1.20 / $5.00 (24%)

# JSON-формат для скриптов
fan mission tree auth-refactor --format json

# Статус миссии
fan mission status
```

## 5. Прерывания

```bash
# Оператор хочет направить миссию
/mission:steer "Сосредоточься на безопасности, не на производительности"

# Агент задал вопрос (DECIDE)
/mission:decide "Используем RS256 вместо HS256 для signing"

# Пауза для ручной проверки
/mission:pause

# После проверки — возобновление
/mission:resume
```

## 6. Результат

После завершения всех пунктов ROADMAP миссия переходит в статус `completed`.
Метрики в `metrics.jsonl`:

```jsonl
{"iteration":1,"tokensIn":12000,"tokensOut":3500,"durationMs":45000,"status":"completed","promiseTag":"COMPLETE","verificationResult":"passed"}
{"iteration":2,"tokensIn":25000,"tokensOut":8000,"durationMs":120000,"status":"completed","promiseTag":"COMPLETE","verificationResult":"passed"}
{"iteration":3,"tokensIn":18000,"tokensOut":5000,"durationMs":60000,"status":"completed","promiseTag":"COMPLETE","verificationResult":"passed"}
```
