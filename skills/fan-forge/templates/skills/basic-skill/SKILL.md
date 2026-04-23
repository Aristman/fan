---
name: basic-skill
description: >
  Template for a new skill. Replace this description with what your skill does.
  Max 1024 characters. Be specific — this determines when the agent loads the skill.
---

# Skill Name

Brief description of what this skill does and when to use it.

## Когда использовать

- Condition 1 when this skill is relevant
- Condition 2

## Когда НЕ использовать

- When this skill is not appropriate

---

## Setup

Если skill требует setup (npm install, env vars, etc.):

```bash
cd /path/to/skill/scripts && npm install
```

Если setup не нужен — удали эту секцию.

---

## Процесс

### Шаг 1: <Название>

Описание шага.

```
Используй tool X для Y
```

### Шаг 2: <Название>

Описание шага.

```
Используй tool Z для W
```

---

## Reference

### Reference 1

Подробности о важном аспекте.

### Reference 2

Подробности о другом важном аспекте.

---

## Helper Scripts

Если есть helper scripts в `scripts/`:

```bash
# Run script
./scripts/my-script.sh <args>
```

---

## Правила

1. Правило 1
2. Правило 2
3. Always do X before Y
