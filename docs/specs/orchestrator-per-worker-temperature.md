# Спецификация: Индивидуальная температура воркеров в fan-orchestrator

## Метаданные

- **Дата**: 2026-06-18
- **Автор**: FAN Dev Team
- **Статус**: Draft
- **Версия**: 1.0
- **Зависимости**: fan-orchestrator ≥ 5.4.8, fan-coding-agent 1.0.0
- **Связанные задачи**: поддержка температуры в skills будет реализована отдельно в fan core

## 1. Обзор

### 1.1 Цель

Внедрить в fan-orchestrator настраиваемую температуру генерации для воркеров:

- Общая температура по умолчанию для всех воркеров оркестратора.
- Индивидуальная температура для каждого типа агента (explore, plan, implement, verify, bug-fix, code-research, tests-impl, docs-impl, security).
- Передача температуры в worker-процесс через CLI-флаг `--temperature`.
- Поддержка CLI-флага `--temperature` в fan-coding-agent.

### 1.2 Не входит в scope

- topK / topP.
- Изменение структуры DB `ModelSetting` (поле `temperature` уже существует).
- Изменение provider-ов (они уже читают `options.temperature`).
- Поддержка температуры в skills (решается отдельно в fan core).

### 1.3 Контекст

Текущее состояние:

- Температура поддерживается на уровне provider-ов и в DB `ModelSetting.temperature`.
- В fan-orchestrator нет полей для температуры.
- В fan-coding-agent CLI нет флага `--temperature`.
- Worker-процессы запускаются с `--mode rpc --model <model>`, без `--temperature`.

## 2. Требования

### 2.1 Функциональные требования

| ID | Требование |
|----|------------|
| FR-1 | В конфигурации оркестратора должно быть поле `temperature` (number \| null) — общая температура по умолчанию. |
| FR-2 | В конфигурации оркестратора должно быть поле `agentTemperature` (объект, ключ — имя агента, значение — number \| null) — индивидуальная температура для типа агента. |
| FR-3 | Диапазон допустимых значений температуры: `0.0`–`1.0`. |
| FR-4 | Значение `null` или отсутствие поля означает "не задано" — используется следующий уровень приоритета. |
| FR-5 | Значение `0.0` является валидным и должно передаваться в worker. |
| FR-6 | Приоритет применения температуры: `per-agent override` > `orchestrator default` > `DB ModelSetting` > `provider default`. |
| FR-7 | При спавне worker-процесса оркестратор должен передавать `--temperature <value>`, если температура задана. |
| FR-8 | fan-coding-agent CLI должен парсить флаг `--temperature <number>`. |
| FR-9 | fan-coding-agent должен применять переданную через CLI температуру к `AgentLoopConfig`. |
| FR-10 | При CLI-запуске без `--temperature` используется текущее поведение (DB / DEFAULT_PRESETS / provider default). |
| FR-11 | Команда `/orchestrator init` должна создавать в `config.json` поля `temperature` и `agentTemperature` с дефолтными значениями `0.1` для всех агентов. |
| FR-12 | `config.example.json` должен содержать пример заполнения `temperature` и `agentTemperature`. |

### 2.2 Нефункциональные требования

| ID | Требование |
|----|------------|
| NFR-1 | Изменения должны быть обратно совместимы: старые `config.json` без температуры продолжают работать. |
| NFR-2 | Не должно быть авто-создания `config.json` при установке расширения. |
| NFR-3 | Валидация значений температуры происходит при чтении конфига с clamp к диапазону `[0.0, 1.0]`. |
| NFR-4 | Логика передачи температуры должна быть покрыта unit-тестами в `packages/orchestrator`. |

## 3. Архитектура

