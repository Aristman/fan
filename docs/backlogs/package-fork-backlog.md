# Backlog: Fork @mariozechner/* packages

## Цель
Полностью избавиться от зависимости от `@mariozechner/*` scope. Переиздать под `@itone/*`.

## Пакеты

| Пакет | Текущий | Целевой | Где используется | Приоритет |
|-------|---------|---------|-----------------|-----------|
| `@mariozechner/jiti` | `^2.6.5` | `@itone/jiti` | coding-agent (extension loader), root devDeps | P1 |
| `@mariozechner/mini-lit` | (в fan-web-ui) | `@itone/mini-lit` | web-ui | P2 |
| `@mariozechner/clipboard` | `^0.3.2` | `@itone/clipboard` | coding-agent (optionalDep) | P2 |

## Что нужно сделать

1. Форкнуть репозитории на GitHub (account: itone)
2. Переименовать package name в каждом форке (`@itone/jiti` и т.д.)
3. Опубликовать в npm (или использовать GitHub Packages / git+ssh dependency)
4. Заменить все `@mariozechner/jiti` → `@itone/jiti` (и остальных) в исходниках
5. Обновить package.json, package-lock.json, overrides если есть
6. Пересобрать и протестировать

## Зависимости

- Нужно убедиться что jiti не имеет внутренних ссылок на `@mariozechner/*`
- mini-lit может иметь свою цепочку зависимостей

## Риски

- jiti активно используется в coding-agent extension loader — сломается загрузка extensions если форк несовместим
- clipboard — optionalDependency, низкий риск
