# Ручное тестирование супер-оркестратора FAN

> Подробная инструкция ручной проверки всего, что построено в этапах 0–3
> (48 функций + F-48.5) и post-release фиксов 2.8.1.
> Ветка: `FAN/feature/new-agents-flow`. Версии: FAN 2.8.1, fan-coding-agent 2.7.3,
> fan-mission 0.6.0, fan-super-orchestrator 0.3.0, fan-scheduler 0.2.0, fan-webhook 0.1.3.

---

## Подготовка

### 1. Бинарь
Пересобрать fan из ветки (release-скрипт или свой цикл сборки):

```powershell
# Windows
.\scripts\release-binaries.ps1 -Platform windows-x64
```

В бинаре должны быть: фикс бюджета итерации (opt-in), CLI-discovery расширений,
`fan mission start` (исправленный), `fan mission tree`, Checkpoint API, Mission API.

Проверка версии: `fan --version` → `2.8.1`.

### 2. Расширения (deployed-копии)
Синхронизировать из `extensions/` репозитория в `~/.fan/agent/extensions/`:

- **fan-mission 0.6.0** — обязательно целиком: `index.ts`, `slash-commands.ts`,
  `mission-loop.ts`, `prompt-builder.ts`, `mission-executor.ts`, `default-run-agent.ts`,
  `epic-delegation.ts`, `file-state-manager.ts`, `package.json`, `templates/`
- **fan-super-orchestrator 0.3.0** — каталог целиком (если ещё не синхронизирован после Этапа 3)
- **fan-scheduler 0.2.0**, **fan-webhook 0.1.3** — если не обновлялись ранее

Проверка: в `~/.fan/agent/extensions/fan-mission/package.json` версия `0.6.0`;
файл `prompt-builder.ts` присутствует.

### 3. Тестовый проект
Любой git-репозиторий (можно пустой с `git init`). Все миссионные файлы живут в
`docs/missions/<slug>/` внутри него.

---

## Блок 1 — Жизненный цикл миссии (~10 мин)

Проверяет: автопилот, фиксы missionStart (2.7.3), lazy-attach (0.6.0), prompt-builder (0.5.0).

1. **Создание миссии (CLI):**
   ```
   fan mission init test-mission
   ```
   ✅ `docs/missions/test-mission/` создан: MISSION.md, ROADMAP.md, STATE.md,
   BACKLOG.md, DECISIONS.md, tree-journal.jsonl.
   ❌ Повторный init той же миссии → «Mission already exists» (ожидаемо).

   **0.7.0 — описание при init:**
   ```
   fan mission init test-mission Сделать REST API для профилей пользователей с тестами
   ```
   ✅ Всё после slug склеивается в описание и попадает в `## Goal` в MISSION.md
   (весь текст, без разбора). Без описания — пустой Goal, как раньше.
   Альтернатива из сессии: `/mission:init test-mission Сделать REST API…` —
   без описания TUI спросит диалогами Goal (обязательный) / Scope / Constraints;
   существующая миссия → ошибка через output.

2. **Запуск:** `fan` (TUI) → `/mission:start`

   ⚠️ **Перед запуском добавьте в ROADMAP.md 2–3 своих пункта** — шаблон default
   содержит только bootstrap: после его выполнения миссия легитимно станет
   `completed` (все пункты [x]), и stop/pause будут отвечать «Mission already
   completed». Для теста жизненного цикла нужен roadmap с запасом пунктов.
   Исключение (0.7.0): миссия, созданная **с описанием** (Goal непуст), после
   bootstrap не завершается — контур запускает planning-итерацию и ожидает
   декомпозицию Goal в unchecked-пункты ROADMAP.
   ✅ Первый тик: контур берёт пункт «Bootstrap mission: test-mission».
   ✅ **Ключевое (фикс 0.5.0):** агент НЕ занимается раскопками — не ищет файлы
   миссии и не перечитывает их (контекст уже в промпте: MISSION/ROADMAP/STATE +
   протокол `<promise>` + guidance).
   ✅ **0.7.0:** для bootstrap-пункта при непустом Goal в промпте есть guidance
   «decompose the mission Goal into concrete unchecked ROADMAP.md items…».

