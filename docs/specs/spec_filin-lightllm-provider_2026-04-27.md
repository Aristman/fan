# Спецификация: Интеграция провайдера Filin-LightLLM

> Дата: 2026-04-27
> Статус: Draft
> Тип: Интеграция
> Версия: 1.1

---

## 1. Обзор

### Цель
Подключение LiteLLM proxy (https://litellm.codefine.io/) как отдельного провайдера «Filin-LightLLM» в FAN с доступом по API key.

### Контекст
- FAN поддерживает OpenAI-совместимые провайдеры нативно через API-тип `openai-completions`
- LiteLLM proxy экспонирует стандартный OpenAI API endpoint
- Конфигурация провайдеров возможна через `~/.fan/agent/models.json` без изменения кода
- Файл `models.json` перезагружается без перезапуска (при команде `/model` или `ModelRegistry.refresh()`)

### Решение
Конфигурация провайдера через `~/.fan/agent/models.json` с использованием API-типа `openai-completions`. API key передаётся через переменную окружения `FILIN_LITELLM_API_KEY`.

---

## 2. Функциональные требования

### 2.1 Регистрация провайдера
Провайдер «filin-lightllm» должен быть зарегистрирован в `models.json` со следующими полями:
- `baseUrl`: `https://litellm.codefine.io/v1`
- `api`: `openai-completions`
- `apiKey`: `FILIN_LITELLM_API_KEY` (имя переменной окружения)
- `models`: массив моделей (определяется через /v1/models)

### 2.2 Список моделей
LiteLLM proxy экспонирует 2 модели-абстракции:

| Model ID | Назначение |
|----------|------------|
| `chat` | Чатовые модели (Chat Completions API) |
| `completion` | Completion-модели (Text Completions API) |

Имена абстрагируют upstream-провайдеров — конкретная модель определяется конфигурацией proxy.

Для проверки актуального списка:
```bash
curl -s https://litellm.codefine.io/v1/models \
  -H "Authorization: Bearer $FILIN_LITELLM_API_KEY" | jq '.data[].id'
```

### 2.3 Выбор модели пользователем
Пользователь должен иметь возможность:
- Выбрать модель Filin-LightLLM через команду `/model` в TUI
- Выбрать модель через Dashboard WebUI
- Указать модель через CLI флаг `--model filin-lightllm/<model-id>`

### 2.4 Бизнес-правила
- API key НЕ хранится в файлах конфигурации или репозитории
- Модели провайдера доступны только при наличии валидного API key
- При отсутствии переменной окружения `FILIN_LITELLM_API_KEY` — провайдер неработоспособен с понятной ошибкой

---

## 3. Технические требования

### 3.1 Стек
- Конфигурация: JSON (`~/.fan/agent/models.json`)
- API тип: `openai-completions` (встроенный в FAN)
- Стриминг: SSE через `openai` npm SDK
- Аутентификация: Bearer token через переменную окружения

### 3.2 Архитектура
```
User (TUI/Dashboard)
  → ModelRegistry.find("filin-lightllm", modelId)
  → api-registry.getApiProvider("openai-completions")
  → streamOpenAICompletions(model, context)
  → OpenAI SDK: POST https://litellm.codefine.io/v1/chat/completions
  → LiteLLM proxy → upstream provider → SSE response
```

### 3.3 Конфигурация models.json
Полный формат конфигурации:
```json
{
  "providers": {
    "filin-lightllm": {
      "baseUrl": "https://litellm.codefine.io/v1",
      "api": "openai-completions",
      "apiKey": "FILIN_LITELLM_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "chat",
          "name": "Filin-LightLLM Chat",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "completion",
          "name": "Filin-LightLLM Completion",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

### 3.4 Compat-флаги
LiteLLM proxy может потребовать следующие compat-настройки:

| Флаг | Значение | Причина |
|------|----------|---------|
| `supportsDeveloperRole` | `false` | LiteLLM обычно не поддерживает роль `developer` |
| `supportsReasoningEffort` | `false` | Зависит от upstream модели |
| `supportsUsageInStreaming` | `false` | Зависит от конфигурации proxy |
| `maxTokensField` | `"max_tokens"` | Стандартное поле для OpenAI-совместимых API |

### 3.5 API Key Resolution Chain
При запросе к Filin-LightLLM:
1. Проверяется `auth.json` для провайдера `filin-lightllm`
2. Fallback на `models.json` apiKey → разрешает `FILIN_LITELLM_API_KEY` из env
3. OpenAI SDK автоматически добавляет `Authorization: Bearer <key>`

---

## 4. Данные

### 4.1 models.json Schema (provider-level)
| Поле | Тип | Обязательное | Описание |
|------|-----|--------------|----------|
| `baseUrl` | string | Да | API endpoint |
| `api` | string | Да | `openai-completions` |
| `apiKey` | string | Да | Имя env var или литеральное значение |
| `compat` | object | Нет | Настройки совместимости |
| `models` | array | Да | Массив конфигураций моделей |
| `headers` | object | Нет | Дополнительные HTTP-заголовки |

### 4.2 Model Schema
| Поле | Тип | Обязательное | Описание |
|------|-----|--------------|----------|
| `id` | string | Да | Идентификатор модели в LiteLLM proxy (`chat` или `completion`) |
| `name` | string | Нет | Отображаемое имя (по умолчанию = id) |
| `reasoning` | boolean | Нет | Поддержка extended thinking |
| `input` | string[] | Нет | `["text"]` или `["text", "image"]` |
| `contextWindow` | number | Нет | Контекст в токенах (default: 128000) |
| `maxTokens` | number | Нет | Макс. выходных токенов (default: 16384) |
| `cost` | object | Нет | Стоимость (default: все нули) |
| `compat` | object | Нет | Переопределение provider compat |

---

## 5. UI/UX

### 5.1 TUI
- Модели Filin-LightLLM отображаются в `/model` с префиксом `filin-lightllm/`
- Выбор через стрелки и Enter
- При ошибке аутентификации — понятное сообщение: "Invalid API key for filin-lightllm"

### 5.2 Dashboard
- Модели отображаются в секции Model Settings
- Можно задать temperature, maxTokens, thinking level

---

## 6. Нефункциональные требования

### 6.1 Безопасность
- API key хранится ТОЛЬКО в переменной окружения
- Не коммитить в VCS
- Добавить `FILIN_LITELLM_API_KEY` в `.env` и `.gitignore`

### 6.2 Надёжность
- При недоступности proxy — корректная обработка ошибок с сообщением пользователю
- Таймаут соединения — handled by OpenAI SDK defaults

### 6.3 Производительность
- Стриминг ответов (SSE) — работаем через `openai-completions` streaming
- Latency определяется LiteLLM proxy и upstream провайдером

---

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| LiteLLM proxy недоступен | Средняя | Высокое | Fallback на другой провайдер (ручной выбор) |
| Несовместимость compat-флагов | Средняя | Среднее | Тестирование с каждой моделью, индивидуальные compat |
| Изменение API LiteLLM proxy | Низкая | Высокое | Версионирование, мониторинг изменений |
| Утечка API key | Низкая | Критическое | Только env var, .gitignore, аудит окружения |

---

## 8. Компромиссы

| Решение | Альтернатива | Обоснование |
|---------|--------------|-------------|
| Config-only (models.json) | Extension (FAN Store) | Проще в поддержке, нет лишнего кода, достаточно для корпоративного proxy |
| Env var для API key | auth.json | Универсальный подход, совместим с CI/CD и docker-compose |
| Без роутинга | С роутингом | Ручной контроль — корпоративный proxy не должен быть дефолтным |
| Static model list | Dynamic discovery | Стабильность конфигурации; обновление вручную при добавлении моделей |

---

## 9. Приоритеты (MoSCoW)

| Приоритет | Требование |
|-----------|------------|
| **Must** | Регистрация провайдера через models.json |
| **Must** | API key через переменную окружения |
| **Must** | Корректное отображение моделей в TUI и Dashboard |
| **Must** | Стриминг через openai-completions |
| **Should** | Compat-флаги для типичных LiteLLM конфигураций |
| **Should** | Документация по обнаружению моделей через /v1/models |
| **Could** | Скрипт автоматического обновления списка моделей |
| **Won't** | Интеграция в ProviderRouter (ручной выбор) |
| **Won't** | Extension для динамической регистрации |
| **Won't** | Custom streaming implementation |

---

## 10. Следующие шаги

1. [x] Получить API key для litellm.codefine.io
2. [x] Выполнить `curl` запрос к `/v1/models` для получения списка моделей → `chat`, `completion`
3. [ ] Создать `~/.fan/agent/models.json` с конфигурацией провайдера
4. [ ] Добавить `FILIN_LITELLM_API_KEY` в `.env`
5. [ ] Протестировать `chat` модель в TUI: `/model` → `filin-lightllm/chat` → отправить запрос
6. [ ] Протестировать `completion` модель в TUI: `/model` → `filin-lightllm/completion` → отправить запрос
7. [ ] Протестировать в Dashboard: Model Settings → выбрать модель → отправить запрос
8. [ ] Определить compat-флаги по результатам тестирования (при необходимости скорректировать)
9. [ ] Проверить поддержку multimodal input (`image`) для обеих моделей
10. [ ] При изменении списка моделей на proxy — обновить `models.json`

---

*Исходный запрос: Подключение https://litellm.codefine.io/ как провайдера Filin-LightLLM с доступом по API key*
