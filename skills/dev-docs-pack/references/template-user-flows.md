# <Feature Name> — Пользовательские потоки

## Метаданные
- **Дата:** <YYYY-MM-DD>
- **Автор:** dev-docs-pack
- **Исходная спецификация:** [<spec>](<relative-path>)

## Пользователи / Роли

| Роль | Описание | Возможности |
|------|----------|-------------|
| <Role 1> | <description> | <capabilities> |
| <Role 2> | <description> | <capabilities> |

## Поток 1: <Flow Name>

**Актёр:** <Role>
**Триггер:** <what starts the flow>
**Предусловия:** <what must be true>

### Шаги

1. <Действие> → <Ответ системы>
2. <Действие> → <Ответ системы>
3. <Действие> → <Ответ системы>

### Диаграмма потока

```
[Actor] → [Screen/Action] → [Decision?]
                              ├── Да → [Action]
                              └── Нет → [Alternative]
```

### Пути ошибок

| Шаг | Ошибка | Видит пользователь | Восстановление |
|------|--------|--------------------|----------------|
| N | <error type> | <message/state> | <how to recover> |

### Постусловия

**Успех:**
- <What's true after successful flow>

**Ошибка:**
- <What's true after failed flow>

## Поток 2: <Flow Name>

<Аналогичная структура>
