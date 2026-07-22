# Интеграция lavish-axi в FAN — техническое исследование

## Метаданные
- **Дата:** 2026-07-22
- **Тип идеи:** Техническая
- **Глубина:** Стандартный
- **Статус:** Исследовано

## 1. Ядро идеи

> Хочу добавить расширение или скилл для axi/lavish

### Цель
Интегрировать lavish-axi в экосистему FAN для создания визуальных HTML-артефактов с human-in-the-loop ревью: планы, диаграммы, сравнения — с возможностью аннотирования и отправки фидбека агенту через браузер.

### Контекст
lavish-axi — это AXI-инструмент (Agent eXperience Interface) с 2.1k ⭐ на GitHub, MIT-лицензия, npm-пакет. Решает проблему «агент сгенерировал HTML, но человек не может удобно дать обратную связь». Вместо скриншотов и длинных текстовых ответов — пользователь аннотирует элементы прямо в браузере, редактирует Mermaid-диаграммы как whiteboard, и отправляет структурированный фидбек через `lavish-axi poll`.

FAN как локальный AI-агент — идеальная платформа для интеграции: у него есть и TUI, и веб-дашборд, и оркестратор с воркерами, которые могут генерировать артефакты.

---

## 2. Исследование

### 2.1 Проблема и аудитория

**Проблема:** Когда агент генерирует сложный HTML-артефакт (план, диаграмму, сравнительную таблицу), пользователь получает файл и вынужден давать обратную связь через текст — «поменяй цвет в третьем столбце», «стрелка от блока A к блоку B должна быть пунктирной». Это медленно, неточно и теряет интерактивность HTML.

**Для кого:** Пользователи FAN — разработчики, которые хотят визуальное ревью артефактов от агентов с последующей итерацией.

**Насколько острая:** Средняя. Проблема возникает каждый раз при генерации визуального контента. Текущий workaround — ручное редактирование HTML или описание изменений текстом.

### 2.2 Текущее состояние

**lavish-axi уже работает** с 4 агентами через SessionStart hooks:
- Claude Code — через `.claude/settings.json`
- Codex — через env detection
- OpenCode — через axi-sdk-js
- GitHub Copilot CLI — через `~/.copilot/hooks/`

**Для FAN интеграции нет.** Ни в upstream fan, ни в кастомных расширениях.

### 2.3 Источники исследования

