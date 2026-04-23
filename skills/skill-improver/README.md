# skill-improver

Автономная оптимизация fan skills через AutoResearch loop. Вдохновлено [autoresearch](https://github.com/karpathy/autoresearch) Карпатого.

## Идея

Skill-improver запускает agentic loop, который автоматически улучшает целевой skill:

```
target skill → сгенерировать eval criteria → запустить baseline
→ мутировать skill → протестировать на fan subagent
→ pass rate вырос? → keep : discard
→ повторять
```

## Запуск

В fan после `/reload`:

```
/skill:skill-improver <путь-к-skill>
/skill:skill-improver ~/.fan/agent/skills/repo-explorer
/skill:skill-improver repo-explorer --quick 10 --target 90
/skill:skill-improver my-skill --subagent-model gemini-flash
```

## Флаги

| Флаг | Default | Описание |
|------|---------|----------|
| `--dry-run` | — | Только сгенерировать eval criteria, без loop |
| `--quick N` | 15 | Максимум итераций |
| `--target PCT` | 85 | Остановиться при достижении pass rate |
| `--subagent-model ID` | Qwen3-Coder-30B-A3B (Ollama) | Модель для fan subagent'ов |

## Как работает

### Фаза 1: Discovery
Читает целевой skill — SKILL.md, references, scripts. Показывает что будет мутироваться.

### Фаза 2: Eval Setup
Автоматически генерирует 4-6 binary eval criteria (yes/no) и 10-20 тест-кейсов. Пользователь утверждает перед запуском.

### Фаза 3: Baseline
Запускает `fan --skill <target>` на всех тест-кейсах. Считает pass rate — сколько тестов прошли ВСЕ критерии.

### Фаза 4: Improvement Loop
Автономный цикл (без участия человека):

1. Анализирует failures предыдущих итераций
2. Формулирует **одну** гипотезу улучшения
3. Мутирует файлы skill
4. Тестирует через fan subagent
5. Pass rate вырос → keep, не вырос → discard (восстановление из snapshot)

### Фаза 5: Finalization
Итоговый отчёт. Сохраняет `results.tsv` и `results-improved-{date}.tsv` в директорию target skill.

## Версионирование

Git не используется (директории skill обычно не в git). Вместо этого — snapshot-based keep/discard:

- Перед мутацией → `cp -r` в `.skill-improver/snapshots/`
- KEEP → обновить best snapshot
- DISCARD → восстановить из best snapshot
- После завершения → cleanup snapshots, оставить только results.tsv

## Модель subagent'ов

Дефолт: `danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS` (Ollama)

MoE модель — 30B параметров total, 3B active per token. Unsloth Dynamic Quant для 16GB GPU (~10GB VRAM).
Бесплатная, работает локально, достаточно умная чтобы следовать инструкциям skill.

```bash
ollama pull danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS
```

## Потребление токенов

Один subagent run: ~15K tokens (system prompt + skill + user prompt + output).

Один полный run (~15 итераций × 15 тест-кейсов = 225 subagent запусков):

| Показатель | Значение |
|------------|---------|
| Subagent запусков | 225 |
| Токенов на subagent'ов | ~3.4M |
| Токенов на оркестратора | ~50-100K |
| **Итого** | **~3.5M tokens** |

## Структура

```
skill-improver/
├── SKILL.md              # Основной skill (441 строка, 5 фаз)
├── references/
│   └── eval-guide.md     # Гайд по написанию binary assertions
└── README.md             # Этот файл
```

## Зависимости

- fan coding agent (с доступом к fan subagent)
- Модель с API доступом (рекомендуется Gemini Flash для subagent'ов)

## License

MIT
