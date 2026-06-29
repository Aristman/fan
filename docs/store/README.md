# FAN Store — пакетный менеджер расширений, скилов и тем

## Обзор

FAN Store — встроенный пакетный менеджер для установки, обновления и удаления расширений (extensions), скилов (skills) и тем (themes). Реализован как бандлированное расширение FAN, которое регистрирует 5 LLM-инструментов и `/store` slash-команду для TUI.

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                       FAN Store Client                          │
│  packages/store/ (npm-пакет @fan/store, расширение fan-store)   │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ config.ts │  │ types.ts │  │storage.ts│  │ progress-      │  │
│  │          │  │          │  │          │  │ overlay.ts     │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ repo-    │  │installer │  │ store-     │  │ store-       │  │
│  │ client.ts│  │ .ts      │  │ tools.ts   │  │ command.ts   │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐                  │
│  │ browse-  │  │ store-   │  │ store-       │                  │
│  │component │  │extension │  │ extension.ts │                  │
│  └──────────┘  └──────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FAN Store Server (VPS)                        │
│  tools/fan-store-server/ (bash CLI для управления репозиторием)  │
│  nginx на VPS 185.219.41.46, URL: https://fan.sea-agents.ru/    │
│  fan-store/                                                      │
│  • dist/ — опубликованные пакеты (.tar.gz)                       │
│  • index.json — манифест репозитория                            │
└─────────────────────────────────────────────────────────────────┘
```

## Компоненты клиента

### 1. Конфигурация — `packages/store/src/config.ts`
- Файл: `~/.fan/agent/store.json`
- Поля: `repositories`, `autoUpdateCheck`, `installScope`, `archiveTempDir`
- Дефолтный репозиторий: `https://fan.sea-agents.ru/fan-store` (priority: 1, enabled: true)

### 2. Типы — `packages/store/src/types.ts`
- `ResourceType`: `extension` | `skill` | `theme`
- `RepoEntry`, `RepoPackage`, `RepoIndex`, `InstalledPackage`

### 3. Локальная БД — `packages/store/src/storage.ts`
- `StoreDatabase` — CRUD для установленных пакетов
- Файл: `~/.fan/agent/store-packages.json`
- Хранит: имя, версию, тип, путь установки, timestamp проверки обновлений

### 4. HTTP-клиент — `packages/store/src/repo-client.ts`
- `RepoClient` — фетчит `index.json` из репозиториев (с 5-минутным кешем)
- Поиск по пакетам (fuzzy match)
- Скачивание архивов с SHA-256 верификацией
- Проверка обновлений (semver сравнение)

### 5. Установщик — `packages/store/src/installer.ts`
- `ArchiveInstaller` — распаковка `.tar.gz` / `.zip`
- Автоопределение типа пакета (по наличию SKILL.md / theme.json / index.ts)
- Установка бандлов (мульти-ресурс)
- Установка зависимостей (`bun install`)
- Двухфазное самообновление (staged)
- Backup/restore при сбоях
- Защита от path traversal

### 6. LLM-инструменты — `packages/store/src/store-tools.ts`
- `store_search` — поиск по репозиториям
- `store_install` — установка пакета
- `store_remove` — удаление пакета
- `store_update` — обновление пакета(ов)
- `store_list` — список установленных

### 7. Slash-команда — `packages/store/src/store-command.ts`
- `/store help` — справка
- `/store list` — установленные пакеты
- `/store search <query>` — поиск в репозиториях
- `/store install <package>` — установка
- `/store remove <package>` — удаление
- `/store update [package]` — обновление
- `/store self` — самообновление store-расширения
- `/store browse` — интерактивный браузер (TUI)
- `/store repos [add|remove|list]` — управление репозиториями

### 8. TUI-компоненты
- **`browse-component.ts`** — полноэкранный браузер: вкладки репозиториев, фильтр по типу, fuzzy search, детали пакета, действия (install/update/remove)
- **`progress-overlay.ts`** — индикатор прогресса с отменой по Escape

### 9. Точка входа — `packages/store/src/store-extension.ts`
- Регистрирует 5 LLM-инструментов
- Регистрирует `/store` slash-команду и `Alt+S` хоткей
- Жизненный цикл: `session_start` (auto-update check, статус-бар)
- Самообновление отложенное (staged)

## Компоненты сервера

### `tools/fan-store-server/`

| Файл | Назначение |
|------|-----------|
| `fan-store` | Bash-скрипт управления репозиторием. Команды: `init`, `add`, `remove`, `list`, `info`, `publish`, `serve` |
| `GUIDE.md` | Полная документация (~800 строк): nginx config, dist/ structure, manifest format, install lifecycle, security |
| `setup-vps.sh` | Развёртывание nginx на VPS |
| `restore-server.sh` | Восстановление сервера |
| `deploy-nginx.sh` | Деплой конфига nginx |

### Формат пакета (архив)

```
package-name-v1.0.0.tar.gz
├── package.json       # обязательный, содержит метаданные (name, version, type)
├── SKILL.md           # для скилов
├── theme.json         # для тем
├── index.ts / index.js # для расширений
└── ...                # остальные файлы
```

### Формат index.json репозитория

```json
{
  "name": "fan-store",
  "url": "https://fan.sea-agents.ru/fan-store",
  "packages": [
    {
      "name": "fan-orchestrator",
      "version": "6.0.0",
      "type": "extension",
      "description": "Multi-agent orchestrator",
      "archive": "fan-orchestrator-v6.0.0.tar.gz",
      "sha256": "abc123...",
      "homepage": "...",
      "author": "...",
      "tags": ["orchestrator", "agents"],
      "requires": ["fan-ai@>=1.0.0"]
    }
  ]
}
```

## Пути установки

| Тип | User scope | Project scope |
|-----|-----------|---------------|
| extension | `~/.fan/agent/extensions/` | `.fan/extensions/` |
| skill | `~/.fan/agent/skills/` | `.fan/skills/` |
| theme | `~/.fan/agent/themes/` | `.fan/themes/` |

## Runtime-данные

| Файл | Назначение |
|------|-----------|
| `~/.fan/agent/store.json` | Конфигурация (репозитории, автообновление, scope) |
| `~/.fan/agent/store-packages.json` | БД установленных пакетов |

## Ключевые файлы

| Файл | Назначение |
|------|-----------|
| `packages/store/src/store-extension.ts` | Точка входа расширения (188 строк) |
| `packages/store/src/store-command.ts` | Slash-команда `/store` (592 строки) |
| `packages/store/src/store-tools.ts` | 5 LLM-инструментов (290 строк) |
| `packages/store/src/installer.ts` | Установщик архивов (629 строк) |
| `packages/store/src/repo-client.ts` | HTTP-клиент репозитория (240 строк) |
| `packages/store/src/browse-component.ts` | TUI-браузер (780 строк) |
| `packages/store/package.json` | Манифест (@fan/store, fan-store, v0.8.2) |
| `tools/fan-store-server/fan-store` | CLI управления серверным репозиторием |
| `tools/fan-store-server/GUIDE.md` | Документация серверной части |
