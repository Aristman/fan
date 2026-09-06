---
name: feature-pipeline
description: >
  Полный TDD-пайплайн разработки фичи (Red-Green-Refactor) от roadmap до готового результата.
  Берёт roadmap из docs/features/<slug>/roadmap.md, проходит по всем этапам
  и функциям, для каждой выполняя: тесты (Red) → реализация (Green) → верификация → рефакторинг → коммит.
  Каждый шаг цикла — отдельный delegate_task с независимым verify.
  На границах этапов — phase-gate e2e (smoke + e2e-сценарий этапа из roadmap).
  Координатор управляет pipeline через TaskCreate/TaskUpdate, не выполняя код сам.
  В финале: полная верификация, code review, security-аудит, smoke/e2e-тесты, обновление документации,
  финальный коммит и отчёт.
  Используйте когда есть roadmap фичи и нужно автоматизировать полный цикл разработки
  с прозрачным TDD-контролем.
compatibility: "TaskCreate, TaskUpdate, list_tasks, TaskClear, delegate_task, read, write, edit, bash, question, questionnaire, pipeline"
metadata:
  author: "FAN Team"
  version: "3.3.0"
  changelog: |
    v3.3.0 (2026-09-04):
    - Integrated read-only security and code-review workers into the flow
    - Final phase: new steps G.1.5 (code review, once per feature) and G.1.6 (security audit)
    - Optional security audit on phase-gate for stages touching auth/secrets/user input
    - Rule 22: heavy read-only workers are never run in every TDD cycle
    v3.2.0 (2026-08-10):
    - TDD cycle reordered to Red-Green-Refactor: tests-impl (Red) → implement (Green) → verify → refactor → commit
    - Refactor step added between verify and commit (reads Refactor-цели from roadmap)
    - Phase-gate e2e at stage boundaries: Smoke-критерий этапа + E2E-сценарий этапа from roadmap
    - New anti-patterns: Test-After, refactor without green tests
    - Aligned with feature-roadmap v1.3.0 (Red-тест, Refactor-цели, E2E-сценарий этапа, Smoke-критерий этапа)
    v3.1.0 (2026-07-08):
    - Pipeline Mode: working artifacts (development-plan.md, development-log.md, phase-status.json)
    - Integration with FAN Orchestrator `/pipeline` command
    - Auto-update hooks on TaskCreate/TaskUpdate
    - Mandatory commit policy (conventional-commits, per-phase/per-function/manual)
    - Function limit increased to 30 per stage
    - State recovery after session restart
---

# feature-pipeline — TDD-пайплайн разработки фичи

Автоматизирует полный цикл разработки фичи от roadmap до закоммиченного,
протестированного и задокументированного кода. Проходит по roadmap этап за этапом,
функция за функцией, для каждой выполняя полный TDD-цикл.

---

## Контекст запуска (обязательно прочитать перед стартом)

Этот skill предназначен для **агента-оркестратора**, который имеет
доступ к инструментам **TaskCreate/TaskUpdate/list_tasks/TaskClear**
и инструменту **delegate_task** с типами воркеров:
`implement`, `verify`, `tests-impl`, `bug-fix`, `docs-impl`, `explore`, `plan`, `security`, `code-review`.

### Запрещено

- **Делегировать весь pipeline одному `implement`-воркеру как black-box.**
  Это теряет visibility, ломает adversarial verify и скрывает прогресс
  от пользователя.
- Выполнять реализацию, тесты или коммиты в собственном контексте
  координатора — это раздувает контекст и не даёт независимой проверки.
- Запускать pipeline без предварительного согласования с пользователем
  scope и стратегии коммитов.

### Обязательно

- Создавать отдельную задачу (TaskCreate) на КАЖДУЮ функцию из roadmap
  плюс на финальную верификацию, smoke и docs.
- Делегировать каждый TDD-шаг (tests-impl → implement → verify → refactor → commit)
  ОТДЕЛЬНЫМ вызовом delegate_task.
- verify — ВСЕГДА отдельным воркером, не тем же, что implement.
- Запрашивать у пользователя подтверждение на control points
  (см. раздел «Контрольные точки»).

---

## Рабочие артефакты pipeline (v3.1.0+)

Каждый запуск feature-pipeline создаёт и поддерживает **3 рабочих артефакта**, которые живут на диске на время работы над фичей:

| Файл | Назначение | Когда обновляется |
|------|-----------|-------------------|
| `docs/development-plan.md` | Roadmap с фазами, фичами, критериями приёмки | При инициализации |
| `docs/development-log.md` | Append-only журнал выполнения | На каждый TaskUpdate через orchestrator hook |
| `.fan/tracking/phase-status.json` | Машиночитаемый state machine | На каждый TaskUpdate через orchestrator hook |

### Почему артефакты, а не только TaskCreate/TaskUpdate?

| Подход | Плюсы | Минусы |
|--------|-------|--------|
| Только TaskCreate | Минимум дисковых операций | Потеря контекста при перезапуске сессии, нельзя передать состояние другому координатору |
| Артефакты на диске | Документация для коллег, восстановление после обрыва, machine-readable state | Сложнее поддерживать |
| **Гибрид (v3.1.0)** | Лучшее из двух: TaskUpdate пишет и в in-memory TaskManager, и в артефакты на диске | Чуть больше работы |

### Автообновление через orchestrator

