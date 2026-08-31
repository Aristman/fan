# Ручная приёмка: fan-security bundle v1.0.0

> Автопокрытие: 172 (extension) + 387 (orchestrator) тестов, build 0.
> Ниже — то, что проверяется только руками: TUI, установщик, сквозные сценарии.
> Ветка: `FAN/feature/new-worker-security-guard` (HEAD 12759aa).

## TC-1. Сборка архива бандла
- **Шаги:**
  ```bash
  cd bundles/fan-security
  tar -czf /tmp/fan-security-1.0.0.tar.gz \
    --transform="s,^\./,fan-security/," \
    ./DEPLOY.toml ./package.json ./README.md \
    ./extensions/fan-security ./skills/fan-security \
    --exclude="*/node_modules/*" --exclude="*/tests/*"
  tar -tzf /tmp/fan-security-1.0.0.tar.gz
  ```
- **Ожидается:** top-level директория `fan-security/`; внутри `DEPLOY.toml`, `package.json`, `README.md`, `extensions/fan-security/` (index.ts, cli/×3, lib/×6, package.json, README.md), `skills/fan-security/` (SKILL.md, package.json). НЕТ: tests/, fixtures/, node_modules/, *.test.*

## TC-2. Установка бандла (авто-детект)
- **Шаги:** `fan store install /tmp/fan-security-1.0.0.tar.gz` (без `--type`!)
- **Ожидается:** installer сообщает `type: bundle`; установлены **оба** компонента:
  `~/.fan/agent/extensions/fan-security/` и `~/.fan/agent/skills/fan-security/`;
  в списке пакетов (`fan store list` или dashboard) — fan-security v1.0.0.

## TC-3. Загрузка extension
- **Шаги:** запуск `fan`, затем `/reload`.
- **Ожидается:** без ошибок загрузки; команда `/security-scan` доступна (в списке slash-команд).

## TC-4. /security-scan — text (дефолт)
- **Шаги:** в чате: `/security-scan ~/.fan/agent/extensions/fan-security/tests/fixtures` — путь недоступен у пользователя, поэтому создать временный каталог с 2-3 файлами-приманками (фейковый `AKIA`+16 символов, `md5(...)`, `SELECT ... + var`) и выполнить команду на него.
- **Ожидается:** сводка в чате: counts по трём сканерам (secrets/patterns/dep-audit), severity-строки `[SEVERITY] file:line — title`; деп-audit с предупреждением «утилита pip-audit/cargo недоступна», но без падения.

## TC-5. /security-scan — JSON + overflow
- **Шаги:** тот же вызов с `--format json`; затем на каталоге с >20 findings (сгенерировать дублирование приманок).
- **Ожидается:** JSON — валидный, целиком в одном сообщении; при >20 findings — файл `security-scan-*.json` во временном каталоге, путь указан в сводке, JSON внутри валиден.

## TC-6. CLI-сканеры напрямую
- **Шаги:** из `~/.fan/agent/extensions/fan-security/`:
  - `bun cli/scan-secrets.ts <каталог с приманкой> --format json` → `echo $?`
  - `bun cli/scan-secrets.ts <чистый каталог>` → `echo $?`
  - `bun cli/dep-audit.ts <каталог без манифестов>` → `echo $?`
- **Ожидается:** exit 1 (есть findings) / 0 (чисто) / 0 (нет манифестов — не ошибка); в JSON-выводе полный секрет `AKIA...` **не встречается** — только `AKIA…MNOP`.

## TC-7. Секреты не утекают (ключевая проверка)
- **Шаги:** любой вывод из TC-4/5/6 прогнать `grep -c "AKIAABCDEFGHIJKLMNOP"` (полный тестовый ключ).
- **Ожидается:** 0 совпадений везде (чат, stdout, json-файл). Только маскированный вид.

## TC-8. /agents — новый воркер
- **Шаги:** `/agents` в TUI.
- **Ожидается:** 9 агентов; `🔒 security` — Security Auditor, read-only; tools не включают write/edit.

## TC-9. /orchestrator models — 9 типов
- **Шаги:** `/orchestrator models`.
- **Ожидается:** 9 строк (включая security 🔒, не 🤖-fallback); температура security = 0.1; модель настраивается и сохраняется.

## TC-10. Routing координатора: аудит → security
- **Шаги:** coordinator mode (Alt+O); запрос: «проверь модуль <путь> на уязвимости и CVE».
- **Ожидается:** координатор выбирает агента `security` (classify → security); воркер возвращает отчёт: findings с severity/file:line/CWE/remediation; **ни один файл проекта не изменён** (git status чист).

## TC-11. Routing: обычный diff → verify
- **Шаги:** после любого изменения кода: «проверь свежие изменения».
- **Ожидается:** уходит **verify** (не security); при формулировке «сделай полный аудит безопасности проекта» → security.

## TC-12. Скилл
- **Шаги:** `/skill:fan-security` (или обычный запрос «проверь безопасность перед коммитом» — авто-инвокация по description).
- **Ожидается:** методология загружается в контекст; в тексте упомянуты чеклисты и сканеры (с указанием директории установленного расширения).

## TC-13. Обновление пакета
- **Шаги:** повторный `fan store install` архива той же версии (update-ветка).
- **Ожидается:** update проходит (preserve=[] — полная замена), extension и skill перезаписаны, `/reload` без ошибок.

## TC-14. Удаление
- **Шаги:** `fan store remove fan-security`.
- **Ожидается:** удалены оба установленных компонента (extensions/fan-security + skills/fan-security); повторная установка из TC-2 работает.

---

**Критерий готовности к публикации:** TC-1–TC-7 — обязательны (деплой-критично), TC-8–TC-12 — функциональная приёмка, TC-13–14 — желательно.
После приёмки: архив публикуется в store-репозиторий (index.json + manifest + hash по GUIDE.md хранилища).
