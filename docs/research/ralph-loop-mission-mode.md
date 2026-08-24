# Design: ralph-loop режим для fan-mission (fresh session per iteration)

**Статус:** proposal · **Дата:** 2026-08-18 · **Целевая версия:** fan-mission 0.10.0, @seaagents/fan-coding-agent (minor)

## 1. Проблема

`default-run-agent.ts:155` шлёт каждую итерацию как `followUp` в **одну** AgentSession. `agent-loop.ts` пересобирает `currentContext.messages = [...context.messages, ...prompts]` — каждая итерация несёт ПОЛНУЮ историю в LLM API. Инцидент: 334k токенов на 5-ю итерацию при лимите 700k. Auto-compaction (`agent-session.ts:2300+`) суммаризирует, но не обнуляет и срабатывает только post-hoc.

## 2. Принцип ralph-loop

> Каждая итерация = новая сессия агента. Состояние миссии — полностью в файлах (MISSION/ROADMAP/STATE/BACKLOG/RECURRING/DECISIONS.md + `.mission-loop.json` + git). Контекст диалога между итерациями не переиспользуется.

Это уже почти выполнено по построению: `prompt-builder.ts:135-190` собирает промпт из файлов на диске; `LoopState` (`mission-loop.ts:155-180`) персистится атомарно (`writeLoopStateSync`, `mission-loop.ts:207-222`); recovery после SIGKILL работает без истории диалога (`mission-loop.ts:812-831`).

## 3. Критические находки исследования

1. **`abort()` деструктивен**: `mission-loop.ts:1216-1233` — пишет abort-signal файл, `abortedByOperator: true` и статус `aborted`. Ротация сессии вызывает `session_shutdown` → `detach()` → `wiring.shutdown()` → `loop.abort()` (`index.ts:280-283` → `index.ts:124-136`). **Без guard-флага fresh-режим убьёт миссию на первой же ротации.**
2. **Фабрики расширений пересоздаются на каждую сессию**: `createAgentSessionServices` (`agent-session-services.ts:137-143`) → новый `DefaultResourceLoader` → `loadExtensions()` → `await factory(api)` (`loader.ts:371`). Старый `fan`-объект после `newSession()` мёртв — промпт следующей итерации нельзя слать из старого инстанса.
3. **`newSession()` поддержан во всех хост-режимах**: TUI (`interactive-mode.ts:1259-1267`), main/server adapter (`main.ts:216-240`), RPC (`rpc-mode.ts:324-332`), print (`print-mode.ts:40-48`).
4. **EventBus per-session**: новый `DefaultResourceLoader` = новый EventBus. fan-scheduler перезапускается на `session_start` — тики продолжаются после ротации автоматически.
5. **`newSession({parentSession})` поддержан** (`agent-session-runtime.ts:149-178`) — можно связывать итерационные сессии в дерево.

## 4. Архитектура

### 4.1 Переключатель

```yaml
# MISSION.md frontmatter
session_mode: fresh        # fresh | persistent (отсутствует = persistent)
```

- `MissionFrontmatter` += `session_mode?: string` — опциональное, НЕ в required (обратная совместимость).
- MISSION.md иммутабелен после init → режим задаётся при init (шаблоны) или ручной правкой.
- Шаблоны default/refactor получают `session_mode: fresh` (см. §8).

### 4.2 Поток ротации (ключевое проектное решение)

Ротация — **на границе тика, после полного персистирования состояния** (не внутри runAgent, не посреди tick):

```
tick() в сессии S_N:
  steps 1-7 — как сейчас (в fresh-режиме while-loop делает ОДИН проход и break)
  finalise: writeLoopStateSync(lastStep=7, interrupted=false)
  если fresh && isSuccess && осталась работа:
      loopState.resumeAfterRotation = true; writeLoopStateSync(...)
  tick() возвращается (lock освобождён в finally)
  deps.sessionRotator.rotate()                    ← ПОСЛЕ tick

rotate() (в index.ts):
  rotatingGuard = true
  await fan.newSession({ parentSession: <текущий sessionFile> })
    ├─ session_before_switch может отменить → {cancelled:true}
    │   → fallback: persistent до конца тика (warn)
    ├─ teardownCurrent() → session_shutdown на СТАРОМ runner
    │   → fan-mission handler: if (rotatingGuard) — лёгкая очистка
    │     (unsubTick, bridge.dispose), БЕЗ detach/abort     ← КРИТИЧНО
    └─ новая сессия S_{N+1}: фабрики пересозданы → session_start

session_start в S_{N+1}:
  attach → если .mission-loop.json.resumeAfterRotation:
      сбросить флаг; setTimeout(() => loop.tick(), 0)   ← автопродолжение
```

План-B без автопродолжения: scheduler перезапускается на `session_start` и пришлёт `mission_tick` ≤60с.

### 4.3 Изменения в MissionLoop

- `LoopState` += `resumeAfterRotation?: boolean`.
- `MissionLoopDeps` += `sessionRotator?: { rotate(): Promise<{ cancelled: boolean }> }` (DI, в тестах — mock).
- Continuous while-loop: в fresh-режиме break после одной итерации.
- Recur-phase: ротация между due-айтемами; повторный тик ре-входит, `isRecurringDue`/`markRecurringRun` пропускают выполненные.
- Ротация вызывается после `finally { lock.release() }` — обёртка публичного `tick()` над `_tickInner()`. Отмена → warn + флаг снимается, persistent-fallback.

