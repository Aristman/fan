# Pipeline Report: Интеграция lavish-axi в FAN

> **Дата:** 2026-07-22
> **Ветка:** FAN-NEW-EXT-LAVISH
> **Roadmap:** docs/features/lavish-axi-integration/roadmap.md

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 13 |
| Реализовано (✅) | 13 |
| Провалено (❌) | 0 |
| Коммитов | 3 |
| Сборка | PASS |
| Тесты проекта | 511 pass, 0 fail |

## Стратегия коммитов

Пачками по этапам: 3 коммита (Foundation, Expansion, Polish).

## Коммиты

| # | SHA | Сообщение |
|---|-----|-----------|
| 1 | `abf1f26` | feat(fan-lavish): Stage 1 Foundation — extension core + skill |
| 2 | `38740b5` | feat(fan-lavish): Stage 2 Expansion — config, Windows compat, README |
| 3 | `124fd20` | feat(fan-lavish): Stage 3 Polish — FAN Store packaging |

## Функции

| Функция | Статус | Коммит | Попыток |
|---------|--------|--------|---------|
| F-1.1 [INTEG]: CLI auto-detect | ✅ | abf1f26 | 1 |
| F-1.2 [API]: Tool registration | ✅ | abf1f26 | 1 |
| F-1.3 [API]: Core subcommands open/poll/end | ✅ | abf1f26 | 1 |
| F-1.4 [API]: Subcommands playbook/info | ✅ | abf1f26 | 1 (с F-1.3) |
| F-1.5 [INTEG]: session_start hook | ✅ | abf1f26 | 1 |
| F-1.6 [INTEG]: session_shutdown hook | ✅ | abf1f26 | 1 |
| F-1.7 [CLI]: SKILL.md | ✅ | abf1f26 | 1 |
| F-1.8 [CLI]: Playbook support | ✅ | abf1f26 | 1 (с F-1.3) |
| F-2.1 [API]: Subcommands design/export | ✅ | abf1f26 | 1 (с F-1.3) |
| F-2.2 [DATA]: config.json | ✅ | 38740b5 | 1 |
| F-2.3 [INTEG]: Windows compat | ✅ | 38740b5 | 1 |
| F-2.4 [CLI]: README.md | ✅ | 38740b5 | 1 |
| F-3.1 [CLI]: FAN Store packaging | ✅ | 124fd20 | 1 |

## Детали реализации

### Этап 1: Foundation (MVP)

#### F-1.1 [INTEG]: CLI auto-detect
- **Реализация:** `detectCli()` — 3-step chain: `where`/`which` → `npm root -g` + `existsSync` → `npx -y` fallback. Модульный кеш `cachedCli`. 2s timeout на каждый шаг.
- **Заметка:** `killProcessTree()` helper добавлен в F-2.3 для Windows taskkill fallback.

#### F-1.2 [API]: Tool registration
- **Реализация:** `fan.registerTool()` с `name: "lavish"`, TypeBox schema (7 subcommands в union literal + 6 optional полей), 6 promptGuidelines.
- **Заметка:** `details: undefined` добавлен для совместимости с `AgentToolResult<T>`.

#### F-1.3 [API]: Core subcommands
- **Реализация:** Полный switch/case для всех 7 subcommands. `poll` использует `executeLavishPoll()` (без timeout), остальные — `executeLavish()` (timeout 15s). Heartbeat forwarding через `onUpdate`.
- **Бонус:** F-1.4 (playbook/info) и F-2.1 (design/export) реализованы в том же switch — одна итерация implement.

#### F-1.5 [INTEG]: session_start hook
- **Реализация:** `fan.on("session_start")` перед `registerTool()`. Вызывает `executeLavish([], ctx.signal, 5_000)`. Inject через `ctx.ui.notify()` (не `injectMessage` — метод не существует в API).
- **Адаптация:** Roadmap указывал `ctx.injectMessage()` → использован `ctx.ui.notify()` (доступный метод).

#### F-1.6 [INTEG]: session_shutdown hook
- **Реализация:** `fan.on("session_shutdown")` после `registerTool()`. Вызывает `executeLavish(["stop"], undefined, 5_000)`. Best-effort try-catch.
- **Исправление:** Первая реализация использовала `["end", "--all"]` → исправлено на `["stop"]` (правильная команда для shutdown сервера).

#### F-1.7 [CLI]: SKILL.md
- **Реализация:** Frontmatter (`name: lavish`, description ≤1024 chars, `argument-hint`). Body: When to Use/NOT, Workflow (7 steps), Playbook Router (3 playbooks), Visual Guidance (6 rules), Commands Reference (7 commands), Important Rules.

#### F-1.8 [CLI]: Playbook support
- **Реализация:** Playbook-ы работают через upstream `lavish-axi playbook <id>`. Extension передаёт stdout как-is. Subcommand реализован в F-1.3.

### Этап 2: Expansion

#### F-2.1 [API]: Subcommands design/export
- **Реализация:** Реализованы вместе с F-1.3. `design` → `executeLavish(["design"])`. `export` → `executeLavish(["export", file, --out?])`.

