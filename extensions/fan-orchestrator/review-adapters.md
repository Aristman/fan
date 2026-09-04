# PlatformReviewAdapter — contract documentation (F-15)

> Документация к `extensions/fan-orchestrator/review-adapters.d.ts`
> (TypeScript declaration file, 0 рантайма — только типы).
> Реализации GitHub/Bitbucket — отдельные extension'ы БУДУЩИХ фаз; в v1
> создаётся только контракт. Roadmap: `docs/features/code-review-worker/roadmap.md`
> → «#### ☐ F-15».

## Semantics of errors

Единая семантика ошибок, обязательная для каждой `PlatformReviewAdapter`-реализации:

- **Network / transient** (таймаут, connection reset, 5xx) → retry с
  экспоненциальным backoff внутри адаптера (например 3 попытки: 500ms → 1s →
  2s, с jitter). Наружу ошибка отдаётся только после исчерпания попыток —
  транзиентные сбои сети не должны ронять ревью.
- **Auth** (401/403, невалидный или просроченный токен) → явная ошибка:
  бросается немедленно, с классом auth-ошибки и человекочитаемым сообщением
  (какой `credentialsRef` не сработал). Retry НЕ выполняется — повтор не
  лечит неверные креденшелы.
- **Not found** (репозиторий из `PlatformRef.repo` или PR не существует) →
  явная 404/not-found ошибка с идентификаторами (`ref.repo`, номер PR),
  пробрасывается наверх как есть.

Всё перечисленное реализуется в единой точке HTTP-транспорта адаптера, чтобы
семантика не расходилась между методами `getDiff` / `postComments` / `resolvePr`.

## Extension model

- Каждая реализация контракта — **отдельный FAN extension** (например
  `fan-github-adapter`, `fan-bitbucket-adapter`), который регистрирует свой
  `PlatformReviewAdapter` и несёт только свои зависимости. Ни одна реализация
  не встраивается в `fan-orchestrator`.
- **Orchestrator остаётся platform-agnostic**: он импортирует из
  `review-adapters.d.ts` ТОЛЬКО типы и не знает о конкретных платформах;
  выбор реализации делается по `PlatformRef.id` в момент запуска ревью.
- **Явное правило для неизвестных платформ.** Тип `PlatformRef.id` намеренно
  permissive (`string & {}` — autocomplete для известных id + extensibility
  для новых). Обратная сторона: An unknown platform id must be explicitly
  handled by the implementation (logged + gracefully rejected or forwarded) —
  the type contract is permissive, the implementation is strict. Молча
  трактовать неизвестный id как известную платформу запрещено.

## Precedent

Прецедент реализации платформенного клиента: `extensions/fan-confluence/client.ts`.
Рекомендуемый для GitHub/Bitbucket-адаптеров паттерн:

1. **Типизированный объект-клиент** (`ConfluenceClient`) — неймспейсы методов
   (`space`, `content`, `search`), а не россыпь функций.
2. **Фабрика `initClient(config)`** — конфигурация отделена от транспорта;
   транспорт не читает окружение сам.
3. **Единая точка `apiRequest()`** — один HTTP-слой, который вешает
   HTTP-статус на бросаемый `Error` (`err.status = res.status`). Именно здесь
   реализуется секция «Semantics of errors» выше: статус → retry / auth / 404.
4. **`healthCheck()`** — дешёвый вызов (`getSpaces({limit: 1})`) возвращает
   `{ ok, version?, error? }` без исключений — для `/fan doctor` и настроек.

Адаптер платформы = этот паттерн (typed client + factory + единый `apiRequest`
со статусом + `healthCheck`), обёрнутый в интерфейс `PlatformReviewAdapter`.