### 4.4 ExtensionAPI: `fan.newSession()`

Сейчас `newSession` есть только на `ExtensionCommandContext` (`types.ts:305-308`). Добавить в `ExtensionAPI`:

| Файл | Изменение |
|------|-----------|
| `packages/coding-agent/src/core/extensions/types.ts` (~:1122) | `ExtensionAPI` += `newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }>` |
| `loader.ts` (`createExtensionRuntime`, ~:60-135) | слот `newSession`, default `async () => ({cancelled: true})` — **fail-safe** |
| `loader.ts` (`createExtensionAPI`, ~:216) | `api.newSession = (opts) => runtime.newSession(opts)` |
| `runner.ts` (`bindCommandContext`, :316-333) | `this.runtime.newSession = (opts) => this.newSessionHandler(opts)` — все 4 хост-режима уже биндят handler |

### 4.5 Старые сессии (JSONL)

- Каждая итерация = новый `.jsonl` в session-dir проекта.
- **v1 (0.10.0):** авто-удаления нет. `parentSession` (дерево) + `fan.setSessionName()` → имя `mission/<slug>/iter-<n>` для наблюдаемости в `/resume` и dashboard.
- **v1.1 (отдельная задача):** prune по возрасту/количеству (`fan doctor --prune-sessions` или retention в fan-mission).

## 5. Промпт холодного старта

Текущий `buildExecutionPrompt` **достаточен** (секции ≤4KB, протокол `<promise>`, guidance). Дополнение для fresh (`freshSession?: boolean` в `ExecutionPromptOptions`):

```
## Session mode
- This is a FRESH session (ralph loop): no prior conversation exists. All mission
  state is in the sections above and in git history. Do NOT search for prior chat context.
- The previous iteration's outcome is the latest BACKLOG entry and STATE.md.
- Before finishing, record anything the NEXT iteration must know into STATE.md
  '## Следующие шаги' — the next session will not remember this one.
```

Последний iterationResult в промпт добавлять не нужно — он уже на диске (BACKLOG, секция уже в промпте).

## 6. Стоимость

| | persistent | fresh |
|---|---|---|
| Итерация N, вход | base + Σ транскриптов 1..N−1 (линейный рост; инцидент: 334k на N=5) | ≈ const: system + промпт ≤20KB (~5-7k tok) + tool-выводы только этой итерации |
| Предсказуемость | нет (до compaction-threshold) | да |
| Overhead | — | холодное чтение рабочих файлов (~2-10k tok/итерацию) |
| Точка безубыточности | fresh дешевле уже с N≈2-3 для типичных tool-heavy итераций | |

## 7. Tradeoffs и риски

| Риск | Митигейшн |
|---|---|
| Потеря устного контекста → повтор ошибок | Guidance «записывай в STATE.md»; STATE/BACKLOG/git — единственный канал памяти (by design) |
| `abort()` при `session_shutdown` убивает миссию | rotatingGuard — обязателен (§4.2) |
| `session_before_switch` отменяет ротацию | `{cancelled:true}` → warn + persistent-fallback на этот тик |
| SIGKILL mid-iteration | Без изменений (P0-1 recovery); fresh-redo даже чище |
| SIGKILL между ротацией и автопродолжением | `resumeAfterRotation` на диске; `session_start(reason "startup")` подхватывает |
| Засорение списка сессий / TUI чат очищается | `parentSession` + `setSessionName`; v1.1 — prune |
| Widget/события | Пересоздаются фабрикой; EventBus per-session, scheduler перезапускается — OK |
| Утечка closures старых инстансов | Лёгкая очистка в guard-ветке; loop idle — GC-able |
| DECIDE/steer mid-flight | Оба file-based — переживают ротацию без изменений |

## 8. План реализации

1. **ExtensionAPI `newSession()`** — types.ts, loader.ts, runner.ts. Risk 🟢
2. **frontmatter `session_mode` + шаблоны** — file-state-manager.ts, оба MISSION.md.ts. Risk 🟢
3. **MissionLoop fresh-режим и ротация** — mission-loop.ts. Risk 🟡 (recovery-инварианты)
4. **prompt-builder fresh-секция** — prompt-builder.ts. Risk 🟢
5. **wiring: guard, rotator, автопродолжение** — index.ts. Risk 🟡 (lifecycle-гонки)
6. **Тесты** — парсинг session_mode, fresh-ротация (mock rotator), промпт, guard, автопродолжение. Risk 🟢
7. **Версии и docs** — fan-mission 0.10.0, coding-agent minor, orchestrator.md, manual-testing.md. Risk 🟢

## 9. Рекомендация: default vs opt-in

**Промежуточный вариант (рекомендован):**
- Отсутствующее поле = `persistent` (0.10.0 не ломает запущенные миссии).
- **Новые шаблоны шипят `session_mode: fresh`** — де-факто дефолт для новых миссий.
- После bake-in (1-2 недели) рассмотреть flip «отсутствует → fresh» в 0.11.0.

Persistent осмыслен для коротких миссий (2-3 итерации).

## 10. Success Criteria

- Миссия с `session_mode: fresh` на 5+ итераций: входные токены итерации N ≈ итерации 1 (±20%)
- Ротация не пишет abort-сигнал и не меняет статус миссии
- SIGKILL в любой точке → recovery продолжает миссию
- Миссия без `session_mode` идентична 0.9.0 (регрессион-тесты зелёные)