| Источник | Релевантность | Ключевые выводы |
|----------|--------------|----------------|
| [lavish-axi GitHub](https://github.com/kunchenguid/lavish-axi) | Высокая | CLI API, skill format, playbook system, AXI SDK pattern |
| [AXI: Agent eXperience Interface](https://axi.md/) | Высокая | 10 принципов проектирования, бенчмарки (100% success, $0.074/task) |
| `packages/coding-agent/docs/extensions.md` | Высокая | FAN Extension API: lifecycle hooks, registerTool, commands |
| `skills/*/SKILL.md` (12 скиллов FAN) | Высокая | Формат FAN-скиллов, frontmatter, структура |
| `tools/fan-store-server/GUIDE.md` | Средняя | Публикация в FAN Store: .tar.gz, index.json, авто-детекция типа |
| `extensions/fan-orchestrator/` | Высокая | Паттерн регистрации tools, subprocess spawning |

---

## 3. Матрица неопределённости

| Аспект | Что знаем | Что не знаем | Уверенность |
|--------|-----------|---------------|-------------|
| lavish-axi CLI | Полная документация, MIT, 43 релиза | Поведение на Windows (long-poll, file watching) | 0.85 |
| FAN Extension API | Зрелый API: registerTool, lifecycle hooks, commands | — | 0.95 |
| FAN Skill format | SKILL.md + frontmatter, загрузка через skills.ts | Совместимость frontmatter lavish с FAN | 0.80 |
| Polling mechanism | `lavish-axi poll` — long-poll, TOON output, heartbeat | Интеграция blocking poll с FAN tool execution model | 0.70 |
| FAN Store | .tar.gz архивы, авто-детекция типа, index.json | — | 0.90 |
| Оркестратор | Workers через subprocess, stdin/stdout JSONL | Как воркеру блокировать на poll без таймаута | 0.65 |
| Плейбуки | 7 playbook-ов с guidance | Нужно ли адаптировать playbook guidance для FAN-контекста | 0.80 |
| TOON формат | ~40% экономия токенов, LLM-readable | Нужен ли парсер или модель читает TOON нативно | 0.85 |

**Средняя уверенность по блокирующим аспектам:** 0.77 → требуется уточнение по polling-интеграции.

### Матрица пробелов знаний

- 🔴 **Блокирующие:**
  - Как интегрировать long-poll (`lavish-axi poll`) с моделью исполнения tools в FAN — tools блокируют воркер до возврата результата
  - Работает ли lavish-axi на Windows (Node.js, file paths, process spawning)

- 🟡 **Важные:**
  - Нужен ли отдельный tool `lavish_open` / `lavish_poll` / `lavish_end` или один tool `lavish` с subcommands
  - Как воркер-агент должен генерировать HTML — встроенный навык или отдельный плейбук
  - SessionStart hook для FAN — через какой lifecycle event (`session_start`?)

- 🟢 **Рекомендательные:**
  - TOON vs JSON для output — FAN уже использует JSON, TOON даёт экономию, но требует зависимости
  - Стоит ли поддерживать `lavish-axi share` (публикация на ht-ml.app) — опциональная фича
  - Интеграция с дашбордом — показывать артефакт в WebView вместо отдельного браузера

### Матрица рисков

| Риск | Вероятность | Влияние | Категория |
|------|-------------|---------|-----------|
| lavish-axi не работает на Windows | Низкая | Критичное | Технический |
| Long-poll блокирует воркер навечно | Средняя | Среднее | Технический |
| Пользователь не открывает браузер — poll висит | Средняя | Низкое | Ресурсный |
| Конфликт портов (4387 по умолчанию) | Низкая | Среднее | Технический |
| Модель генерирует невалидный HTML — layout gate блокирует | Средняя | Низкое | Технический |
| Зависимость от npm/npx — нет offline-режима | Низкая | Среднее | Ресурсный |

---

## 4. SWOT-анализ

### Strengths (Сильные стороны) 🔵

- **Зрелый upstream.** lavish-axi — 2.1k ⭐, 43 релиза, активная разработка (последний — сегодня). MIT-лицензия. Не нужно писать визуализатор с нуля.
- **AXI-принципы.** Token-efficient output (TOON), content-first, contextual disclosure — всё это снижает расход токенов на ~40% vs JSON-based подходы.
- **FAN Extension API готов.** registerTool, lifecycle hooks (`session_start`, `session_shutdown`), commands — всё есть для полноценной интеграции.
- **Двойной формат.** Skill для быстрого старта (агент учится из SKILL.md) + Extension для глубокой интеграции (tools, hooks, ambient context).

### Weaknesses (Слабые стороны) 🟠

- **Long-poll — чужеродный паттерн для FAN.** FAN tools возвращают результат сразу. `lavish-axi poll` блокирует процесс до действия пользователя — это требует special handling в tool execution model.
- **Внешний процесс.** lavish-axi — отдельный Node.js-сервер с собственным lifecycle. FAN должен управлять его запуском/остановкой, что добавляет complexity.
- **Windows-совместимость не гарантирована.** lavish-axi тестировался преимущественно на macOS/Linux. File watching, process spawning и path resolution могут вести себя иначе на Windows.
- **Зависимость от npx.** Требует Node.js в PATH. Для FAN-пользователей без Node.js — дополнительный setup step.

### Opportunities (Возможности) 🟢

- **Уникальный DX для FAN.** Ни один конкурент (Claude Code, Codex, Copilot) не имеет встроенного визуального ревью. FAN + lavish-axi = первый агент с native HTML artifact review.
- **FAN Store distribution.** Публикация как `fan store install fan-lavish` — все пользователи FAN получают доступ одним командой.
- **Оркестратор-интеграция.** Воркеры `implement` и `docs-impl` могут генерировать артефакты, координатор открывает ревью, человек аннотирует — итерация замыкается автоматически.
- **Dashboard WebView.** FAN Dashboard (Lit + Vite) может встроить iframe с lavish-axi артефактом — без открытия отдельного браузера.

### Threats (Угрозы) 🔴

- **lavish-axi может изменить API.** Upstream активен, breaking changes возможны. Но semantic versioning + `lavish-axi update` (AXI SDK self-updater) митигируют.
- **Альтернативные визуализаторы.** Figma MCP, Excalidraw MCP, v0.dev — все предлагают визуальную коллаборацию. Но lavish-axi выигрывает на token efficiency и local-first.
- **Сложность поддержки.** Два формата (Skill + Extension), 3 плейбука, polling mechanism — есть что поддерживать.

---

## 5. Альтернативы

### 5.1 Альтернатива: Только Skill (без Extension)

**Суть:** Написать SKILL.md, который инструктирует агента использовать `bash` для запуска `npx -y lavish-axi`. Аналогично тому, как lavish распространяется для Claude Code.

**Плюсы:**
- Минимальные трудозатраты — 1-2 часа на SKILL.md
- Не нужен runtime-код, только markdown
- Легко поддерживать и обновлять

**Минусы:**
- Нет ambient context (live sessions при старте)
- Нет управляемого polling — агент вызывает `bash lavish-axi poll` и блокируется, нет graceful handling
- Нет integration с оркестратором — воркеры не знают о lavish
- Нет session lifecycle management (сервер не останавливается автоматически)

| Параметр | Оценка |
|----------|--------|
| Сложность | Низкая |
| Время | 2-4 часа |
| Риски | Средние (нет управления процессом) |

### 5.2 Альтернатива: Только Extension (без Skill)

**Суть:** TypeScript-расширение, регистрирующее tools: `lavish_open`, `lavish_poll`, `lavish_end`, `lavish_playbook`. Lifecycle hooks для session management. Без отдельного SKILL.md.

**Плюсы:**
- Полный контроль над CLI-вызовами
- Ambient context через `session_start` hook
- Корректный polling с timeout и heartbeat
- Интеграция с оркестратором

**Минусы:**
- Сложнее в разработке (3-5 дней)
- Agent не получает «нарративного» guidance из SKILL.md — только tool descriptions
- Нет slash-команды `/lavish` для ручного вызова

| Параметр | Оценка |
|----------|--------|
| Сложность | Высокая |
| Время | 3-5 дней |
| Риски | Низкие (полный контроль) |

### 5.3 Альтернатива: Skill + Extension (комбинированный подход) — РЕКОМЕНДУЕТСЯ

**Суть:** Bundle-пакет для FAN Store, содержащий:
1. **Skill** (`SKILL.md`) — инструкции для агента: когда использовать, workflow, playbook router, visual guidance
2. **Extension** (`index.ts`) — регистрирует tools (`lavish_open`, `lavish_poll`, `lavish_end`, `lavish_playbook`) + session lifecycle hooks

**Плюсы:**
- Skill даёт нарративный контекст (когда/зачем использовать, как генерировать HTML)
- Extension даёт управляемые tools и ambient context
- Slash-команда `/lavish` + автовызов моделью
- Полная интеграция с оркестратором
- Один пакет в FAN Store: `fan store install fan-lavish`

**Минусы:**
- Больше кода для написания и поддержки
- Два артефакта (SKILL.md + index.ts) в одном пакете

| Параметр | Оценка |
|----------|--------|
| Сложность | Средняя |
| Время | 4-6 дней |
| Риски | Низкие |

### 5.4 Альтернатива: MCP-сервер (lavish-axi через MCP)

**Суть:** Обернуть lavish-axi в MCP-сервер, зарегистрировать в `mcp.json`. Tools становятся `mcp__lavish__open`, `mcp__lavish__poll` и т.д.

**Плюсы:**
- Стандартный протокол интеграции
- Автоматическая регистрация tools
- Schema-based parameters

**Минусы:**
- MCP schema overhead (~2.3x input tokens vs AXI/CLI)
- Нет session hooks — MCP не поддерживает lifecycle events
- Нет skill/guidance — только tool schemas
- Противоречит AXI-философии (CLI-first, token-efficient)

| Параметр | Оценка |
|----------|--------|
| Сложность | Средняя |
| Время | 3-4 дня |
| Риски | Средние (token overhead, нет hooks) |

### 5.5 Сравнительная матрица

| Критерий | Skill only | Extension only | Skill + Extension | MCP-сервер |
|----------|-----------|---------------|-------------------|-----------|
| Нарративный guidance | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐ |
| Управление tools | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Ambient context | ⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐ |
| Token efficiency | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| Сложность разработки | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| Интеграция с оркестратором | ⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| FAN Store publishing | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Итого** | **3.4** | **3.6** | **4.4** | **2.6** |

---

## 6. Рекомендация

### Что делать: Skill + Extension (Bundle для FAN Store)

**Уверенность:** 0.85/1.0

**Обоснование:**
1. Skill даёт agent-ам нарративный контекст (когда генерировать HTML, как применять плейбуки, visual guidance) — это критично для качества артефактов. Без SKILL.md модель не знает «зачем» и «когда».
2. Extension даёт управляемые tools (`lavish_open`, `lavish_poll`, `lavish_end`) — без этого агент вызывает bash и надеется на лучшее. Polling без таймаута — рискованный паттерн.
3. Bundle (skill + extension) — поддерживаемый формат FAN Store. Авто-детекция по наличию и `SKILL.md`, и `index.ts`.

**Компромиссы:**
- Принимаем: больше кода для поддержки. Окупается качеством DX и надёжностью.
- Отклоняем: MCP-сервер. Token overhead (2.3x) и отсутствие lifecycle hooks делают его непригодным для polling-based инструмента.

**Предупреждения:**
- ⚠️ Long-poll требует special handling. FAN tool execution model предполагает возврат результата. `lavish_poll` tool должен запускать `lavish-axi poll` как subprocess и ждать результата с heartbeat-таймаутом. Если poll прерван (abort signal) — gracefully завершать.
- ⚠️ Windows-совместимость нужно проверить перед релизом. `lavish-axi` использует Node.js `child_process.spawn()` и file watching — на Windows пути и сигналы могут отличаться.

---

## 7. Техническая архитектура

### Архитектура

```
┌─────────────────────────────────────────────────────┐
│                    FAN Runtime                       │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │         fan-lavish Extension                 │    │
│  │                                              │    │
│  │  session_start → ambient context (sessions)  │    │
│  │  session_shutdown → stop lavish server       │    │
│  │                                              │    │
│  │  Tools:                                      │    │
│  │   lavish_open   → npx -y lavish-axi <file>   │    │
│  │   lavish_poll   → lavish-axi poll <file>     │    │
│  │   lavish_end    → lavish-axi end <file>      │    │
│  │   lavish_playbook → lavish-axi playbook [id] │    │
│  │   lavish_design  → lavish-axi design         │    │
│  └──────────────┬───────────────────────────────┘    │
│                  │ subprocess spawn                   │
│                  ▼                                    │
│  ┌─────────────────────────────────────────────┐    │
│  │         lavish-axi (Node.js process)         │    │
│  │                                              │    │
│  │  Server (port 4387)                          │    │
│  │   ├── Serves HTML artifact in iframe         │    │
│  │   ├── Injects annotation SDK                 │    │
│  │   ├── Layout audit (severe failures only)    │    │
│  │   └── Long-poll endpoint for feedback        │    │
│  │                                              │    │
│  │  State: ~/.lavish-axi/state.json             │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │         fan-lavish Skill (SKILL.md)          │    │
│  │                                              │    │
│  │  When to use → Workflow → Playbooks →        │    │
│  │  Visual guidance → Commands & rules          │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │
         ▼ Browser
┌──────────────────────────────────────────────┐
│  Lavish Editor (http://127.0.0.1:4387)       │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  HTML Artifact (iframe)               │    │
│  │   + Annotation SDK                    │    │
│  │   + Mermaid whiteboard                │    │
│  │   + Layout audit                      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Chrome: composer, annotations, send to agent│
└──────────────────────────────────────────────┘
```

### Стек технологий

| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| Extension | TypeScript | Стандарт для FAN extensions, jiti loader |
| CLI wrapper | `child_process.spawn()` | lavish-axi — отдельный процесс, не библиотека |
| Skill | Markdown (SKILL.md) | FAN skill format |
| Bundle | .tar.gz | FAN Store format, авто-детекция bundle (есть и skill, и extension) |
| Output parsing | JSON (stdout от lavish-axi) | TOON тоже читается LLM, но JSON надёжнее для tool result |

### Интеграция

**Extension lifecycle:**

```typescript
// index.ts
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

export default function fanLavish(fan: ExtensionAPI) {
  // Session start → inject ambient context
  fan.on("session_start", async (event, ctx) => {
    const sessions = await getOpenSessions();
    if (sessions.length > 0) {
      fan.injectMessage({
        role: "system",
        content: formatAmbientContext(sessions),
      });
    }
  });

  // Session shutdown → cleanup
  fan.on("session_shutdown", async () => {
    await stopLavishServer();
  });

  // Register tools
  fan.registerTool({ name: "lavish_open", ... });
  fan.registerTool({ name: "lavish_poll", ... });
  fan.registerTool({ name: "lavish_end", ... });
  fan.registerTool({ name: "lavish_playbook", ... });
  fan.registerTool({ name: "lavish_design", ... });
}
```

**Tool: lavish_poll (long-poll handling):**

```typescript
fan.registerTool({
  name: "lavish_poll",
  description: "Wait for user feedback on a Lavish Editor artifact",
  parameters: Type.Object({
    file: Type.String({ description: "Path to HTML artifact" }),
    agent_reply: Type.Optional(Type.String({ description: "Agent's reply to show in browser" })),
  }),
  async execute(toolCallId, params, signal) {
    const args = ["-y", "lavish-axi", "poll", params.file];
    if (params.agent_reply) args.push("--agent-reply", params.agent_reply);

    const result = await execSubprocess("npx", args, {
      signal,
      timeoutMs: 0, // no timeout — long-poll
      heartbeatMs: 30_000, // stderr heartbeat
    });

    return {
      content: [{ type: "text", text: result.stdout }],
    };
  },
});
```

### Структура пакета

```
fan-lavish/
├── SKILL.md                    # Skill: guidance для агентов
├── index.ts                    # Extension: tools + lifecycle
├── package.json                # Манифест (fan: { extensions: ["./index.ts"], skills: true })
├── config.example.json         # Пример конфигурации (port, no-open, и т.д.)
└── README.md                   # Документация
```

---

## 8. Оценка трудозатрат

| Задача | Сложность | Оценка времени | Зависимости |
|--------|-----------|---------------|-------------|
| Написать SKILL.md (адаптация lavish skill для FAN) | Низкая | 2-3 часа | Изучение lavish skill format |
| Написать Extension (index.ts): 5 tools + 2 hooks | Средняя | 1-2 дня | FAN Extension API |
| Long-poll subprocess wrapper | Средняя | 4-6 часов | Тестирование на Windows |
| Тестирование: TUI mode | Низкая | 2-3 часа | Extension готов |
| Тестирование: Dashboard mode | Средняя | 3-4 часа | Extension готов |
| Тестирование: Оркестратор (воркеры) | Средняя | 3-4 часа | Extension готов |
| Упаковка для FAN Store (.tar.gz + index.json) | Низкая | 1-2 часа | Всё готово |
| Windows compatibility fixes | Средняя | 2-4 часа | lavish-axi на Windows |

**Итого:** ~4-6 дней (стандартный темп, без спешки)
**MVP (Skill only):** ~4-6 часов

---

## 9. План действий

### Приоритеты (MoSCoW)

**Must Have (Обязательно):**
- [ ] SKILL.md — guidance для агентов (when to use, workflow, playbooks, visual guidance)
- [ ] Extension: tools `lavish_open`, `lavish_poll`, `lavish_end`
- [ ] Extension: `session_start` hook для ambient context
- [ ] Extension: `session_shutdown` hook для cleanup
- [ ] Базовое тестирование в TUI mode

**Should Have (Желательно):**
- [ ] Tools `lavish_playbook` и `lavish_design`
- [ ] Тестирование с оркестратором (воркеры генерируют артефакты)
- [ ] Windows compatibility verification
- [ ] Конфигурация (port, no-open, state-dir)

**Could Have (Возможно):**
- [ ] Dashboard integration (iframe с артефактом в WebView)
- [ ] `lavish-axi share` support (публикация на ht-ml.app)
- [ ] `lavish-axi export` support (standalone HTML)
- [ ] TOON output parsing (если даст измеримую экономию токенов)

**Won't Have (Не входит):**
- [ ] MCP-сервер — token overhead неприемлем для polling-based инструмента
- [ ] Собственный HTML-рендерер — используем upstream lavish-axi
- [ ] Интеграция с `lavish-design` (внутренний brand-скилл) — не нужен для FAN

### Шаги реализации

| # | Действие | Зависимости | Срок | Статус |
|---|----------|-------------|------|--------|
| 1 | Проверить lavish-axi на Windows (install, open, poll, end) | — | 2 часа | TODO |
| 2 | Написать SKILL.md (адаптация upstream skill для FAN) | #1 | 3 часа | TODO |
| 3 | Написать Extension skeleton (index.ts, package.json) | #1 | 2 часа | TODO |
| 4 | Реализовать tools: lavish_open, lavish_poll, lavish_end | #3 | 1 день | TODO |
| 5 | Реализовать session_start/session_shutdown hooks | #3 | 4 часа | TODO |
| 6 | Реализовать lavish_playbook и lavish_design tools | #4 | 4 часа | TODO |
| 7 | Тестирование: TUI mode (ручной прогон workflow) | #4, #5 | 3 часа | TODO |
| 8 | Тестирование: оркестратор (implement → lavish → poll → iterate) | #7 | 4 часа | TODO |
| 9 | Упаковка в .tar.gz для FAN Store | #8 | 2 часа | TODO |
| 10 | Публикация в FAN Store + README | #9 | 2 часа | TODO |

---

## 10. Adoption

### Шаги внедрения

1. Локальная установка: скопировать fan-lavish в `~/.fan/agent/extensions/fan-lavish/` + `~/.fan/agent/skills/lavish/`
2. Убедиться что Node.js ≥ 18 в PATH (для `npx -y lavish-axi`)
3. Перезапустить FAN — extension auto-discovery подхватит
4. Проверить: `/lavish plan for my project` — должен открыться браузер с HTML-артефактом

### Rollback стратегия

- Удалить `~/.fan/agent/extensions/fan-lavish/` и `~/.fan/agent/skills/lavish/`
- Перезапустить FAN
- lavish-axi server останавливается автоматически (idle timeout 30 минут) или вручную: `lavish-axi stop`

---

## 11. Приложения

### Дополнительные материалы

- [lavish-axi GitHub](https://github.com/kunchenguid/lavish-axi) — исходный код, README, AGENTS.md
- [AXI: 10 Principles](https://axi.md/) — философия дизайна agent-эргономичных CLI
- [FAN Extension API docs](../../../../packages/coding-agent/docs/extensions.md) — полная документация
- [FAN Store Guide](../../../../tools/fan-store-server/GUIDE.md) — публикация пакетов

### Глоссарий

| Термин | Определение |
|--------|------------|
| AXI | Agent eXperience Interface — 10 принципов для CLI, эргономичных для агентов |
| TOON | Token-Oriented Object Notation — компактный формат сериализации (~40% экономия vs JSON) |
| Playbook | Набор guidance для конкретного типа артефакта (diagram, plan, comparison и т.д.) |
| Long-poll | HTTP-запрос, который блокируется до появления данных (в lavish-axi — до действия пользователя) |
| Ambient context | Контекст, инжектируемый в начало сессии агента (live sessions, guidance) |
| Layout gate | Проверка рендеринга: браузер не показывает артефакт, пока не доказано отсутствие severe layout failures |
| Bundle | FAN Store тип пакета: содержит и extension, и skill |

---

*Создано: idea-lab skill*
*Глубина: Стандартный*
*Исходный запрос: «хочу добавить расширение или скилл для axi/lavish»*
