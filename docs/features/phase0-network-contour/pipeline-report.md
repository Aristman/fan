# Pipeline Report: Фаза 0 — Сетевой контур

> **Дата старта:** 2026-07-25
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Roadmap:** docs/features/phase0-network-contour/roadmap.md
> **Стратегия коммитов:** per-function (conventional)
> **Репортинг:** ошибки + финал
> **VPS-шаги:** файлы + локальная проверка (реальный деплой — manual)

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 11 |
| Реализовано (✅) | 11 |
| Провалено (❌) | 0 |
| Коммитов | 13 (11 фич + 1 fix + 1 финализация) |
| Финальная верификация | PASS (1 P1-fix применён) |
| E2E | e2e-local.sh 10/10 × 4 прогона |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-0.1 PORT env | ✅ | 684de18 | 11/11 | 2 |
| F-0.2 HOST env | ✅ | dcffbbf | 8/8 | 1 |
| F-0.3 FAN_PUBLIC | ✅ | 9edb9b5 | 15/15 | 2 |
| F-0.4 CORS ALLOWED_ORIGINS | ✅ | 5d8fb15 | 9/9 | 1 |
| F-0.5 Dockerfile | ✅ | 9524ac0 | 2/2 | 1 |
| F-0.6 docker-compose | ✅ | bbf59ec | 3/3 | 1 |
| F-0.7 nginx | ✅ | be0bc19 | static | 1 |
| F-0.8 certbot | ✅ | 312e603 | static | 1 |
| F-0.9 health readiness | ✅ | 9dac9fb | 3/3 | 1 |
| F-0.10 logging volume | ✅ | 164c6f0 | 14/14 | 1 |
| F-0.11-E2E deploy chain | ✅ | 0d6bd65 | 10/10 | 1 |

## Детали реализации

### F-0.11-E2E: Полная цепочка деплоя с нуля
- **Статус:** ✅ Реализовано
- **Коммит:** 0d6bd65
- **Верификация:** PASS (независимый прогон e2e-local.sh координатором: PASS=10 FAIL=0)
- **Файлы:** deploy/scripts/e2e-local.sh (новый), ws-handler.ts, http-server.ts, index.ts, deployment.md
- **Критичный фикс в ходе фичи:** WS не работал под Bun.serve в Docker → createBunWebSocketBridge
- **Находки:** POST /api/tokens защищён tokenAuth (chicken-and-egg) — bootstrap через docker exec + Prisma (operator-side provisioning); `fan token create` не существует — кандидат на отдельную фичу; пустая сессия не пишется в JSONL до первого сообщения (by design)

**Все 11 фич фазы 0 реализованы** ✅

### F-0.9: Readiness-поля health endpoint
- **Статус:** ✅ Реализовано
- **Коммит:** 9dac9fb
- **Верификация:** PASS (api-gateway 64/64)
- **Файлы:** api-gateway: types.ts, http-server.ts, __tests__/http-server.test.ts; coding-agent main.ts; docker-compose.yml (комментарий)
- **Решение:** 200 ok / 503 degraded — healthcheck F-0.6 ловит сбой без изменений (r.ok)

### F-0.10: Логирование в volume
- **Статус:** ✅ Реализовано
- **Коммит:** 164c6f0
- **Верификация:** PASS (14/14 unit + live Docker: записи, ротация, LOG_LEVEL-фильтр, passthrough)
- **Файлы:** utils/file-logger.ts (новый), main.ts, test/file-logger.test.ts, docker-compose.yml, Dockerfile
- **Заметки:** LOG_LEVEL фильтрует только файл; MSYS path-conv нюанс на Windows при ручном docker run

### F-0.8: Certbot SSL сертификаты
- **Статус:** ✅ Реализовано (артефакты; реальный выпуск — manual VPS-шаг)
- **Коммит:** 312e603
- **Верификация:** PASS (bash -n, идемпотентность, согласованность путей с F-0.7)
- **Файлы:** deploy/scripts/setup-tls.sh, docs/guides/deployment.md (раздел TLS)
- **Заметки:** найден и исправлен баг парсинга dig (склейка A-записей); DNS A-запись — предусловие

**Граница этапа 0.3** ✅ — инфраструктура готова (F-0.7, F-0.8)