### 3.1 Диаграмма потока данных

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          fan-orchestrator config.json                        │
│  {                                                                           │
│    "temperature": 0.1,                                                       │
│    "agentTemperature": {                                                     │
│      "explore": 0.1,                                                         │
│      "plan": 0.3,                                                            │
│      "implement": 0.1,                                                       │
│      "verify": 0.0,                                                          │
│      ...                                                                     │
│    }                                                                         │
│  }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  config.js: loadConfig() / normalizeConfig()                                 │
│  - валидация диапазона [0.0, 1.0]                                            │
│  - значение null/undefined пропускается                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  resolveWorkerTemperature(agentName)                                          │
│  return agentTemperature[agentName] ?? temperature ?? null                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  subagent-runner.js: runWorker(model, agentName, temperature)                │
│  rpcArgs = ["--mode", "rpc", "--model", model]                               │
│  if (temperature != null) rpcArgs.push("--temperature", String(temperature)) │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  fan --mode rpc --model claude-sonnet-4 --temperature 0.1                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  coding-agent/src/cli/args.ts: parse --temperature                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  coding-agent/src/main.ts: buildSessionOptions()                             │
│  - передает temperature в CreateAgentSessionOptions                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  coding-agent/src/core/sdk.ts: createAgentSession()                          │
│  - копирует temperature в AgentLoopConfig                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AgentLoopConfig extends SimpleStreamOptions { temperature?: number }        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  sdk.ts streamFn(model, context, options)                                    │
│  options.temperature уже задан (если передан через CLI)                      │
│  modelManager.applySettingsToOptions() НЕ переопределяет заданное значение   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Provider API (anthropic, openai, google, ...)                               │
│  Использует options.temperature                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Приоритет применения температуры

```text
1. Orchestrator per-agent override   (agentTemperature[agentName])
2. Orchestrator default              (temperature)
3. DB ModelSetting.temperature       (Prisma)
4. DEFAULT_PRESETS / provider default
```

## 4. Конфигурация

### 4.1 Схема config.json (orchestrator)

```json
{
  "cloud": {
    "model": "claude-sonnet-4-20250514",
    "models": {}
  },
  "local": {
    "model": "",
    "models": {}
  },
  "providerMode": "cloud",
  "coordinatorDefault": true,
  "parallelWorkers": 3,
  "workerTimeout": 600,
  "stallTimeout": 300,
  "planTimeout": 300,
  "maxRetries": 2,
  "agentTimeouts": {
    "explore": 600,
    "plan": 600,
    "implement": 600,
    "verify": 600,
    "bug-fix": 600,
    "code-research": 600,
    "tests-impl": 600,
    "docs-impl": 600
  },
  "temperature": 0.1,
  "agentTemperature": {
    "explore": 0.1,
    "plan": 0.3,
    "implement": 0.1,
    "verify": 0.0,
    "bug-fix": 0.1,
    "code-research": 0.1,
    "tests-impl": 0.1,
    "docs-impl": 0.1,
    "security": 0.1
  },
  "dangerousCommands": []
}
```

### 4.2 Default values

| Параметр | Дефолт | Примечание |
|----------|--------|------------|
| `temperature` | `0.1` | Общая температура по умолчанию |
| `agentTemperature.<agent>` | `0.1` | Индивидуальная температура по умолчанию |

### 4.3 Валидация

- При загрузке `config.json` значения температуры clamp-ятся к `[0.0, 1.0]`.
- `NaN` и non-number заменяются на `null`.
- Отсутствующие ключи восполняются дефолтами из `DEFAULTS`.

## 5. Изменения в файлах

### 5.1 fan-orchestrator extension

| Файл | Изменение |
|------|-----------|
| `config.js` | Добавить `temperature` и `agentTemperature` в `DEFAULTS`. Добавить `resolveWorkerTemperature(agentName)`. Обновить `normalizeConfig` / `deepMerge` для восстановления дефолтов. |
| `config.example.json` | Добавить `temperature` и `agentTemperature`. |
| `subagent-runner.js` | Принимать `temperature` в `runWorker()` / `runSingleAgent()` и добавлять `--temperature` в `rpcArgs`. |
| `orchestrator-tools.js` | Вызывать `resolveWorkerTemperature()` и передавать температуру в `runSingleAgent()`. |
| `orchestrator-extension.js` | Добавить в `/orchestrator init` шаги для настройки `temperature` и `agentTemperature` с дефолтом `0.1`. |
| `types.js` / `types.d.ts` | Добавить `temperature?: number \| null` и `agentTemperature?: Record<string, number \| null>` в `OrchestratorConfig`. |

### 5.2 fan-coding-agent core

| Файл | Изменение |
|------|-----------|
| `packages/coding-agent/src/cli/args.ts` | Добавить `temperature?: number` в `Args`. Добавить парсинг `--temperature`. |
| `packages/coding-agent/src/main.ts` | Передавать `temperature` из `parsed` в `buildSessionOptions()` → `CreateAgentSessionOptions`. |
| `packages/coding-agent/src/core/sdk.ts` | Принимать `temperature` в `CreateAgentSessionOptions` и копировать в `AgentLoopConfig`. |

