# Backlog: Fork @mariozechner/* packages

## Цель
Полностью избавиться от зависимости от `@mariozechner/*` scope. Переиздать под `@seaagents/*`.

## Пакеты

| Пакет | Текущий | Целевой | Где используется | Приоритет |
|-------|---------|---------|-----------------|-----------|
| `@mariozechner/jiti` | `^2.6.5` | `@seaagents/jiti` | coding-agent (extension loader), root devDeps | P1 |
| `@mariozechner/mini-lit` | (в fan-web-ui) | `@seaagents/mini-lit` | web-ui | P2 |
| `@mariozechner/clipboard` | `^0.3.2` | `@seaagents/clipboard` | coding-agent (optionalDep) | P2 |

## Что нужно сделать

1. Форкнуть репозитории на GitHub (account: seaagents)
2. Переименовать package name в каждом форке (`@seaagents/jiti` и т.д.)
3. Опубликовать в npm (или использовать GitHub Packages / git+ssh dependency)
4. Заменить все `@mariozechner/jiti` → `@seaagents/jiti` (и остальных) в исходниках
5. Обновить package.json, package-lock.json, overrides если есть
6. Пересобрать и протестировать

## Зависимости

- Нужно убедиться что jiti не имеет внутренних ссылок на `@mariozechner/*`
- mini-lit может иметь свою цепочку зависимостей

## Риски

- jiti активно используется в coding-agent extension loader — сломается загрузка extensions если форк несовместим
- clipboard — optionalDependency, низкий риск