3. **Результат итерации:**
   ✅ `STATE.md` — итерация 1, секция «Сделано» заполнена.
   ✅ `git log` — коммит вида `mission: ...`.
   ✅ `MISSION.md` — пункт ROADMAP отмечен `[x]`.

4. **Перезапуск без рестарта fan (фиксы 0.6.0 + 2.7.3):**
   - `/mission:stop` → статус `aborted`
   - `/mission:start` **в той же сессии** → контур подхватывается заново
     (lazy-attach: scan → FSM-переход aborted→active → attach → tick)
   - ✅ Никакого «No active mission (mission loop is not attached)», работа идёт.
   - CLI-вариант: `fan mission start` → «Mission started at …» (раньше — молча падал).

5. **Пауза/возобновление:** `/mission:pause` → тики не выполняют работу →
   `/mission:resume` → работа продолжается.

6. **Виджет:** `F9` — виджет миссии появляется/скрывается (статус, итерация, шаг).

7. **Авто-тик:** при активной миссии scheduler раз в 5 минут шлёт `mission_tick` →
   контур делает итерацию без ручного `/mission:start`. (Можно проверить
   `docs/missions/test-mission/.mission-loop.json` — currentIteration растёт сам.)

---

## Блок 2 — Устойчивость к данным ROADMAP (~3 мин)

Проверяет фикс 0.4.1 (ложный completed).

8. Отредактировать ROADMAP: пункты с маркером `* [ ]` вместо `- [ ]`.
   ✅ Тик берёт `*`-пункт в работу; после выполнения маркер сохранён (`* [x]`).

9. ROADMAP без единого чеклист-пункта (просто текст).
   ✅ Тик → статус `failed`, диагностика «ROADMAP contains no parseable checklist items».
   ❌ НЕ должно быть мгновенного `completed` с iteration 0.

10. Экранированные скобки (`* \[ ]` — артефакт некоторых редакторов).
    ✅ Честный `failed` с диагностикой (парсер их не берёт — это не чеклист).
    Лечится переписыванием ROADMAP нормальным markdown.

---

## Блок 3 — Webhook + multi-instance (~3 мин)

11. ```bash
    curl http://127.0.0.1:9090/health
    ```
    ✅ `{"status":"ok"}`.

12. ```bash
    curl -X POST http://127.0.0.1:9090/webhook -H "Content-Type: application/json" \
      -d '{"type":"steer","message":"проверь статус"}'
    ```
    ✅ HTTP 200; steer-сообщение потреблено контуром на следующем тике.

13. Запустить **второй** fan в другом терминале.
    ✅ В логе второго: `[fan-webhook] port 9090 busy, listening on 9091` (0.1.3).
    ✅ Оба инстанса живы, `curl :9091/health` → ok. Остановить второй → порт освобождается.

---

## Блок 4 — Иерархия узлов / EPIC-делегирование (~15 мин) — РЕШАЮЩИЙ

Проверяет: F-48.5 wiring, depth2-integration, дерево реальных процессов, бюджеты, kill-switch.

14. Добавить в ROADMAP пункт с маркером EPIC:
    ```
    - [ ] [EPIC] Реализовать X (подзадача 1; подзадача 2; подзадача 3)
    ```

15. Тик (`/mission:start` или авто-тик).
    ✅ Контура декомпозирует EPIC (runAgent) и порождает **реальные дочерние
    `fan server` процессы** (видно в диспетчере задач: дочерние fan.exe).
    ✅ В env дочерних: `FAN_NODE_TOKEN`, `FAN_ORCHESTRATOR_DEPTH`, `--tools <манифест>`.

16. Журнал дерева:
    ✅ `docs/missions/test-mission/tree-journal.jsonl` — записи `spawn`/`complete`
    с correlationId, nodeId, parentId, usage.

17. CLI-дерево:
    ```
    fan mission tree test-mission
    fan mission tree test-mission --format json
    fan mission tree test-mission --depth 1
    ```
    ✅ ASCII-дерево L0 → L1 со статусами; JSON-топология совпадает; `--depth` обрезает.

18. Бюджет:
    ✅ `docs/missions/test-mission/mission-budget.json` — `by_branch`,
    Σ allocated ≤ budget_total (из frontmatter MISSION.md).

