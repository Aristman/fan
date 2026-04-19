# FAN Repo Server — Руководство

> Полное руководство по работе с FAN Repo Server — репозиторием расширений, скиллов и тем для FAN (Filin Agent Next).

---

## Содержание

- [Обзор](#обзор)
- [Инструменты](#инструменты)
  - [fan-repo CLI](#fan-repo-cli)
  - [setup-vps.sh](#setup-vpssh)
- [Серверная инфраструктура](#серверная-инфраструктура)
- [Формат index.json](#формат-indexjson)
- [Формат архива tar.gz](#формат-архива-targz)
- [Клиентская сторона FAN Store](#клиентская-сторона-fan-store)
- [Жизненный цикл пакета](#жизненный-цикл-пакета)
- [Безопасность](#безопасность)
- [Troubleshooting](#troubleshooting)

---

## Обзор

FAN Repo Server — это HTTP-репозиторий для дистрибуции FAN-пакетов (расширений, скиллов, тем). Работает через nginx, отдаёт статику:

| Ресурс | URL | Кеширование |
|--------|-----|-------------|
| Индекс | `http://185.219.41.46/fan/index.json` | `no-cache` |
| Пакеты | `http://185.219.41.46/fan/packages/<name>-<ver>.tar.gz` | `immutable` (1 год) |
| Релизы | `http://185.219.41.46/fan/releases/<name>-<ver>.tar.gz` | `immutable` |

---

## Инструменты

В `tools/fan-repo-server/` лежат два инструмента:

| Файл | Назначение |
|------|-----------|
| `fan-repo` | CLI для управления репозиторием (add, remove, publish, serve) |
| `setup-vps.sh` | Одноразовая настройка VPS с nginx |

### fan-repo CLI

```bash
# Подготовить к работе
chmod +x tools/fan-repo-server/fan-repo
export PATH="$PATH:$(pwd)/tools/fan-repo-server"

# Или symlink
ln -s $(pwd)/tools/fan-repo-server/fan-repo /usr/local/bin/fan-repo
```

#### Команды

```bash
fan-repo init [path]            # Создать новый репозиторий
fan-repo set-url <url>          # Задать базовый URL репозитория
fan-repo add <archive.tar.gz>   # Добавить пакет (автоматически обновляет index.json)
fan-repo remove <name>          # Удалить пакет по имени
fan-repo list                   # Список всех пакетов
fan-repo info <name>            # Детали пакета
fan-repo publish [target]       # Задеплоить на сервер (rsync)
fan-repo serve [port]           # Локальный HTTP-сервер для тестов (по умолчанию 8888)
fan-repo help                   # Справка
```

Алиасы: `rm` → remove, `ls` → list, `show` → info, `push` → publish, `deploy` → publish.

#### Типичный рабочий цикл

```bash
# 1. Собрать архив (см. раздел "Формат архива")
cd packages/orchestrator
tar -czf /tmp/fan-orchestrator-1.0.0.tar.gz \
  --transform='s,^\./,fan-orchestrator/,' \
  ./src/ ./package.json ./README.md ./config.example.json

# 2. Добавить в локальный репозиторий (~/fan-repo/)
cd ~/fan-repo
fan-repo add /tmp/fan-orchestrator-1.0.0.tar.gz
# → Автоматически: копирует в packages/, пересобирает index.json с SHA-256

# 3. Проверить
fan-repo list
fan-repo info fan-orchestrator

# 4. Задеплоить на сервер
fan-repo publish
# → rsync -avz --delete ~/fan-repo/ root@185.219.41.46:/var/www/fan-repo/

# Или на кастомный таргет:
fan-repo publish user@other-host:/var/www/repo
```

#### Что делает fan-repo add

1. Копирует архив в `packages/`
2. Извлекает `name`, `version`, `description` из `package.json` внутри архива
3. Авто-определяет тип (extension/skill/theme/bundle) по содержимому (первые 20 файлов)
4. **Fallback:** если `package.json` отсутствует — имя и версия извлекаются из имени файла (`name-version.tar.gz`)
5. Считает SHA-256 хеш
6. Пересобирает `index.json` **полностью** со всеми пакетами в `packages/`

#### Конфигурация по умолчанию (вшита в скрипт)

```
REMOTE_HOST = root@185.219.41.46
REMOTE_PATH = /var/www/fan-repo
REPO_URL    = http://185.219.41.46/fan
```

Перекрытие через env: `FAN_REPO_DIR=/path/to/repo fan-repo list`

Все env-переменные скрипта (для справки, не нужны в обычной работе):

| Переменная | Назначение |
|------------|-----------|
| `FAN_REPO_DIR` | Путь к локальному репозиторию (ищет `index.json` вверх по дереву) |
| `FAN_PKG_DIR`, `FAN_REPO_URL`, `FAN_TS` | Внутренние — передаются в python3-встроики при rebuild index |
| `FAN_PKG_ARRAY` | Внутренняя — JSON массив пакетов |
| `FAN_PKG_NAME` | Внутренняя — имя пакета для `info` |
| `FAN_OFFLINE` | **Клиентская** (не скрипта) — отключает сетевые запросы в FAN Store

### setup-vps.sh

Одноразовый bash-скрипт для развёртывания сервера с нуля на Ubuntu:

```bash
# Базовый запуск (автогенерация пароля)
./tools/fan-repo-server/setup-vps.sh root@185.219.41.46

# С указанием auth-credentials
./tools/fan-repo-server/setup-vps.sh root@185.219.41.46 fan mypassword
```

**Параметры:** `setup-vps.sh <user@host> [auth_user] [auth_password]`

Что делает:
1. Устанавливает nginx + apache2-utils (для `htpasswd`)
2. Создаёт `/var/www/fan-repo/packages/` с placeholder `index.json`
3. Генерирует htpasswd файл (`/etc/nginx/.fan-htpasswd`)
4. Деплоит nginx-конфиг с Basic Auth в `/etc/nginx/sites-available/fan-repo`
5. Удаляет default site, включает fan-repo, запускает nginx

> **⚠️ Важно:** Текущий сервер работает **без Basic Auth** (открытый репозиторий). Конфиг в `setup-vps.sh` включает auth. Для открытого доступа нужно убрать блоки `auth_basic` из nginx-конфига или адаптировать скрипт.

---

## Серверная инфраструктура

### Стек

- **OS:** Ubuntu (VPS)
- **Web:** nginx/1.24.0
- **Хост:** `185.219.41.46`
- **Root репозитория:** `/var/www/fan-repo/`

### Структура директорий на сервере

```
/var/www/fan-repo/
├── index.json                          # Индекс репозитория
├── packages/                           # Текущие версии пакетов (.tar.gz)
│   ├── fan-orchestrator-1.0.0.tar.gz
│   └── fan-persistent-memory-3.1.2.tar.gz
└── releases/                           # Архив всех релизов (для откатов)
    ├── fan-persistent-memory-3.0.0.tar.gz
    ├── fan-persistent-memory-3.1.0.tar.gz
    └── ...
```

### Nginx конфигурация

Файл: `/etc/nginx/sites-enabled/default`

```nginx
server {
    listen 80 default_server;
    server_name _;

    location /fan/ {
        alias /var/www/fan-repo/;
        add_header X-Content-Type-Options nosniff always;

        location = /fan/index.json {
            add_header Cache-Control "no-cache, must-revalidate" always;
            add_header Content-Type application/json always;
        }

        location /fan/packages/ {
            add_header Cache-Control "public, max-age=31536000, immutable" always;
        }
    }

    location / { return 404; }
    location ~ /\. { deny all; }
}
```

Перезагрузка: `ssh root@185.219.41.46 "nginx -t && systemctl reload nginx"`

---

## Формат index.json

```json
{
  "repository": {
    "name": "fan-repo",
    "url": "http://185.219.41.46/fan",
    "updatedAt": "2026-04-19T17:20:00Z"
  },
  "packages": [
    {
      "name": "fan-orchestrator",
      "version": "1.0.0",
      "type": "extension",
      "description": "Multi-agent orchestrator with delegate_task, task management, workers, and slash commands",
      "author": "FAN Team",
      "downloadUrl": "http://185.219.41.46/fan/packages/fan-orchestrator-1.0.0.tar.gz",
      "hash": "sha256:6ff90442cbed6b90646c6ab2c155e1eb61b2798b5b6594b9fe60b349b8866f9b"
    }
  ]
}
```

### Поля записи пакета

| Поле | Обязательное | Описание |
|------|-------------|----------|
| `name` | ✅ | Имя пакета (kebab-case, без `@fan/`) |
| `version` | ✅ | Семантическая версия (semver) |
| `type` | ✅ | `"extension"` / `"skill"` / `"theme"` / `"bundle"` |
| `description` | ✅ | Краткое описание |
| `downloadUrl` | ✅ | Полный URL до `.tar.gz` |
| `hash` | ✅ | SHA-256 хеш (`sha256:<hex>`) |
| `author` | ❌ | Автор/команда |

> `fan-repo add` автоматически заполняет все поля из `package.json` + хеш + URL.

---

## Формат архива (.tar.gz)

### Структура

Архив содержит **одну top-level директорию** с именем пакета:

```
fan-orchestrator/
├── src/
│   ├── index.ts                        # Barrel export (main entry)
│   ├── orchestrator-extension.ts       # ExtensionFactory
│   ├── orchestrator-tools.ts
│   ├── subagent-runner.ts
│   ├── task-manager.ts
│   ├── workers.ts
│   ├── agents.ts
│   ├── config.ts
│   ├── permissions.ts
│   ├── types.ts
│   ├── agents/                         # Промпты агентов (.md)
│   │   ├── explore.md
│   │   ├── plan.md
│   │   ├── implement.md
│   │   └── verify.md
│   └── prompts/                        # Промпты воркеров (.md)
│       ├── implement.md
│       ├── plan-only.md
│       └── verify.md
├── package.json                        # Манифест npm + fan manifest
├── config.example.json                 # Пример конфигурации
└── README.md
```

### Правила упаковки

| ✅ Включить | ❌ Исключить |
|-------------|-------------|
| `src/` — TypeScript исходники | `node_modules/` |
| `package.json` | `dist/` |
| `README.md` | `__tests__/`, `*.test.ts` |
| `config.example.json` | `.env`, `.git/` |
| `agents/*.md`, `prompts/*.md` | Скрытые файлы |
| `tsconfig.json` | `vitest.config.ts` |

### Команда сборки архива

```bash
cd packages/<extension-name>

VERSION="1.0.0"
NAME="<extension-name>"

tar -czf "/tmp/${NAME}-${VERSION}.tar.gz" \
  --transform="s,^\./,${NAME}/," \
  ./src/ ./package.json ./README.md ./config.example.json

# Проверить содержимое
tar -tzf "/tmp/${NAME}-${VERSION}.tar.gz"

# Хеш
sha256sum "/tmp/${NAME}-${VERSION}.tar.gz"
```

### Типы ресурсов (авто-детекция)

Детекция происходит по содержимому архива (`fan-repo add` и `ArchiveInstaller` на клиенте).

| Тип | Детектор | Приоритет |
|-----|----------|----------|
| `bundle` | Пути содержат `extensions/`, `skills/` или `themes/` | 1 (проверяется первым) |
| `skill` | `SKILL.md` в корне архива | 2 |
| `theme` | `theme.json` в корне архива | 3 |
| `extension` | `index.ts`, `index.js` или `package.json` | 4 |
| `unknown` | Ничего не подошло — ошибка при установке | — |

> **Примечание:** `fan-repo add` проверяет первые 20 файлов (`head -20`). Если ключевой файл глубже — тип может определиться неверно.

---

## Клиентская сторона FAN Store

### Конфигурация

Файл: `~/.fan/agent/store.json`

```json
{
  "repositories": [
    {
      "name": "fan-repo",
      "url": "http://185.219.41.46/fan",
      "enabled": true,
      "priority": 1
    }
  ],
  "autoUpdateCheck": true,
  "autoUpdateCheckIntervalHours": 24,
  "installScope": "user",
  "archiveTempDir": "/tmp/fan-store"
}
```

### База установленных пакетов

Файл: `~/.fan/agent/store-packages.json`

```json
{
  "packages": {
    "fan-orchestrator": {
      "name": "fan-orchestrator",
      "version": "1.0.0",
      "type": "extension",
      "source": "repo",
      "installedAt": 1713534000000,
      "installedPath": "/home/user/.fan/agent/extensions/fan-orchestrator",
      "scope": "user",
      "repoName": "fan-repo",
      "repoUrl": "http://185.219.41.46/fan",
      "hash": "sha256:..."
    }
  },
  "lastUpdateCheck": 1713534000000
}
```

### Пути установки

| Scope / Type | Path |
|-------------|------|
| extension (user) | `~/.fan/agent/extensions/<name>/` |
| extension (project) | `.fan/extensions/<name>/` |
| skill | `~/.fan/agent/skills/<name>/` |
| theme | `~/.fan/agent/themes/<name>.json` |

### CLI команды

```bash
fan store search orchestrator          # Поиск
fan store install fan-orchestrator     # Установка из репо
fan store install /path/to/file.tgz    # Установка из архива
fan store list                         # Список установленных
fan store update                       # Проверить обновления
fan store update fan-orchestrator      # Обновить конкретный
fan store remove fan-orchestrator      # Удалить
```

### LLM tools (внутри сессии)

```
store_search("orchestrator")
store_install("fan-orchestrator")
store_list()
store_update("fan-orchestrator")
store_remove("fan-orchestrator")
```

---

## Жизненный цикл пакета

### 1. Разработка

```bash
# В monorepo FAN
cd packages/my-extension
# ... пишете код ...
npm run build && npm test
```

### 2. Сборка архива

```bash
VERSION="1.0.0"
NAME="my-extension"
tar -czf "/tmp/${NAME}-${VERSION}.tar.gz" \
  --transform="s,^\./,${NAME}/," \
  ./src/ ./package.json ./README.md
```

### 3. Добавление в репозиторий

```bash
cd ~/fan-repo
fan-repo add /tmp/my-extension-1.0.0.tar.gz
fan-repo list    # проверить
```

### 4. Деплой на сервер

```bash
fan-repo publish
```

### 5. Верификация

```bash
# Проверить index.json на сервере
curl -s http://185.219.41.46/fan/index.json | python3 -m json.tool

# Проверить доступность архива
curl -sI http://185.219.41.46/fan/packages/my-extension-1.0.0.tar.gz | head -5

# Локальный тест
cd ~/fan-repo && fan-repo serve
# → http://localhost:8888/index.json
```

### 6. Обновление версии

```bash
# fan-repo не управляет версиями автоматически — делайте вручную:

# 1. Переместить старый архив в releases/
ssh root@185.219.41.46 \
  "mv /var/www/fan-repo/packages/my-extension-1.0.0.tar.gz \
       /var/www/fan-repo/releases/"

# 2. Собрать и добавить новую версию
fan-repo add /tmp/my-extension-2.0.0.tar.gz

# 3. Задеплоить
fan-repo publish
```

---

## Безопасность

| Механизм | Детали |
|----------|--------|
| **SHA-256** | Проверяется при каждой загрузке. Несовпадение → ошибка |
| **Path traversal** | Installer валидирует пути внутри архива |
| **Immutable cache** | Пакеты кешируются на год. Инвалидация = новая версия |
| **Код выполняется** | Расширения выполняют произвольный код — ревью перед установкой |

---

## Troubleshooting

| Проблема | Решение |
|----------|---------|
| Пакет не находится | `curl -s http://185.219.41.46/fan/index.json` — проверьте index |
| Хеш не совпадает | `sha256sum file.tar.gz` → обновите hash в index.json |
| 403 на `/packages/` | Нормально — directory listing отключён. Файлы доступны по прямому URL |
| `fan-repo add` не находит name/version | Убедитесь, что `package.json` с `name` и `version` внутри архива |
| Кешированный старый index | TTL 5 минут на клиенте. Или `rm ~/.fan/agent/store-packages.json` |
| Офлайн не даёт установить | `FAN_OFFLINE=1` работает только с кешированными данными |

---

## Шаблон package.json для расширения

```json
{
  "name": "fan-my-extension",
  "version": "1.0.0",
  "description": "My FAN extension",
  "type": "module",
  "main": "src/index.ts",
  "fan": {
    "name": "fan-my-extension",
    "type": "extension",
    "displayName": "My Extension",
    "description": "What it does",
    "version": "1.0.0",
    "main": "src/index.ts",
    "entry": "src/extension.ts",
    "author": "Author",
    "tags": ["tag1", "tag2"]
  },
  "dependencies": {
    "@itone/fan-coding-agent": "workspace:*",
    "@itone/fan-ai": "workspace:*",
    "@itone/fan-agent-core": "workspace:*",
    "@itone/fan-tui": "workspace:*",
    "@sinclair/typebox": "^0.34.0"
  }
}
```

> `workspace:*` зависимости автоматически удаляются при установке через Store и резолвятся через runtime.

---

## Дополнительные репозитории на сервере

| Ресурс | URL | Root |
|--------|-----|------|
| FAN Store | `http://185.219.41.46/fan/` | `/var/www/fan-repo/` |
| PI Store | `http://185.219.41.46/pi/` | `/opt/repos/pi-store/` |
