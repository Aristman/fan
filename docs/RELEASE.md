# RELEASE.md — Процесс релиза FAN

> Документация по сборке, версионированию и публикации релизов FAN.
> Актуально для версии 1.0.0+ (независимое версионирование пакетов).

---

## 1. Обзор

С FAN 1.0.0 проект переходит на **независимое версионирование** пакетов. Каждый
из 10 пакетов монопространства имеет собственную версию в своём `package.json`.
Версия FAN-бинарника (исполняемый файл `fan`) равна версии пакета
`@itone/fan-coding-agent`.

**Где читать версию FAN-бинарника:**

```bash
node -e "console.log(require('./packages/coding-agent/package.json').version)"
```

**Когда вызывать `sync-version.mjs`:**

В релизном процессе 1.0.0+ `sync-version.mjs` **НЕ используется**. Он оставлен
для обратной совместимости и dev-сборок, где удобно синхронизировать все пакеты
с корневой версией. В релизе каждый пакет обновляется вручную.

---

## 2. Стратегия версионирования

### Semantic Versioning

Все пакеты следуют [SemVer 2.0](https://semver.org/):

| Компонент | Семантика |
|-----------|-----------|
| **MAJOR** (x.0.0) | Breaking change в публичном API пакета |
| **MINOR** (0.x.0) | Новая функциональность (обратно совместимо) |
| **PATCH** (0.0.x) | Исправление ошибок (обратно совместимо) |

### Версия FAN-бинарника

Версия FAN-бинарника = версия `@itone/fan-coding-agent`. Это **единственный
пакет**, выпускающий бинарник. Изменения в других пакетах не обязаны вести к
бампу `@itone/fan-coding-agent` — бинарник пересобирается только когда нужно
выпустить релизный маркер.

### Префиксы пакетов

| Префикс | Назначение | Пакеты |
|---------|-----------|--------|
| `@itone/` | Open-source npm-пакеты (публикуются в npm) | `fan-ai`, `fan-agent-core`, `fan-tui`, `fan-coding-agent`, `fan-web-ui` |
| `@fan/` | Проприетарные / интегрированные пакеты | `api-gateway`, `db`, `model-manager`, `store`, `dashboard`, `orchestrator` |

### Состав пакетов

| Директория | npm-имя | Назначение |
|-----------|---------|-----------|
| `packages/ai` | `@itone/fan-ai` | Единое LLM API, 20+ провайдеров |
| `packages/agent` | `@itone/fan-agent-core` | Абстракция агента, транспорт, цикл агента |
| `packages/tui` | `@itone/fan-tui` | TUI-библиотека (Markdown, редактор) |
| `packages/coding-agent` | `@itone/fan-coding-agent` | CLI-фронтенд, **производит бинарник** `fan` |
| `packages/db` | `@fan/db` | Prisma + SQLite (сессии, настройки) |
| `packages/model-manager` | `@fan/model-manager` | Маршрутизация провайдеров, fallback-цепочки |
| `packages/api-gateway` | `@fan/api-gateway` | HTTP/WS сервер (Hono) |
| `packages/web-ui` | `@itone/fan-web-ui` | Веб-компоненты (Lit) |
| `packages/dashboard` | `@fan/dashboard` | Веб-панель управления (private) |
| `packages/store` | `@fan/store` | Менеджер пакетов FAN Store |

---

## 3. Pre-release checklist

Перед сборкой релиза необходимо проверить:

- [ ] Все изменения смержены в `master`
- [ ] Все тесты прошли: `npm test`
- [ ] `npm run build` проходит без ошибок
- [ ] `CHANGELOG.md` в корне обновлён (раздел для новой версии)
- [ ] `packages/coding-agent/CHANGELOG.md` обновлён
- [ ] Версии пакетов, требующих изменений, бампнуты вручную (см. раздел 4)
- [ ] Корневой `package.json` — `"private": true` (не версионируется, не публикуется)
- [ ] git-теги подписаны для ключевых пакетов при необходимости
- [ ] `scripts/release-binaries.sh` протестирован локально хотя бы для одной платформы

---

## 4. Как обновить версии пакетов

Релиз FAN 1.0.0+ не использует `sync-version.mjs`. Версии пакетов обновляются
вручную в файлах `packages/<name>/package.json`.

### Ручное обновление

```bash
# Отредактировать нужный package.json
# Изменить поле "version" с текущей на новую
# Пример для @itone/fan-coding-agent (он же версия FAN-бинарника):
#   "version": "0.13.2" → "1.0.0"
```

### Через npm version (без git-тегов)

```bash
# Бамп только @itone/fan-coding-agent
npm version 1.0.0 -w @itone/fan-coding-agent --no-git-tag-version

# Бамп только @itone/fan-ai (patch)
npm version patch -w @itone/fan-ai --no-git-tag-version

# Бамп только @itone/fan-tui (minor)
npm version minor -w @itone/fan-tui --no-git-tag-version
```

### Примеры бампа

| Изменение | Что бампать | Пример |
|-----------|------------|--------|
| Bug fix в одном пакете | `patch` этого пакета | `0.13.2` → `0.13.3` |
| Новая фича в одном пакете | `minor` этого пакета | `0.13.2` → `0.14.0` |
| Breaking change в API пакета | `major` этого пакета | `0.13.2` → `1.0.0` |
| Релизный маркер | `@itone/fan-coding-agent` | `0.13.2` → `1.0.0` |

### Важно

- Версия корневого `package.json` **не участвует** в версионировании релиза
- Версия `@itone/fan-coding-agent` бампится когда меняется сам пакет,
  или когда требуется новый релизный бинарник (даже если код не изменился)
- Остальные пакеты бампаются только когда в них были изменения

---

## 5. Сборка релиза (release-binaries.sh)

Скрипт `scripts/release-binaries.sh` — основной инструмент для создания
релизных артефактов FAN 1.0.0+.

### Что делает скрипт

1. Устанавливает зависимости (`bun install`)
2. Генерирует Prisma-клиент
3. Устанавливает платформенные native-биндинги (clipboard, sharp)
4. Собирает все пакеты (`npm run build`)
5. Собирает dashboard (`npm run build:dashboard`)
6. Встраивает версию в api-gateway dist (через `sed`)
7. Компилирует бинарник для 5 платформ (`bun build --compile`)
8. Копирует assets в директории платформ (темы, WASM, dashboard, Prisma engine)
9. Упаковывает в архивы (`.tar.gz` / `.zip`)
10. Генерирует `manifest.json` с SHA256 хешами
11. Копирует артефакты в `~/fan-store/dist/`

### Команды

```bash
# Полная сборка для всех 5 платформ
./scripts/release-binaries.sh

# Только Linux x64
./scripts/release-binaries.sh --platform linux-x64

# Пропустить установку native-зависимостей (если уже установлены)
./scripts/release-binaries.sh --skip-deps

# Только macOS ARM64 без deps
./scripts/release-binaries.sh --platform darwin-arm64 --skip-deps
```

### Поддерживаемые платформы

| Аргумент | Целевая платформа | Архив |
|----------|------------------|-------|
| `darwin-arm64` | macOS Apple Silicon | `fan-<VERSION>-darwin-arm64.tar.gz` |
| `darwin-x64` | macOS Intel | `fan-<VERSION>-darwin-x64.tar.gz` |
| `linux-x64` | Linux x86_64 | `fan-<VERSION>-linux-x64.tar.gz` |
| `linux-arm64` | Linux ARM64 | `fan-<VERSION>-linux-arm64.tar.gz` |
| `windows-x64` | Windows x86_64 | `fan-<VERSION>-windows-x64.zip` |

### Структура архива

```
fan/
├── fan                    # Исполняемый бинарник (fan.exe на Windows)
├── package.json
├── README.md
├── CHANGELOG.md
├── photon_rs_bg.wasm      # WASM для обработки изображений
├── theme/                 # JSON-файлы темы TUI
├── assets/                # PNG-ассеты
├── export-html/           # HTML-экспорт сессий
├── dashboard/             # Собранная веб-панель (Vite build)
└── node_modules/
    └── .prisma/client/    # Prisma query engine для данной платформы
```

### Размеры архивов (ориентировочно)

| Платформа | Размер |
|-----------|--------|
| `linux-x64` | ~39 MB |
| `darwin-arm64` | ~44 MB |
| `darwin-x64` | ~46 MB |
| `linux-arm64` | ~45 MB |
| `windows-x64` | ~57 MB |

### Где лежат артефакты

```
packages/coding-agent/binaries/
├── manifest.json
├── fan-<VERSION>-darwin-arm64.tar.gz
├── fan-<VERSION>-darwin-x64.tar.gz
├── fan-<VERSION>-linux-x64.tar.gz
├── fan-<VERSION>-linux-arm64.tar.gz
├── fan-<VERSION>-windows-x64.zip
└── <platform>/fan/         # Распакованная директория для тестирования
```

### Версия в api-gateway

Скрипт встраивает версию FAN в собранный `api-gateway` через `sed`:

```bash
sed -i "s|JSON\.parse(...)\.version|'${FAN_VERSION}'|g" \
  packages/api-gateway/dist/http-server.js
```

Это необходимо, потому что `bun build --compile` не может разрешить
`__dirname`-относительные чтения `package.json` в runtime.

---

## 6. Публикация

После сборки артефактов выполняется публикация релиза.

### GitHub Release

```bash
# Создать git-тег с версией @itone/fan-coding-agent
git tag v1.0.0
git push origin v1.0.0

# CI (.github/workflows/release.yml) соберёт и опубликует релиз автоматически
```

CI-пайплайн (если настроен) автоматически:
- Собирает бинарники для всех платформ
- Создаёт GitHub Release с архивами
- Публикует manifest.json

### FAN Store

Скрипт `release-binaries.sh` автоматически копирует артефакты
в `~/fan-store/dist/`. После сборки:

```bash
fan-store publish
```

### npm publish (open-source пакеты @itone/*)

```bash
# Опубликовать каждый @itone/* пакет с новой версией
npm publish -w @itone/fan-coding-agent
npm publish -w @itone/fan-ai
npm publish -w @itone/fan-agent-core
npm publish -w @itone/fan-tui
npm publish -w @itone/fan-web-ui
```

Пакеты `@fan/*` (api-gateway, db, model-manager, store, dashboard) не
публикуются в npm — они распространяются в составе бинарного архива FAN.

---

## 7. Связь с build-binaries.sh

С введением независимого версионирования в репозитории существуют два скрипта
сборки:

| Скрипт | Назначение | Версионирование | Когда использовать |
|--------|-----------|----------------|-------------------|
| `scripts/build-binaries.sh` | LEGACY: dev-сборки и CI до 1.0.0 | Использует `sync-version.mjs` | Локальные dev-сборки, CI до миграции |
| `scripts/release-binaries.sh` | Релизы 1.0.0+ | Независимое (читает версию из `packages/coding-agent/package.json`) | **Только для релизов** |

**`sync-version.mjs`** (`scripts/sync-version.mjs`) — оставлен для обратной
совместимости. Читает версию из корневого `package.json` и синхронизирует со
всеми пакетами. Команда `npm run prebuild` в корневом `package.json`
по-прежнему вызывает `sync-version.mjs`, но в релизном процессе 1.0.0+
этот скрипт **не используется**.

---

## 8. Известные ограничения

- Версия FAN-бинарника = версия `@itone/fan-coding-agent`, а не сумма или
  агрегация версий всех пакетов
- В `manifest.json` указывается только версия бинарника (одно поле `latest`)
- Если в FAN Store публикуется пакет (расширение, навык), его версия хранится
  в `@fan/store/package.json` (это отдельная сущность, не связанная с версией
  бинарника)
- Платформенные native-биндинги (clipboard, sharp) требуют предварительной
  установки системных зависимостей (см. `INSTALL.md`)

---

## 9. Пример полного цикла релиза FAN 1.0.0

Пошаговый сценарий для первой публикации FAN 1.0.0.

### Шаг 1: Подготовка

```bash
# Переключиться на master и убедиться, что всё чисто
git checkout master
git pull --rebase

# Проверить тесты и сборку
npm test
npm run build
```

### Шаг 2: Обновить версию @itone/fan-coding-agent

```bash
# Редактировать packages/coding-agent/package.json
# "version": "0.13.2" → "1.0.0"
```

### Шаг 3: Обновить CHANGELOG

В корневом `CHANGELOG.md` и `packages/coding-agent/CHANGELOG.md` должен быть
раздел `## [1.0.0] - 2026-06-14`.

### Шаг 4: Закоммитить и создать тег

```bash
git add -A
git commit -m "release: v1.0.0"
git tag v1.0.0
git push origin master --tags
```

### Шаг 5: CI собирает артефакты

CI-пайплайн (`.github/workflows/release.yml`) автоматически собирает бинарники
для всех платформ и публикует GitHub Release.

Если CI не настроен — собрать локально:

```bash
./scripts/release-binaries.sh
```

### Шаг 6: Локальное тестирование

```bash
# Распакованные архивы лежат в:
ls packages/coding-agent/binaries/
# Протестировать, например, linux-x64:
./packages/coding-agent/binaries/linux-x64/fan --help
```

### Шаг 7: Опубликовать в FAN Store

Скрипт уже скопировал артефакты в `~/fan-store/dist/`. Остаётся:

```bash
fan-store publish
```

### Шаг 8: Опубликовать в npm

```bash
# Проверить, что @itone/* пакеты имеют правильные версии
node -e "console.log(require('./packages/coding-agent/package.json').version)"

# Опубликовать
npm publish -w @itone/fan-coding-agent
npm publish -w @itone/fan-ai
npm publish -w @itone/fan-agent-core
npm publish -w @itone/fan-tui
npm publish -w @itone/fan-web-ui
```

### Шаг 9: Проверка

- Скачать архив с GitHub Release
- Установить через инсталлятор: `curl -fsSL https://fan.sea-agents.ru/install.sh | bash`
- Запустить `fan --version` — должна показать `1.0.0`
- Запустить `fan --web` — должна открыться веб-панель
- Проверить FAN Store: `fan store list`
