# Спецификация: Фаза 4 — Автономность (Scheduler / Git/PR-политика / Budget caps)

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 4 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)

---

## 1. Обзор

### 1.1 Цель

Добавить фоновые автономные задачи поверх workspace-режима. Scheduler запускает задачи по расписанию через FAN API, управляет очередью из одной задачи (архитектура из v1), обеспечивает git/PR-политику через bot-identity и budget caps для контроля расходов токенов.

### 1.2 Контекст

Исследование v1 (`docs/research/idea-lab/fan-remote-vps/FAN Remote — FAN на VPS с удалённым доступом — исследование.md`, разделы 8, таблицы MoSCoW):

**Что готово:**
- REST API + WebSocket (16 endpoints)
- Bash-инструмент: агент может выполнять любые git-команды
- Budget tracking: `PUT /api/budget` для ограничений
- Мульти-токенная аутентификация

**Что отсутствует:**
- Нет scheduler'а, webhook'ов, очереди задач
- Нет git/PR-инструментов (агент делает всё через bash + gh CLI)
- Персистентная очередь сообщений (текущая in-memory в фазе 2 теряется при рестарте)

Архитектурный паттерн: внешний scheduler дёргает FAN API (паттерн code-automator). Ядро FAN остаётся execution engine без оркестрации расписаний.

---

## 2. Функциональные требования

### 2.1 Scheduler-сервис

**Файл:** новый сервис `tools/fan-scheduler/` (отдельный пакет или скрипт)

```
tools/fan-scheduler/
├── scheduler.ts          # Главный цикл
├── config.yaml           # Cron-конфигурация
├── lib/
│   ├── queue.ts          # Очередь задач
│   ├── client.ts         # FAN API client
│   └── logger.ts         # Логирование
└── package.json          # Bun package
```

#### Cron-конфигурация

```yaml
# config.yaml
tasks:
  - name: "daily-code-review"
    schedule: "0 9 * * *"        # каждый день в 9:00
    workspace: "/data/repos/my-project"
    message: |
      Run a full code review of the latest commits.
      Generate a PR with suggestions if issues found.
    budget_limit: 500              # tokens per task
    timeout: 3600                  # seconds
    
  - name: "weekly-research-report"
    schedule: "0 8 * * 1"         # понедельник 8:00
    workspace: "/data/repos/idea-lab-workspace"
    message: |
      Generate a weekly research report from docs/research/.
      Summarize findings, identify trends.
    budget_limit: 1000
    timeout: 7200
```

#### Архитектура очереди (из v1)

Очередь из одной задачи: одна задача за раз, чат имеет приоритет.

```typescript
class TaskQueue {
    private isRunning = false;
    private pendingTasks: Array<{task: TaskConfig, resolved: () => void}> = [];
    
    // Добавить задачу
    async enqueue(task: TaskConfig): Promise<void> {
        this.pendingTasks.push({ task, resolved: () => {} });
    }
    
    // Выполнить следующую задачу (если свободен)
    async runNext(): Promise<void> {
        if (this.isRunning || this.pendingTasks.length === 0) return;
        
        this.isRunning = true;
        const { task, resolved } = this.pendingTasks.shift()!;
        
        try {
            await this.executeTask(task);
        } finally {
            this.isRunning = false;
            // Автоматически запустить следующую
            this.runNext();
        }
    }
    
    private async executeTask(task: TaskConfig): Promise<void> {
        // 1. Создать сессию в проекте
        const session = await fanClient.createSession({ cwd: task.workspace });
        
        // 2. Отправить сообщение с задачей
        await fanClient.sendMessage(session.id, task.message);
        
        // 3. Ждать завершения (WS subscription)
        await this.waitForCompletion(session.id, task.timeout);
        
        // 4. Обновить бюджет
        await fanClient.updateBudget({ project: task.workspace, limit: task.budget_limit });
    }
}
```

#### Приоритет чата над задачами

Если движок занят выполнением задачи, входящее сообщение от пользователя (live chat) прерывает задачу и переходит в приоритет:

```typescript
// В ws-handler.ts
async handleWsMessage(ws: WebSocket, data: WsMessage) {
    if (data.type === 'sendMessage' && data.priority === 'chat') {
        // Чат имеет высокий приоритет
        if (scheduler.isRunning()) {
            await scheduler.pauseCurrentTask();
            logger.info('Paused autonomous task for live chat');
        }
        
        await runtime.sendMessage(data.sessionId, data.content);
    }
}
```

