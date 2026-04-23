---
name: skill-improver
description: >
  Автономная оптимизация fan skills через AutoResearch loop. Принимает имя или путь к целевому skill,
  копирует его в изолированную workspace-директорию, генерирует binary eval criteria,
  мутирует копию skill, тестирует через RPC orchestrator, keep/discard по pass rate.
  Оригинальный skill НЕ изменяется. Лучший результат копируется обратно только по завершении.
---

# Skill Improver

Автономная оптимизация fan skills, вдохновлённая [AutoResearch](https://github.com/karpathy/autoresearch) Карпатого.

**Ключевой принцип:** оригинальный skill никогда не изменяется. Все мутации происходят в изолированной workspace-директории. Лучший результат применяется к оригиналу только один раз — после завершения loop и подтверждения пользователем.

---

## Когда использовать

- Пользователь хочет улучшить качество существующего skill
- Пользователь говорит «улучши skill», «оптимизируй skill», «заставь skill работать лучше»
- Пользователь хочет запустить autoresearch loop на skill
- Пользователь хочет проверить/оценить skill через eval

---

## Парсинг входных данных

Входная строка передаётся после `User:`.

**ВАЖНО:** Входная строка — это ВСЕГДА имя или путь целевого skill для оптимизации.
Это НЕ команда для вызова другого skill. Даже если вход совпадает с именем существующего skill
(например, `research-spec-generator`) — это означает «оптимизируй skill research-spec-generator»,
а не «запусти skill research-spec-generator».

### Путь к skill
- `~/.fan/agent/skills/my-skill` — абсолютный или ~-путь
- `my-skill` — короткое имя, ищется в `~/.fan/agent/skills/` и `.fan/skills/`
- Текущая директория если не указан путь, и в ней есть SKILL.md

При получении входа НЕ загружай и НЕ выполняй skill с таким именем.
Резолви путь к файловой системе и читай файлы напрямую через `read` и `bash`.

### Флаги
- `--dry-run` — только генерация eval criteria, без запуска loop
- `--quick N` — ограничить количество итераций (default: 15)
- `--target PCT` — остановиться при достижении pass rate, 0.0–1.0 (default: 0.85)
- `--plateau N` — остановиться при отсутствии улучшений N итераций подряд (default: 3)
- `--subagent-model ID` — модель для subagent'ов (default: `default model`)

---

## Фаза 1: Discovery — поиск и чтение skill

### 1A. Резолв пути

```bash
SKILL_PATH="$INPUT"
if [ ! -d "$SKILL_PATH" ]; then
  for dir in "$HOME/.fan/agent/skills/$INPUT" ".fan/skills/$INPUT" "$INPUT"; do
    if [ -f "$dir/SKILL.md" ]; then SKILL_PATH="$dir"; break; fi
  done
fi
```

Если путь не найден — сообщи пользователю и остановись.

### 1B. Чтение skill

1. Проверь что `$SKILL_PATH/SKILL.md` существует
2. Прочитай SKILL.md целиком (frontmatter + body)
3. Прочитай все файлы в директории skill (references/, scripts/, assets/)
4. Собери карту файлов: `{path: content}` для каждого файла

### 1C. Предупреждение

Сообщи пользователю:
- Название skill (из frontmatter `name`)
- Description (из frontmatter `description`)
- Список всех файлов в директории
- **Оригинальный skill НЕ будет изменён** — все мутации в изолированной workspace
- Лучший результат будет предложен к замене после завершения

---

## Фаза 2: Workspace Setup — изолированная среда

### 2A. Создание workspace

Все мутации происходят в workspace. Оригинальный skill только читается.

```
~/.fan/agent/skills/skill-improver/runs/
  {timestamp}-{skill-name}/
    skill/              ← mutable copy (это то, что мутируется и тестируется)
      SKILL.md
      references/
      ...
    .improver/          ← metadata (НЕ part of skill)
      snapshots/
        00-original/    ← snapshot of original skill copy
        best/           ← best version so far
      outputs/
        baseline/
        iter-{N}/
      eval.yaml         ← eval criteria + test cases
      results.tsv       ← all results
      state.json        ← loop state (for resume)
```

### 2B. Инициализация workspace

```bash
RUN_DIR="$HOME/.fan/agent/skills/skill-improver/runs/$(date +%Y-%m-%d_%H%M%S)-$(basename $SKILL_PATH)"
mkdir -p "$RUN_DIR/skill"
mkdir -p "$RUN_DIR/.improver/snapshots"
mkdir -p "$RUN_DIR/.improver/outputs"

# Copy original skill to workspace
cp -r "$SKILL_PATH/"* "$RUN_DIR/skill/"
cp "$SKILL_PATH/SKILL.md" "$RUN_DIR/skill/SKILL.md" 2>/dev/null

# Snapshot original
cp -r "$RUN_DIR/skill/" "$RUN_DIR/.improver/snapshots/00-original/"

# Best starts as original
cp -r "$RUN_DIR/skill/" "$RUN_DIR/.improver/snapshots/best/"
```

**Определи переменные для дальнейшего использования:**
```bash
SKILL_COPY="$RUN_DIR/skill"       # mutable skill copy (NOT the original!)
IMPROVER_DIR="$RUN_DIR/.improver"
SNAPSHOTS="$IMPROVER_DIR/snapshots"
OUTPUTS="$IMPROVER_DIR/outputs"
```

### 2C. Subagent command

Subagent'ы запускаются через **RPC orchestrator** (`fan orchestrator (Agent tool)`).

**Ключевой момент:** orchestrator запускается с `--skill-dir $SKILL_COPY` — он читает SKILL.md
из workspace copy и инжектит его в prompt. Оригинальный skill при этом НЕ используется.

```bash
ORCHESTRATOR="$HOME/.fan/agent/skills/skill-improver/fan orchestrator (Agent tool)"
SUBAGENT_MODEL="${SUBAGENT_MODEL:-default model}"

# --skill-dir указывает на MUTABLE COPY в workspace
SUBAGENT_CMD="node $ORCHESTRATOR --model $SUBAGENT_MODEL --skill-dir $SKILL_COPY"
```

Проверь доступность модели:
```bash
fan --list-models ${SUBAGENT_MODEL#*/} 2>/dev/null | grep -q "${SUBAGENT_MODEL%%/*}" || {
  echo "Model '$SUBAGENT_MODEL' not found."
  exit 1
}
```

---

## Фаза 3: Eval Setup — определение критериев качества

### 3A. Анализ skill и генерация eval criteria

Проанализируй SKILL.md целевого skill и определи:

1. **Что этот skill делает** — из description и body
2. **Какой output ожидается** — какие файлы/результаты создаёт
3. **Типичные failure modes** — что может пойти не так

На основе анализа сгенерируй **4-6 binary eval criteria** (yes/no).

#### Правила хороших eval criteria

Каждый критерий:
- **Бинарный** — ответ только True/False, никаких "частично"
- **Проверяемый** — можно автоматически проверить по output'у subagent'а
- **Специфичный** — ловит реальный failure mode, не тривиальный
- **Независимый** — не дублирует другие критерии

Формат:
```yaml
criteria:
  - id: <short-id>
    name: <Human-readable название>
    check: <Что именно проверяется>
    assertion: <Как определить pass/fail по output>
```

#### Примеры для repo-explorer:
```yaml
criteria:
  - id: structure
    name: "ASCII tree содержит директории"
    assertion: "В output есть code-блок с tree-структурой, содержащей минимум 3 строки вида '├──' или '└──'"

  - id: languages
    name: "Определены языки программирования"
    assertion: "В output есть секция 'Технологии' или 'Languages' с таблицей где перечислены языки и есть числа > 0"

  - id: architecture
    name: "Определён тип архитектуры"
    assertion: "В output есть слово из: Monolith, Monorepo, Library, CLI, Web app, API service"

  - id: file_count
    name: "Указано количество файлов"
    assertion: "В output есть число с контекстом 'файл' или 'file' — паттерн '\\d+ (файл|file)'"
```

### 3B. Генерация тест-кейсов

Сгенерируй **10-20 тест-кейсов**.

Правила:
- Разнообразие: разные сценарии, разная сложность
- Реалистичность: так бы писал реальный пользователь
- Краевые случаи: минимальный ввод, специфичные запросы

Формат:
```yaml
test_cases:
  - id: tc_001
    prompt: "https://github.com/facebook/react"
    expected: "Должен проанализировать репозиторий React"

  - id: tc_002
    prompt: "изучи проект в текущей директории"
    expected: "Должен найти .git и проанализировать локальный репо"
```

### 3C. Сохранение и утверждение

Сохрани eval в `$IMPROVER_DIR/eval.yaml`.

Покажи пользователю eval criteria и тест-кейсы. Спроси утверждение через `question` tool:
- Утверждаю, запускай
- Хочу изменить eval criteria
- Хочу добавить тест-кейсы

---

## Фаза 4: Baseline — первый запуск

### 4A. Запуск baseline

Запусти subagent'а на ВСЕХ тест-кейсах. Важно: **оригинальный skill copy** из workspace
(т.е. `$SKILL_COPY` — ещё не мутированный).

```bash
for tc in "${TEST_CASES[@]}"; do
  ID=$(echo "$tc" | grep -oP 'tc_\d+' | head -1)
  echo "=== Baseline: $ID ==="

  $SUBAGENT_CMD \
    --prompt "$tc" \
    --max-turns 20 --max-steers 5 --timeout 300000 \
    --output "$OUTPUTS/baseline/$ID.txt" \
    --verbose 2>"$OUTPUTS/baseline/$ID.log"
done
```

**Timeout:** 300 секунд (5 минут) на тест-кейс. Локальные модели медленные.
Если модель стабильно timeout'ится — увеличь до 600.

### 4B. Оценка baseline

Для каждого output'а:
1. Прочитай `$OUTPUTS/baseline/$ID.txt`
2. Для каждого критерия — True/False
3. Test case passed = ВСЕ критерии True
4. `pass_rate` = passed / total

### 4C. Запись результатов

```bash
# results.tsv — в workspace, НЕ в оригинальном skill
echo "timestamp	iteration	status	val_bpb	memory_gb	description	commit	pass_rate	criterion_details" \
  > "$IMPROVER_DIR/results.tsv"

# Пример строки:
# 2026-04-08T15:00:00	0	baseline	0.000	0.0	baseline run	N/A	0.65	structure:0.8|languages:0.9|architecture:0.7|file_count:0.6
```

Покажи пользователю baseline pass rate. Спроси «продолжаем?».

---

## Фаза 5: Improvement Loop — AutoResearch

### Цикл

```
LOOP (до --target, --quick или --plateau):

  1. Прочитай результаты предыдущих итераций
  2. Анализируй failures:
     - Какие критерии чаще всего fail?
     - Какие тест-кейсы fail по большинству критериев?
     - Есть ли общий паттерн?
  3. Сформулируй ОДНУ гипотезу улучшения
  4. Сохрани snapshot текущего состояния (из $SKILL_COPY)
  5. Мутируй файлы в $SKILL_COPY:
     - SKILL.md body (инструкции)
     - reference файлы
     - scripts
     - НЕ трогай frontmatter `name`
  6. Запусти orchestrator на всех тест-кейсах (--skill-dir $SKILL_COPY)
  7. Оцени output'ы через eval criteria
  8. Запиши результаты
  9. KEEP → обновить best snapshot из $SKILL_COPY, сбросить plateau counter
     DISCARD → восстановить $SKILL_COPY из best snapshot, увеличить plateau counter
  10. Условия СТОП:
      - pass_rate >= target → СТОП
      - итераций >= max (--quick) → СТОП
      - plateau counter >= --plateau → СТОП
```

### Правила мутации

**Одна гипотеза на итерацию.**

Типы гипотез (по приоритету):
1. **Уточнение инструкций** — добавить missing step, уточнить output format
2. **Упрощение** — удалить избыточные инструкции, сократить verbose sections
3. **Добавление примеров** — example input/output, edge cases
4. **Restructuring** — переорганизация секций, вынос в references/
5. **Reference files** — обновление/добавление reference документации
6. **Scripts** — добавление helper scripts

### Snapshot правила

**Перед каждой мутацией:**
```bash
ITER_NUM=$((ITER_NUM + 1))
SNAP="$SNAPSHOTS/$(printf '%02d' $ITER_NUM)-before"
mkdir -p "$SNAP"
cp -r "$SKILL_COPY/"* "$SNAP/"
```

**KEEP (pass_rate улучшился):**
```bash
rm -rf "$SNAPSHOTS/best"
cp -r "$SKILL_COPY/" "$SNAPSHOTS/best"
```

**DISCARD (не улучшилось):**
```bash
rm -rf "$SKILL_COPY/"*
cp -r "$SNAPSHOTS/best/"* "$SKILL_COPY/"
```

### Правила оценки

```bash
ITER_OUTPUT="$OUTPUTS/iter-$(printf '%02d' $ITER_NUM)"
mkdir -p "$ITER_OUTPUT"

for tc in "${TEST_CASES[@]}"; do
  ID=$(echo "$tc" | grep -oP 'tc_\d+' | head -1)

  $SUBAGENT_CMD \
    --prompt "$tc" \
    --max-turns 20 --max-steers 5 --timeout 300000 \
    --output "$ITER_OUTPUT/$ID.txt" \
    --verbose 2>"$ITER_OUTPUT/$ID.log"
done
```

Timeout/crash → пометить test case как crash, продолжить.

### Plateau detection

Если pass_rate не улучшается N итераций подряд:

**Первая попытка (plateau - 1):**
1. Структурное изменение — не just wording tweaks
2. Альтернативный подход к формулированию
3. Сбросить plateau counter

**Вторая неудача → СТОП:**
- results.tsv пометка `plateau`
- Перейти к финализации

### Прогресс

Каждые 3 итерации выводи:
```
[=====>          ] 5/15 | pass_rate: 0.72 | baseline: 0.55 | best: 0.75 | +20pp
```

---

## Фаза 6: Finalization — итоги

### 6A. Отчёт

```
## Skill Improver Results

**Skill:** {name}
**Iterations:** {N}
**Baseline pass rate:** {X}%
**Final pass rate:** {Y}%
**Improvement:** +{Z}pp

### Per-criterion progression:
| Criterion | Baseline | Final | Delta |
|-----------|----------|-------|-------|
| {name}    | {X}%     | {Y}%  | +{Z}% |

### Results saved to:
- $IMPROVER_DIR/results.tsv
- Best snapshot: $SNAPSHOTS/best/
```

### 6B. Применение результата к оригиналу

**Оригинальный skill НЕ перезаписывается автоматически.** Покажи пользователю diff между оригиналом и best:

```bash
diff -ru "$SKILL_PATH" "$SNAPSHOTS/best" || true
```

Спроси через `question`:
- Применить — заменить оригинальный skill лучшим результатом
- Оставить оригинал — workspace и результаты сохранены, можно применить вручную позже
- Посмотреть diff подробнее

**Если «Применить»:**
```bash
# Заменить оригинал лучшим результатом
find "$SKILL_PATH" -maxdepth 1 ! -name "$(basename $SKILL_PATH)" -exec rm -rf {} +
cp -r "$SNAPSHOTS/best/"* "$SKILL_PATH/"
```

### 6C. Cleanup

Предложи удалить workspace (она может быть большой из-за snapshots и outputs):

```bash
rm -rf "$RUN_DIR"
```

Не удаляй автоматически — спроси пользователя.

---

## Обработка ошибок

| Ситуация | Действие |
|----------|----------|
| Skill не найден | Сообщить и остановить |
| SKILL.md отсутствует | Сообщить и остановить |
| Subagent timeout | crash для test case, продолжить |
| Subagent crash | crash, продолжить |
| Все тест-кейсы crash | Остановить loop, сообщить |
| Snapshot восстановление провалилось | Сообщить, предложить ручной откат |
| Pass rate = 1.0 | Цель достигнута |
| Plateau | СТОП, status=plateau |

---

## Обработка ошибок

| Ситуация | Действие |
|----------|----------|
| Skill не найден | «Skill не найден. Укажите корректный путь.» |
| SKILL.md отсутствует | «SKILL.md не найден. Это не валидный skill.» |
| Subagent timeout | Отметить test case как `crash`, продолжить |
| Subagent crash | Отметить как `crash`, продолжить |
| Все тест-кейсы crash | Остановить loop, сообщить пользователю |
| Snapshot восстановление провалилось | Сообщить, предложить ручной откат |
| Pass rate = 1.0 | Цель достигнута |
| Plateau | СТОП, status=plateau |

---

## Пример использования

```
User: skill-improver repo-explorer

→ Обнаружен skill: repo-explorer
→ Файлов: SKILL.md, references/filter-patterns.md, references/language-patterns.md, references/key-file-patterns.md
→ Создаю workspace: runs/2026-04-08_150000-repo-explorer/
→ Оригинал НЕ будет изменён
→ Генерирую eval criteria (4 шт)...
→ Генерирую тест-кейсы (15 шт)...
→ [Утверждение с пользователем]
→ Baseline: 15 test cases, timeout 300s each...
→ Baseline pass rate: 60% (9/15)
→ Loop:
  [====>           ] 3/15 | pass_rate: 0.67 | best: 0.67 | +7pp
  [========>       ] 6/15 | pass_rate: 0.73 | best: 0.73 | +13pp
→ Target 85% достигнут!
→ Diff между оригиналом и best: ...
→ Применить? [Да/Нет]

---

## Справочные материалы

- [AutoResearch methodology](https://github.com/karpathy/autoresearch)
- [fan orchestrator (Agent tool)](fan orchestrator (Agent tool)) — RPC orchestrator для subagent'ов
