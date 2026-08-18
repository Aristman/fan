# Сравнение AI Coding Планов: Qwen vs Kimi

> Дата: 2026-08-16 · Актуально на август 2026
> Для: FAN-оркестратор (параллельные воркеры, длинные сессии, 100K+ контексты)

---

## Содержание

1. [Qwen (Alibaba Cloud)](#qwen-alibaba-cloud)
   - [Token Plan (Personal Edition)](#token-plan-personal-edition)
   - [Coding Plan](#coding-plan)
   - [Pay-as-you-go](#pay-as-you-go)
   - [Механика списания Credits](#механика-списания-credits)
2. [Kimi (Moonshot AI)](#kimi-moonshot-ai)
   - [Membership (Kimi Code)](#membership-kimi-code)
   - [API (Pay-per-token)](#api-pay-per-token)
   - [Механика квот](#механика-квот)
3. [Сравнительная таблица](#сравнительная-таблица)
4. [Рекомендации по конфигурации FAN](#рекомендации-по-конфигурации-fan)
5. [Экономика: что выгоднее](#экономика-что-выгоднее)

---

## Qwen (Alibaba Cloud)

Alibaba предлагает **два отдельных продукта** с принципиально разной механикой биллинга. Их часто путают.

### Token Plan (Personal Edition)

Подписка на основе **Credits** — единая валюта для всех моделей. Лимит по токенам, пересчитанным в кредиты через коэффициенты моделей.

#### Тарифы

| План | Цена (промо) | Обычная цена | Квота | Параллельных агентов |
|------|-------------|-------------|-------|---------------------|
| **Lite** | $6/мес (¥39) | $8/мес (¥60) | 2 500 Credits / 7 дней | 1–2 |
| **Standard** | $18/мес (¥139) | $25/мес (¥180) | 10 000 Credits / 7 дней | 3–4 |
| **Pro** | $68/мес (¥499) | $80/мес (¥600) | 40 000 Credits / 7 дней | 6–8 |
| **Extra Bundle** | $15/мес (¥100) | — | 20 000 Credits, без оконных лимитов | до 5 пакетов |

#### Механика

- **7-дневное скользящее окно** от первого вызова. Исчерпал — сервис встаёт до конца окна.
- **Credits** — единая валюта. Каждая модель имеет свой коэффициент списания.
- **Квота не переносится** между окнами.
- **Reset card** — одноразовый сброс квоты (выдаётся разово, не регулярно).
- **Регион:** Personal Edition — только China (Beijing).

#### Поддерживаемые модели

| Бренд | Модель | Возможность |
|-------|--------|-------------|
| Qwen | qwen3.8-max | Reasoning, vision, text |
| Qwen | qwen3.7-max | Reasoning, text |
| Qwen | qwen3.7-plus | Reasoning, vision, text |
| Qwen | qwen3.6-flash | Reasoning, vision, text |
| Qwen | qwen-image-3.0-pro | Image generation |
| Qwen | qwen-audio-3.0-tts-plus | Speech synthesis |
| Qwen | qwen-audio-3.0-realtime-plus | Realtime voice |
| Qwen | qwen-audio-3.0-asr-flash | Speech recognition |
| DeepSeek | deepseek-v4-pro | Reasoning, text |
| DeepSeek | deepseek-v4-pro-0813 | Reasoning, text |
| DeepSeek | deepseek-v4-flash-0731 | Reasoning, text |
| Zhipu AI | glm-5.2 | Reasoning, text |
| Wan | wan2.7-image | Image generation |
| Wan | wan2.7-image-pro | Image generation |
| HappyHorse | happyhorse-1.1-i2v/t2v/r2v | Video generation |

#### Специальные условия

- **Ночная скидка qwen3.8-max:** 22:00–08:00 UTC+8 (17:00–03:00 МСК) — **−50% Credits**.
- **Ночная скидка deepseek-v4-pro-0813:** тот же интервал, −50%.
- `qwen3.8-max-preview` ретайрнут, автоматически роутится на `qwen3.8-max` по полным тарифам.

### Coding Plan

Подписка на основе **запросов** (requests). Токены внутри запроса **не тарифицируются**.

#### Тарифы

| План | Цена | 5-часовой лимит | Недельный лимит | Месячный лимит |
|------|------|----------------|----------------|---------------|
| **Pro** | $50/мес | 6 000 req | 45 000 req | 90 000 req |

- **Lite** закрыт: новые подписки — с 20.03.2026, продления — с 13.04.2026.
- 1 запрос = 1 model call. Простая задача = 5–10 calls, сложная = 10–30+.
- API key: `sk-sp-...`, base URL: `coding-intl.dashscope.aliyuncs.com`.
- ⚠️ **qwen3.7-max в Coding Plan НЕ входит.** Max-модели только через Token Plan или PAYG.

#### Поддерживаемые модели

| Модель | Возможность |
|--------|-------------|
| qwen3.7-plus (vision) | Reasoning, vision, text |
| qwen3.6-plus (vision) | Reasoning, vision, text |
| qwen3.5-plus (vision) | Reasoning, vision, text |
| qwen3-max-2026-01-23 | Reasoning, text |
| qwen3-coder-next | Code |
| qwen3-coder-plus | Code |
| **kimi-k2.5** (vision) | Reasoning, vision, text |
| glm-5 | Text generation |
| glm-4.7 | Text generation |
| MiniMax-M2.5 | Reasoning, text |

### Pay-as-you-go

Прямая оплата за токены без подписки.

#### Цены (за 1M токенов)

| Модель | Input | Cached Input | Output | Контекст |
|--------|-------|-------------|--------|---------|
| qwen3.8-max | $2.00 | $0.25 | $6.00 | 1M |
| qwen3.7-max | $2.50 | $0.25 | $7.50 | 1M |
| qwen3.7-plus | $0.40 | ~$0.04 | $1.60 | 1M |
| qwen3.6-plus | $0.50 | $0.05 | $3.00 | 1M |
| qwen3.6-flash | ~$0.05–0.15 | ~$0.005–0.015 | ~$0.40–0.80 | 1M |

### Механика списания Credits

**Важно:** Alibaba **не публикует** официальную таблицу коэффициентов по моделям. Константа выведена из официального примера расчёта (qwen3.6-plus):

> 8 349 input → 1.67 Credits, 40 794 cached → 0.82 Credits, 573 output → 0.69 Credits
> Все три строки сходятся: **1 Credit = $0.0025 по прайсу PAYG** (400 кредитов за $1).

#### Таблица списания Credits за 1M токенов (контекст до 256K)

| Модель | Input (мимо кэша) | Cached input | Output (вкл. thinking) |
|--------|-------------------|-------------|----------------------|
| **qwen3.8-max** | 800 | 100 | 2 400 |
| **qwen3.7-max** | 1 000 | ~100–250 | 3 000 |
| **qwen3.7-plus** | 160 | ~16 | 640 |
| **qwen3.6-plus** | 200 | 20 | 1 200 |
| **qwen3.6-flash** | ~40–60 | ~4–6 | ~300–400 |

*Строка qwen3.6-plus сверена с официальным примером Alibaba. Flash — оценка, официальных цифр нет.*

#### Что получает Pro-план ($68, 40 000 Credits / 7 дней)

Типичный микс кодинг-агента: 95% input (из них ~90% кэш), 5% output + thinking.

| Модель | Credits за 1M микса | Потолок на квоту |
|--------|-------------------|-----------------|
| qwen3.8-max | ~250 | ~160M токенов |
| qwen3.7-max | ~290 | ~138M токенов |
| qwen3.7-plus | ~54 | ~740M токенов |
| qwen3.6-plus | ~88 | ~455M токенов |
| qwen3.6-flash | ~27 | ~1.5B токенов |

#### Модификаторы

- **Thinking-токены** = output-тариф (самая дорогая строка).
- **Tiered pricing:** контекст >256K → все токены запроса по старшему тиру (до ~4x).
- **Кэш** дешевле в 10 раз.
- **Harness-инструменты** (web_search и пр.) — отдельный коэффициент за вызов.

#### Экономика подписки

- $68/мес ≈ 172 000 Credits/мес → 1 Credit = **$0.000395** vs номинал $0.0025.
- Скидка к PAYG: **~6.3x**.
- Точка безубыточности: **~13M токенов/мес**. Ниже — выгоднее PAYG, выше — подписка.

#### Предупреждения

- ⚠️ Независимые замеры (FoodTruck Bench, авг 2026): фактическое списание по консоли оказалось **~2x выше** математического. Доверяй Usage Analysis, не формулам.
- ⚠️ Не путай API key (`sk-sp-...`) и base URL (`coding-intl.dashscope.aliyuncs.com`) с обычными — иначе летишь на PAYG.
- ⚠️ Данные в Personal Edition используются для обучения моделей (в отличие от Team Edition).

---

## Kimi (Moonshot AI)

### Membership (Kimi Code)

Подписка с **мультипликаторами квоты**. Kimi не публикует фиксированное количество токенов за кредит — квота меряется в **некэшированных токенах**.

#### Тарифы (International)

| План | Месяц | Год (эффективно/мес) | Kimi Code уровень |
|------|-------|---------------------|-------------------|
| **Moderato** | $19 | $15 | 1× |
| **Allegretto** | $39 | $31 | 5× |
| **Allegro** | $99 | $79 | 15× |
| **Vivace** | $199 | $159 | 30× |

#### Тарифы (China, RMB)

| План | Цена/мес | Kimi Code уровень |
|------|---------|-------------------|
| Andante | ¥49 | — |
| Moderato | ¥99 | 1× |
| Allegretto | ¥199 | 5× |
| Allegro | ¥699 | 15× |

⚠️ **Доступность:** с 20.07.2026 Kimi Code отделили от общего membership. В CN прямая покупка прикрывается **после 20.08.2026** — только продления для текущих подписчиков.

#### Модели и контекст

| Модель | Moderato | Allegretto | Allegro | Vivace |
|--------|----------|-----------|---------|--------|
| K2.7 Code Standard | ✅ | ✅ | ✅ | ✅ |
| K3 | ✅ | ✅ | ✅ | ✅ |
| K3-256k (фикс. контекст) | ✅ | ✅ | ✅ | ✅ |
| K2.7 Code HighSpeed | ❌ | ✅ | ✅ | ✅ |
| Контекст K3 | 256K | до 1M | до 1M | до 1M |
| Kimi Code allowance | 1× | 5× | 15× | 30× |

#### Множители расхода квоты

| Режим / модель | Расход квоты | Комментарий |
|---------------|-------------|-------------|
| K2.7 Code Standard | **1×** (база) | Дефолт Kimi Code |
| K3 в фикс. контексте 256K (`k3-256k`) | **1×** | Те же результаты, что у K3 |
| K3 на полном 1M контексте | **~2×** | Официально заявленный двойной расход |
| K2.7 Code **HighSpeed** | **~3×** | Выдача в 5–6× быстрее, квоту жрёт втрое |
| Cached input | **~0** | Кэшированные токены в недельный лимит практически не считаются |
| Thinking (reasoning) | считается как output | У K2.7 Code reasoning неотключаем |

#### Три независимых лимита

| Контроль | Что покрывает | Обновление | При достижении |
|----------|-------------|-----------|---------------|
| Месячный общий пул | Все фичи membership | Ежемесячно в дату подписки | Заморозка всех фич |
| Недельная квота Kimi Code | Только Kimi Code | Каждые 7 дней от даты подписки | Kimi Code пауза |
| 5-часовое окно | Концентрированная активность | Скользящее, восстановление по мере выхода активности из окна | Rate-limit |

⚠️ **Общий пул:** Kimi Code, Kimi Work, Deep Research и другие фичи делят один месячный пул кредитов. Увлёкся ресёрчем — не осталось на кодинг.

#### Extra Usage (платный overflow)

- От $10 минимальное пополнение.
- Максимум 10 пополнений/день, $1 000/день, $2 000 баланс.
- После исчерпания квоты — автоматически подхватывает.
- Не сгорает, не переносится, non-refundable.

### API (Pay-per-token)

Отдельная платформа (Kimi Platform), отдельный баланс. Не путать с membership.

#### Цены (за 1M токенов)

| Модель | Cached Input | Uncached Input | Output | Контекст |
|--------|-------------|---------------|--------|---------|
| **K2.7 Code** | ¥1.3 / $0.19 | ¥6.5 / $0.95 | ¥27 / $4.00 | 256K |
| **K2.7 Code HighSpeed** | ¥2.6 / $0.38 | ¥13 / $1.90 | ¥54 / $7.90 | 256K |
| **K3** | ¥2 / $0.28 | ¥20 / $2.80 | ¥100 / $14.00 | 1M |

#### Механика квот (оценка)

Официальных цифр нет. Замеры сообщества (февраль 2026, базовый тариф 1×):
- 5-часовое окно: ~1M некэшированных токенов
- Недельная квота: ~4M некэшированных токенов

**Экстраполяция на тарифы:**

| План | 5-часовое окно | Недельная квота | Полные токены/нед (при 90-95% кэше) |
|------|---------------|----------------|-------------------------------------|
| Moderato 1× | ~1M uncached | ~4M uncached | ~38–73M |
| Allegretto 5× | ~5M uncached | ~20M uncached | ~190–365M |
| Allegro 15× | ~15M uncached | ~60M uncached | ~570M–1.1B |
| Vivace 30× | ~30M uncached | ~120M uncached | ~1.1–2.2B |

#### API-эквивалент стоимости

Недельная квота Allegro 15× (~60M uncached+output, ~5.5M output + 54.5M uncached):
- По API K2.7 Code: 5.5M × $4.00 + 54.5M × $0.95 ≈ **$74/нед**
- Плюс бесплатные кэшированные ~0.5–1B токенов: ~$95–190 по API
- Итого: **~$400–500/мес** API-эквивалент vs $99 подписки = **~4–5x выгода**

### Механика квот

**Ключевое отличие от Qwen:** кэшированные токены **практически не считаются** в недельном лимите. Это значит:

- В агентных сессиях, где 90–95% токенов — кэш, реальная стоимость работы в 10–20× ниже, чем кажется по "номинальным" лимитам.
- Разрыв сессии / смена ветки = cache miss = резкий рост расхода.
- **Дисциплина контекста** — главный фактор экономии.

#### Что увеличивает расход

- Большой контекст (сканирование всего репозитория).
- Длинный output (большие патчи, документация).
- Tool loops (поиск → редактирование → тест → исправление).
- Параллельная работа (суб-агенты).
- HighSpeed (×3 расход).
- Смена модели/reasoning уровня (инвалидация кэша).

#### Как продлить квоту

- Указывать релевантные папки, не весь репозиторий.
- Суммаризировать длинные логи.
- Держать одну модель и reasoning level в сессии.
- Начинать новую сессию после смены модели.
- Использовать Standard вместо HighSpeed, когда скорость не критична.
- Разбивать задачи на верифицируемые этапы.

---

## Сравнительная таблица

| Параметр | Qwen Token Plan | Qwen Coding Plan | Kimi Code Membership |
|----------|----------------|-----------------|---------------------|
| **Механика** | Credits за токены | Запросы (токены не считаются) | Некэшированные токены |
| **Цена (сопоставимый тир)** | Pro $68 | Pro $50 | Allegro $99 |
| **Лимиты** | 40K Credits / 7 дней | 6K req/5ч, 45K req/нед | 5ч + неделя + месяц |
| **Флагман** | qwen3.8-max / 3.7-max | qwen3.7-plus (нет max!) | K3 / K2.7 Code |
| **Объём/нед (флагман)** | ~138M (3.7-max) | 45K req (~1500 задач) | ~600M–1.1B |
| **Объём/нед (рабочая лошадка)** | ~740M (3.7-plus) | — | ~570M–1.1B |
| **Объём на $1/мес (флагман)** | ~8.7M/$ | ~30 req/$ | ~25–45M/$ |
| **Кэшированный input** | 1/10 цены | не считается | **не считается** |
| **Thinking** | по output-тарифу | не считается | как output |
| **Временная скидка** | 3.8-max ночью −50% | — | — |
| **Прозрачность** | Константа реверс-инжиниринг, консоль ≠ докам (×2!) | Прозрачно по запросам | Непрозрачно, `/usage` |
| **Зоопарк моделей** | Qwen + DeepSeek + GLM + Kimi + MiniMax | Qwen + GLM + Kimi + MiniMax | Только Kimi |
| **Регион** | Personal: Beijing; Team: Singapore | International | International + CN |
| **Данные** | Personal: используются для обучения | Не используются для обучения | Не используются |

### На сопоставимых тирах

| | **Qwen Token Plan Pro $68** | **Kimi Allegro $99** | **Qwen Coding Plan Pro $50** |
|---|---|---|---|
| Механика | Credits, ~$0.0025/credit | Некэш. токены, кэш ≈ 0 | Запросы |
| Окна | 7-дн жёсткое | 5ч + нед + мес | 5ч + нед + мес |
| Флагман объём/нед | ~138M | ~600M–1.1B | 45K req |
| Плюс объём/нед | ~740M | — | — |
| Кэш | 1/10 цены | **бесплатно** | не считается |
| Прозрачность | Низкая | Очень низкая | Высокая |
| Лучшее применение | Короткие задачи, разнообразие моделей | Длинные агентные сессии | Длинные петли, много вызовов |

---

## Рекомендации по конфигурации FAN

### Под Kimi Vivace $199 + Qwen Token Plan Pro $68

**Распределение ролей:**

| Роль | Модель | Обоснование |
|------|--------|-------------|
| Coordinator | `kimi-coding/k3-256k` | Сильное reasoning, 256K = 1× расход |
| Plan | `kimi-coding/k3-256k` | Планирование = reasoning, K3 на 256K = 1× |
| Implement | `kimi-coding/k2.7-code-highspeed` | Скорость критична, Vivace 30× потянет ×3 |
| Verify | `kimi-coding/k2.7-code` | Точность > скорость, ×1 расход |
| Bug-fix | `kimi-coding/k2.7-code` | Точность, ×1 расход |
| Explore | `qwen/qwen3.6-flash` | Дёшево, быстро, read-only |
| Code-research | `qwen/qwen3.7-plus` | Глубокое исследование |
| Tests-impl | `qwen/qwen3.7-plus` | Сильная модель на code |
| Docs-impl | `qwen/qwen3.6-flash` | Не требует флагмана |

**Конфиг:**

```json
{
  "cloud": {
    "model": "kimi-coding/k3-256k",
    "models": {
      "explore": "qwen/qwen3.6-flash",
      "plan": "kimi-coding/k3-256k",
      "implement": "kimi-coding/k2.7-code-highspeed",
      "verify": "kimi-coding/k2.7-code",
      "bug-fix": "kimi-coding/k2.7-code",
      "code-research": "qwen/qwen3.7-plus",
      "tests-impl": "qwen/qwen3.7-plus",
      "docs-impl": "qwen/qwen3.6-flash"
    }
  },
  "providerMode": "cloud",
  "parallelWorkers": 3,
  "temperature": 0.1
}
```

**Альтернативные сценарии:**

- **Ночью (17:00–03:00 МСК):** implement → `qwen/qwen3.8-max` (−50% credits).
- **Kimi rate-limited:** fallback implement/bug-fix → `qwen/qwen3.7-plus`.
- **Максимальная мощность:** tests-impl → `qwen/deepseek-v4-pro`, verify → `qwen/glm-5.2`.

---

## Экономика: что выгоднее

### Сценарий: FAN-оркестратор, ~50 задач/день

| Конфигурация | Цена/мес | Объём/нед | Качество | Вердикт |
|-------------|---------|----------|---------|---------|
| Qwen Token Plan Pro + qwen3.7-max на всём | $68 | ~138M | Max | ❌ Квота сгорает за 1–2 дня |
| Qwen Token Plan Pro + qwen3.7-plus на всём | $68 | ~740M | Plus | ✅ Рабочий вариант |
| Qwen Coding Plan Pro | $50 | 45K req (~1500 задач) | Plus | ✅ Лучшая цена, нет max |
| Kimi Allegro | $99 | ~600M–1.1B | K2.7/K3 | ✅ Кэш бесплатно, много объёма |
| Kimi Vivace + Qwen Pro | $267 | ~2B+ | K3 + qwen3.7-plus | ✅ Максимум качества и объёма |
| **Kimi Vivace + Qwen Pro (рекомендация)** | **$267** | **~2B+** | **Флагман + сильный** | **🏆 Оптимум цена/качество** |

### Ключевые выводы

1. **Qwen Token Plan на max-моделях — худшая экономика.** Флагман жрёт квоту в 5× быстрее plus.

2. **Kimi выигрывает на длинных сессиях.** Кэш бесплатный = оркестратор с параллельными воркерами и 100K+ контекстами жрёт квоту медленно.

3. **Qwen Coding Plan — тёмная лошадка.** Лимит по запросам, а не токенам. Для оркестратора с длинными петлями — часто выгоднее Token Plan. Но без max-моделей.

4. **Оптимум: Kimi Vivace на code-задачи + Qwen Pro на explore/docs.** Kimi даёт объём и скорость (HighSpeed), Qwen — разнообразие моделей и ночную скидку.

5. **Прозрачность:** GLM (Zhipu) — единственный, кто публикует точную формулу списания. Kimi — самый непрозрачный. Qwen — где-то посередине, но фактическое списание может отличаться от расчётного в 2×.

---

## Источники

- [Alibaba Cloud Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [Alibaba Cloud Token Plan Personal](https://help.aliyun.com/en/model-studio/token-plan-personal-overview)
- [QwenCloud Token Plan Individual](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview)
- [QwenCloud PAYG Pricing](https://docs.qwencloud.com/developer-guides/getting-started/pricing)
- [Kimi Code Plans & Limits](https://kimi-ai.chat/guide/kimi-code-plans-limits/)
- [Kimi API Platform Pricing](https://platform.kimi.ai/docs/pricing/limits)
- [FoodTruck Bench: Qwen Token Plan Economics](https://foodtruckbench.com/blog/qwen-token-plan-economics)
- [Jiegec's Knowledge Base: AI Coding Plans](https://jia.je/kb/en/software/coding_plan.html)
- [CodeAgentSwarm: Kimi Code Plans and Pricing](https://www.codeagentswarm.com/en/guides/kimi-code-plans-and-pricing)
