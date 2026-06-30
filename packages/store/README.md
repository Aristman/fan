# @fan/store

> FAN Store — package manager for extensions, skills, themes from repositories and archives

## Описание

`@fan/store` — это менеджер пакетов FAN. Он позволяет устанавливать, обновлять и удалять расширения (extensions), навыки (skills) и темы (themes) из настроенных репозиториев или локальных архивов.

**Решаемая задача:** управление экосистемой FAN через единый интерфейс. Вместо ручного копирования файлов в директории `extensions/`, `skills/`, `themes/`, пользователь может искать пакеты в магазине, устанавливать их одной командой и получать уведомления об обновлениях.

**Где используется:** встроен в FAN как bundled extension (автоматически загружается при старте). Доступен через 5 LLM-инструментов (store_search, store_install, store_remove, store_update, store_list), slash-команду `/store` и хоткей `Alt+S` для графического браузера.

**Ключевые возможности:**
- 5 LLM инструментов: `store_search`, `store_install`, `store_remove`, `store_update`, `store_list`
- Slash-команда `/store` для интерактивного использования
- Хоткей `Alt+S` — графический браузер расширений
- Multi-repo: основной репозиторий `https://fan.sea-agents.ru/fan-store/` + кастомные
- Установка из архивов (`.tar.gz`, `.zip`) с SHA-256 верификацией
- Self-update: FAN Store может обновлять сам себя
- Auto-update check: фоновые проверки обновлений при старте сессии
- Конфигурация через `~/.fan/agent/store.json`

## Архитектура / Как работает

FAN Store — это Extension для FAN (`@seaagents/fan-coding-agent`). При загрузке он:

1. Регистрирует 5 LLM-инструментов и slash-команду
2. При старте каждой сессии проверяет наличие обновлений в репозиториях
3. Отображает статусную строку с количеством пакетов и доступных обновлений

```
FAN Store Extension
├── StoreTools      — 5 LLM-инструментов
├── StoreCommand    — /store slash-команда
├── RepoClient      — HTTP-клиент для репозиториев
├── ArchiveInstaller — установка из .tar.gz/.zip
├── StoreDatabase   — хранение метаданных пакетов (JSON)
└── Config          — загрузка store.json
```

### Хранение данных

- **Конфигурация:** `~/.fan/agent/store.json` — репозитории, автообновления, временная директория
- **База пакетов:** `~/.fan/agent/store-packages.json` — список установленных пакетов
- **Файлы пакетов:** `~/.fan/agent/extensions/`, `~/.fan/agent/skills/`, `~/.fan/agent/themes/`

## Использование

### Базовое использование

```ts
import { storeExtension, default as storeExt } from "@fan/store";

// FAN Store регистрируется автоматически как bundled extension
// Инструменты доступны в чате:

// "Найди extension для работы с PostgreSQL"
// → store_search("postgresql", "extension")

// "Установи orchestrator"
// → store_install("orchestrator")

// "Проверь обновления"
// → store_update()
```

### API

#### Экспорты из `src/index.ts`

| Экспорт | Тип | Описание |
|---------|-----|----------|
| `storeExtension` | `ExtensionFactory` | Фабрика расширения для регистрации в FAN |
| `default` | `ExtensionFactory` | Алиас для `storeExtension` |
| `RepoClient` | Class | HTTP-клиент для репозиториев FAN Store |
| `ArchiveInstaller` | Class | Установщик из .tar.gz/.zip архивов с SHA-256 |
| `StoreDatabase` | Class | Хранение метаданных установленных пакетов |
| `ProgressOverlay` | Class | UI-оверлей прогресса установки |
| `InstalledPackage` | Type | Метаданные установленного пакета |
| `RepoIndex` | Type | Индекс репозитория |
| `RepoPackage` | Type | Пакет в репозитории |
| `ResourceType` | Type | `"extension" \| "skill" \| "theme"` |
| `StoreConfig` | Type | Конфигурация store.json |

#### LLM Инструменты

| Инструмент | Описание |
|-----------|----------|
| `store_search` | Поиск пакетов в репозиториях по названию и типу |
| `store_install` | Установка пакета из репозитория или локального архива |
| `store_remove` | Удаление установленного пакета |
| `store_update` | Проверка и применение обновлений |
| `store_list` | Список установленных пакетов |

## Сборка

```bash
npm run build      # production build (tsgo)
npm run dev        # watch mode
npm run test       # vitest run
npm run clean      # удалить dist/
```

## Зависимости

**Runtime:**
- `@seaagents/fan-coding-agent` — FAN Coding Agent SDK (Extension API, инструменты, команды)
- `@sinclair/typebox` — валидация схем TypeScript

**Dev:**
- `vitest`, `shx`

## Связанные документы

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [docs/guides/configuration.md](../../docs/guides/configuration.md)
- [docs/RELEASE.md](../../docs/RELEASE.md)

## License

MIT © Fast Agents Network Team
