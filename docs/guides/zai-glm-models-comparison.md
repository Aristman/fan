# Z.ai (Zhipu) GLM — Полное руководство по моделям и тарифам

> Дата: 2026-08-27 · Актуально на август 2026
> Источник: официальная документация docs.z.ai, storefront z.ai, независимые замеры

---

## Содержание

1. [Обзор экосистемы](#обзор-экосистемы)
2. [Модели: характеристики и возможности](#модели-характеристики-и-возможности)
3. [Coding Plan: тарифы и механика](#coding-plan-тарифы-и-механика)
4. [Коэффициенты списания по моделям](#коэффициенты-списания-по-моделям)
5. [API цены (Pay-as-you-go)](#api-цены-pay-as-you-go)
6. [Сравнительная таблица моделей](#сравнительная-таблица-моделей)
7. [Рекомендации по использованию](#рекомендации-по-использованию)

---

## Обзор экосистемы

Z.ai (Zhipu AI) предлагает несколько продуктов для доступа к моделям GLM:

| Продукт             | Назначение                             | Биллинг                                    |
|---------------------|----------------------------------------|--------------------------------------------|
| **GLM Coding Plan** | Подписка для coding/agent инструментов | Credits с 5-часовыми и недельными лимитами |
| **General API**     | Приложения и кастомные интеграции      | Pay-per-token, баланс аккаунта             |
| **ZCode**           | Собственная coding-среда Z.ai          | Встроенные планы                           |
| **Open Weights**    | Локальный хостинг                      | Лицензии моделей                           |

**Важно:** Coding Plan и General API — **раздельные продукты** с разными ключами, эндпоинтами и биллингом.

---

## Модели: характеристики и возможности

### Флагманские модели

#### GLM-5.3 (14 августа 2026) — текущий флагман

| Параметр          | Значение                                |
|-------------------|-----------------------------------------|
| Контекст          | **1M** (1,048,576 токенов)              |
| Max output        | 128K токенов                            |
| Параметры         | Proprietary (веса не опубликованы)      |
| Модальности       | Text → Text                             |
| Vision            | ❌ Нет                                   |
| Reasoning         | ✅ **Всегда включён** (low / high / max) |
| Function calling  | ✅                                       |
| Context caching   | ✅                                       |
| Structured output | ✅                                       |

**Ключевые улучшения vs GLM-5.2:**

- +50% к coding performance на Z.ai Code Bench
- SOTA среди open-source на Terminal-Bench 3.0 (28.3 vs 4.6)
- Улучшенные cyber-возможности (CyberGym 84.5%, ExploitBench 54.4%)
- Меньше output-токенов при лучшем результате (75K vs 96K на задачу)

**Рекомендации:**

- Для coding: `reasoning_effort: "max"`
- Для простых задач: `reasoning_effort: "low"`

---

#### GLM-5.3-Flash (26 августа 2026) — новый flash-флагман 🆕

| Параметр         | Значение                         |
|------------------|----------------------------------|
| Контекст         | **1M** (1,310,720 токенов)       |
| Max output       | 128K токенов                     |
| Параметры        | **320B total, 18B active**       |
| Архитектура      | Hybrid sparse + linear attention |
| Модальности      | Text + **Image/Video** → Text    |
| Vision           | ✅ **Нативный мультимодальный**   |
| Reasoning        | ✅ Всегда включён                 |
| Function calling | ✅                                |
| Context caching  | ✅                                |

**Архитектурные особенности:**

- Первая open-source frontier-модель с hybrid sparse + linear attention
- Снижение attention compute в **3.01×** vs GLM-5.3
- Снижение KV cache в **4.44×** vs GLM-5.3
- Лицензия **MIT** (полностью open-source)

**Возможности:**

- Visual coding: скриншоты → приложения
- Office: PPTX, PDF, DOCX, XLSX generation
- Financial workflows: research → valuation → reports
- Video understanding & editing
- 3D scene creation (Blender)
- Game development (Godot)
- Computer Use (CUA)
- CAD visual reproduction

**Производительность:**

- Искусственный индекс Intelligence Index v4.1.1: **57 баллов** (на уровне Claude Opus 4.8)
- DeepSWE v1.1: 63.4 vs GLM-5.2 46.2
- AutomationBench: 48.8 vs GLM-5.2 26.2
- На Z.ai Code Bench при max effort: 29.0 (Claude Opus 4.8: 29.5)

**Coding Plan:** **3× квота** по сравнению с GLM-5.3

---

### Предыдущие поколения

#### GLM-5.3-Highspeed — быстрая версия флагмана (Coding Plan exclusive)

| Параметр   | Значение                                                   |
|------------|------------------------------------------------------------|
| Контекст   | **1M**                                                     |
| Max output | 131K                                                       |
| Vision     | ❌                                                          |
| Reasoning  | ✅ (low / high / max)                                       |
| Endpoint   | `https://api.z.ai/api/coding/paas/v4` (только Coding Plan) |
| PAYG цена  | **Нет** — недоступна вне подписки                          |

**Суть:** та же GLM-5.3 на ускоренном inference-стеке (аналог Kimi K2.7-HighSpeed). Модель ID: `glm-5.3-highspeed`.
Доступна только внутри GLM Coding Plan (intl и CN). Официальный коэффициент расхода квоты **не опубликован**; по
аналогии с Kimi HighSpeed (×3) и практикой Z.ai — ожидается **повышенный расход (~×2–3)** против базовой 5.3. Проверяй в
план-дашборде.

---

#### GLM-5.2 (13 июня 2026) — предыдущий флагман

| Параметр   | Значение                                                     |
|------------|--------------------------------------------------------------|
| Контекст   | 1M                                                           |
| Max output | 128K                                                         |
| Параметры  | **753B total** (open-weight, MIT, BF16 + FP8 на HuggingFace) |
| Vision     | ❌                                                            |
| Reasoning  | ✅ (enabled/disabled)                                         |

**Статус:** В Coding Plan запросы на `glm-5.2` и `glm-5.1` **автоматически роутятся на GLM-5.3**.

#### GLM-5.2-Highspeed (13 июня 2026) — Coding Plan exclusive

| Параметр   | Значение                                                     |
|------------|--------------------------------------------------------------|
| Контекст   | 1M                                                           |
| Max output | 131K                                                         |
| Endpoint   | Coding Plan только                                           |
| Статус     | С выходом GLM-5.3 фактически вытесняется `glm-5.3-highspeed` |

⚠️ **GLM-5.2-Flash как API-модель НЕ существует.** В прайсе Z.ai и Coding Plan такого ID нет. Упоминания «GLM-5.2-Flash»
в СМИ — ошибка либо речь о локальных open-weight производных. Лёгкие модели линейки: GLM-4.7-Flash (бесплатная) и
GLM-5.3-Flash (новая, мультимодальная).

---

#### GLM-5-Turbo (март 2026) — для agent-задач

| Параметр   | Значение           |
|------------|--------------------|
| Контекст   | **200K** (202,752) |
| Max output | 128K–131K          |
| Vision     | ❌                  |
| Reasoning  | ✅                  |

**Оптимизации:**

- Для high-throughput agent tasks
- Улучшенное tool invocation
- Complex instruction decomposition
- Temporal consistency в extended tasks

---

#### GLM-4.7 (декабрь 2025) — рабочая лошадка

| Параметр   | Значение                                      |
|------------|-----------------------------------------------|
| Контекст   | **200K**                                      |
| Max output | 128K                                          |
| Vision     | ❌                                             |
| Reasoning  | ✅ (interleaved, retention-based, round-level) |

**Особенности:**

- Значительно дешевле флагманов
- Улучшенная frontend эстетика
- SWE-bench Verified: 73.8% (open-source SOTA на момент выхода)
- LiveCodeBench V6: 84.9 (open-source SOTA)
- BrowseComp: 67 points
- τ²-Bench: 84.7 (surpassed Claude Sonnet 4.5)

**Варианты:**

- **GLM-4.7** — стандартная версия
- **GLM-4.7-FlashX** — ultra-cheap ($0.07/1M input)
- **GLM-4.7-Flash** — **бесплатная**

---

## Coding Plan: тарифы и механика

### Тарифы (Individual)

| План     | Цена/мес | 5-часовой лимит | Недельный лимит | Проекты     |
|----------|----------|-----------------|-----------------|-------------|
| **Lite** | $18      | 2,000 credits   | 10,000 credits  | 1 проект    |
| **Pro**  | $80      | 12,000 credits  | 60,000 credits  | 1–2 проекта |
| **Max**  | $168     | 28,000 credits  | 140,000 credits | 2+ проекта  |

**Team Plan:** Standard $598/seat, Advanced $1198/seat (отдельные квоты в токенах, не кредитах).

### Механика квот

**Два одновременных лимита:**

1. **5-часовое скользящее окно** — кредиты, потреблённые в момент X, восстанавливаются через 5 часов
2. **Недельный лимит** — сбрасывается каждые 7 дней от даты подписки

**Доступ к обоим лимитам необходим** — если недельный исчерпан, 5-часовое восстановление не поможет.

### Peak / Off-peak

| Время                                       | Статус       | Множитель |
|---------------------------------------------|--------------|-----------|
| Mon–Fri 14:00–18:00 UTC+8 (09:00–13:00 МСК) | **Peak**     | ×1.0      |
| Всё остальное время + выходные              | **Off-peak** | **×0.5**  |

**Для Москвы:** вечер, ночь, утро после 13:00, выходные — **всё за полцены**.

### Поддерживаемые модели (полный лист Coding Plan endpoint)

По каталогу models.dev (обновлено август 2026) на Coding Plan endpoint доступны **7 моделей**:

| Model ID            | Контекст | Max output | Примечание                                  |
|---------------------|----------|------------|---------------------------------------------|
| `glm-5.3`           | 1M       | 131K       | Флагман, база квоты 1×                      |
| `glm-5.3-highspeed` | 1M       | 131K       | 🆕 Быстрая 5.3, повышенный расход квоты     |
| `glm-5.3-flash`     | 1M       | 131K       | 🆕 Мультимодальная, **3× квота** (коэф. ÷3) |
| `glm-5.2`           | 1M       | 131K       | Роутится на `glm-5.3`                       |
| `glm-5.2-highspeed` | 1M       | 131K       | Устаревает, вытесняется 5.3-highspeed       |
| `glm-5-turbo`       | 200K     | 131K       | Agent-оптимизированная                      |
| `glm-4.7`           | 204K     | 131K       | Рабочая лошадка                             |

Все модели на Coding Plan endpoint — **$0 в пересчёте на токены** (внутри подписки), расход меряется credits.

**Автоматический роутинг:**

- `glm-5.2` → `glm-5.3`
- `glm-5.1` → `glm-5.3`

⚠️ Официальные коэффициенты для `*-highspeed` вариантов в опубликованной таблице Z.ai **отсутствуют** (таблица от 18.08
предшествовала выходу 5.3-highspeed). До публикации сверяй фактический расход в дашборде плана.

### Поддерживаемые инструменты

**Официально:**

- ZCode, Claude Code, Claude for IDE, Codex, OpenCode, Pi, Cursor, Cline, TRAE, Qoder, Droid, Kilo Code, Roo Code,
  Crush, Goose, Eigent

**Best-effort (может быть rate-limited):**

- OpenClaw, Hermes Agent, SillyTavern

---

## Коэффициенты списания по моделям

### Формула

```
Credits = (Input × Input_coef + Cached × Cached_coef + Output × Output_coef) / 10,000
```

### Таблица коэффициентов

| Модель                  | Input | Cached Input | Output | Относительно GLM-5.3  |
|-------------------------|-------|--------------|--------|-----------------------|
| **GLM-5.3**             | 6.9   | 1.7          | 24     | 1× (база)             |
| **GLM-5.3-Flash** 🆕    | ~2.3  | ~0.57        | ~8     | **~0.33×** (3× квота) |
| **GLM-5-Turbo**         | 5.7   | 1.5          | 21     | ~0.83×                |
| **GLM-4.7**             | 4.6   | 1.2          | 16     | ~0.67×                |
| **GLM-4.6V Vision MCP** | 1.2   | 0.3          | 2.7    | ~0.17×                |

**Harness tools:**

- Web Search / Web Reader / Zread: **1.2 credits per call**

### Пример расчёта

**Запрос на GLM-5.3 (peak):**

- 20,000 uncached input
- 80,000 cached input
- 5,000 output

```
Credits = (20,000 × 6.9 + 80,000 × 1.7 + 5,000 × 24) / 10,000
        = (138,000 + 136,000 + 120,000) / 10,000
        = 39.4 credits (peak)
        = 19.7 credits (off-peak)
```

**Тот же запрос на GLM-5.3-Flash:**

```
Credits ≈ 39.4 / 3 ≈ 13.1 credits (peak)
        ≈ 6.6 credits (off-peak)
```

### Объём в токенах (оценка при 90.9% кэше)

| План | GLM-5.3 (peak → off-peak) | GLM-5.3-Flash (3×) | GLM-4.7 (~3× vs 5.3) |
|------|---------------------------|--------------------|----------------------|
| Lite | 43–87M токенов/нед        | **~130–260M/нед**  | ~130–260M/нед        |
| Pro  | 263–526M/нед              | **~790M–1.6B/нед** | ~790M–1.6B/нед       |
| Max  | 613M–1.2B/нед             | **~1.8–3.6B/нед**  | ~1.8–3.6B/нед        |

---

## API цены (Pay-as-you-go)

### Text models (за 1M токенов)

| Модель               | Input     | Cached Input | Cached Storage | Output    |
|----------------------|-----------|--------------|----------------|-----------|
| **GLM-5.3**          | $1.40     | $0.26        | Free           | $4.40     |
| **GLM-5.3-Flash** 🆕 | **$0.15** | **$0.075**   | Free           | **$0.50** |
| GLM-5.2              | $1.40     | $0.26        | Free           | $4.40     |
| GLM-5-Turbo          | $1.20     | $0.24        | Free           | $4.00     |
| GLM-5.1              | $1.40     | $0.26        | Free           | $4.40     |
| GLM-5                | $1.00     | $0.20        | Free           | $3.20     |
| **GLM-4.7**          | $0.60     | $0.11        | Free           | $2.20     |
| GLM-4.7-FlashX       | $0.07     | $0.01        | Free           | $0.40     |
| GLM-4.6              | $0.60     | $0.11        | Free           | $2.20     |
| GLM-4.5              | $0.60     | $0.11        | Free           | $2.20     |
| GLM-4.5-X            | $2.20     | $0.45        | Free           | $8.90     |
| GLM-4.5-Air          | $0.20     | $0.03        | Free           | $1.10     |
| GLM-4.5-AirX         | $1.10     | $0.22        | Free           | $4.50     |
| GLM-4-32B-0414-128K  | $0.10     | —            | —              | $0.10     |
| **GLM-4.7-Flash**    | **FREE**  | FREE         | FREE           | **FREE**  |
| GLM-4.5-Flash        | FREE      | FREE         | FREE           | FREE      |

**Промо:** GLM-5.3-Flash — **50% скидка** до 9 сентября 2026 (перечёркнутые цены: $0.30/$0.15/$1.00).

### Vision models

| Модель          | Input | Cached | Output |
|-----------------|-------|--------|--------|
| GLM-5V-Turbo    | $1.20 | $0.24  | $4.00  |
| GLM-4.6V        | $0.30 | $0.05  | $0.90  |
| GLM-OCR         | $0.03 | —      | $0.03  |
| GLM-4.6V-FlashX | $0.04 | $0.004 | $0.40  |
| GLM-4.5V        | $0.60 | $0.11  | $1.80  |
| GLM-4.6V-Flash  | FREE  | FREE   | FREE   |

### Built-in tools

| Tool       | Cost        |
|------------|-------------|
| Web Search | $0.01 / use |

### Image generation

| Model     | Price          |
|-----------|----------------|
| GLM-Image | $0.015 / image |
| CogView-4 | $0.01 / image  |

### Video generation

| Model            | Price         |
|------------------|---------------|
| CogVideoX-3      | $0.20 / video |
| ViduQ1-Text      | $0.40 / video |
| ViduQ1-Image     | $0.40 / video |
| ViduQ1-Start-End | $0.40 / video |
| Vidu2-Image      | $0.20 / video |
| Vidu2-Start-End  | $0.20 / video |
| Vidu2-Reference  | $0.40 / video |

---

## Сравнительная таблица моделей

| Модель                | Релиз      | Контекст | Output | Vision | Reasoning | API Input        | API Output | Coding Plan Coef        | Относительно 5.3 |
|-----------------------|------------|----------|--------|--------|-----------|------------------|------------|-------------------------|------------------|
| **GLM-5.3**           | 14.08.2026 | 1M       | 128K   | ❌      | ✅ always  | $1.40            | $4.40      | 6.9/1.7/24              | 1×               |
| **GLM-5.3-Highspeed** | 08.2026    | 1M       | 131K   | ❌      | ✅ always  | Coding Plan only | —          | не опубликован (~×2–3?) | **повышенный**   |
| **GLM-5.3-Flash** 🆕  | 26.08.2026 | 1M       | 128K   | ✅      | ✅ always  | $0.15            | $0.50      | ~2.3/0.57/8             | **~0.33×**       |
| GLM-5.2               | 13.06.2026 | 1M       | 128K   | ❌      | ✅         | $1.40            | $4.40      | → 5.3                   | → 5.3            |
| GLM-5.2-Highspeed     | 13.06.2026 | 1M       | 131K   | ❌      | ✅         | Coding Plan only | —          | не опубликован          | устаревает       |
| GLM-5-Turbo           | 03.2026    | 200K     | 128K   | ❌      | ✅         | $1.20            | $4.00      | 5.7/1.5/21              | ~0.83×           |
| GLM-5                 | 02.2026    | 1M       | 128K   | ❌      | ✅         | $1.00            | $3.20      | —                       | —                |
| **GLM-4.7**           | 12.2025    | 200K     | 128K   | ❌      | ✅         | $0.60            | $2.20      | 4.6/1.2/16              | ~0.67×           |
| GLM-4.7-FlashX        | —          | 200K     | 128K   | ❌      | ✅         | $0.07            | $0.40      | —                       | —                |
| GLM-4.7-Flash         | —          | 200K     | 128K   | ❌      | ✅         | FREE             | FREE       | —                       | —                |
| GLM-4.6               | —          | 128K     | —      | ✅      | —         | $0.60            | $2.20      | —                       | —                |
| GLM-4.5V              | —          | —        | —      | ✅      | —         | $0.60            | $1.80      | —                       | —                |

---

## Рекомендации по использованию

### Выбор модели по задаче

| Задача                                 | Рекомендуемая модель    | Обоснование                                      |
|----------------------------------------|-------------------------|--------------------------------------------------|
| **Complex coding / refactoring**       | GLM-5.3 (max effort)    | Флагман, лучший reasoning                        |
| **Daily coding / agent loops**         | GLM-5.3-Flash           | 3× квота, vision, почти флагман                  |
| **Speed-critical coding (в подписке)** | GLM-5.3-Highspeed       | Быстрейший inference, но следи за расходом квоты |
| **High-throughput agents**             | GLM-5-Turbo             | Оптимизирован для tool invocation                |
| **Budget coding**                      | GLM-4.7                 | Дёшево, качественно                              |
| **Ultra-budget / testing**             | GLM-4.7-Flash           | Бесплатно                                        |
| **Frontend / UI from screenshots**     | GLM-5.3-Flash           | Нативный vision                                  |
| **Long-horizon tasks (>200K)**         | GLM-5.3 / GLM-5.3-Flash | 1M контекст                                      |
| **Mobile / client-side debugging**     | GLM-5.3                 | Project-level context                            |

**Highspeed vs Flash — выбор тактики:**

- `glm-5.3-flash` — **экономит квоту** (×⅓), даёт vision, качество ~Opus 4.8. Дефолт для массовых задач.
- `glm-5.3-highspeed` — **тратит квоту быстрее** (оценочно ×2–3), но минимальная задержка. Для интерактивных сессий, где
  скорость критична, а объём мал.
- Правило: массовый код → Flash; точечные интерактивные правки → Highspeed; сложный reasoning → базовая 5.3.

### Оптимизация расхода квоты

1. **Работай в off-peak** (после 13:00 МСК, выходные) — **всегда ×0.5**
2. **Используй GLM-5.3-Flash** для большинства задач — 3× квота при почти флагманском качестве
3. **Держи одну модель в сессии** — смена инвалидирует кэш
4. **Кэшируй контекст** — cached input в 4× дешевле uncached (6.9 → 1.7)
5. **Разбивай длинные задачи** — не превышай 5-часовое окно
6. **Для GLM-5.3 используй `reasoning_effort: "low"`** для простых задач

### Конфигурация FAN-оркестратора

**Оптимальное распределение:**

| Роль          | Модель          | Обоснование                        |
|---------------|-----------------|------------------------------------|
| Coordinator   | `glm-5.3` (max) | Сильное reasoning для планирования |
| Plan          | `glm-5.3` (max) | Complex decomposition              |
| Implement     | `glm-5.3-flash` | 3× квота, vision для UI, быстро    |
| Verify        | `glm-5.3-flash` | Точность + скорость                |
| Bug-fix       | `glm-5.3-flash` | Vision для скриншотов ошибок       |
| Explore       | `glm-4.7`       | Дёшево, быстро                     |
| Code-research | `glm-5.3-flash` | Vision + reasoning                 |
| Tests-impl    | `glm-5.3-flash` | Качество + скорость                |
| Docs-impl     | `glm-4.7`       | Не требует флагмана                |

**Конфиг:**

```json
{
  "cloud": {
    "model": "glm-5.3",
    "models": {
      "explore": "glm-4.7",
      "plan": "glm-5.3",
      "implement": "glm-5.3-flash",
      "verify": "glm-5.3-flash",
      "bug-fix": "glm-5.3-flash",
      "code-research": "glm-5.3-flash",
      "tests-impl": "glm-5.3-flash",
      "docs-impl": "glm-4.7"
    }
  },
  "providerMode": "cloud",
  "parallelWorkers": 3,
  "temperature": 0.1
}
```

### Экономия: GLM Pro vs Kimi Vivace vs Qwen Pro

| План                 | Цена | Объём/нед (флагман) | Объём/нед (flash/plus)    | Качество        |
|----------------------|------|---------------------|---------------------------|-----------------|
| GLM Pro              | $80  | 263–526M            | **790M–1.6B** (5.3-Flash) | Флагман + Flash |
| Kimi Allegro         | $99  | 600M–1.1B           | —                         | K2.7/K3         |
| Qwen Token Plan Pro  | $68  | 138M (3.7-max)      | 740M (3.7-plus)           | Max / Plus      |
| Qwen Coding Plan Pro | $50  | —                   | 45K req                   | Plus only       |

**GLM Pro $80 + GLM-5.3-Flash = лучший объём за доллар** среди всех провайдеров.

---

## Источники

- [Z.ai Pricing](https://docs.z.ai/guides/overview/pricing)
- [GLM-5.3 Overview](https://docs.z.ai/guides/llm/glm-5.3)
- [GLM-5.3-Flash Overview](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [GLM-5.2 Overview](https://docs.z.ai/guides/llm/glm-5.2)
- [GLM-4.7 Overview](https://docs.z.ai/guides/llm/glm-4.7)
- [GLM Coding Plan Guide](https://glm-ai.chat/guide/glm-coding-plan/)
- [Z.ai Subscription Storefront](https://z.ai/subscribe)