### 2.2 Git/PR-политика

**Контекст:** FAN не имеет специальных git-инструментов. Агент делает всё через bash tool + `gh` CLI внутри контейнера.

#### Bot Identity

Отдельный аккаунт GitHub (или GitHub App) для действий агента:
- Имя: `fan-bot` (или аналогичное)
- Токен: отдельный PAT с scope `repo` (только для целевых репозиториев)
- Настройка: env var `GITHUB_TOKEN` в docker-compose

#### Feature-ветки

Политика коммитов:
1. Каждая задача создаёт новую ветку: `fan-auto/<task-id>-<timestamp>`
2. Коммиты делаются в feature-ветку, NEVER в main/master
3. После завершения задачи → Pull Request в main
4. Main protected: require PR, no direct push

#### GitHub CLI интеграция

Агент использует `gh` CLI через bash tool:

```bash
# Создание новой ветки
git checkout -b fan-auto/task-123-20260725

# Коммит изменений
git add .
git commit -m "auto: fix auth bug (#123)"

# Push и создание PR
git push origin fan-auto/task-123-20260725
gh pr create \
    --base main \
    --head fan-auto/task-123-20260725 \
    --title "auto: fix auth bug" \
    --body "Automated fix generated by FAN agent. Closes #123"
```

**Безопасность:** PAT имеет minimum necessary scope. Branch protection на main блокирует прямой push.

#### Бэкапы и восстановление

Важные файлы бэкапа:
- `~/.fan/agent/fan.db` → daily cron backup
- Клонированные репозитории → всегда есть копия на GitHub
- `.fan/settings.json` → version-controlled в проекте

### 2.3 Budget Caps

**Файл:** существующий `PUT /api/budget` endpoint

Для каждой автономной задачи:
1. Перед запуском: установить cap `PUT /api/budget?project=<path>&limit=<tokens>`
2. Во время выполнения: мониторинг через `GET /api/budget`
3. По достижении лимита: graceful shutdown задачи
4. По завершении: сброс или повышение общего limit

```typescript
// Scheduler логика budget control
async executeTaskWithBudget(task: TaskConfig): Promise<void> {
    // Установить проект-specific cap
    await fanClient.setProjectBudget(task.workspace, task.budget_limit);
    
    // Запустить задачу
    try {
        await this.executeTask(task);
    } catch (error) {
        if (error.code === 'BUDGET_EXCEEDED') {
            logger.warn(`Task ${task.name} stopped: budget exceeded (${task.budget_limit} tokens)`);
            return;
        }
        throw error;
    }
    
    // Проверить использование
    const usage = await fanClient.getBudgetUsage(task.workspace);
    logger.info(`Task ${task.name}: used ${usage.tokens} / ${task.budget_limit} tokens`);
}
```

---

## 3. Пользовательские сценарии

### Сценарий 1: Автоматический код-ревью ежедневно

**Предусловия:** scheduler настроен, config.yaml содержит task
**Шаги:**
1. Каждый день в 9:00 scheduler запускает task
2. Scheduler создаёт сессию в `/data/repos/my-project`
3. Отправляет промпт для code review
4. Agent изучает последние коммиты, генерирует рекомендации
5. Создаёт branch + PR через gh CLI
6. Логирует результат

**Ожидаемый результат:** ежедневный automated code review, PR создаётся автоматически

### Сценарий 2: Недельный исследовательский отчёт

**Предусловия:** research workspace активен, contains files in docs/research/
**Шаги:**
1. Каждое утро понедельника scheduler запускает task
2. Agent сканирует `docs/research/`, читает все markdown файлы
3. Генерирует summary report с трендами и выводами
4. Сохраняет в `docs/reports/weekly-YYYY-Www.md`

**Ожидаемый результат:** еженедельный отчёт о проведённых исследованиях

### Сценарий 3: Прерывание задачи живым чатом

**Предусловия:** scheduler выполняет фоновую задачу
**Шаги:**
1. Пользователь подключается к Web UI
2. Отправляет срочное сообщение
3. Текущая задача ставится на паузу
4. Обработка пользовательского сообщения продолжается
5. После завершения чата — задача возобновляется (опционально)

**Ожидаемый результат:** пользователь получает немедленный ответ, автономная задача переносится

