# FAN RPC Mode — Полное руководство разработчика

> **FAN (Filin Agent Next)** — локальный AI runtime-agent для разработчиков.
> RPC Mode — это headless-режим работы FAN, предназначенный для встраивания AI-агента
> в сторонние приложения (IDE-плагины, веб-интерфейсы, CI/CD-пайплайны, десктоп-приложения).

---

## Содержание

1. [Обзор](#обзор)
2. [Быстрый старт](#быстрый-старт)
3. [Протокол](#протокол)
4. [Команды (stdin → агент)](#команды-stdin--агент)
5. [События (агент → stdout)](#события-агент--stdout)
6. [Состояние сессии](#состояние-сессии)
7. [Extension UI (взаимодействие с пользователем)](#extension-ui-взаимодействие-с-пользователем)
8. [Программный клиент (RpcClient)](#программный-клиент-rpcclient)
9. [Обработка ошибок](#обработка-ошибок)
10. [Примеры интеграции](#примеры-интеграции)
11. [RPC vs WebSocket API](#rpc-vs-websocket-api)
12. [Типы TypeScript](#типы-typescript)
13. [Советы и best practices](#советы-и-best-practices)

---

## Обзор

FAN RPC Mode — это **stdio-based RPC протокол** для программного взаимодействия с AI-агентом.

### Как это работает

```
Ваше приложение                    FAN Agent (--mode rpc)
┌─────────────────┐    stdin      ┌──────────────────────┐
│                 │───JSONL──────▶│                      │
│  RpcClient      │              │  runRpcMode()        │
│  или ваш код    │    stdout     │                      │
│                 │◀──JSONL──────│  session.subscribe()  │
└─────────────────┘              └──────────────────────┘
                                        │
                                   stderr (логи, отладка)
```

### Ключевые особенности

- **Полный контроль** — вы управляете агентом пошагово: отправили промпт, получили стрим событий, дождались завершения
- **Два канала** — stdin для команд, stdout для событий и ответов (stderr для логов)
- **Асинхронность** — команды не блокируют агента; события приходят по мере выполнения
- **JSONL формат** — строгий NDJSON (Newline-Delimited JSON) с LF-разделителями
- **Никаких зависимостей** — достаточно сгенерировать JSON и прочитать его через сокет/процесс
- **Типизирован** — полные TypeScript типы для всех команд и ответов

### Когда использовать RPC

| Сценарий | RPC | WebSocket API |
|----------|-----|---------------|
| IDE-плагин | ✅ | ✅ |
| TUI-приложение | ✅ | ❌ (требует HTTP) |
| CI/CD скрипт | ✅ | ❌ (требует сервер) |
| Десктоп (Tauri, Electron) | ✅ | ✅ |
| Микросервис | ❌ (один процесс) | ✅ |
| Мульти-клиент | ❌ (один процесс = одна сессия) | ✅ |

---

## Быстрый старт

### Запуск

```bash
# Базовый запуск
fan --mode rpc

# С указанием провайдера и модели
fan --mode rpc --provider openai --model gpt-4o

# Без сохранения на диск (in-memory сессия)
fan --mode rpc --no-session

# С указанием директории для сессий
fan --mode rpc --session-dir /path/to/sessions
```

### Проверка, что RPC работает

```bash
echo '{"type":"get_state","id":"1"}' | fan --mode rpc
```

Ожидаемый ответ в stdout:
```json
{"id":"1","type":"response","command":"get_state","success":true,"data":{...}}
```

### Простейший диалог через shell

```bash
# Отправка промпта, затем abort
printf '{"type":"prompt","id":"1","message":"Скажи привет"}\n{"type":"abort","id":"2"}\n' | fan --mode rpc 2>/dev/null
```

### Интерактивный клиент (Node.js, 30 строк)

```javascript
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const fan = spawn("fan", ["--mode", "rpc"], { stdio: ["pipe", "pipe", "inherit"] });
const decoder = new StringDecoder();
let buffer = "";

fan.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  const idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response") console.log("RESP:", msg);
      if (msg.type === "agent_end") console.log("AGENT DONE");
      if (msg.type === "message_update") process.stdout.write(msg.assistantMessageEvent?.textDelta || "");
    } catch {}
  }
});

// Отправить команду
function send(cmd) { fan.stdin.write(JSON.stringify(cmd) + "\n"); }
```

---

## Протокол

### Транспорт

- **stdin** — команды от клиента к агенту
- **stdout** — события и ответы от агента к клиенту (FAN самостоятельно перехватывает stdout)
- **stderr** — логи, отладочная информация, предупреждения (свободный канал)

### Формат сообщений

Строгий **JSONL (JSON Lines, NDJSON)**:

```json
{"type":"get_state","id":"req-1"}
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}
```

Правила:
- Каждое сообщение — ровно одна строка с завершающим `\n` (LF, U+000A)
- Кодировка — UTF-8
- Пробельные символы в начале/конце строки не допускаются

> **⚠️ ВАЖНО:** Не используйте `node:readline` для чтения ответов! Он спотыкается на Unicode-разделителях строк (U+2028, U+2029), которые могут быть внутри JSON-строк (например, в коде, сгенерированном агентом). Используйте простой буфер с поиском `\n`.

```typescript
// Правильный JSONL reader (TypeScript)
function readJsonl(stream: ReadableStream<string>) {
  let buffer = "";
  const reader = stream.getReader();
  return {
    async next(): Promise<{ value: any; done: boolean }> {
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          return { value: JSON.parse(line), done: false };
        }
        const { done, value } = await reader.read();
        if (done && buffer.length === 0) return { done: true, value: undefined as any };
        buffer += value;
      }
    },
    [Symbol.asyncIterator]() { return this; }
  };
}
```

### Request ID (корреляция)

Каждая команда может иметь опциональный `id` — произвольная строка, которая будет включена в ответ. Это позволяет сопоставлять запросы с ответами в асинхронном протоколе.

```json
{"type":"prompt","id":"msg-42","message":"Hello"}
{"id":"msg-42","type":"response","command":"prompt","success":true}
```

---

## Команды (stdin → агент)

### 📝 Prompting — отправка сообщений

#### `prompt` — отправить сообщение агенту

```json
{
  "type": "prompt",
  "id": "req-1",
  "message": "Расскажи про архитектуру FAN",
  "images": [],
  "streamingBehavior": "steer"
}
```

**Параметры:**

| Поле | Тип | Обязательное | Описание |
|------|-----|-------------|----------|
| `message` | `string` | ✅ | Текст сообщения |
| `images` | `ImageContent[]` | ❌ | Изображения для мультимодальных моделей |
| `streamingBehavior` | `"steer" \| "followUp"` | ❌ | Что делать, если агент уже стримит: `steer` — прервать и начать новый ответ; `followUp` — поставить в очередь |

**Ответ:** `{ success: true }` — сама генерация ответа приходит через события.

**Как стримится ответ:**
```
[stdin]  {"type":"prompt","message":"Напиши hello world"}
[stdout] {"type":"response","command":"prompt","success":true}    ← подтверждение приёма
[stdout] {"type":"agent_start"}
[stdout] {"type":"turn_start"}
[stdout] {"type":"message_start"}
[stdout] {"type":"message_update","assistantMessageEvent":{"textDelta":"Привет"}}
[stdout] {"type":"message_update","assistantMessageEvent":{"textDelta":"! Я напишу"}}
[stdout] {"type":"message_update","assistantMessageEvent":{"textDelta":" hello world"}}
[stdout] {"type":"tool_execution_start","toolName":"write","args":{"path":"hello.py","content":"..."}}
[stdout] {"type":"tool_execution_end","result":"...","isError":false}
[stdout] {"type":"message_end"}
[stdout] {"type":"turn_end"}
[stdout] {"type":"agent_end","messages":[...]}
```

---

#### `steer` — прервать агента с новым сообщением

```json
{
  "type": "steer",
  "id": "req-2",
  "message": "Нет, давай про модель управления памятью"
}
```

Прерывает текущий ответ агента и начинает новый с указанным сообщением. Аналог Ctrl+Enter в TUI.

---

#### `follow_up` — поставить сообщение в очередь

```json
{
  "type": "follow_up",
  "id": "req-3",
  "message": "А теперь добавь пример кода"
}
```

Не прерывает текущий ответ, а добавляет сообщение в очередь на выполнение после завершения.

---

#### `abort` — прервать текущую операцию

```json
{"type": "abort", "id": "req-4"}
```

Немедленно прерывает агента (стриминг, выполнение инструментов, bash).

---

### 🆕 Управление сессиями

#### `new_session` — создать новую сессию

```json
{
  "type": "new_session",
  "id": "req-5",
  "parentSession": "/path/to/session.jsonl"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `parentSession` | `string` (opt) | Путь к файлу сессии для наследования контекста |

**Ответ:**
```json
{ "id": "req-5", "type": "response", "command": "new_session", "success": true,
  "data": { "cancelled": false } }
```

После создания новой сессии все последующие команды работают с ней. `cancelled: true` если пользователь отменил (через Extension UI).

---

#### `switch_session` — переключиться на другую сессию

```json
{
  "type": "switch_session",
  "id": "req-6",
  "sessionPath": "/home/user/.fan/agent/sessions/my-session.jsonl"
}
```

После переключения сессия перезагружается: расширения перепривязываются, подписки на события обновляются.

**Ответ:** `{ cancelled: boolean }`

---

#### `fork` — создать форк от сообщения

```json
{
  "type": "fork",
  "id": "req-7",
  "entryId": "msg-entry-abc123"
}
```

Создаёт новую сессию, начиная с указанного сообщения. `entryId` можно получить из `get_fork_messages` или `get_messages`.

**Ответ:**
```json
{ "id": "req-7", "type": "response", "command": "fork", "success": true,
  "data": { "text": "текст сообщения...", "cancelled": false } }
```

---

#### `get_fork_messages` — сообщения, доступные для форка

```json
{"type": "get_fork_messages", "id": "req-8"}
```

**Ответ:**
```json
{ "id": "req-8", "type": "response", "command": "get_fork_messages", "success": true,
  "data": { "messages": [{ "entryId": "abc123", "text": "текст..." }, ...] } }
```

---

#### `get_last_assistant_text` — последний ответ ассистента

```json
{"type": "get_last_assistant_text", "id": "req-9"}
```

**Ответ:** `{ "text": "последний ответ..." }`

---

#### `set_session_name` — задать имя сессии

```json
{"type": "set_session_name", "id": "req-10", "name": "Моя сессия"}
```

---

### 📊 Состояние и статистика

#### `get_state` — получить состояние сессии

```json
{"type": "get_state", "id": "req-11"}
```

**Ответ:** — полный объект `RpcSessionState` (см. [раздел "Состояние сессии"](#состояние-сессии)).

---

#### `get_session_stats` — статистика сессии

```json
{"type": "get_session_stats", "id": "req-12"}
```

**Ответ:** — объект `SessionStats` с метриками использования (токены, затраты, время).

---

#### `get_messages` — все сообщения сессии

```json
{"type": "get_messages", "id": "req-13"}
```

**Ответ:**
```json
{ "id": "req-13", "type": "response", "command": "get_messages", "success": true,
  "data": { "messages": ["AgentMessage", ...] } }
```

Каждое сообщение содержит поля: `role`, `content`, `id`, `timestamp` и другие метаданные.

---

### 🤖 Управление моделью

#### `set_model` — установить модель

```json
{
  "type": "set_model",
  "id": "req-14",
  "provider": "openai",
  "modelId": "gpt-4o"
}
```

**Ответ:** полный объект `Model` с информацией о провайдере, возможностях и настройках.

---

#### `cycle_model` — переключить на следующую модель

```json
{"type": "cycle_model", "id": "req-15"}
```

Аналог горячей клавиши в TUI. Возвращает `null` если нет моделей для переключения.

---

#### `get_available_models` — список доступных моделей

```json
{"type": "get_available_models", "id": "req-16"}
```

**Ответ:**
```json
{ "id": "req-16", "type": "response", "command": "get_available_models",
  "success": true, "data": { "models": ["Model", ...] } }
```

Каждая модель содержит: `provider`, `id`, `name`, `capabilities` (text, tool_use, vision).

---

### 🧠 Thinking Level

#### `set_thinking_level` — установить уровень рассуждений

```json
{"type": "set_thinking_level", "id": "req-17", "level": "high"}
```

Уровни: `"off"` | `"low"` | `"medium"` | `"high"`

---

#### `cycle_thinking_level` — переключить уровень

```json
{"type": "cycle_thinking_level", "id": "req-18"}
```

Циклически переключает между `off → low → medium → high`.

---

### 🔄 Режимы очередей

#### `set_steering_mode` / `set_follow_up_mode`

```json
{"type": "set_steering_mode", "id": "req-19", "mode": "all"}
{"type": "set_follow_up_mode", "id": "req-20", "mode": "one-at-a-time"}
```

| Режим | Описание |
|-------|----------|
| `"all"` | Обрабатывать все сообщения в очереди |
| `"one-at-a-time"` | Обрабатывать только последнее (отменять предыдущие) |

---

### 🗜️ Компактизация контекста

#### `compact` — сжать контекст

```json
{
  "type": "compact",
  "id": "req-21",
  "customInstructions": "Сохрани ключевые архитектурные решения"
}
```

**Ответ:** `CompactionResult` с информацией о результате (количество удалённых сообщений, размер).

---

#### `set_auto_compaction` — включить/выключить авто-компактизацию

```json
{"type": "set_auto_compaction", "id": "req-22", "enabled": true}
```

---

### 🔁 Auto-retry

#### `set_auto_retry` — включить авто-ретрай при ошибках модели

```json
{"type": "set_auto_retry", "id": "req-23", "enabled": true}
```

---

#### `abort_retry` — прервать текущий ретрай

```json
{"type": "abort_retry", "id": "req-24"}
```

---

### 💻 Bash

#### `bash` — выполнить bash команду

```json
{
  "type": "bash",
  "id": "req-25",
  "command": "ls -la"
}
```

**Ответ:**
```json
{ "id": "req-25", "type": "response", "command": "bash", "success": true,
  "data": { "exitCode": 0, "stdout": "...", "stderr": "" } }
```

> **Важно:** Результаты bash автоматически становятся контекстом для следующего `prompt`. Агент видит их как `BashExecutionMessage`, которая преобразуется в `UserMessage` при следующем запросе. Таким образом, следующий вызов `prompt()` будет иметь контекст предыдущих bash команд.

---

#### `abort_bash` — прервать выполнение bash

```json
{"type": "abort_bash", "id": "req-26"}
```

---

### 📤 Экспорт

#### `export_html` — экспорт сессии в HTML

```json
{
  "type": "export_html",
  "id": "req-27",
  "outputPath": "/tmp/session-export.html"
}
```

**Ответ:** `{ "path": "/tmp/session-export.html" }`

Экспортирует всю историю сессии в читаемый HTML-документ со стилями.

---

### 📋 Команды и скиллы

#### `get_commands` — список всех доступных команд

```json
{"type": "get_commands", "id": "req-28"}
```

**Ответ — команды из трёх источников:**
```json
{
  "commands": [
    { "name": "edit", "description": "...", "source": "extension", "sourceInfo": { ... } },
    { "name": "skill:bug-fix", "description": "...", "source": "skill", "sourceInfo": { ... } },
    { "name": "research", "description": "...", "source": "prompt", "sourceInfo": { ... } }
  ]
}
```

Команды можно вызывать через `prompt`:
```json
{"type": "prompt", "message": "/edit Исправь баг в user-service.ts"}
```

---

### 🏗️ FAN Model Management

#### `get_routing_rules` — правила роутинга моделей

```json
{"type": "get_routing_rules", "id": "req-29"}
```

**Ответ:** массив правил роутинга (id, name, provider, model, fallback, enabled).

---

#### `get_budget_status` — статус бюджетов

```json
{"type": "get_budget_status", "id": "req-30"}
```

**Ответ:** статусы бюджетов по провайдерам (tokenUsed, costUsed, tokenLimit, costLimit, exceeded).

---

#### `get_model_settings` — настройки моделей

```json
{"type": "get_model_settings", "id": "req-31"}
```

**Ответ:** массив настроек (temperature, maxTokens, thinking) по моделям.

---

### 🔐 Управление токенами API Gateway

#### `generate_token` — создать токен доступа

```json
{"type": "generate_token", "id": "req-32", "name": "my-ide-plugin"}
```

**Ответ:**
```json
{
  "token": {
    "id": "uuid",
    "name": "my-ide-plugin",
    "token": "fan_tk_abc123...",
    "createdAt": "2026-06-15T..."
  }
}
```

---

#### `list_tokens` — список всех токенов

```json
{"type": "list_tokens", "id": "req-33"}
```

---

#### `revoke_token` — отозвать токен

```json
{"type": "revoke_token", "id": "req-34", "tokenId": "uuid-токена"}
```

---

## События (агент → stdout)

После отправки `prompt`, агент стримит события в stdout. Каждое событие — отдельная JSONL-строка.

### Полный список событий

| Тип события | Когда происходит | Ключевые поля |
|------------|------------------|---------------|
| `agent_start` | Агент получил промпт | — |
| `turn_start` | Начало одного "хода" | — |
| `message_start` | Начало формирования сообщения | — |
| `message_update` | Обновление стриминг-сообщения | `assistantMessageEvent` |
| `message_end` | Сообщение завершено | — |
| `tool_execution_start` | Агент вызвал инструмент | `toolCallId`, `toolName`, `args` |
| `tool_execution_update` | Прогресс инструмента | `result` (аккумулированный) |
| `tool_execution_end` | Инструмент завершён | `result`, `isError` |
| `turn_end` | Ход завершён | `message`, `toolResults` |
| `agent_end` | Весь ответ завершён | `messages: AgentMessage[]` |
| `queue_update` | Изменение очередей | `steering`, `followUp` |
| `compaction_start` | Начало компактизации | `reason` |
| `compaction_end` | Компактизация завершена | `result`, `aborted`, `willRetry` |
| `auto_retry_start` | Начало авто-ретрая | `attempt`, `maxAttempts`, `delayMs` |
| `auto_retry_end` | Авто-ретрай завершён | `success`, `attempt` |
| `extension_error` | Ошибка расширения | `extensionPath`, `event`, `error` |

### Типичный lifecycle

```
[stdout] {"type":"agent_start"}
[stdout] {"type":"turn_start"}
[stdout]   {"type":"message_start"}
[stdout]   {"type":"message_update","assistantMessageEvent":{"textDelta":"Давайте "}}
[stdout]   {"type":"message_update","assistantMessageEvent":{"textDelta":"я проанализирую код"}}
[stdout]   {"type":"message_update","assistantMessageEvent":{"thinkingDelta":"..."}}
[stdout]   {"type":"tool_execution_start","toolName":"read","args":{"path":"src/main.ts"}}
[stdout]   {"type":"tool_execution_end","result":"содержимое файла...","isError":false}
[stdout]   {"type":"message_end"}
[stdout] {"type":"turn_end"}
[stdout] {"type":"agent_end","messages":[...]}    ← сигнал завершения
```

### Важные поля

#### `message_update`

```json
{
  "type": "message_update",
  "assistantMessageEvent": {
    "textDelta": "обновление текста",
    "thinkingDelta": "рассуждения модели",
    "toolCallDelta": { "id": "call_abc", "function": { "name": "read", "arguments": "{\"path\":\"...\"}" } }
  }
}
```

- `textDelta` — **инкрементальное** обновление текста (только новые символы)
- `thinkingDelta` — инкрементальное обновление рассуждений модели
- `toolCallDelta` — дельта для streaming tool calls (появляется только при streaming tool calls)

#### `tool_execution_update`

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "result": { "partialContent": "полный текущий результат..." }
}
```

> **Важно:** `result` — **аккумулированный**, а не дельта. Каждое следующее событие содержит **весь** текущий результат.

#### `agent_end`

```json
{
  "type": "agent_end",
  "messages": [
    { "role": "assistant", "content": "полный ответ..." },
    { "role": "tool", "toolCallId": "call_abc123", "content": "результат..." }
  ]
}
```

Содержит **все** сообщения, сгенерированные за этот промпт. Используйте это событие как сигнал завершения.

---

## Состояние сессии

Команда `get_state` возвращает полное состояние сессии:

```json
{
  "model": {
    "provider": "openai",
    "id": "gpt-4o",
    "name": "GPT-4o",
    "capabilities": ["text", "tool_use", "vision"]
  },
  "thinkingLevel": "high",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all",
  "followUpMode": "all",
  "sessionFile": "/home/user/.fan/agent/sessions/my-session.jsonl",
  "sessionId": "uuid-сессии",
  "sessionName": "Моя сессия",
  "autoCompactionEnabled": true,
  "messageCount": 15,
  "pendingMessageCount": 0
}
```

### Поля состояния

| Поле | Тип | Описание |
|------|-----|----------|
| `model` | `Model \| undefined` | Текущая модель (провайдер, id, name, capabilities) |
| `thinkingLevel` | `"off" \| "low" \| "medium" \| "high"` | Уровень рассуждений |
| `isStreaming` | `boolean` | Агент в процессе ответа |
| `isCompacting` | `boolean` | Идёт компактизация контекста |
| `steeringMode` | `"all" \| "one-at-a-time"` | Режим обработки steering |
| `followUpMode` | `"all" \| "one-at-a-time"` | Режим обработки follow-up |
| `sessionFile` | `string \| undefined` | Путь к файлу сессии на диске |
| `sessionId` | `string` | Уникальный UUID сессии |
| `sessionName` | `string \| undefined` | Имя сессии |
| `autoCompactionEnabled` | `boolean` | Авто-компактизация включена |
| `messageCount` | `number` | Количество сообщений в истории |
| `pendingMessageCount` | `number` | Ожидающие сообщения в очереди |

---

## Extension UI (взаимодействие с пользователем)

Когда расширениям или инструментам нужен ввод от пользователя (например, `questionnaire`, диалог подтверждения), RPC-режим отправляет **Extension UI Request** в stdout. Клиент **обязан** ответить через stdin.

> **Важно:** В TUI-режиме `questionnaire` использует `ctx.ui.custom()` для рендеринга таб-интерфейса.
> В RPC-режиме он автоматически переключается на последовательные вызовы `select`/`input`/`confirm`,
> так что клиент получает стандартные Extension UI Request-ы для каждого вопроса.

### Dialog-методы (требуют ответа)

Эти методы блокируют выполнение агента до получения ответа от клиента.

#### `select` — выбор из списка

```json
// ← Агент спрашивает:
{"type":"extension_ui_request","id":"ui-1","method":"select",
 "title":"Выберите модель","options":["GPT-4o","Claude 3.5","Gemini"],
 "timeout":30000}

// → Клиент отвечает:
{"type":"extension_ui_response","id":"ui-1","value":"GPT-4o"}
// или отмена:
{"type":"extension_ui_response","id":"ui-1","cancelled":true}
```

#### `confirm` — подтверждение

```json
// ← Запрос:
{"type":"extension_ui_request","id":"ui-2","method":"confirm",
 "title":"Подтверждение","message":"Удалить файл?",
 "timeout":10000}

// → Ответ (подтверждено):
{"type":"extension_ui_response","id":"ui-2","confirmed":true}
// или отмена:
{"type":"extension_ui_response","id":"ui-2","cancelled":true}
```

#### `input` — однострочный ввод

```json
// ← Запрос:
{"type":"extension_ui_request","id":"ui-3","method":"input",
 "title":"Введите название функции","placeholder":"myFunction"}

// → Ответ:
{"type":"extension_ui_response","id":"ui-3","value":"myFunction"}
```

#### `editor` — многострочный редактор

```json
// ← Запрос:
{"type":"extension_ui_request","id":"ui-4","method":"editor",
 "title":"Опишите изменения","prefill":"// ваш код"}

// → Ответ:
{"type":"extension_ui_response","id":"ui-4","value":"function hello() {\n  ...\n}"}
```

### Fire-and-forget методы (не ждут ответа)

#### `notify` — показать уведомление

```json
{"type":"extension_ui_request","id":"ui-5","method":"notify",
 "message":"Файл сохранён","notifyType":"info"}
```

`notifyType`: `"info"` | `"warning"` | `"error"`

---

#### `setStatus` — обновить строку статуса

```json
{"type":"extension_ui_request","id":"ui-6","method":"setStatus",
 "statusKey":"model","statusText":"GPT-4o активна"}
```

---

#### `setWidget` — обновить виджет

```json
{"type":"extension_ui_request","id":"ui-7","method":"setWidget",
 "widgetKey":"budget","widgetLines":["$0.50 / $10.00"],
 "widgetPlacement":"aboveEditor"}
```

`widgetPlacement`: `"aboveEditor"` | `"belowEditor"`

---

#### `setTitle` — установить заголовок окна/терминала

```json
{"type":"extension_ui_request","id":"ui-8","method":"setTitle",
 "title":"FAN Agent — анализ кода"}
```

---

#### `set_editor_text` — установить текст в редакторе

```json
{"type":"extension_ui_request","id":"ui-9","method":"set_editor_text",
 "text":"function hello() {\n  console.log('world')\n}"}
```

---

### Методы, не поддерживаемые в RPC

| Метод | Причина | Альтернатива |
|-------|---------|-------------|
| `custom()` | Требует TUI-рендеринг | Комбинация `select` + `input` + `editor` |
| `setFooter()` | Требует TUI | `setStatus()` + `setWidget()` |
| `setHeader()` | Требует TUI | `setTitle()` |
| `setEditorComponent()` | Требует TUI | `set_editor_text()` + `editor()` |
| `onTerminalInput()` | Нет терминала | — |
| `setTheme()` | Нет UI | — |
| `setWorkingMessage()` | Требует TUI | — |
| `setHiddenThinkingLabel()` | Требует TUI | — |

---

## Программный клиент (RpcClient)

FAN поставляется со встроенным TypeScript-клиентом для прямого использования в Node.js-приложениях.

### Установка

```bash
npm install @itone/fan-coding-agent
```

### Быстрый старт

```typescript
import { RpcClient } from "@itone/fan-coding-agent";

async function main() {
  const client = new RpcClient({
    cliPath: "/usr/local/bin/fan",
    provider: "openai",
    model: "gpt-4o",
  });

  // Подписка на streaming-события
  client.onEvent((event) => {
    if (event.type === "message_update") {
      process.stdout.write(event.assistantMessageEvent.textDelta || "");
    }
    if (event.type === "agent_end") {
      console.log("\n✅ Ответ готов!");
    }
  });

  await client.start();

  // Отправляем + ждём завершения
  const messages = await client.promptAndWait(
    "Проанализируй архитектуру проекта"
  );
  console.log(`Получено ${messages.length} сообщений`);

  // Проверяем состояние
  const state = await client.getState();
  console.log(`Модель: ${state.model?.id}`);

  await client.stop();
}
```

### Полное API

#### Конструктор

```typescript
interface RpcClientOptions {
  cliPath?: string;              // путь к fan CLI (по умолчанию: из PATH)
  cwd?: string;                  // рабочая директория процесса
  env?: Record<string, string>;  // доп. переменные окружения
  provider?: string;             // провайдер (например "openai")
  model?: string;                // модель (например "gpt-4o")
  noSession?: boolean;           // не сохранять сессию на диск
  sessionDir?: string;           // директория для хранения сессий
  additionalArgs?: string[];     // дополнительные CLI аргументы
}
```

---

## Обработка ошибок

### Формат ошибок

```json
// Ошибка выполнения команды
{"id":"req-1","type":"response","command":"set_model","success":false,
 "error":"Model not found: openai/gpt-5"}

// Ошибка парсинга команды (без id)
{"id":null,"type":"response","command":"parse","success":false,
 "error":"Failed to parse command: Unexpected token"}

// Ошибка валидации (например, пустое имя сессии)
{"id":"req-2","type":"response","command":"set_session_name","success":false,
 "error":"Session name cannot be empty"}
```

### Ошибки расширений

```json
{"type":"extension_error","extensionPath":".fan/extensions/my-ext",
 "event":"execute","error":"Failed to read file"}
```

### Таймауты Extension UI

Если клиент не отвечает на Extension UI запрос в течение `timeout`, метод возвращает значение по умолчанию:
- `select` → `undefined`
- `confirm` → `false`
- `input` → `undefined`
- `editor` → `undefined`

Если `signal` (AbortSignal) прерван — аналогичное поведение.

---

## Примеры интеграции

### Python

```python
import subprocess
import json

class FanRpcClient:
    def __init__(self, cli_path="fan"):
        self.proc = subprocess.Popen(
            [cli_path, "--mode", "rpc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        self._buffer = ""

    def send(self, cmd: dict):
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def read_line(self):
        while "\n" not in self._buffer:
            chunk = self.proc.stdout.readline()
            if not chunk:
                return None
            self._buffer += chunk
        idx = self._buffer.index("\n")
        line = self._buffer[:idx]
        self._buffer = self._buffer[idx + 1:]
        return json.loads(line)

    def prompt(self, message: str):
        self.send({"type": "prompt", "message": message})

    def wait_for_end(self) -> list:
        events = []
        while True:
            event = self.read_line()
            if event is None:
                break
            events.append(event)
            if event.get("type") == "agent_end":
                break
        return events

    def close(self):
        self.proc.terminate()
        self.proc.wait()
```

### Rust

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use serde_json::Value;

pub struct FanRpc {
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    _process: std::process::Child,
}

impl FanRpc {
    pub fn start() -> std::io::Result<Self> {
        let mut child = Command::new("fan")
            .arg("--mode").arg("rpc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            _process: child,
        })
    }

    pub fn send(&mut self, cmd: &Value) -> std::io::Result<()> {
        writeln!(self.stdin, "{}", serde_json::to_string(cmd)?)?;
        self.stdin.flush()?;
        Ok(())
    }

    pub fn read_line(&mut self) -> std::io::Result<Option<Value>> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(&line)?))
    }
}
```

---

## RPC vs WebSocket API

| Характеристика | RPC (stdio) | WebSocket API |
|---------------|-------------|---------------|
| **Транспорт** | stdin/stdout | WebSocket (ws://) |
| **Формат** | JSONL | JSON сообщения |
| **Аутентификация** | Не требуется | Bearer token |
| **Сессий** | 1 процесс = 1 сессия | Множество сессий |
| **Клиентов** | 1:1 | 1:N |
| **HTTP API** | Нет | Да (REST + WS) |
| **Для чего** | Встраивание, CI/CD | Веб-интерфейсы, мультиклиент |
| **Статус** | Стабильный | Стабильный |

**Когда выбрать RPC:**
- Вы пишете IDE-плагин или десктоп-приложение
- Нужен запуск по требованию (CI/CD)
- Не хотите запускать отдельный сервер
- Нужна минимальная задержка

**Когда выбрать WebSocket:**
- Нужно поддерживать несколько клиентов
- Уже есть веб-сервер FAN (`fan server`)
- Нужен REST API для управления сессиями

---

## Типы TypeScript

### RpcCommand

```typescript
type RpcCommand =
  // Prompting
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }

  // State
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_messages" }

  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }

  // Thinking
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }

  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }

  // Retry
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }

  // Bash
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "abort_bash" }

  // Session
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }

  // Commands
  | { id?: string; type: "get_commands" }

  // FAN Management
  | { id?: string; type: "get_routing_rules" }
  | { id?: string; type: "get_budget_status" }
  | { id?: string; type: "get_model_settings" }

  // Tokens
  | { id?: string; type: "generate_token"; name: string }
  | { id?: string; type: "list_tokens" }
  | { id?: string; type: "revoke_token"; tokenId: string };
```

### RpcSessionState

```typescript
interface RpcSessionState {
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}
```

### Extension UI Request

```typescript
type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select";
      title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm";
      title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input";
      title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor";
      title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify";
      message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus";
      statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget";
      widgetKey: string; widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };
```

### Extension UI Response

```typescript
type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }      // select, input, editor
  | { type: "extension_ui_response"; id: string; confirmed: boolean } // confirm
  | { type: "extension_ui_response"; id: string; cancelled: true };   // любой метод (отмена)
