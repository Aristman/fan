# pi 0.68.0 — Changelog Summary

> Source: [0.68.0] — 2026-04-20 (с patch-сериями 0.67.2–0.67.68)

---

## Новые фичи

| Фича                                             | Описание                                                                                                                                                                                |
|--------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Working indicator для extensions**             | `ctx.ui.setWorkingIndicator()` — анимированный, статический или скрытый индикатор во время стриминга. Extensions полностью контролируют отображение.                                    |
| **`before_agent_start` → `systemPromptOptions`** | Extensions получают структурированные входы system prompt (`BuildSystemPromptOptions`), не нужно переоткрывать ресурсы.                                                                 |
| **`/clone`**                                     | Дублирует текущую ветку в новую сессию (в отличие от `/fork`, который разветвляет от конкретного сообщения). Extensions могут выбирать `position: "before" \| "at"` через `ctx.fork()`. |
| **Настраиваемые хоткеи**                         | Scoped model selector и session-tree filter теперь можно ремапить в `keybindings.json`.                                                                                                 |
| **`after_provider_response` hook**               | Extensions могут инспектировать HTTP статус и хедеры провайдера до начала стрима.                                                                                                       |
| **`renderShell: "self"`**                        | Инструменты (built-in и extension) могут взять рендеринг внешней оболочки на себя вместо стандартного бокса. Полезно для диффов.                                                        |
| **`--no-context-files` (`-nc`)**                 | Отключает автозагрузку AGENTS.md / CLAUDE.md для чистого запуска.                                                                                                                       |
| **`--append-system-prompt` × N**                 | Несколько флагов, каждый добавляется к system prompt через двойной перенос строки.                                                                                                      |
| **Prompt templates: `argument-hint`**            | Frontmatter поле показывает `<обязательный>` и `[необязательный]` аргументы в автокомплите `/`.                                                                                         |
| **OSC 8 hyperlinks**                             | Markdown-ссылки в терминале рендерятся как кликабельные OSC 8 (на поддерживающих терминалах).                                                                                           |
| **Compact startup header**                       | Запуск сжат в строчку, `Ctrl+O` — развернуть список AGENTS.md, templates, skills, extensions.                                                                                           |
| **Bedrock bearer token**                         | `AWS_BEARER_TOKEN_BEDROCK` для Converse API без локальных SigV4 credentials.                                                                                                            |
| **Inline extensions в `main()`**                 | Extension factories можно передавать прямо в `main()` для embedded интеграций.                                                                                                          |
| **Kitty super-ключи**                            | Хоткеи с Super модификатором (`super+k`, `ctrl+super+k` и т.д.).                                                                                                                        |
| **`PI_OAUTH_CALLBACK_HOST`**                     | OAuth callback сервер может биндиться на кастомный интерфейс вместо 127.0.0.1.                                                                                                          |
| **`loadProjectContextFiles()` exported**         | Утилита для Extensions/SDK — discover контекст-файлы без полного DefaultResourceLoader.                                                                                                 |

---

## Изменения в текущих фичах

| Область                               | Что изменилось                                                                                                                                                          |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **SDK: tools → string[]**             | `createAgentSession({ tools })` теперь принимает `string[]` имён вместо `Tool[]`. Migration: `["read", "bash"]` вместо `[readTool, bashTool]`.                          |
| **Убраны предстроенные Tool exports** | `readTool`, `bashTool`, `editTool`, `codingTools` и прочие удалены. Используй фабрики: `createReadTool(cwd)`, `createCodingTools(cwd)` и т.д.                           |
| **`cwd` обязателен**                  | `DefaultResourceLoader`, `loadProjectContextFiles()`, `loadSkills()` больше не используют `process.cwd()` — путь передаётся явно.                                       |
| **`pi update` быстрее**               | Batch-обновления npm + bounded parallelism для git-пакетов.                                                                                                             |
| **Bedrock**                           | Пропускает `maxTokens` при неизвестных лимитах, не отправляет `temperature` если не задана — экономит TPM квоту. Уважает `model.baseUrl` для VPC/proxy.                 |
| **OpenAI prompt caching**             | `session_id` + `x-client-request-id` хедеры для cache affinity. OpenAI-compatible (litellm, Fireworks) тоже. `prompt_cache_retention: "24h"` для direct api.openai.com. |
| **Anthropic caching**                 | `cache_control` breakpoint на последнем tool definition — схемы кэшируются независимо от транскрипта.                                                                   |
| **`claude-opus-4-7`**                 | Новый добавлен. Adaptive thinking + `xhigh` reasoning поддерживается через Anthropic и Bedrock.                                                                         |
| **`/compact`**                        | Использует thinking level сессии вместо hardcoded `high` — больше no errors на моделях с `medium` thinking.                                                             |
| **`find` tool**                       | Полнофайловые glob паттерны (`src/**/*.spec.ts`) теперь работают. `.gitignore` — иерархический, без кросс-директориальных конфликтов.                                   |
| **`grep`**                            | Больше не stalls на `context=0` — форматирование из ripgrep JSON вместо синхронных file reads.                                                                          |
| **Edit diff preview**                 | Стабильный рендеринг через `renderShell: "self"`, не исчезает при permission dialogs и replay.                                                                          |
| **`session_shutdown`**                | Содержит `reason` и `targetSessionFile` — можно различить quit, reload, new-session, resume, fork. Срабатывает на SIGHUP/SIGTERM.                                       |
| **Auto-retry**                        | Живой обратный отсчёт при backoff вместо статического сообщения. `Network connection lost.` теперь retryable.                                                           |
| **Windows**                           | `Ctrl+Z` больше не крашит. pnpm detection зафиксен для `\.pnpm\` store paths.                                                                                           |
| **HTML export**                       | `T`/`O` для toggle thinking/tools вместо браузерных `Ctrl+T`/`Ctrl+O`. Text selection не триггерит collapse. Отступы сохраняются.                                       |
| **Kill orphan processes**             | Detached bash-процессы убиваются при shutdown.                                                                                                                          |
| **xterm uppercase**                   | `Shift+letter` больше не глушится в интерактивном редакторе.                                                                                                            |
| **Hyperlinks safety**                 | Неизвестные терминалы и tmux/screen — гиперссылки off по дефолту, URL не пропадают.                                                                                     |

---

## Breaking Changes

1. **`tools: string[]`** — если есть SDK код, мигрировать с `Tool[]` на имённый allowlist.
2. **Убраны предэкспорты** — `readTool`, `bashTool` и т.д. удалены из `@mariozechner/pi-coding-agent`. Использовать
   фабрики с явным `cwd`.
3. **`cwd` обязателен везде** — `process.cwd()` fallback убран. Проверить все вызовы `DefaultResourceLoader`,
   `loadProjectContextFiles`, `loadSkills`.