В FAN Orchestrator при работающем `pipelineState` каждый TaskUpdate и TaskCreate автоматически:
1. Обновляет `.fan/tracking/phase-status.json` (через `PipelineState.recordStatusChange`)
2. Делает append в `development-log.md` (через `recordLogEntry`)

Координатору **не нужно** явно вызывать эти методы — хуки срабатывают на каждом изменении статуса.

---

## Когда использовать

- Есть roadmap фичи (docs/features/<slug>/roadmap.md) и нужно реализовать всю фичу
- Нужен автоматизированный TDD-конвейер: тесты (Red) → код (Green) → верификация → рефакторинг → коммит
- Требуется гарантированное качество: каждая функция верифицируется перед коммитом
- Нужен phase-gate e2e на границах этапов (smoke + e2e-сценарий из roadmap)
- Нужен финальный отчёт с результатами по каждой функции

## Commit Policy (v3.1.0+)

После каждой функции или фазы (зависит от стратегии) **обязателен** осмысленный git commit с conventional-commits форматом.

### Стратегии

| Стратегия | Когда коммитим | Commit message |
|-----------|---------------|----------------|
| `per-phase` | Когда фаза переходит в COMPLETED | `feat(phase-N): <name> complete` |
| `per-function` | Когда функция переходит в completed | `feat(phase-N/F-X.Y): <summary>` |
| `manual` | Никогда автоматически | — |

### Формат

```
feat(phase-3): Session Management complete

- fan-rust-session crate implemented
- JSONL persistence with compaction, fork, metadata API
- Tests: 47 passed
- E2E: scripts/e2e/phase-3.sh → PASS
```

### Когда НЕ коммитим

- На каждом черновике (только полные завершения)
- Несколько фаз вместе (только одну!)
- С `--no-verify` (skips хуки = обычно плохо)
- Без `feat(` / `fix(` / `chore(` (не conventional)

### Workflow

```bash
# После verify PASS + tests PASS:
git status                                  # проверяем что нет мусора
git add <явный список файлов>              # НЕ git add -A
git commit -m "$(cat <<'EOF'
feat(phase-3): Session Management complete

- tests + implementation
- coverage: 89%
EOF
)"
git log -1 --format=%H  # сохраняем sha в phase-status.json
```

После `git commit` обязательно: `pipeline.recordPhaseChange({ phaseId, status: 'COMPLETED', commitSha: '<sha>' })`.

---

## Когда НЕ использовать

- Нет roadmap (сначала используйте feature-roadmap для его создания)
- Нужно реализовать только одну функцию из roadmap (укажите её вручную)
- Есть только идея без спецификации (сначала research-spec-generator, потом feature-roadmap)
- Не нужно ветвление и коммиты (просто правка кода)
- Нужен полный пакет документов разработки (используйте dev-docs-pack)
- **Не нужны персистентные артефакты** — если работа одноразовая (правка одной строчки), не включай pipeline mode, делай через обычный `delegate_task`
- **Нет FAN Orchestrator** — v3.1.0 завязан на orchestrator. Без orchestrator остаётся v3.0 поведение (только pipeline-report.md, без авто-хуков)

---

## Доступные инструменты

| Инструмент | Для чего |
|-----------|----------|
| `TaskCreate` | Создание задачи на каждую функцию/шаг |
| `TaskUpdate` | Обновление статуса задачи (in_progress → completed/failed) |
| `list_tasks` | Просмотр списка задач |
| `TaskClear` | Очистка завершённых задач после финала |
| `delegate_task` | Запуск под-агентов: implement, verify, tests-impl, bug-fix, docs-impl, explore, plan, security, code-review |
| `read` | Чтение roadmap, кода, тестов |
| `write` | Запись файлов и отчёта |
| `edit` | Изменение roadmap (статусы), документов |
| `bash` | Git-команды, запуск тестов, создание директорий |
| `question` | Уточнения при критических ошибках |
| `questionnaire` | Множественные вопросы при инициализации |

---

## Парсинг входных данных

Skill принимает аргументы через `/skill:feature-pipeline <args>`:

1. **Slug фичи:**
   ```
   /skill:feature-pipeline notification-system
   ```
   Искать roadmap: `docs/features/notification-system/roadmap.md`

2. **Путь к roadmap:**
   ```
   /skill:feature-pipeline docs/features/notification-system/roadmap.md
   ```
   Читать прямой путь.

3. **Без аргументов:**
   ```bash
   # Найти все roadmap
   find docs/features/ -name "roadmap.md" -type f 2>/dev/null
   ```
   Если найден 1 — использовать его. Если несколько — спросить через `question`.

4. **Если аргумент содержит `.md`** — считать путём к файлу. Иначе — считать slug.

---

## Процесс

### Фаза 0: Инициализация

**0.1 Прочитать и распарсить roadmap**

```bash
# Если slug:
read docs/features/<slug>/roadmap.md

# Если путь:
read <path>
```

Распарсить:
- **Название фичи** — из заголовка `# Roadmap: <Название>`
- **Slug** — имя директории (`docs/features/<slug>/`)
- **Этапы** — разделы `## Этап N: <Название>`
- **Функции** — пункты с `#### ☐ <ID>: <Название>` внутри каждого этапа
- **TDD-тесты** — `**TC-<ID>-N:** <название>` с условиями и ожидаемыми результатами
- **Red-тест** — `**Red-тест:**` с ID тест-кейса, который должен упасть первым
- **Refactor-цели** — `**Refactor-цели:**` с описанием что улучшить после Green (или `(none)`)
- **Критерии приёмки** — `**Критерии приёмки:**` со списком
- **Зависимости** — `**Зависимости:**` с перечислением ID
- **E2E-сценарий этапа** — `**E2E-сценарий этапа:**` сквозной сценарий для phase-gate
- **Smoke-критерий этапа** — `**Smoke-критерий этапа:**` быстрый тест для phase-gate