### F-0.7: Nginx конфиг с WebSocket поддержкой
- **Статус:** ✅ Реализовано
- **Коммит:** be0bc19
- **Верификация:** PASS (реальный `nginx -t` в docker nginx:alpine — syntax ok; статический чеклист директив)
- **Файлы:** deploy/nginx/agent.sea-agents.ru.conf, docs/guides/deployment.md (новые)
- **Заметки:** map $connection_upgrade — ровно один раз на инстанс nginx (задокументировано); basic auth не включён (решение v2); TC-F-0.7-1/2 — VPS-чеклист в deployment.md (manual)

### F-0.6: docker-compose.yml для продакшена
- **Статус:** ✅ Реализовано
- **Коммит:** bbf59ec
- **Верификация:** PASS (независимый прогон координатором: config OK, health 200, no-token 401, loopback-only; воркером: persistence down/up)
- **Файлы:** docker-compose.yml (новый), .env.example
- **Заметки:** фактическое имя БД `filin.db` (не `fan.db` — upstream hardcode, в roadmap ошибочно); сессия создаётся лениво (JSONL при первом сообщении); POST messages в контейнере требует API-ключи провайдеров (настраиваются при деплое)

**Граница этапа 0.2** ✅ — контейнеризация готова (F-0.5, F-0.6)

### F-0.5: Мультистейдж Dockerfile
- **Статус:** ✅ Реализовано
- **Коммит:** 9524ac0
- **Верификация:** PASS (реальный docker build ×2 воспроизводимо, health 200, POST /api/sessions, volume persistence: filin.db + sessions в /data/.fan/agent)
- **Файлы:** Dockerfile, .dockerignore (новые)
- **Отклонение:** 645MB вместо <500MB — принято (Bun runtime + Prisma engines + production node_modules monorepo; implement-воркер провёл оптимизацию слоёв)

*(заполняется инкрементально)*

### F-0.4: Безопасность CORS — ALLOWED_ORIGINS
- **Статус:** ✅ Реализовано
- **Коммит:** 5d8fb15
- **Верификация:** PASS с 1-й попытки (live: allowed/evil/default origin, preflight, WS upgrade)
- **Файлы:** api-gateway/src/cors-config.ts (новый), http-server.ts, index.ts, __tests__/cors-config.test.ts
- **Тесты:** 9 новых (api-gateway 61)
- **Неблокирующие замечания:** trailing slash не нормализуется; fail-open на '*' при пустом env без warning (рекомендация: warn при FAN_PUBLIC=1); WS не проверяет Origin (CSWSH, смягчается токеном)

**Граница этапа 0.1** ✅ — все 4 фичи ядра сервера реализованы (F-0.1, F-0.2, F-0.3, F-0.4)

### F-0.3: Режим публичного сервера FAN_PUBLIC
- **Статус:** ✅ Реализовано
- **Коммит:** 9edb9b5
- **Верификация:** FAIL → bug-fix → PASS (2 попытки: fail-open при FAN_PUBLIC=TRUE/" 1"/yes → fail-closed семантика + дедупликация в api-gateway)
- **Файлы:** api-gateway/src/auth.ts, index.ts, http-server.ts, __tests__/auth.test.ts; coding-agent: cli/server-config.ts, main.ts, test/server-config.test.ts
- **Тесты:** 15 новых (api-gateway 52, coding-agent 1058)
- **Живой прогон verify:** FAN_PUBLIC=1+FAN_NO_AUTH=1 → 401 REST и WS; без FAN_PUBLIC → 200 legacy
- **Замечания (низкие):** /api/health публичен (intentional, scope F-0.9)

### F-0.2: Чтение HOST из переменной окружения
- **Статус:** ✅ Реализовано
- **Коммит:** dcffbbf
- **Верификация:** PASS с 1-й попытки (adversarial: unit 12/12, живой bind 0.0.0.0, парсер аргументов, IPv6)
- **Файлы:** cli/server-config.ts, main.ts, cli/server-command.ts, cli/args.ts, test/server-config.test.ts
- **Тесты:** 8 новых (suite 1048)
- **Неблокирующие замечания:** server-command.ts:155 литерал "localhost" вместо константы; IPv6-URL без скобок (pre-existing)

### F-0.1: Чтение PORT из переменной окружения
- **Статус:** ✅ Реализовано
- **Коммит:** 684de18
- **Верификация:** FAIL → bug-fix → PASS (2 попытки: biome import order, валидация диапазона 1..65535, trim, daemon URL, help)
- **Файлы:** cli/server-config.ts (новый), main.ts, cli/server-command.ts, cli/args.ts, test/server-config.test.ts
- **Тесты:** 11/11 (TC-F-0.1-1, TC-F-0.1-2 + edge cases)
- **Критерии приёмки:** все выполнены
