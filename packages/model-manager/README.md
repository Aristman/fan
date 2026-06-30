# @fan/model-manager

> FAN model manager — provider routing, fallback chains, budget tracking

## Описание

`@fan/model-manager` — это центральный компонент FAN для управления моделями ИИ. Он отвечает за маршрутизацию запросов к провайдерам, обработку ошибок через fallback-цепи и контроль бюджета.

**Решаемая задача:** абстрагировать логику выбора модели от остального кода FAN. Вместо того чтобы каждому компоненту (chat, orchestrator, tools) самостоятельно решать, какую модель вызвать и что делать при ошибке, ModelManager предоставляет единый интерфейс с правилами, fallback'ами и контролем расходов.

**Где используется:** `@fan/api-gateway` использует его для обработки API-запросов к моделям. `@seaagents/fan-coding-agent` использует его для выбора модели при выполнении задач. CLI-команды (`fan init`, `fan server`) полагаются на него для конфигурации моделей.

**Ключевые возможности:**
- **ProviderRouter** — выбирает провайдера и модель на основе routing rules (task type → provider/model)
- **FallbackChain** — при ошибке автоматически пробует следующую модель из цепочки
- **BudgetTracker** — отслеживает расход токенов и стоимости, уведомляет при превышении лимитов
- **ModelRegistry** — реестр доступных моделей с их характеристиками
- Персистентность: настройки, правила и бюджет хранятся в SQLite через `@fan/db`

## Архитектура / Как работает

ModelManager объединяет три подсистемы:

```
ModelManager
├── ProviderRouter     — маршрутизация: task type → (provider, model)
├── FallbackChain      — fallback: primary → fallback1 → fallback2 → ...
└── BudgetTracker      — контроль: лимиты токенов/стоимости по провайдерам
```

**Типичный flow:**
1. Запрос приходит с `TaskType` (например, `"chat"`, `"code"`, `"reasoning"`)
2. `ProviderRouter.resolve(taskType)` → возвращает `{ provider, model, fallback? }`
3. Если у провайдера превышен бюджет — `BudgetTracker` сигнализирует, и роутер выбирает fallback
4. При ошибке вызова — `FallbackChain` пробует следующую модель
5. После успешного вызова — `BudgetTracker.trackUsage()` списывает токены/стоимость

## Использование

### Базовое использование

```ts
import { ModelManager } from "@fan/model-manager";
import { initDatabase } from "@fan/db";

// Инициализация БД (для хранения правил и бюджета)
await initDatabase();

// Создание ModelManager
const manager = new ModelManager({
  router: { /* опции роутера */ },
  budget: {
    defaultTokenLimit: 1_000_000,
    defaultCostLimit: 10.0,
  },
  onAlert: (alert) => console.warn("Budget alert:", alert),
});

// Загрузить правила из БД
await manager.loadRoutingRules();

// Разрешить маршрут для задачи
const route = await manager.resolveForTask("code");
// → { primary: { provider: "openai", model: "gpt-4" },
//     fallback: { provider: "anthropic", model: "claude-3" },
//     settings: { temperature: 0.3 } }

// Отследить использование
await manager.trackUsage("openai", "gpt-4", {
  tokens: 1500,
  cost: 0.03,
});
```

### API

#### Экспорты из `src/index.ts`

| Экспорт | Тип | Описание |
|---------|-----|----------|
| `ModelManager` | Class | Главный класс, объединяет роутер, fallback и бюджет |
| `ProviderRouter` | Class | Маршрутизация по правилам (task type → provider/model) |
| `FallbackChain` | Class | Цепочка fallback'ов при ошибках |
| `BudgetTracker` | Class | Отслеживание лимитов токенов/стоимости |
| `ResolvedTaskRoute` | Type | `{ primary: ModelRoute, fallback: ModelRoute \| null, settings }` |
| `BudgetConfig` | Type | Настройки бюджета (tokenLimit, costLimit, period) |
| `BudgetStatus` | Type | Текущий статус (tokensUsed, costUsed, remaining) |
| `FallbackResult` | Type | Результат fallback'а (ok/error, модель, причина) |
| `RoutingRuleData` | Type | Правило маршрутизации (name, provider, model, fallback) |
| `ModelSettingData` | Type | Настройки модели (temperature, maxTokens, thinking) |
| `TaskType` | Type | Тип задачи для маршрутизации |

## Сборка

```bash
npm run build      # production build (tsgo)
npm run dev        # watch mode
npm run test       # vitest run
npm run clean      # удалить dist/
```

## Зависимости

**Runtime:**
- `@fan/db` — хранение правил, настроек, бюджета в SQLite
- `@seaagents/fan-ai` — типы и интерфейсы моделей ИИ

**Dev:**
- `vitest`, `shx`

## Связанные документы

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [docs/guides/configuration.md](../../docs/guides/configuration.md)
- [docs/RELEASE.md](../../docs/RELEASE.md)

## License

MIT © Fast Agents Network Team