```

---

## Советы и best practices

### 1. JSONL reader: не используйте readline

```typescript
// ❌ НЕПРАВИЛЬНО — ломается на Unicode U+2028/U+2029
import readline from "node:readline";

// ✅ ПРАВИЛЬНО — ручной буфер с indexOf("\n")
let buffer = "";
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    try { handleMessage(JSON.parse(line)); } catch { /* skip bad lines */ }
  }
});
```

### 2. Дожидайтесь agent_end

Команда `prompt` — асинхронная. Всегда дожидайтесь события `agent_end` перед отправкой следующего `prompt`.

### 3. Используйте хелперы RpcClient

```typescript
const success = await client.waitForIdle(60000); // ждать до 60с
const events = await client.collectEvents(30000); // собрать все события
const messages = await client.promptAndWait("Запрос"); // prompt + collect
```

### 4. Extension UI в IDE-плагине

```typescript
client.onEvent((event) => {
  if (event.type === "extension_ui_request") {
    // Показываем UI пользователю
    showQuickPick(event.title, event.options)
      .then((value) => sendToStdin({
        type: "extension_ui_response",
        id: event.id,
        value
      }));
  }
});
```

### 5. Контекст сохраняется между промптами

```typescript
await client.promptAndWait("Здорова");
await client.promptAndWait("Как дела?"); // агент помнит контекст
```

### 6. Отслеживайте компактизацию

```typescript
client.onEvent((event) => {
  if (event.type === "compaction_start") console.log("Компактизация...");
  if (event.type === "compaction_end") console.log("Готово");
});
```

### 7. Добавление новой RPC-команды

Обновить 3 места:
1. `RpcCommand` union в `rpc-types.ts`
2. `RpcResponse` union (если есть data)
3. `case` в `handleCommand` в `rpc-mode.ts`

---

## Исходные файлы

| Файл | Назначение |
|------|-----------|
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | Все TypeScript типы |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | RPC обработчик |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | RpcClient класс |
| `packages/coding-agent/src/modes/rpc/jsonl.ts` | JSONL сериализация |
| `packages/coding-agent/src/modes/rpc/README.md` | Встроенная документация |
| `packages/coding-agent/src/modes/index.ts` | Barrel экспорт |
| `packages/coding-agent/src/main.ts` | Entry point + CLI парсинг |

---

*Документ создан на основе анализа исходного кода FAN v1.0.0. Актуальность: июнь 2026*