19. Завершение EPIC:
    ✅ ROADMAP пункт `[x]`, STATE обновлён, коммит, дочерние процессы остановлены.

20. **Kill-switch:** во время работы дочерних убить родительский fan
    (Ctrl+C / taskkill).
    ✅ Дочерние процессы мертвы в течение секунд (kill-switch ≤1с).
    ✅ При следующем старте — startup-reconciliation: orphan-записи в журнале
    (reconciled/abandoned), зомби-процессы не остаются.

---

## Блок 5 — Dashboard + Mission API (~7 мин)

21. `fan --web` → dashboard в браузере.

22. REST (нужен ClientToken из БД/settings):
    ```bash
    curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/missions/test-mission/tree
    curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/missions/test-mission/status
    curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/missions/test-mission/budget
    ```
    ✅ JSON дерева/статуса/бюджета; неизвестный slug → **404**;
    slug с `../` → отклонён (traversal hardening).

23. WS: подписка на события — при работе дерева приходят `mission_event`
    (spawn/complete/fail/abort). Проверить devtools браузера или любым WS-клиентом.

24. Компоненты dashboard: `<mission-tree>`, `<mission-status>`, `<mission-log>`,
    `<mission-budget>` (обновляются по WS-дельтам; snapshot/delta контракт).

---

## Блок 6 — Ядро: чекпоинты и бюджет итерации (~5 мин)

25. **Checkpoint API:** в сессии создать чекпоинт (через API AgentSession):
    ✅ `.fan/checkpoints/<slug>/<label>.json` + git-коммит `checkpoint:<label>`.
    ✅ Restore → состояние откатывается, рабочее дерево НЕ тронуто (без `--hard`),
    `.fan/` не попадает в коммиты.

26. **Бюджет итерации opt-in (фикс 2.7.1):**
    - Без настроек `budget.*` → длинные тёрны с большим контекстом живут
      (регрессия «обрыв после первого tool call» не повторяется).
    - С `settings.json` → `budget.iterationTokenLimit: 50000` → тяжёлый тёрн:
      ✅ событие `iteration_budget_exceeded`, сессия остаётся живой, следующий
      запрос обрабатывается (лимит per-turn, не per-session).
    - После проверки лимит убрать (0 или удалить ключ = безлимит).

---

## Автопрогон (вместо или до ручных блоков)

```bash
cd extensions/fan-super-orchestrator
node test/phase-gate-a.e2e.mjs    # 11/11 — node spawn/auth/sanitize
node test/phase-gate-a3.e2e.mjs   # 17/17 — глубина 3, манифесты, guard
node test/phase-gate-b.e2e.mjs    # 26/26 — протоколы, бюджет, журнал
node test/phase-gate-c.e2e.mjs    # 20/20 — MVP depth 2, kill-switch
node test/phase-gate-c3.e2e.mjs   # 32/32 — полный wired EPIC-контур

cd ../../packages/api-gateway && npx vitest run   # phase-gate B3 (12/12) в suite
```

Все e2e-скрипты поднимают реальные `fan server` процессы из локального dist
(`node packages/coding-agent/dist/cli.js server`), ничего не мокают на уровне узлов.

---

## Критерий мержа

- Блок 1 ✅ и Блок 4 ✅ — обязательны для мержа `FAN/feature/new-agents-flow` → `develop`.
- Блоки 2, 3, 5, 6 — желательны; любое отклонение → тикет в бэклог
  (`docs/features/super-orchestrator/pipeline-report.md`).

## Известные проблемы (не блокируют)

- **Flaky-тест** `agent-session-concurrent > should queue extension-origin steering
  messages while streaming` — падает детерминированно в изоляции (бэклог #25).
- Тестовые e2e-скрипты пишут argv/env дампы в tempdir (FAN_ARGV_DUMP_DIR) — репо не загрязняют.
- Полный бэклог: #16–#31 в `pipeline-report.md` (секция «Бэклог»).

## После успешной проверки

1. Мерж `FAN/feature/new-agents-flow` → `develop` (merge commit, не squash — история TDD ценна).
2. Разгрести бэклог (#25 — первым).
3. Релиз 2.8.1: `.\scripts\release-binaries.ps1` → архивы + manifest.