---

## 4. Нефункциональные требования

### 4.1 Надёжность

| Метрика | Целевое значение |
|---------|------------------|
| Очередь задач | Одновременно только одна задача (без гонок) |
| Обработка ошибок | Retry до 3 раз с exponential backoff |
| Логирование | Структурированный JSON в stdout/stderr |
| Recovery после crash | Задача перезапускается при старте scheduler'а (персистентная очередь) |

### 4.2 Безопасность

- PAT GitHub: минимальные scopes, ограниченный доступ к конкретным репозиториям
-_budget_: жёсткий cap prevents runaway token spending
- Изоляция tasks: каждая задача в своей сессии, результаты не смешиваются

### 4.3 Мониторинг

- Health endpoint для scheduler: `GET /health` (новый)
- Метрики: количество выполненных задач, затраченные токены, ошибки
- Alerting: уведомления при превышении бюджета или частых ошибках

---

## 5. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Scheduler теряет задачу при restart | Низкая | Среднее | Персистентная очередь (SQLite/file) — решает эту проблему |
| Бюджет истощён ночью, критическая задача не выполняется | Средняя | Среднее | Budget caps настраиваются per-task; алерты при низком бюджете |
| Agent создаёт плохие PR | Средняя | Низкое | PR требует human review (branch protection); PR-only политика |
| Конфликт двух cron-задач на один workspace | Низкая | Среднее | Очередь одна; задачи сериализуются |
| gh CLI недоступен (network issue) | Средняя | Критичное | Graceful degradation: task fails with clear error, retries later |
| Rate limits GitHub API | Низкая | Среднее | Backoff при 403; batch operations где возможно |

---

## 6. Компромиссы

### 6.1 Принятые решения

- **Scheduler отдельно от ядра FAN** — паттерн code-automator: оркестрация снаружи, ядро — чистый execution engine. Плюс: обратимо, заменяемо. Минус: дополнительный сервис.
- **Очередь из одной задачи** — простота архитектуры. Для личного инструмента достаточно: если нужно несколько задач, запускаем руками. Параллельное исполнение — фаза 5.
- **In-memory очередь → персистентная в фазе 4** — решаем потерю задач при рестарте. SQLite для tiny очереди (1–5 задач) избыточно, файловое хранение достаточно.
- **Chat priority > tasks** — живой пользователь важнее автоматических задач. Согласуется с концепцией «personal assistant».

### 6.2 Отклонённые альтернативы

- **Webhook-триггеры (GitHub issues → tasks)** — сложнее cron: нужен публичный endpoint, верификация подписей. Отложено как Could Have.
- **Специальный инструмент PR внутри ядра** — agent уже умеет через bash + gh CLI. Не нужно новое code path в core.
- **Per-task budgets вместо global cap** — усложнение бюджетной модели. Общий cap + алерты для MVP. Per-project — позже.

---

## 7. Приоритеты

### Must Have
- Scheduler-сервис (cron → FAN API)
- Очередь из одной задачи
- Bot identity (GitHub PAT)
- Feature-ветки + PR политика (gh CLI)
- Budget caps per task
- Config YAML формат

### Should Have
- Persistent queue (file-based)
- Task retry with exponential backoff
- Structured logging (JSON)
- Health/monitoring endpoint
- Chat interruption (pause auto tasks)

### Could Have
- GitHub webhook triggers (issue with label → task)
- Per-project budgets
- Slack/email notifications on task completion
- Dashboard виджет статуса scheduler
- Task history UI в dashboard

### Won't Have
- Multi-user scheduling — один оператор
- Parallel task execution — фаза 5
- Kubernetes deployment — single VPS
- Built-in TLS — nginx решает

---

## 8. Следующие шаги

- [ ] Создать директорию `tools/fan-scheduler/` с базовой структурой
- [ ] Реализовать TaskQueue (одна задача одновременно)
- [ ] Определить формат config.yaml для cron-задач
- [ ] Интегрировать FAN API client (sessions, messages, budget)
- [ ] Настроить GitHub PAT для bot identity
- [ ] Подготовить GH_CLI в контейнере Docker (уже должен быть доступен via bash tool)
- [ ] Реализовать budget control logic
- [ ] Persistent queue: JSON файл для восстановления после restart
- [ ] Документация: docs/guides/scheduler.md

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 4 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
