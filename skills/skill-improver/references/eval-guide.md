# Eval Guide — Binary Assertions Best Practices

Руководство по написанию эффективных binary eval criteria для skill-improver.

---

## Что такое binary assertion

Это yes/no проверка output'а skill. Определяет, удовлетворяет ли результат конкретному критерию качества.

Хороший критерий:
- **Бинарный** — только True или False
- **Объективный** — два человека пришли бы к одинаковому ответу
- **Детерминированный** — один и тот же output всегда даёт один и тот же результат
- **Информативный** — ловит реальную проблему качества, не тривиальность

---

## Типы критериев

### 1. Content presence

Проверяет наличие конкретного контента в output.

```yaml
- id: has_summary
  name: "Наличие summary секции"
  check: "Output содержит секцию с кратким описанием"
  assertion: "В output есть заголовок уровня 2+ содержащий слова 'summary', 'обзор', 'краткое'"
```

### 2. Structure compliance

Проверяет что output следует ожидаемой структуре.

```yaml
- id: has_table
  name: "Наличие таблицы с метриками"
  check: "Output содержит markdown таблицу"
  assertion: "В output есть блок с pipe-разделёнными столбцами (минимум 2 строки с |)"
```

### 3. Completeness

Проверяет что все ожидаемые компоненты присутствуют.

```yaml
- id: all_sections
  name: "Все обязательные секции присутствуют"
  check: "Отчёт содержит: обзор, структура, выводы"
  assertion: "В output найдены все три заголовка: 'Обзор', 'Структура', 'Вывод'"
```

### 4. Format correctness

Проверяет корректность формата output.

```yaml
- id: valid_markdown
  name: "Output — валидный markdown"
  check: "Файл можно распарсить как markdown без ошибок"
  assertion: "Output не содержит незакрытых code block (```), все заголовки начинаются с #"
```

### 5. Data accuracy

Проверяет корректность данных в output.

```yaml
- id: correct_file_count
  name: "Указано правильное количество файлов"
  check: "Число файлов совпадает с реальным количеством"
  assertion: "Число файлов в output совпадает с результатом find -type f | wc -l в целевой директории"
```

### 6. Negative checks

Проверяет ОТСУТСТВИЕ нежелательного контента.

```yaml
- id: no_filler
  name: "Нет filler-фраз"
  check: "Output не содержит бесполезных фраз-заполнителей"
  assertion: "В output нет фраз 'Отличный вопрос!', 'Конечно!', 'Я с удовольствием помогу'"
```

---

## Сколько критериев

- **4-6** — золотая середина
- **< 3** — недостаточно информации, pass rate будет шумным
- **> 8** — overhead растёт, паттерны сложнее найти, criteria могут конфликтовать

---

## Чего избегать

### Слишком узкие критерии
```yaml
# Плохо — skill научится обходить, а не улучшаться
- id: has_word_research
  name: "Содержит слово 'исследование'"
  assertion: "Output содержит слово 'исследование'"
```

### Слишком широкие критерии
```yaml
# Плохо — всегда passes, не даёт сигнал
- id: has_text
  name: "Output не пустой"
  assertion: "Длина output > 100 символов"
```

### Зависимые критерии
```yaml
# Плохо — дублируют друг друга
- id: has_overview_1
  name: "Есть секция обзор"
  assertion: "Заголовок содержит 'обзор'"
- id: has_overview_2
  name: "Есть секция обзор (alt)"
  assertion: "Заголовок содержит 'Overview' или 'обзор'"
```

### Субъективные критерии
```yaml
# Плохо — нельзя проверить детерминистически
- id: quality_good
  name: "Качество хорошее"
  assertion: "Output выглядит профессионально и информативно"
```

---

## Примеры по типам skill

### Для code-generation skill
```yaml
- id: valid_syntax
  name: "Валидный синтаксис"
  assertion: "Сгенерированный код не содержит синтаксических ошибок (проверяется через компиляцию/linting)"
- id: has_imports
  name: "Все импорты присутствуют"
  assertion: "Код содержит все import statements для используемых символов"
- id: follows_style
  name: "Следует style guide"
  assertion: "Код следует naming convention проекта (snake_case/camelCase)"
```

### Для research skill
```yaml
- id: has_sources
  name: "Есть источники"
  assertion: "Output содержит минимум 3 ссылки или цитаты"
- id: has_conclusions
  name: "Есть выводы"
  assertion: "Output содержит секцию с выводами или рекомендациями"
```

### Для analysis skill
```yaml
- id: has_metrics
  name: "Есть метрики"
  assertion: "Output содержит числовые метрики с единицами измерения"
- id: actionable
  name: "Есть рекомендации к действию"
  assertion: "Output содержит конкретные next steps или action items"
```
