---
name: ask-answer
description: Interactive dialog with the user via TUI selection UI (arrows, enter, esc). Use when you need to ask the user a question with predefined options, confirm a decision, or collect multiple answers at once. Provides question (single) and questionnaire (multi) tools.
---

# Ask-Answer Skill

## Overview

Этот навык даёт тебе доступ к двум инструментам для интерактивного диалога с пользователем:

- **`question`** — один вопрос с вариантами ответов
- **`questionnaire`** — серия вопросов с таб-навигацией

Когда ты вызываешь эти tools, TUI автоматически рендерит интерактивный UI:
- ↑↓ навигация по вариантам
- Enter — выбрать
- Esc — отмена
- "Type something..." — свободный ввод
- Tab/←→ — навигация между вкладками (для questionnaire)

## Когда использовать

### ✅ Используй `question` когда:
- Нужно подтвердить действие перед выполнением
- Есть 2-6 вариантов действий, и выбор за пользователем
- Нужно уточнить предпочтения (формат, стиль, подход)
- Пользователь явно попросил показать варианты

### ✅ Используй `questionnaire` когда:
- Нужно собрать несколько ответов за один раз
- Есть серия связанных решений (например: фреймворк + язык + база данных)
- Хочешь минимизировать количество round-trip к пользователю

### ❌ НЕ используй когда:
- Ты можешь решить сам (действуй, потом объясняй)
- Вопрос тривиальный и не влияет на результат
- Это вопрос об информации, а не о выборе (просто спроси текстом)

## Паттерны использования

### Подтверждение действия

```json
{
  "question": "Удалить все логи из /tmp/logs?",
  "options": [
    { "label": "Да, удалить", "description": "Безвозвратное удаление" },
    { "label": "Нет, оставить" },
    { "label": "Type something..." }
  ]
}
```

### Выбор подхода

```json
{
  "question": "Какую архитектуру используем?",
  "options": [
    { "label": "Clean Architecture", "description": "Слои: domain → data → presentation" },
    { "label": "MVVM", "description": "Model-View-ViewModel с Repository" },
    { "label": "MVI", "description": "Unidirectional data flow, Intent → State" },
    { "label": "Type something..." }
  ]
}
```

### Множественный выбор

```json
{
  "questions": [
    {
      "id": "framework",
      "label": "Framework",
      "prompt": "Какой UI-фреймворк?",
      "options": [
        { "value": "compose", "label": "Jetpack Compose" },
        { "value": "views", "label": "XML Views" }
      ]
    },
    {
      "id": "di",
      "label": "DI",
      "prompt": "Какой DI фреймворк?",
      "options": [
        { "value": "hilt", "label": "Hilt" },
        { "value": "koin", "label": "Koin" },
        { "value": "dagger", "label": "Dagger 2" }
      ]
    }
  ]
}
```

## Правила

1. **Всегда добавляй "Type something..."** как последний вариант, чтобы дать свободу
2. **Краткость**: вопрос — одна строка, описание — максимум полстроки
3. **Минимум 2 варианта**: не предлагай выбор из одного пункта
4. **Максимум 7 вариантов**: больше — плохо читается в TUI
5. **Описание опционально**: добавляй когда вариант неоднозначен без пояснения
6. **Действуй, потом спрашивай**: если уверен — делай. Если есть осмысленные альтернативы — спрашивай
