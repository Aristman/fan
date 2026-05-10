# <Feature Name> — API Reference

## Метаданные
- **Дата:** <YYYY-MM-DD>
- **Автор:** dev-docs-pack
- **Base URL:** <base URL or path>
- **Auth:** <authentication method>

## Обзор

<Краткое описание API-поверхности, которую фича добавляет/изменяет>

## Эндпоинты

### <METHOD> /path/to/endpoint

**Описание:** <what this endpoint does>

**Request:**

| Поле | Тип | Обязательный | Описание |
|------|------|-------------|----------|
| field1 | string | Да | <description> |

**Пример запроса:**
```json
{ "field1": "value" }
```

**Response (200 OK):**

| Поле | Тип | Описание |
|------|------|----------|
| id | string | <description> |

**Пример ответа:**
```json
{ "id": "abc-123" }
```

**Ошибки:**

| Status | Code | Описание |
|--------|------|----------|
| 400 | VALIDATION_ERROR | <when> |
| 401 | UNAUTHORIZED | <when> |
| 404 | NOT_FOUND | <when> |
| 500 | INTERNAL_ERROR | <when> |

### <METHOD> /path/to/endpoint-2

<Аналогичная структура>

## Модели данных

### ModelName

| Поле | Тип | Описание |
|------|------|----------|
| id | string | UUID |
| ... | ... | ... |

## События (WebSocket)

### event:name

**Описание:** <when this event fires>

**Payload:**
```json
{ "field": "value" }
```

## Rate Limiting

<Если применимо>
