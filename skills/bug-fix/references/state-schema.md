# Схема state.json и правила resume

> Рабочее состояние прогона bug-fix: `.fan/bug-fix/<slug>/state.json`. Не коммитится.
> Создаётся на Стадии 0 (Intake), обновляется после каждой стадии. Источник resume.

## Полная схема

```json
{
  "slug": "bug-session-switch-crash",
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>",
  "input": {
    "type": "text|file|stacktrace",
    "source": null,
    "claimedRootCause": null,
    "severity": "major",
    "hotfix": false
  },
  "stage": "intake|rca|approval|red|green|verify|done|stopped",
  "rca": {
    "status": "confirmed",
    "summaryRef": "docs/bugs/<slug>/bug.md#rca",
    "attempt": 1
  },
  "approval": {
    "method": "lavish|question|hotfix-bypass",
    "approvedAt": "<ISO>",
    "iterations": 2
  },
  "red": {
    "tests": [
      { "id": "TC-BUG-...-1", "file": "...", "failReason": "..." }
    ],
    "confirmed": true
  },
  "green": {
    "attempts": 1,
    "maxAttempts": 3,
    "diffFiles": ["..."]
  },
  "verify": {
    "verdict": "PASS",
    "runs": 1
  },
  "decisions": {
    "commitPolicy": "auto|manual|none",
    "testInfra": "auto|manual-scenario|none",
    "docPath": "docs/bugs/<slug>/bug.md"
  },
  "commits": []
}
```

## Поля

| Поле | Тип / значения | Смысл |
|---|---|---|
| `slug` | string | Идентификатор прогона, `bug-<kebab-symptom>`; задаёт каталог `.fan/bug-fix/<slug>/` |
| `createdAt` / `updatedAt` | ISO 8601 | Создание / последняя запись (обновлять при каждом изменении state) |
| `input.type` | `text` \| `file` \| `stacktrace` | Тип входа, определённый на intake |
| `input.source` | string \| null | Путь к тикету/доке или первичный текст описания |
| `input.claimedRootCause` | string \| null | Заявленная оператором причина (fast-path RCA) |
| `input.severity` | `critical` \| `major` \| `minor` \| `trivial` | Дефолт `major`, если не задано |
| `input.hotfix` | boolean | `true` — явный `--hotfix` (аппрув post-hoc) |
| `stage` | `intake` \| `rca` \| `approval` \| `red` \| `green` \| `verify` \| `done` \| `stopped` | Текущая стадия; точка resume |
| `rca.status` | `confirmed` \| `refuted` \| `not_reproducible` | Итог RCA-воркера |
| `rca.summaryRef` | string | Ссылка на секцию RCA в документе решения |
| `rca.attempt` | number | Попытка RCA (счётчик повторных запусков стадии RCA) |
| `approval.method` | `lavish` \| `question` \| `hotfix-bypass` | Способ аппрува |
| `approval.approvedAt` | ISO 8601 \| null | Момент фиксации аппрува |
| `approval.iterations` | number | Итераций правок (лимит 5) |
| `red.tests[]` | массив | Один элемент на TC тест-плана: id, файл теста, причина падения (цитата failure) |
| `red.confirmed` | boolean | Red-критерий подтверждён: все тесты падают по правильной причине |
| `green.attempts` / `maxAttempts` | number | Счётчик общих циклов Green↔Verify; лимит 3 |
| `green.diffFiles` | string[] | Файлы, изменённые фикс-воркером |
| `verify.verdict` | `PASS` \| `FAIL` | Вердикт verify-воркера |
| `verify.runs` | number | Число запусков verify |
| `decisions.commitPolicy` | `auto` \| `manual` \| `none` | Коммит в финале: автоматом / предложить оператору / не коммитить |
| `decisions.testInfra` | `auto` \| `manual-scenario` \| `none` | Решение по тестовой инфраструктуре (утверждается на аппруве) |
| `decisions.docPath` | string | Путь к документу решения `docs/bugs/<slug>/bug.md` |
| `commits` | string[] | SHA коммитов, созданных прогоном |

## Правила resume

1. **Точка входа.** Аргумент = slug или путь `docs/bugs/<slug>/bug.md` → resume по
   `.fan/bug-fix/<slug>/state.json`. Без аргумента → найти свежий прогон: один → resume,
   несколько → самый свежий + уведомить, ноль → стоп с отчётом.
2. **Продолжение с `state.stage`.** Прочитать state, восстановить контекст (артефакты
   стадии, документ решения) и продолжить с зафиксированной стадии.
3. **Стадия считается выполненной, если её артефакты существуют** (даже если `stage` не
   был обновлён): intake → `intake.md` + state; RCA → `rca.status` заполнен; approval →
   `approval.approvedAt` не null; red → `red.confirmed = true` и файлы тестов существуют;
   green → `green.diffFiles` не пуст; verify → `verify.verdict` заполнен. При
   расхождении «артефакты есть, stage отстаёт» — доверять артефактам, поправить stage.
4. **Отсутствующие ключи → безопасные дефолты + запись в отчёт, НЕ вопрос:**
   `severity = "major"`, `commitPolicy = "auto"`, `testInfra = "manual-scenario"`,
   `hotfix = false`, счётчики попыток = актуальные значения. Дополнения фиксируются в
   финальном отчёте.
5. **Повреждённый state.json** (невалидный JSON / неизвестная `stage`) → стоп с отчётом
   и инструкцией пересоздания: удалить `.fan/bug-fix/<slug>/state.json` и перезапустить
   `/skill:bug-fix <slug или путь к bug.md>` — intake пройдёт заново, существующий
   `bug.md` переиспользуется (аппрув проверяется по шапке документа).
6. **Терминальные стадии.** `done` — прогон завершён, сообщить итог и выйти. `stopped` —
   прогон остановлен (лимиты / abort / ended без аппрува); resume возможен только по
   явной команде оператора.
7. **Инварианты переходов.** Не продолжать вглубь при `approval.approvedAt = null`
   (кроме `input.hotfix = true`) и при `red.confirmed = false`. `green.attempts ≥ 3` →
   стоп с отчётом, без автопродолжений.
