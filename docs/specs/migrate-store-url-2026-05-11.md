# Миграция FAN Store на новый сервер

> Спецификация перехода с `http://185.219.41.46/fan` на `https://fan.sea-agents.ru/fan-store`

**Дата:** 2026-05-11  
**Статус:** На ревизии  
**Источник требований:** `/home/aristman/Загрузки/Telegram Desktop/adding-fan-store.md`

---

## 1. Обзор

FAN Store (репозиторий пакетов) размещён на VPS `185.219.41.46`. Сейчас работает через HTTP на голом IP. План — перевести на домен `fan.sea-agents.ru` с HTTPS (SSL от Let's Encrypt).

Изменения затрагивают:
- **Домен:** `185.219.41.46` → `fan.sea-agents.ru`
- **Протокол:** `http://` → `https://`
- **Base path:** `/fan` → `/fan-store`
- **Путь на сервере (nginx root):** `/var/www/fan-repo/` → `/var/www/html/fan-store/`
- **Название репозитория:** `fan-repo` → `fan-store` (во всех конфигах, коде, документации)

SSH-хост **не меняется** — это тот же VPS `185.219.41.46`, только путь к директории другой.

---

## 2. Старая vs Новая инфраструктура

| Аспект | Было | Станет |
|--------|------|--------|
| Протокол | `http://` (порт 80) | `https://` (порт 443, SSL) |
| Хостнейм | `185.219.41.46` | `fan.sea-agents.ru` |
| Base URL | `http://185.219.41.46/fan` | `https://fan.sea-agents.ru/fan-store` |
| Индекс | `http://185.219.41.46/fan/index.json` | `https://fan.sea-agents.ru/fan-store/index.json` |
| Пакеты | `http://185.219.41.46/fan/packages/<file>` | `https://fan.sea-agents.ru/fan-store/packages/<file>` |
| Дистрибутивы | `http://185.219.41.46/fan/dist/<file>` | `https://fan.sea-agents.ru/fan-store/dist/<file>` |
| Имя репозитория | `fan-repo` | `fan-store` |
| Nginx root | `/var/www/fan-repo/` | `/var/www/html/fan-store/` |
| SSH remote path | `root@185.219.41.46:/var/www/fan-repo` | `root@185.219.41.46:/var/www/html/fan-store` |
| SSH host | `root@185.219.41.46` | `root@185.219.41.46` (без изменений) |

---

## 3. Полный перечень изменений (файл за файлом)

### 3.1. Исходный код (TypeScript)

#### `packages/store/src/config.ts` — строка 33

Default URL репозитория при первом запуске (когда `~/.fan/agent/store.json` не существует).

```diff
 repositories: [
   {
-    name: "fan-repo",
-    url: "http://185.219.41.46/fan",
+    name: "fan-store",
+    url: "https://fan.sea-agents.ru/fan-store",
     enabled: true,
     priority: 1,
   },
 ],
```

**Влияние:** Новые установки FAN будут по умолчанию подключены к новому серверу.

---

#### `packages/coding-agent/src/cli/self-update.ts` — строка 41

Сервер обновлений для `fan update` и авто-проверки при старте TUI.

```diff
-export const UPDATE_SERVER_URL = "http://185.219.41.46/fan/dist";
+export const UPDATE_SERVER_URL = "https://fan.sea-agents.ru/fan-store/dist";
```

**Влияние:** Самообновление FAN (`fan update`, `fan update --check`) будет обращаться к новому серверу.

---

### 3.2. CLI и серверные скрипты

#### `tools/fan-repo-server/fan-repo`

CLI-утилита для управления репозиторием. Содержит 3 константы и Help-текст.

**Конфиг (строки 18-20):**
```diff
 REMOTE_HOST="root@185.219.41.46"        # ← без изменений (SSH host тот же)
-REMOTE_PATH="/var/www/fan-repo"
-REPO_URL="http://185.219.41.46/fan"
+REMOTE_PATH="/var/www/html/fan-store"
+REPO_URL="https://fan.sea-agents.ru/fan-store"
```

**Help-текст (строки ~506-511):**
```diff
-        echo "  publish [target]       Deploy to server (default: root@185.219.41.46:/var/www/fan-repo)"
+        echo "  publish [target]       Deploy to server (default: root@185.219.41.46:/var/www/html/fan-store)"
 ...
-        echo "Default server: root@185.219.41.46:/var/www/fan-repo"
-        echo "Default URL:    http://185.219.41.46/fan/"
+        echo "Default server: root@185.219.41.46:/var/www/html/fan-store"
+        echo "Default URL:    https://fan.sea-agents.ru/fan-store/"
```

**Влияние:** `fan-repo publish` будет деплоить в новую директорию на сервере. URL в index.json будут указывать на новый домен.

---

#### `tools/fan-repo-server/restore-server.sh`

Восстановление структуры директорий на сервере после сбоя.

```diff
-REPO_DIR="/var/www/fan-repo"
+REPO_DIR="/var/www/html/fan-store"
 ...
     "repository": {
-      "name": "fan-repo",
-      "url": "http://185.219.41.46/fan/",
+      "name": "fan-store",
+      "url": "https://fan.sea-agents.ru/fan-store/",
```

---

#### `scripts/install.sh`

Unix one-liner installer. Содержит URL в комментариях и в коде.

```diff
-#   curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
+#   curl -fsSL https://fan.sea-agents.ru/fan-store/dist/install.sh | bash
 ...
-MANIFEST_URL="http://185.219.41.46/fan/dist/manifest.json"
+MANIFEST_URL="https://fan.sea-agents.ru/fan-store/dist/manifest.json"
 ...
-ARCHIVE_URL="http://185.219.41.46/fan/dist/${ARCHIVE_NAME}"
+ARCHIVE_URL="https://fan.sea-agents.ru/fan-store/dist/${ARCHIVE_NAME}"
```

---

#### `scripts/install.ps1`

Windows one-liner installer.

```diff
-#        irm http://185.219.41.46/fan/dist/install.ps1 | iex
+#        irm https://fan.sea-agents.ru/fan-store/dist/install.ps1 | iex
 ...
-$manifestUrl = "http://185.219.41.46/fan/dist/manifest.json"
+$manifestUrl = "https://fan.sea-agents.ru/fan-store/dist/manifest.json"
```

---

### 3.3. Данные (JSON)

#### `packages/coding-agent/binaries/manifest.json`

Манифест дистрибутивов. Все 5 platform-записей содержат URL.

```diff
     "platforms": {
       "darwin-arm64": {
-        "url": "http://185.219.41.46/fan/dist/fan-0.9.0-darwin-arm64.tar.gz",
+        "url": "https://fan.sea-agents.ru/fan-store/dist/fan-0.9.0-darwin-arm64.tar.gz",
         ...
       },
       "darwin-x64": {
-        "url": "http://185.219.41.46/fan/dist/fan-0.9.0-darwin-x64.tar.gz",
+        "url": "https://fan.sea-agents.ru/fan-store/dist/fan-0.9.0-darwin-x64.tar.gz",
         ...
       },
       "linux-arm64": {
-        "url": "http://185.219.41.46/fan/dist/fan-0.9.0-linux-arm64.tar.gz",
+        "url": "https://fan.sea-agents.ru/fan-store/dist/fan-0.9.0-linux-arm64.tar.gz",
         ...
       },
       "linux-x64": {
-        "url": "http://185.219.41.46/fan/dist/fan-0.9.0-linux-x64.tar.gz",
+        "url": "https://fan.sea-agents.ru/fan-store/dist/fan-0.9.0-linux-x64.tar.gz",
         ...
       },
       "windows-x64": {
-        "url": "http://185.219.41.46/fan/dist/fan-0.9.0-windows-x64.zip",
+        "url": "https://fan.sea-agents.ru/fan-store/dist/fan-0.9.0-windows-x64.zip",
         ...
       }
     }
```

**Влияние:** `install.sh`, `install.ps1` и `fan update` скачивают бинарники по URL из этого манифеста.

> ⚠️ При сборке новых бинарников (`scripts/build-binaries.sh`) этот файл перегенерируется. Нужно убедиться, что скрипт сборки также использует новый URL, либо обновлять его вручную после каждой сборки.

---

#### `~/.fan/agent/store.json`

Runtime-конфиг FAN Store. Генерируется автоматически из defaults при первом запуске, но у текущих пользователей уже существует.

```diff
 {
   "repositories": [
     {
-      "name": "fan-repo",
-      "url": "http://185.219.41.46/fan",
+      "name": "fan-store",
+      "url": "https://fan.sea-agents.ru/fan-store",
       "enabled": true,
       "priority": 1
     }
   ],
   ...
 }
```

**Влияние:** Активная сессия FAN будет обращаться к новому серверу.

---

#### `~/fan-repo/index.json`

Локальная копия индекса репозитория. Содержит `repository.name`, `repository.url` и `downloadUrl` для каждого пакета.

```diff
 {
   "repository": {
-    "name": "fan-repo",
-    "url": "http://185.219.41.46/fan",
+    "name": "fan-store",
+    "url": "https://fan.sea-agents.ru/fan-store",
     ...
   },
   "packages": [
     {
       "name": "auto-tests",
       ...
-      "downloadUrl": "http://185.219.41.46/fan/packages/auto-tests-1.0.0.tar.gz",
+      "downloadUrl": "https://fan.sea-agents.ru/fan-store/packages/auto-tests-1.0.0.tar.gz",
       ...
     },
     // ... все остальные пакеты аналогично
   ]
 }
```

**Количество пакетов:** ~15-20 записей, все `downloadUrl` нужно обновить.

**Влияние:** `fan-repo publish` копирует этот файл на сервер. Без обновления — на сервере будут старые URL.

---

### 3.4. Документация (Markdown)

#### `CLAUDE.md` — строка 87

```diff
-FAN ships with 8 pre-installed skills in `skills/`. Source files are local; installable via FAN Store (`http://185.219.41.46/fan/`). All skills are v1.0.0.
+FAN ships with 8 pre-installed skills in `skills/`. Source files are local; installable via FAN Store (`https://fan.sea-agents.ru/fan-store/`). All skills are v1.0.0.
```

---

#### `ARCHITECTURE.md` — строка 199

```diff
-**FAN Store:** `http://185.219.41.46/fan/` — install via `fan store install <name>`.
+**FAN Store:** `https://fan.sea-agents.ru/fan-store/` — install via `fan store install <name>`.
```

---

#### `INSTALL.md` — строки 29, 35

```diff
-curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
+curl -fsSL https://fan.sea-agents.ru/fan-store/dist/install.sh | bash
 ...
-irm http://185.219.41.46/fan/dist/install.ps1 | iex
+irm https://fan.sea-agents.ru/fan-store/dist/install.ps1 | iex
```

---

#### `QUICK-START.md` — строки 13, 16

```diff
-curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
+curl -fsSL https://fan.sea-agents.ru/fan-store/dist/install.sh | bash
 ...
-irm http://185.219.41.46/fan/dist/install.ps1 | iex
+irm https://fan.sea-agents.ru/fan-store/dist/install.ps1 | iex
```

---

#### `docs/guides/quick-start.md` — строки 11, 14

```diff
-curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
+curl -fsSL https://fan.sea-agents.ru/fan-store/dist/install.sh | bash
 ...
-irm http://185.219.41.46/fan/dist/install.ps1 | iex
+irm https://fan.sea-agents.ru/fan-store/dist/install.ps1 | iex
```

---

#### `tools/fan-repo-server/GUIDE.md`

Крупный файл (~500 строк) с множеством URL-ссылок. Все вхождения нужно заменить:

| Что искать | На что заменить |
|-----------|----------------|
| `http://185.219.41.46/fan` | `https://fan.sea-agents.ru/fan-store` |
| `fan-repo` (как имя репозитория) | `fan-store` |
| `/var/www/fan-repo` | `/var/www/html/fan-store` |
| `root@185.219.41.46:/var/www/fan-repo` | `root@185.219.41.46:/var/www/html/fan-store` |

Затронутые строки (ориентировочно): 34, 35, 36, 85, 283, 392, 452, 506, 510, 511 и другие throughout.

---

## 4. Что НЕ меняется

| Файл/компонент | Причина |
|---------------|---------|
| SSH-хост `root@185.219.41.46` | IP сервера не меняется |
| `tools/fan-repo-server/setup-vps.sh` | Одноразовый скрипт, уже отработан |
| `packages/store/src/repo-client.ts` | URL приходит из config, сам по себе не хардкодит |
| `packages/store/src/store-extension.ts` | Работает через config и db, URL не хардкодит |
| `packages/store/src/store-tools.ts` | Работает через config, URL не хардкодит |
| `packages/store/src/installer.ts` | Работает через downloadUrl из index.json |
| `packages/store/src/storage.ts` | Хранит installedPath, не URL |
| `packages/store/src/types.ts` | Типы, не содержат URL |

---

## 5. Оценка рисков

| Риск | Уровень | Митигация |
|------|---------|-----------|
| Старые URL перестанут работать на сервере | **Высокий** | Сохранить старый nginx location `/fan/` как redirect на новый URL |
| Пользователи с существующим `~/.fan/agent/store.json` останутся на старом сервере | **Средний** | Новый nginx может перенаправлять HTTP на HTTPS, но старые клиенты не получат новые пакеты. Опубликовать уведомление об обновлении. |
| `manifest.json` перегенерируется при сборке со старым URL | **Средний** | Проверить `scripts/build-binaries.sh` — возможно, URL хардкодится там |
| SSL-сертификат протухнет / не установлен | **Высокий** | Проверить на сервере до миграции: `curl -sI https://fan.sea-agents.ru/fan-store/index.json` |
| Разные пути: nginx root vs fan-store remote path | **Низкий** | Одинаковый VPS, rsync target просто меняется |

---

## 6. Порядок деплоя

### Фаза 0: Верификация сервера (до любых изменений)

```bash
# Проверить что новый URL работает
curl -sI https://fan.sea-agents.ru/fan-store/index.json | head -5
# Ожидаем: HTTP/2 200

# Проверить CORS
curl -sI https://fan.sea-agents.ru/fan-store/index.json | grep -i access-control
# Ожидаем: Access-Control-Allow-Origin: *

# Проверить скачивание пакета
curl -I https://fan.sea-agents.ru/fan-store/packages/auto-tests-1.0.0.tar.gz | head -5
```

### Фаза 1: Данные (index.json на сервере)

```bash
# 1. Обновить ~/fan-repo/index.json (все URL + repository.name)
# 2. fan-repo publish (зальёт на новый путь /var/www/html/fan-store/)
```

> Важно: `fan-repo publish` деплоит в `REMOTE_PATH`. После изменения `REMOTE_PATH` в скрипте, publish пойдёт в `/var/www/html/fan-store/`. Но нужно убедиться, что эта директория существует на сервере и nginx указывает туда.

### Фаза 2: Исходный код (config.ts + self-update.ts)

```bash
# Изменить 2 файла
# Пересобрать: npm run build
```

### Фаза 3: Runtime-конфиг

```bash
# Обновить ~/.fan/agent/store.json (name + url)
```

### Фаза 4: Скрипты (fan-repo, install.sh, install.ps1, restore-server.sh)

### Фаза 5: Документация

### Фаза 6: Итоговая верификация

```bash
# grep -r "185.219.41.46/fan" --include="*.ts" --include="*.json" --include="*.sh" --include="*.ps1" --include="*.md" .
# Ожидаем: 0 результатов (кроме .git, node_modules, dist)
```

---

## 7. План отката

Если что-то пошло не так:

1. **Код:** `git diff` → `git checkout` — откатить 2 TS-файла
2. **Скрипты:** `git checkout tools/ scripts/`
3. **Документация:** `git checkout *.md docs/`
4. **Данные:** `~/fan-repo/index.json` — `git checkout` (если в git) или ручной revert
5. **Runtime config:** вручную вернуть `~/.fan/agent/store.json`
6. **manifest.json:** `git checkout packages/coding-agent/binaries/manifest.json`

Все изменения обратимы через git.

---

## 8. Сводка

| Категория | Файлов | Изменений |
|-----------|--------|-----------|
| Исходный код (TS) | 2 | 3 замены (URL + name в config.ts, URL в self-update.ts) |
| Скрипты (bash/ps1) | 4 | ~12 замен (URL + path + name) |
| Данные (JSON) | 3 | ~27 замен (manifest: 5, index.json: ~20+name+url, store.json: name+url) |
| Документация (MD) | 6 | ~20 замен (URL + fan-repo→fan-store) |
| **Итого** | **15 файлов** | **~62 замены** |
