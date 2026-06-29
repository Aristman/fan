# Документация проекта FAN

```ascii
  ______ _____ _   _ 
 |  ____|  ___| \ | |
 | |__  | |_  |  \| |
 |  __| |  _| | . ` |
 | |____| |___| |\  |
 |______|_____|_| \_|
```

## Разделы

| Раздел | Описание |
|--------|----------|
| [`docs/store/README.md`](./store/README.md) | **FAN Store** — пакетный менеджер расширений, скилов и тем. Клиентская часть (`packages/store/`), серверная часть (`tools/fan-store-server/`), репозиторий на VPS. |
| [`docs/extensions/README.md`](./extensions/README.md) | **Расширения** — 9 установленных расширений в `extensions/`: оркестратор, память, веб-поиск, душа, диалоги, Confluence, loop, SOFA, голос. Инфраструктура загрузки и lifecycle. |
| [`docs/skills/README.md`](./skills/README.md) | **Скилы** — 12 предустановленных скилов в `skills/`: автотесты, баг-фикс, code-research, deep-dive, dev-docs-pack, fan-forge, idea-lab, feature-pipeline, feature-roadmap, repo-explorer, research-spec-generator, SOFA-скил. |

## Быстрая навигация

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — архитектура проекта
- [`INSTALL.md`](../INSTALL.md) — установка
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — как контрибьютить
- [`CHANGELOG.md`](../CHANGELOG.md) — история изменений

## Структура проекта (Store, Extensions, Skills)

```
fan/
├── packages/
│   ├── store/                    ← FAN Store Extension (@fan/store, fan-store)
│   │   ├── src/                  ─ исходники (extension, tools, command, browser)
│   │   ├── package.json          ─ манифест
│   │   └── CHANGELOG.md          ─ история версий
│   └── coding-agent/
│       ├── src/core/extensions/  ─ инфраструктура загрузки расширений
│       └── src/core/skills.ts    ─ движок загрузки скилов
│
├── extensions/                   ← 9 расширений (исходники)
│   ├── fan-orchestrator/         ─ мульти-агентный оркестратор v6.0.0
│   ├── fan-persistent-memory/    ─ гибридная RAG-память v4.0.0
│   ├── fan-web-search/           ─ веб-поиск с fallback v1.7.0
│   ├── fan-soul/                 ─ личность/профиль агента v1.0.0
│   ├── fan-ask-answer/           ─ интерактивные диалоги v1.1.0
│   ├── fan-confluence/           ─ Confluence интеграция v2.0.0
│   ├── fan-loop/                 ─ итеративный цикл v1.0.0
│   ├── stack-overflow-agents/    ─ SOFA (гибрид: extension + skill) v1.1.0
│   └── voice-ollama-tui/         ─ голосовой ввод v2.4.0
│
├── skills/                       ← 12 предустановленных скилов
│   ├── auto-tests/               ─ генерация тестов (8 языков)
│   ├── bug-fix/                  ─ исправление багов
│   ├── code-research/            ─ read-only анализ кода
│   ├── deep-dive/                ─ углублённое исследование
│   ├── dev-docs-pack/            ─ пакет документации
│   ├── fan-forge/                ─ фабрика расширений/скилов (шаблоны)
│   ├── feature-pipeline/         ─ TDD-пайплайн фичи
│   ├── feature-roadmap/          ─ TDD-роадмапа
│   ├── idea-lab/                 ─ исследование идей
│   ├── repo-explorer/            ─ исследование репозиториев
│   ├── research-spec-generator/  ─ спецификации по теме
│   └── stack-overflow-agents-skill/ ─ SOFA standalone skill
│
├── tools/
│   └── fan-store-server/         ← CLI серверного репозитория
│       ├── fan-store             ─ bash-скрипт управления
│       ├── GUIDE.md              ─ документация сервера
│       ├── setup-vps.sh          ─ развёртывание nginx
│       └── deploy-nginx.sh       ─ деплой конфига
│
├── docs/
│   ├── store/README.md           ─ документация FAN Store
│   ├── extensions/README.md      ─ документация расширений
│   └── skills/README.md          ─ документация скилов
│
└── README.md                     ─ корневой README
```