### 5.3 Тесты

| Файл | Что тестировать |
|------|-----------------|
| `packages/orchestrator/tests/config.test.ts` | `resolveWorkerTemperature()` priority, clamp, null handling. |
| `packages/orchestrator/tests/subagent-runner.test.ts` | `--temperature` передается в rpcArgs. |
| `packages/coding-agent/tests/args.test.ts` | `--temperature` парсится корректно. |
| `packages/coding-agent/tests/sdk.test.ts` | temperature прокидывается в AgentLoopConfig. |

## 6. CLI-интерфейс

### 6.1 Новый флаг

```bash
fan --mode rpc --model claude-sonnet-4 --temperature 0.1
```

### 6.2 Поведение

- `--temperature 0.0` — валидно, передается в provider.
- `--temperature 1.5` — валидно с точки зрения CLI (provider сам отрежет или вернет ошибку).
- Без флага — используется DB / DEFAULT_PRESETS / provider default.

## 7. Init wizard

### 7.1 Новые шаги в `/orchestrator init`

1. **Общая температура по умолчанию**:
   - Вопрос: "Default temperature for orchestrator workers? (0.0-1.0)"
   - Дефолт: `0.1`
   - Валидация: число в диапазоне `[0.0, 1.0]`

2. **Индивидуальная температура по типам агентов**:
   - Вопрос: "Configure per-agent temperatures?"
   - Если да — показать таблицу из 9 типов агентов с дефолтом `0.1`.
   - Если нет — `agentTemperature` заполняется дефолтами `0.1` для всех агентов.

### 7.2 Пример результата

```json
{
  "temperature": 0.1,
  "agentTemperature": {
    "explore": 0.1,
    "plan": 0.3,
    "implement": 0.1,
    "verify": 0.0,
    "bug-fix": 0.1,
    "code-research": 0.1,
    "tests-impl": 0.1,
    "docs-impl": 0.1,
    "security": 0.1
  }
}
```

## 8. Граничные случаи

| Сценарий | Ожидаемое поведение |
|----------|---------------------|
| Старый `config.json` без `temperature` | Загружается, дефолты добавляются в памяти, файл не перезаписывается автоматически. |
| `agentTemperature.implement` = `null` | Используется `temperature` оркестратора. |
| `temperature` = `null` | Используется DB / DEFAULT_PRESETS / provider default. |
| `agentTemperature.implement` = `0.0` | Передается `0.0`, не путается с null. |
| Температура вне `[0.0, 1.0]` | Clamp к ближайшей границе при загрузке конфига. |
| Worker запущен не через оркестратор | CLI `--temperature` работает как обычно. |

## 9. Риски

| Риск | Митигация |
|------|-----------|
| Compiled Bun binary может некорректно передавать новый CLI флаг | Протестировать на `fan.exe`; при необходимости передавать через env var `FAN_TEMPERATURE` как fallback. |
| LLM может не понимать clamp к `[0.0, 1.0]` | Документировать и добавить валидацию в init wizard. |
| Существующие пользовательские config.json | Обратная совместимость: отсутствие полей не ломает работу. |
| DEFAULT_PRESETS имеют temperature 0.2–0.7, что может конфликтовать | Приоритет оркестратора выше DB и DEFAULT_PRESETS, пользователь контролирует поведение. |

## 10. Acceptance Criteria

- [ ] `config.example.json` содержит `temperature` и `agentTemperature`.
- [ ] `/orchestrator init` создает поля `temperature` и `agentTemperature` с дефолтом `0.1`.
- [ ] `resolveWorkerTemperature()` возвращает правильное значение по цепочке приоритетов.
- [ ] Worker-процесс запускается с `--temperature <value>` при заданной температуре.
- [ ] `fan --mode rpc --temperature 0.1` корректно парсит и применяет температуру.
- [ ] При отсутствии температуры в оркестраторе используется DB / provider default.
- [ ] Все новые функции покрыты тестами.
- [ ] Версия fan-orchestrator bumped и опубликована в FAN Store.

## 11. Решения по open questions

| Вопрос | Решение |
|--------|---------|
| Поддержка температуры в slash-командах | **Нет.** Температура настраивается только через `config.json`. |
| Отображение температуры в live widget | **Нет.** Виджет не перегружается информацией о температуре. |
| Runtime reload `config.json` | **Нет.** Температура применяется при старте сессии/команды. |