#### F-2.2 [DATA]: Конфигурация
- **Реализация:** `loadConfig()` читает `config.json` через `dirname(fileURLToPath(import.meta.url))` + `join(__dirname, "config.json")`. Try-catch с дефолтами. Env vars: `LAVISH_AXI_PORT`, `LAVISH_AXI_NO_OPEN`.
- **Файл:** `config.example.json` с `{ "port": 4387, "noOpen": false }`.

#### F-2.3 [INTEG]: Windows-совместимость
- **Реализация:** `killProcessTree()` helper — `taskkill /F /T /PID` на Windows, `process.kill(pid, "SIGKILL")` на Unix. Используется в обоих `killProc` closures.

#### F-2.4 [CLI]: README.md
- **Реализация:** 7 секций (description, requirements, installation, quick start, configuration, commands, troubleshooting). 2 способа установки (FAN Store + manual). 5 troubleshooting записей.

### Этап 3: Polish & Release

#### F-3.1 [CLI]: FAN Store packaging
- **Реализация:** `package.json` с `fan.extensions: ["./index.ts"]`, `fan.skills: true`. Архив `fan-lavish-1.0.0.tar.gz` (gitignored). `.gitignore` обновлён.

## Финальная верификация

- **Вердикт:** PASS
- **Сборка (`npm run build`):** PASS — 10 пакетов, 0 ошибок
- **Тесты (`npm test`):** 511 pass, 0 fail, 8 skipped
- **TypeScript strict:** PASS — 0 ошибок
- **Adversarial probing:** PASS — edge cases (pid=0, timeout race, already-aborted signal), no dead code, no security issues
- **Smoke test:** Skipped — lavish-axi CLI не установлен для runtime-тестирования

## Изменённые файлы

- `extensions/fan-lavish/index.ts` — Extension: CLI detect, tool registration, subcommands, lifecycle hooks
- `extensions/fan-lavish/SKILL.md` — Skill: narrative guidance для агентов
- `extensions/fan-lavish/package.json` — FAN Store manifest
- `extensions/fan-lavish/config.example.json` — Пример конфигурации
- `extensions/fan-lavish/README.md` — Документация (7 секций, troubleshooting)
- `.gitignore` — Исключение `extensions/*.tar.gz`

## Проблемы

| # | Функция | Проблема | Решение |
|---|---------|----------|---------|
| 1 | F-1.5 | `ctx.injectMessage()` не существует в ExtensionContext API | Адаптация: использован `ctx.ui.notify()` |
| 2 | F-1.6 | Первая реализация использовала `["end", "--all"]` вместо `["stop"]` | Исправлено координатором через edit |

## Рекомендации

1. **Unit tests** — Extension не имеет выделенных тестов. Рекомендуется добавить для `detectCli()`, `loadConfig()`, и switch/case логики.
2. **Runtime test** — После установки `lavish-axi` (`npm install -g lavish-axi`) — провести ручной smoke-тест: `/lavish plan for REST API`.
3. **FAN Store publish** — Загрузить `fan-lavish-1.0.0.tar.gz` на repo-server и обновить `index.json`.
4. **`@sinclair/typebox` dependency** — Не указан в `package.json` (consistent с другими FAN extensions — TypeBox предоставляется runtime через virtual modules).

---

*Создано: feature-pipeline skill*
*Ветка: FAN-NEW-EXT-LAVISH*
*Коммитов: 3 (abf1f26, 38740b5, 124fd20)*

---

## Post-pipeline: Bundle Restructuring

**Коммит:** `85c976e` — `refactor(fan-lavish): restructure as FAN Store bundle`

Исходный код переструктурирован в bundle-формат:

```
extensions/fan-lavish/
├── package.json              (bundle metadata)
├── README.md                 (bundle docs)
├── extensions/
│   └── fan-lavish/
│       ├── index.ts          (extension code)
│       ├── package.json      (extension manifest + @sinclair/typebox dep)
│       ├── config.example.json
│       └── README.md
└── skills/
    └── lavish/
        └── SKILL.md          (skill guidance)
```

### Почему

FAN Store `installer.detectType()` определяет bundle по наличию поддиректорий `extensions/` и `skills/` в корне архива. Плоская структура (index.ts + SKILL.md рядом) детектировалась как `extension` — и SKILL.md терялся при установке (skill loader ищет только в `~/.fan/agent/skills/`).

### Что изменилось

| До | После |
|----|-------|
| Плоская: `fan-lavish/{index.ts, SKILL.md, package.json}` | Bundle: `fan-lavish/{extensions/fan-lavish/, skills/lavish/}` |
| `fan.extensions: ["./index.ts"]` + `fan.skills: true` | Extension: `fan.type: "extension"` + `fan.main: "index.ts"` |
| Нет `dependencies` → typebox не устанавливался | `dependencies: { "@sinclair/typebox": "^0.34.0" }` → auto-install |
| SKILL.md терялся при `fan store install` | SKILL.md копируется в `~/.fan/agent/skills/lavish/` |