Для каждой функции собрать структуру:
```
{
  id: "F-1.1",
  name: "...",
  priority: "P0",
  description: "...",
  stage: 1,
  tests: [ { id: "TC-F-1.1-1", name: "...", condition: "...", steps: "...", expected: "..." } ],
  redTest: "TC-F-1.1-1: <почему падает>",
  refactorGoals: "(none)" | "<что улучшить>",
  criteria: ["...", "..."],
  dependencies: ["F-1.0"],
  status: "☐"  // ☐ ⏳ ✅ ❌
}
```

Для каждого этапа также извлекаются:
```
{
  stageId: 1,
  e2eScenario: "<E2E-сценарий этапа>",
  smokeCriteria: "<Smoke-критерий этапа>"
}
```

**Лимиты roadmap:**
- Этапы: 2-8
- Функций на этап: 3-30 (v3.1.0+, было 3-15 в v3.0)

Для фич с большим числом фаз (>8) — разделите на дочерние roadmap.

**0.2 Проверить статусы**

- Если в roadmap есть уже выполненные функции (✅) — спросить, переделать или пропустить
- Если roadmap пустой (нет функций) — сообщить об ошибке

**0.3 Согласование с пользователем (control point #1)**

Перед стартом цикла ОБЯЗАТЕЛЬНО спросить через **questionnaire**:

1. **Стратегия коммитов** (по умолчанию — без коммитов):
   - один коммит на функцию (auto, conventional на языке проекта);
   - пачками по этапам;
   - вручную после каждого шага;
   - без коммитов (только код).

2. **Scope подтверждения**: перечислить все найденные функции с приоритетами,
   дать пользователю approve или скорректировать.

3. **Control points**: где пользователь хочет видеть прогресс-отчёт:
   - после каждой функции;
   - после каждого этапа roadmap;
   - только в конце;
   - при ошибках + в конце.

**0.4 Создать task list**

Для каждой функции F-X.Y из roadmap:
```
TaskCreate(
  subject = "F-X.Y [<слой>]: <название>",
  owner = "implement",
  blocks = [зависимости из roadmap]
)
```

Плюс фиксированные задачи:
```
TaskCreate(subject = "Verify final: Полная верификация фичи")
TaskCreate(subject = "Smoke: End-to-end smoke test")
TaskCreate(subject = "Docs: README/CHANGELOG/MANIFEST")
```

Все задачи создаются со статусом `pending`. Зависимости настраиваются через `blocks[]`:
- Функции блокируют свои зависимости (если F-1.2 зависит от F-1.1, то F-1.1 не блокирует F-1.2,
  а порядок определяется очередью и приоритетами; **blocks[] = [F-1.1]** на F-1.2).
- Финальная верификация блокируется всеми функциями.

⚠️ **При создании задач через `TaskCreate` ОБЯЗАТЕЛЬНО используй phaseId, иначе orchestrator не сможет группировать:**

✅ Правильно:
```
TaskCreate(
  subject = "F-3.1 [session]: fan-rust-session crate skeleton",
  owner = "implement",
)
# orchestrator хук: inferPhaseId("F-3.1 ...") → phaseId=3
```

❌ Неправильно:
```
TaskCreate(
  subject = "Create session crate",  # невозможно инферить фазу
  owner = "implement",
)
```

Для функций, которые не относятся к фазе (например, "Setup environment"):
```
TaskCreate(subject = "[Phase 0] Setup environment", owner = "implement")
```

**0.5 Создать feature-ветку**

```bash
# Определить текущую ветку
git branch --show-current

# Если не в master/develop:
git checkout master  # или develop
git pull

# Создать feature-ветку
git checkout -b feature/<slug>
```

**0.6 Установить slug фичи**

Если slug не определён — извлечь из пути к roadmap (директория после `docs/features/`).

**0.7 Создать рабочие артефакты (v3.1.0)**

Вместо одного `pipeline-report.md` v3.1.0 создаёт ТРИ рабочих артефакта через встроенный orchestrator mode:

#### Шаг A: Запустить `/pipeline init` в FAN Orchestrator

В интерактивном режиме FAN Orchestrator:
```
/pipeline init
```
Оркестратор запросит:
- **Feature name** (например "fan-rust port")
- **Commit strategy**: per-phase / per-function / manual
- **Phases** (multi-line текст):
  ```
  phase 0: Foundation
    goal: workspace builds, first green cargo test
    features: F-0.1, F-0.2
    criteria: cargo build --workspace, cargo test --workspace

  phase 1: Providers
    goal: LLM providers via rig-core
    features: F-1.1
    criteria: streaming works for Anthropic/OpenAI
  ```
- **Slug** (kebab-case) — автоопределяется из package.json/Cargo.toml, можно переопределить

#### Шаг B: Подтвердить создание артефактов

Orchestrator создаёт:
- `docs/development-plan.md`
- `docs/development-log.md`
- `.fan/tracking/phase-status.json`

И уведомляет: `✅ Pipeline initialized. Tracking active for: <featureName>`

#### Шаг C: Pipeline-report заменён на artifacts

В отличие от v3.0 (где был `pipeline-report.md`), v3.1.0 не требует отдельного файла-отчёта — он распределён между:
- `docs/development-plan.md` (что планировали)
- `docs/development-log.md` (что фактически произошло)
- `.fan/tracking/phase-status.json` (машинный state)

При финализации (Фаза Final) координатор делает **сводный отчёт** в чате пользователю, основанный на чтении этих 3 файлов через `pipeline.getStatus()` / `getLog()` / `getPlan()`.

---

### Основной цикл: обработка ВСЕХ функций (расширенный)

⚠️ **Каждый шаг функции = отдельный delegate_task.**
Координатор НЕ пишет код, НЕ пишет тесты, НЕ коммитит сам.
Верификация — ВСЕГДА отдельным воркером, не тем же, что implement.

**Алгоритм (одна итерация = одна функция, Red-Green-Refactor):**

1. Взять первую функцию ☐ в roadmap (с учётом зависимостей).
2. **TaskUpdate(in_progress, F-X.Y)** — пометить как активную.
3. **🔴 Red — delegate_task(agent="tests-impl", F-X.Y, phase="red"):**
   - прочитать roadmap, секцию F-X.Y: TC-тесты и поле `**Red-тест:**`;
   - написать failing-тесты по TC-карточкам из roadmap;
   - запустить тесты, подтвердить FAIL (это и есть Red — тесты падают, потому что функциональности ещё нет);
   - если тесты НЕ падают — это нарушение Red: разобраться почему (возможно, тесты написаны некорректно или функциональность уже существует); не переходить к шагу 4, пока Red не подтверждён;
   - вернуть: список тест-файлов + подтверждение FAIL.
4. **🟢 Green — delegate_task(agent="implement", F-X.Y, phase="green"):**
   - прочитать roadmap, секцию F-X.Y;
   - написать **минимальную** реализацию для прохождения тестов из шага 3;
   - требование минимальности: только тот код, который нужен для PASS тестов, без лишней функциональности;
   - запустить тесты — подтвердить PASS;
   - вернуть: список изменённых файлов + diff-summary.
5. **delegate_task(agent="verify", F-X.Y)** — НЕЗАВИСИМЫЙ:
   - проверить TDD-тесты roadmap;
   - проверить критерии приёмки;
   - проверить компиляцию (`npm run build`, `go build`, `cargo check` и т.д.);
   - проверить регрессию (`npm test`, `go test ./...`, `cargo test`);
   - вернуть VERDICT: PASS / FAIL с конкретными замечаниями.
6. **Если FAIL** (max 3 попытки для крупной фичи, 2 для мелкой):
   - **delegate_task(agent="bug-fix", F-X.Y, замечания verify)**;
   - → шаг 5;
   - если попытки исчерпаны → **TaskUpdate(failed, F-X.Y)**, спросить пользователя
     через `question` (пропустить / ещё попытка / отменить pipeline).
7. **delegate_task(agent="verify", F-X.Y, phase="tests")** — верификация тестов:
   - корректно написаны (проверяют то, что должны);
   - не вносят ложных срабатываний;
   - проходят на реализованном коде.
   Если FAIL — исправить через bug-fix или tests-impl (макс 2 попытки).
8. **🔵 Refactor — delegate_task(agent="implement", F-X.Y, phase="refactor"):**
   - прочитать поле `**Refactor-цели:**` из roadmap для F-X.Y;
   - если Refactor-цели = `(none)` — **шаг пропускается**;
   - иначе: выполнить рефакторинг согласно Refactor-целям (устранение дублирования, упрощение, снижение coupling, улучшение именований);
   - **правило:** рефакторинг без зелёных тестов запрещён (все тесты должны быть PASS перед началом рефакторинга);
   - после рефакторинга — прогнать тесты повторно (должны остаться зелёными);
   - если тесты упали после рефакторинга — откат или исправление до зелёного состояния;
   - вернуть: список изменённых файлов + подтверждение что тесты зелёные.
9. **Commit policy check** (v3.1.0+):
   - проверить `pipeline.shouldCommit(phaseId)` через `delegate_task(agent="bash", task="...")`
     или прямой вызов в Node (если есть доступ к pipelineState)
   - если true → выполнить git commit через bash:
     ```bash
     git add <явные файлы>
     git commit -m "$(./pipeline.formatCommitMessage({ phaseId, action: 'complete', summary: '...', feature: 'F-X.Y' }))"
     ```
   - сохранить commit sha → `pipeline.recordPhaseChange({ phaseId, status: 'IN_PROGRESS' | 'COMPLETED', commitSha: '<sha>' })`
10. **Инкрементальная запись (v3.1.0+):** orchestrator hooks автоматически
    добавляют запись в `development-log.md` при каждом TaskUpdate.
    Ручное обновление pipeline-report.md не требуется (см. раздел
    «Инкрементальная запись (v3.1.0+)» ниже).
11. **TaskUpdate(taskId="<UUID>", status="completed")** — пометить задачу
    как завершённую. ID задачи получен из TaskCreate (шаг 0.4).
12. **Phase-gate e2e (граница этапов):**
    Проверить границу этапов: если следующая функция F-(X+1).1 (новый этап
    roadmap) — запустить phase-gate перед переходом:
    - **Smoke-критерий этапа:** прочитать из roadmap.md текущего этапа, запустить через delegate_task(agent="verify").
    - **E2E-сценарий этапа:** прочитать из roadmap.md текущего этапа, запустить через delegate_task(agent="tests-impl").
    - **Опционально (критичные фичи):** если этап затрагивал auth/секреты/обработку
      пользовательского ввода — дополнительно `delegate_task(agent="security")`
      с аудитом нового кода этапа.
    - Если smoke/e2e этапа падает — этап НЕ считается завершённым;
      возврат к исправлению через `delegate_task(agent="bug-fix")` до зелёного состояния.
    - Только после зелёного phase-gate — показать пользователю краткую сводку
      (✅/❌ за этап) через question (control point #2) и переход к следующему этапу.
13. Если есть следующая ☐ функция (с учётом зависимостей и приоритетов)
    → перейти к шагу 1.
    Иначе → **Финальная фаза**.

### Инкрементальная запись (v3.1.0+)

В v3.1.0 ручное обновление pipeline-report.md **не требуется**.
Вся инкрементальная запись идёт через orchestrator hooks автоматически
в `development-log.md`. Координатору не нужно вручную редактировать
pipeline-report после каждой функции — хуки срабатывают при каждом
TaskUpdate.

### Принципы использования воркеров

Воркеры (`delegate_task`) — основной механизм управления контекстом.
Они позволяют изолировать сложные подзадачи в отдельные контексты,
не расширяя основной поток.

| Фактор | Когда нужен воркер | Когда можно напрямую |
|--------|-------------------|---------------------|
| **Объём кода** | > 50 строк, несколько файлов | 1 файл, < 30 строк |
| **Сложность логики** | Алгоритмы, интеграции, состояния | Простые сеттеры/геттеры |
| **Контекст** | Нужно читать много файлов | Достаточно roadmap |
| **Риск регрессии** | Затрагивает несколько модулей | Локальное изменение |
| **Количество инструментов** | Нужны read + write + edit + bash | Хватит 1-2 инструментов |

**Главное правило координатора:** координатор не пишет код. Даже простые
изменения должны быть делегированы — это гарантирует, что контекст
остаётся чистым для управления pipeline. Исключение: изменение статусов
в roadmap (✅/❌/☐), git-команды.

Доступные типы воркеров:
- **implement** — реализация кода
- **verify** — верификация на соответствие TDD-тестам
- **bug-fix** — исправление найденных ошибок (вызывается когда verify нашёл FAIL)
- **explore** — исследование кодовой базы перед реализацией
- **plan** — исследование и планирование кодовой базы, read-only
- **tests-impl** — написание тестов
- **docs-impl** — обновление документации
- **security** — глубокий security-аудит (OWASP/CWE, secrets, deps, IaC, config), read-only
- **code-review** — статическое ревью диффа фичи, read-only; не заменяет verify

### Анти-паттерн: делегирование всего pipeline

❌ **НЕЛЬЗЯ:**
```python
delegate_task(
  agent="implement",
  task="Реализуй все 15 функций из roadmap, верифицируй, тестируй,
        коммить. Используй feature-pipeline skill."
)
```

✅ **ПРАВИЛЬНО:**
```python
# Один воркер — одна функция — один шаг (Red-Green-Refactor):
delegate_task(agent="tests-impl", task="Red: напиши failing-тесты для F-1.1: ...")
delegate_task(agent="implement",  task="Green: минимальная реализация F-1.1: ...")
delegate_task(agent="verify",     task="Проверь F-1.1: ...")
delegate_task(agent="implement",  task="Refactor F-1.1: <Refactor-цели>")
```

### Анти-паттерн: Test-After (реализация до тестов)

❌ **НЕЛЬЗЯ:**
```python
# Сначала код, потом тесты — это Test-After, не TDD:
delegate_task(agent="implement", task="Реализуй F-1.1: ...")
delegate_task(agent="tests-impl", task="Напиши тесты для F-1.1: ...")
```

✅ **ПРАВИЛЬНО:**
```python
# Сначала тесты (Red), потом код (Green):
delegate_task(agent="tests-impl", task="Red: напиши failing-тесты для F-1.1: ...")
delegate_task(agent="implement",  task="Green: минимальная реализация F-1.1: ...")
```

Test-After теряет преимущества TDD: тесты пишутся «под код», а не как спецификация.
Red-фаза гарантирует, что тесты проверяют реальную функциональность.

### Анти-паттерн: рефакторинг без зелёных тестов

❌ **НЕЛЬЗЯ:**
```python
# Рефакторинг при падающих тестах — риск сломать ещё больше:
delegate_task(agent="implement", task="Рефакторинг F-1.1: упрости архитектуру")
# тесты при этом FAIL
```

✅ **ПРАВИЛЬНО:**
```python
# Сначала все тесты в PASS, потом рефакторинг:
# 1. verify → PASS (все тесты зелёные)
# 2. delegate_task(agent="implement", task="Refactor F-1.1: <цели>")
# 3. После рефакторинга — прогнать тесты снова (должны остаться зелёными)
```

Рефакторинг без зелёных тестов = слепое изменение кода. Если тесты падают после
рефакторинга — откат или исправление до зелёного состояния.

### Контрольные точки (где спрашивать пользователя)

| # | Когда | Что спросить | Как |
|---|-------|--------------|-----|
| 1 | До старта цикла | scope, стратегия коммитов, репортинг | questionnaire |
| 2 | На границе этапов roadmap | **phase-gate e2e:** Smoke-критерий этапа + E2E-сценарий этапа из roadmap. Если PASS — краткая сводка ✅/❌, что дальше. Если FAIL — возврат к исправлению, вопрос не задаётся | question (multi-option) |
| 3 | После verify FAIL, попытки исчерпаны | пропустить / ещё / отменить | question |
| 4 | Перед финальным коммитом | approve diff | показ diff-summary |
| 5 | При архитектурном решении (не описанном в roadmap) | выбор подхода | question |

### Управление контекстом координатора

Координатор хранит в своём контексте ТОЛЬКО:
- список задач (TaskCreate/TaskUpdate handles + taskIds);
- roadmap со статусами ☐/⏳/✅/❌;
- development-log.md (последние записи, v3.1.0+);
- метаданные последнего коммита (sha, message).

Координатор НЕ хранит:
- код реализации;
- diff-ы файлов;
- полные логи тестов;
- содержимое воркерских отчётов (только verdict).

Если ощущаешь, что контекст пухнет:
1. Убедиться, что orchestrator hooks пишут в development-log.md (v3.1.0+).
2. Сохранить SHA коммита.
3. Спросить пользователя — продолжать сейчас или прервать на checkpoint.

---

### Финальная фаза: Завершение

> Ты попадаешь сюда **ТОЛЬКО** когда все функции из roadmap обработаны (статус ✅ или ❌).
> Если в roadmap осталась хотя бы одна функция со статусом ☐ — вернись к Основному циклу.

Когда все этапы пройдены (все функции обработаны):

#### Шаг G.0: Подготовка финального отчёта (v3.1.0+)

В v3.1.0 сводный отчёт **не хранится в файле**, а собирается из артефактов на лету:

```javascript
const log = await pipeline.getLog();
const plan = await pipeline.getPlan();
const status = await pipeline.getStatus();

// вывести пользователю markdown-саммари в чате
```

Если нужна стабильная копия отчёта (для передачи коллегам) — можно сгенерировать
`docs/features/<slug>/FINAL-REPORT.md` через `delegate_task(agent="docs-impl", task="...")`.

#### Шаг G.1: Полная верификация фичи

Запустить verify-воркер на ВЕСЬ pipeline, а не на отдельную фичу.
Он прочитает:
- roadmap.md со всеми ✅/❌;
- development-log.md и development-plan.md (v3.1.0+ артефакты);
- git log ветки vs master.

```
delegate_task({
  agent: "verify",
  task: "Проведи ПОЛНУЮ верификацию фичи <slug>.
         Roadmap: docs/features/<slug>/roadmap.md
         Журнал: docs/development-log.md
         План: docs/development-plan.md
         
         Проверь:
         1. Все ли функции из roadmap реализованы (✅)?
         2. Каждая функция проходит свои TDD-тесты
         3. Каждая функция удовлетворяет критериям приёмки
         4. Нет регрессий в смежных модулях
         5. Архитектура целостна и консистентна
         6. Нет дублирования кода
         7. Нет очевидных дыр в безопасности или обработке ошибок
         8. Интеграция между функциями корректна
         
         Отдельно проверь:
         - Проект собирается/компилируется (npm run build, go build, etc.)
         - Все существующие тесты проходят
         
         Вердикт: VERDICT: PASS / FAIL / PARTIAL
         Если PARTIAL — перечисли, что именно не прошло."
})
```

Если FAIL или PARTIAL:
- Исправить проблемы через implement (отдельным воркером)
- Повторить верификацию (max 3 итерации для финала)

#### Шаг G.1.5: Code-review

Запустить code-review-воркер на ПОЛНЫЙ дифф фичи — статическое ревью всех
изменений. Выполняется ОДИН раз на фичу (не после каждого TDD-цикла).

```
delegate_task({
  agent: "code-review",
  task: "Проверь полный дифф фичи <slug> (git diff master..feature/<slug>).
         Slug: <slug>.
         Roadmap: docs/features/<slug>/roadmap.md
         
         Проверь:
         1. Качество и читаемость кода, соответствие конвенциям проекта
         2. Дублирование, мёртвый код, лишние абстракции
         3. Обработку ошибок и краевых случаев
         4. Согласованность с существующими модулями
         
         Вердикт: PASS / CHANGES_REQUESTED (с конкретными замечаниями)."
})
```

Если CHANGES_REQUESTED:
- Исправить замечания через implement (отдельным воркером)
- Повторить code-review (max 2 итерации), иначе — PASS.

#### Шаг G.1.6: Security-аудит

Запустить security-воркер на новый код фичи — глубокий security-аудит
перед финальным коммитом.

```
delegate_task({
  agent: "security",
  task: "Проведи security-аудит фичи <slug>: OWASP/CWE паттерны нового кода,
         secret scanning, зависимости, конфигурации.
         Slug: <slug>.
         Дифф: git diff master..feature/<slug>
         
         Проверь:
         1. OWASP/CWE паттерны в новом коде (injection, XSS, небезопасная
            десериализация, слабая криптография и т.д.)
         2. Secret scanning — нет ли закоммиченных ключей/токенов/паролей
         3. Зависимости — известные уязвимости в новых пакетах
         4. Конфигурации — exposure, дефолтные креды, права доступа
         
         Формат: список findings с severity (CRITICAL/HIGH/MEDIUM/LOW)
         и рекомендациями по исправлению."
})
```

При CRITICAL/HIGH findings:
- Исправить через implement (отдельным воркером)
- Повторить аудит (max 2 итерации).

#### Шаг G.2: Smoke-тестирование

```
delegate_task({
  agent: "tests-impl",
  task: "Напиши smoke-тест для фичи <slug>.
         Smoke-тест должен проверять основной сценарий использования фичи
         от начала до конца (happy path). 
         Slug: <slug>.
         Название фичи: <name> из roadmap.
         Описание: <description> из roadmap.
         
         Smoke-тест — это один тест, который проходит через все ключевые функции.
         Если проект больше (например, веб-сервер), smoke-тест может быть 
         скриптом, который запускает приложение и делает ключевой запрос."
})
```

#### Шаг G.3: E2E-тестирование (если применимо)

Если фича имеет пользовательский интерфейс или сетевое взаимодействие:

```
delegate_task({
  agent: "tests-impl",
  task: "Напиши e2e-тест для фичи <slug> проверяющий полный пользовательский сценарий.
         Slug: <slug>.
         Название: <name>.
         Если e2e-тесты не применимы к проекту — сообщи и пропусти."
})
```

#### Шаг G.4: Обновление документации

```
delegate_task({
  agent: "docs-impl",
  task: "Обнови документацию для фичи <slug>.
         Что обновить:
         1. README.md проекта — добавь информацию о новой фиче, если нужно
         2. CHANGELOG.md или аналог — добавь запись о новой фиче
         3. docs/features/<slug>/ — обнови roadmap.md (синхронизируй статусы)
         4. Дополни: обнови инлайн-документацию в коде, если были изменения API
         
         Slug: <slug>.
         Название фичи: <name>."
})
```

#### Шаг G.5: Обновить roadmap.md

Синхронизировать статусы в roadmap.md с фактическим состоянием:
- Все ☐ заменить на ✅ (реализованные) или ❌ (проваленные)
- Убедиться, что ⏳ нет (все обработаны)

```bash
# Обновить roadmap
edit docs/features/<slug>/roadmap.md
```

#### Шаг G.6: Финальный коммит

```bash
# Определить изменённые файлы
git diff master..feature/<slug> --name-only --diff-filter=AM

# Добавить только известные файлы (явный список, не `git add -A`)
git add <file1> <file2> ...
git commit -m "feat(<slug>): finalize <slug>

- Full verification: PASS
- Smoke tests: PASS
- E2E tests: PASS / N/A
- Documentation: updated
- All <N> functions implemented"
```

Запомнить SHA.

#### Шаг G.7: Обновить финальный отчёт

Дополнить `development-log.md` финальной записью (v3.1.0+).
В v3.0 (без orchestrator) — дополнить `pipeline-report.md`:

1. Обновить сводку
2. Добавить секцию **Финальная верификация**
3. Добавить **Изменённые файлы** (из git log)
4. Добавить **Проблемы** (если были)
5. Добавить **Документация** (какие файлы обновлены)
6. Добавить **Рекомендации** (если есть)

**Финальная структура отчёта:**

```markdown
# Pipeline Report: <Название фичи>

> **Дата:** YYYY-MM-DD HH:MM
> **Ветка:** feature/<slug>

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | N |
| Реализовано (✅) | M |
| Провалено (❌) | K |
| Коммитов | C |
| Тестов всего | T |
| Тестов пройдено | T_pass |
| Тестов не пройдено | T_fail |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-1.1: Name | ✅ | abc123 | 3/3 | 1 |
| F-1.2: Name | ✅ | abc124 | 2/2 | 2 |
| F-2.1: Name | ❌ | — | — | 3 |

## Детали реализации

### F-1.1: Name
- **Статус:** ✅ Реализовано
- **Коммит:** abc123
- **Верификация:** PASS (с 1-й попытки)
- **Тесты:** TC-F-1.1-1 ✅, TC-F-1.1-2 ✅, TC-F-1.1-3 ✅
- **Критерии приёмки:** Все выполнены


### F-1.2: Name
...

## Финальная верификация

- **Вердикт:** PASS
- **Smoke-тесты:** 1/1 ✅
- **E2E-тесты:** 2/2 ✅ (или N/A)
- **Сборка:** OK

## Проблемы

| # | Функция | Проблема | Решение |
|---|---------|----------|---------|
| 1 | F-2.1 | Не удалось реализовать за 3 попытки | Пропущено по решению пользователя |

## Изменённые файлы

- src/lib/notifications/create.ts
- src/lib/notifications/list.ts
- tests/unit/notifications.test.ts
- tests/integration/notifications.test.ts
- README.md
- CHANGELOG.md

## Документация

- README.md — ✅ обновлён
- CHANGELOG.md — ✅ обновлён
- docs/features/<slug>/roadmap.md — ✅ синхронизирован
- docs/development-log.md — ✅ обновлён (v3.1.0+)

## Рекомендации

- F-2.1 (P1, уведомления с вложениями) требует отдельной проработки архитектуры
- Code review и security-аудит выполнены воркерами code-review/security на шагах G.1.5-G.1.6
```

#### Шаг G.8: Представить отчёт пользователю и очистить задачи

```bash
# Показать отчёт
echo "=== Pipeline Report: <slug> ==="
echo "Журнал: docs/development-log.md"
echo ""
echo "=== Коммиты ==="
git log master..feature/<slug> --oneline
echo ""
echo "=== Статус ==="
# Показать сводку из отчёта
echo ""
echo "Что дальше:"
echo "1. Проверьте журнал: docs/development-log.md"
echo "2. Просмотрите отчёты code-review и security (шаги G.1.5-G.1.6)"
echo "3. Замержьте ветку feature/<slug> в master"
```

```
# Очистить завершённые задачи перед завершением
TaskClear()
```

```
question({
  question: "Pipeline для <slug> завершён! Журнал: docs/development-log.md",
  options: [
    { label: "Показать отчёт", description: "Вывести содержимое отчёта" },
    { label: "Показать список коммитов", description: "git log" },
    { label: "Запустить ещё раз", description: "Перезапустить пайплайн" },
    { label: "Всё отлично, спасибо", description: "Завершить" }
  ]
})
```

---

## State Recovery (v3.1.0+)

Если координатор упал / соединение оборвалось / пользователь вернулся через день:

1. FAN Orchestrator при `session_start` читает `.fan/tracking/phase-status.json`
2. Если файл существует и валиден → pipeline восстанавливается в памяти
3. Координатор может продолжить с места, где остановился — статусы всех задач восстановлены
4. `TaskCreate` для уже выполненных функций НЕ создаёт дублей (оркестратор видит что фаза-0 уже COMPLETED в JSON)

### Пример восстановления

```bash
# день 1: 16 фаз, завершили 0 и 1, упали на 2
# день 2:
fan  # запуск
# orchestrator: "Restored pipeline: fan-rust port (16 phases, 2 complete)"
# следующий шаг: phase 2 in_progress + delegate_task
```

### Ручное восстановление

Если нужно пересоздать pipeline вручную:
```bash
rm .fan/tracking/phase-status.json  # удалить state
# затем
/pipeline init  # пересоздать с тем же slug
```

---

## Правила

1. **Одна функция за раз.** Не переходи к следующей, пока текущая не завершена (✅ или ❌).
   После завершения — переходи к следующей. Не запрашивай остановку на каждой функции.
   Контрольные точки срабатывают только на границах этапов roadmap (F-X.Y → F-X+1.Y)
   или при исчерпании попыток. Если пользователь в CP#1 выбрал «после каждой функции»,
   показывай краткую сводку (✅/❌) без вопроса на продолжение.
2. **Учитывай зависимости.** Функция, от которой зависят другие, должна быть реализована первой.
3. **Максимум попыток верификации зависит от размера задачи.** После исчерпания — спросить пользователя.
4. **Каждый коммит — только одна функция.** Никогда не коммить несколько функций вместе.
5. **TDD-first (Red-Green-Refactor).** Сначала failing-тесты (Red), потом минимальная реализация (Green), потом рефакторинг при зелёных тестах (Refactor). Код пишется так, чтобы проходить TDD-тесты, указанные в roadmap.
6. **Не ломай существующее.** Перед каждой реализацией проверяй, что старые тесты всё ещё проходят.
7. **Документируй всё.** Каждый шаг фиксируется в файлах.
8. **Не трогай roadmap пользователя.** Статусы ☐ ✅ ⏳ ❌ — единственное, что меняется в roadmap.md.
9. **Перед коммитом — git status.** Убедись, что нет неожиданных изменений.
10. **Перед коммитом — git add по файлам.** Используй явный список изменённых
    файлов, не `git add -A`.
11. **Делегируй шаги, не функции целиком.** Каждый TDD-шаг (tests-impl → implement → verify → refactor) — отдельный delegate_task.
12. **Запрет black-box делегации.** Никогда не делегировать весь pipeline
    или несколько функций одним воркером. Каждый шаг TDD-цикла — отдельный delegate_task.
13. **Verify — adversarial.** verify-воркер не должен иметь контекст
    implement-воркера. Это adversarial check.
14. **Control points обязательны.** На каждой контрольной точке — явный
    question/questionnaire пользователю перед продолжением.
15. **Pipeline-log инкрементален (v3.1.0+).** В v3.1.0 ручное обновление
    pipeline-report заменено на автоматические записи в `development-log.md`
    через orchestrator hooks. При использовании v3.0 поведения — продолжать
    обновлять pipeline-report после каждой функции.
16. **Коммиты — явная политика.** Не коммитить без согласования с
    пользователем в начале pipeline (или использовать explicitly
    согласованную стратегию).
17. **Контекст — только метаданные.** Координатор хранит только taskIds,
    статусы, sha коммитов. Код, diff и логи тестов — в воркерах.
18. **При прерывании — state recovery.** При новом запуске прочитать
    статусы из `.fan/tracking/phase-status.json` (v3.1.0+) или
    из roadmap и pipeline-report.md (v3.0), продолжить
    с первой невыполненной фазы/функции.
19. **TaskClear в конце.** После финального отчёта (G.8) — очистить
    completed/failed задачи через TaskClear().
20. **Refactor только при зелёных тестах.** Рефакторинг (шаг 8 основного цикла)
    разрешён только если все тесты PASS. После рефакторинга тесты прогоняются
    повторно. Если упали — откат или исправление до зелёного состояния.
    Если `Refactor-цели = (none)` — шаг пропускается.
21. **Phase-gate e2e на границах этапов.** Перед переходом к следующему этапу
    roadmap обязательно запускаются `Smoke-критерий этапа` и `E2E-сценарий этапа`
    из roadmap.md. Если smoke/e2e падает — этап НЕ завершён, возврат к
    исправлению (bug-fix worker) до зелёного состояния. Только после зелёного
    phase-gate — переход к следующему этапу.
22. **security и code-review — read-only и тяжёлые.** code-review — один раз
    на фичу (шаг G.1.5), security — шаг G.1.6 + опционально на phase-gate
    критичных этапов (auth/секреты/пользовательский ввод); не запускать их
    в каждом TDD-цикле.
