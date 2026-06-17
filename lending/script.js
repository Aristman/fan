/**
 * FAN Landing Terminal — JavaScript
 * Fallout 3 PipBoy / ROBCO TERMLINK style interactions
 */

(function () {
    'use strict';

    // Terminal state
    const state = {
        currentSection: 'boot',
        typingCompleted: false,
        bootPlayed: false
    };

    // DOM elements
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.section');
    const copyBtns = document.querySelectorAll('.copy-btn');
    const statValues = document.querySelectorAll('.stat-value');
    const clockEl = document.getElementById('clock');
    const typingEl = document.querySelector('.typing');

    /**
     * Typewriter effect for header
     */
    function typeWriter(element, text, speed = 50) {
        let i = 0;
        element.textContent = '';

        function type() {
            if (i < text.length) {
                element.textContent += text.charAt(i);
                i++;
                setTimeout(type, speed);
            } else {
                state.typingCompleted = true;
            }
        }

        type();
    }

    /**
     * Section navigation
     */
    function showSection(sectionId) {
        navLinks.forEach(link => {
            link.classList.toggle('active', link.dataset.section === sectionId);
        });

        sections.forEach(section => {
            if (section.id === sectionId) {
                section.classList.add('active');
                section.style.animation = 'none';
                section.offsetHeight;
                section.style.animation = '';
            } else {
                section.classList.remove('active');
            }
        });

        state.currentSection = sectionId;

        if (sectionId === 'about') {
            animateStats();
        }

        // Init store menu when store section shown
        if (sectionId === 'store') {
            initStore();
        }
    }

    /**
     * Copy to clipboard
     */
    async function copyToClipboard(button) {
        const text = button.dataset.copy;
        try {
            await navigator.clipboard.writeText(text);
            const originalText = button.textContent;
            button.textContent = 'COPIED!';
            button.classList.add('copied');
            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('copied');
            }, 2000);
        } catch (err) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                const originalText = button.textContent;
                button.textContent = 'COPIED!';
                button.classList.add('copied');
                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('copied');
                }, 2000);
            } catch (e) {
                button.textContent = 'FAILED';
                setTimeout(() => {
                    button.textContent = 'COPY';
                }, 2000);
            }
            document.body.removeChild(textarea);
        }
    }

    /**
     * Animated counters for stats
     */
    function animateStats() {
        statValues.forEach(el => {
            const target = parseInt(el.dataset.count, 10);
            if (!target || el.dataset.animated) return;
            el.dataset.animated = 'true';
            let current = 0;
            const duration = 1500;
            const increment = target / (duration / 16);
            function update() {
                current += increment;
                if (current < target) {
                    el.textContent = Math.floor(current);
                    requestAnimationFrame(update);
                } else {
                    el.textContent = target + '+';
                }
            }
            update();
        });
    }

    /**
     * Clock display
     */
    function updateClock() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        clockEl.textContent = `${hours}:${minutes}:${seconds}`;
    }

    /**
     * Keyboard navigation (Tab and arrow keys)
     */
    function handleKeyboard(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const sectionIds = Array.from(navLinks).map(link => link.dataset.section);
            const currentIndex = sectionIds.indexOf(state.currentSection);
            const nextIndex = (currentIndex + 1) % sectionIds.length;
            showSection(sectionIds[nextIndex]);
        }
    }

    /**
     * Random CRT flicker effect
     */
    function randomFlicker() {
        const overlay = document.querySelector('.crt-overlay');
        if (Math.random() > 0.97) {
            overlay.style.opacity = '0.8';
            setTimeout(() => { overlay.style.opacity = ''; }, 50 + Math.random() * 100);
        }
        setTimeout(randomFlicker, 2000 + Math.random() * 4000);
    }

    /**
     * Add subtle scanline movement
     */
    function initScanlines() {
        const scanlines = document.querySelector('.scanlines');
        let position = 0;
        setInterval(() => {
            position = (position + 1) % 4;
            scanlines.style.transform = `translateY(${position}px)`;
        }, 100);
    }

    /**
     * Initialize event listeners
     */
    function initEventListeners() {
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                showSection(link.dataset.section);
            });
        });
        copyBtns.forEach(btn => {
            btn.addEventListener('click', () => copyToClipboard(btn));
        });
        document.addEventListener('keydown', handleKeyboard);
    }

    /**
     * Boot sequence enhancements
     */
    function initBootSequence() {
        const bootLines = document.querySelectorAll('.boot-line');
        const lastDelay = bootLines.length * 400 + 500;
        setTimeout(() => {
            document.querySelector('.welcome-msg').classList.add('boot-complete');
        }, lastDelay);
    }

    // ============================================================
    //  STORE DATA — все расширения и скиллы FAN Store
    // ============================================================

    const storeData = [
        // ====== EXTENSIONS ======
        {
            id: 'fan-orchestrator',
            name: 'fan-orchestrator',
            version: '5.4.1',
            type: 'extension',
            icon: '[ORC]',
            description: 'Мульти-агентная система декомпозиции и координации задач. 8 типов воркеров, loop prevention, RPC workers, динамический coordinator prompt, task pipeline, permission system.',
            details: 'Оркестратор v5.4.1: loop prevention (hard-fail no-op detection), исправленные имена тулов в prompt, 8 агентов (explore, plan, implement, verify, bug-fix, code-research, tests-impl, docs-impl). RPC-воркеры: каждый воркер запускается в отдельном процессе fan с JSONL stdin/stdout. Слот-пул: только 1 implement-воркер одновременно, остальные — до maxParallel. Permission system: обнаружение опасных команд (rm -rf, git push --force, publish). Динамический coordinator prompt: адаптируется под текущее состояние задач и конфигурацию. Task pipeline: pending → in_progress → completed/failed/blocked. Agent discovery: built-in + user (~/.fan/agent/agents/) + project (.fan/agents/).',
            tools: [
                'delegate_task — запуск одного, цепочки или параллельных воркеров',
                'list_tasks — просмотр задач с фильтрацией по статусу',
                'TaskCreate — создание задачи для отслеживания',
                'TaskUpdate — обновление статуса/описания задачи',
                'TaskClear — очистка завершённых и проваленных задач',
                'classify_task — классификация задачи для выбора типа агента',
                'cancel_task — отмена задачи по ID',
                'stop_worker — остановка работающего воркера'
            ],
            commands: [
                '/orchestrator on — включить режим координатора',
                '/orchestrator off — выключить режим координатора',
                '/orchestrator status — статус системы и активных воркеров',
                '/orchestrator config — текущая конфигурация',
                '/orchestrator init — интерактивный мастер настройки',
                '/orchestrator mode <auto|cloud|local> — переключить режим провайдера моделей',
                '/orchestrator retry — повторить последнюю проваленную задачу',
                '/orchestrator stop — остановить все активные воркеры',
                '/plan <задача> — исследовать и спланировать реализацию',
                '/tasks [статус] — доска задач с фильтрацией',
                '/agents [scope] — список доступных агентов (builtin/user/project)',
                '/delegate <агент> <задача> — быстрый запуск одного воркера'
            ],
            hotkeys: ['Alt+O — вкл/выкл режима координатора', 'Alt+T — свернуть/развернуть доску задач'],
            usage: 'Установи через fan store install fan-orchestrator. Запусти /orchestrator init для настройки моделей и воркеров. Координатор автоматически декомпозирует сложные задачи: создаёт подзадачи, назначает агентов, отслеживает прогресс, верифицирует результаты. Поддерживает deadlock-free деплой с blocks[].'
        },
        {
            id: 'fan-persistent-memory',
            name: 'fan-persistent-memory',
            version: '4.0.0',
            type: 'extension',
            icon: '[MEM]',
            description: 'Персистентная память с гибридным RAG-поиском (FTS4 + векторные эмбеддинги). Сохраняет факты, предпочтения и решения между сессиями.',
            details: 'Гибридный RAG-поиск: FTS4 полнотекстовый поиск + векторные эмбеддинги через Ollama. Две области видимости: глобальные памяти (доступны везде) и проектные (привязаны к проекту). 6 категорий: operator, preference, project, event, instruction, decision. Автоматическое извлечение фактов из диалогов каждые 5 turns. Пайплайн обслуживания: decay confidence, дедупликация, кластеризация, суммаризация, очистка. Graceful degradation — при недоступности Ollama переключается на FTS-only.',
            tools: [
                'memory_remember — сохранить новую память',
                'memory_search — поиск памятей (FTS + векторный)',
                'memory_update — обновить существующую память',
                'memory_forget — архивировать память (soft delete)',
                'memory_promote — повысить проектную память до глобальной',
                'memory_demote — понизить глобальную память до проектной'
            ],
            commands: [
                '/memory — интерактивное управление памятью (статистика, список, поиск, просмотр, архивация)',
                '/memory-maintain — ручной запуск пайплайна обслуживания'
            ],
            hotkeys: [],
            usage: 'Установи через fan store install fan-persistent-memory. Память работает автоматически. Для ручного управления используй /memory. Поиск происходит гибридно: FTS4 + векторные эмбеддинги. Привязывай памяти к проекту через scope.'
        },
        {
            id: 'fan-web-search',
            name: 'fan-web-search',
            version: '1.7.0',
            type: 'extension',
            icon: '[WEB]',
            description: 'Мульти-провайдерный веб-поиск с автоматическим fallback и чтением веб-страниц. Работает без API-ключей через встроенный Mojeek.',
            details: '5 провайдеров поиска с автоматической цепочкой fallback: Mojeek (встроенный, без ключей) → SearXNG (самостоятельный Docker) → Brave Search → Yandex Search → Z.AI MCP. Провайдеры проверяются на старте сессии, статус кэшируется на диск (5 мин TTL). Встроенный ридер конвертирует HTML в Markdown или plain text с опциональными списками ссылок и изображений.',
            tools: [
                'web_search — поиск с фильтрами recency/domain/count (1-50 результатов)',
                'web_reader — чтение и парсинг веб-страниц (markdown/text, ссылки, изображения)'
            ],
            commands: [
                '/web-search — показать справку',
                '/web-search init — интерактивный мастер настройки',
                '/web-search check — проверить все провайдеры и показать статус',
                '/web-search searxng — авто-установка SearXNG в Docker'
            ],
            hotkeys: [],
            usage: 'Работает сразу после установки — просто попроси агента найти информацию. Например: "Поищи документацию по TypeScript 5.0" или "Прочитай страницу https://example.com". Для лучшего качества настрой Brave или Yandex API.'
        },
        {
            id: 'fan-confluence',
            name: 'fan-confluence',
            version: '2.0.0',
            type: 'extension',
            icon: '[CNF]',
            description: 'Интеграция с Confluence Data Center. Чтение, поиск, создание и обновление страниц прямо из сессии агента.',
            details: '6 инструментов для полной работы с Confluence: список пространств, список страниц, чтение контента (Storage Format → Markdown), CQL-поиск, создание страниц (Markdown → Storage Format), обновление существующих. Автоматическая конвертация: заголовки h1-h6, таблицы GFM, кодовые блоки, панели info/warning/note/tip, internal links. Кэширование в памяти с авто-инвалидацией при обновлении. Ошибки на русском языке.',
            tools: [
                'confluence_list_spaces — список доступных пространств',
                'confluence_list_pages — список страниц в пространстве (с пагинацией)',
                'confluence_read_page — чтение страницы как Markdown',
                'confluence_search — поиск через CQL',
                'confluence_create_page — создание новой страницы из Markdown',
                'confluence_update_page — обновление существующей страницы'
            ],
            commands: ['/confluence — показать статус подключения и конфигурацию'],
            hotkeys: [],
            usage: 'Установи через fan store install fan-confluence. Настрой .env файл: CONFLUENCE_BASE_URL, CONFLUENCE_PAT (Personal Access Token), CONFLUENCE_SPACE_KEY. Поддерживает только Confluence Data Center / Server (не Cloud).'
        },
        {
            id: 'fan-ask-answer',
            name: 'fan-ask-answer',
            version: '1.1.0',
            type: 'extension',
            icon: '[ASK]',
            description: 'Интерактивные диалоги с пользователем через TUI и RPC. question: один вопрос со стрелками. questionnaire: серия вопросов с табами. Режим all-at-once для JSON-редактора (RPC).',
            details: 'Два инструмента для опроса пользователя. question: один вопрос со стрелками ↑↓, Enter для выбора, Esc для отмены, опция "Type something..." для свободного ввода. questionnaire: несколько вопросов с таб-навигацией (Tab/←→), каждая вкладка — отдельный вопрос, финальная вкладка Submit с сводкой. Режим mode:"all-at-once": в RPC открывается JSON-редактор со всеми вопросами сразу. Авто-детект TUI/RPC режима. В TUI: нативные TUI-компоненты со стрелками. В RPC: ctx.ui.select/input/confirm/editor. В неинтерактивном режиме: авто-выбор первого варианта.',
            tools: [
                'question — один вопрос с вариантами ответа (параметры: question, options[])',
                'questionnaire — серия вопросов с табами (параметры: questions[{id, label, prompt, options}])'
            ],
            commands: [],
            hotkeys: ['↑↓ — навигация по вариантам', 'Enter — выбор', 'Esc — отмена', 'Tab/←→ — переключение табов (questionnaire)', 'Tab/←→ — Submit вкладка для финального подтверждения'],
            usage: 'Расширение для агентов. Используется автоматически, когда агенту нужно уточнить информацию. Для одного вопроса — question. Для нескольких — questionnaire с mode:"all-at-once" (все вопросы сразу через JSON-редактор). Работает в TUI и RPC режимах.'
        },
        {
            id: 'fan-soul',
            name: 'fan-soul',
            version: '1.0.0',
            type: 'extension',
            icon: '[SL]',
            description: 'Динамическое управление личностью агента (SOUL.md) и профилем оператора (USER.md).',
            details: 'Управляет двумя файлами: SOUL.md (личность агента: имя, характер, стиль, границы) и USER.md (профиль оператора: имя, часовой пояс, контекст, предпочтения). Автоматическое извлечение фактов из диалога каждые 5 turns. Инжекция SOUL.md + USER.md в system prompt агента. Умное слияние с дедупликацией при обновлении секций. Интерактивный мастер /soul init.',
            tools: [
                'soul_update — обновление SOUL.md или USER.md (target, section, action: append/replace/remove)'
            ],
            commands: [
                '/soul init — интерактивная настройка личности и профиля',
                '/soul status — текущее состояние файлов',
                '/soul soul — предпросмотр SOUL.md',
                '/soul user — предпросмотр USER.md',
                '/soul edit — открыть редактор SOUL.md',
                '/soul drafts — список черновиков',
                '/soul migrate — миграция USER.md в секционный формат',
                '/soul reset <soul|user> — сброс к шаблону'
            ],
            hotkeys: [],
            usage: 'Установи через fan store install fan-soul. Запусти /soul init для первичной настройки. После этого агент будет знать твои предпочтения и контекст. Автообучение подстраивает профиль по ходу диалога.'
        },
        {
            id: 'fan-loop',
            name: 'fan-loop',
            version: '1.0.0',
            type: 'extension',
            icon: '[LP]',
            description: 'Автономный loop-механизм для итеративного выполнения задач до выполнения критериев приёмки.',
            details: 'Запускает итеративный цикл: выполнение задачи → верификация критериев → повтор при неудаче. Поддержка stalemate detection (3 одинаковые итерации = прерывание). Safety net: макс. 50 итераций, stall-таймер 5 мин на итерацию. Каждая итерация запускает RPC-воркер: свежий контекст, без накопления истории. Двойная проверка: сначала выполнение, затем верификация отдельным LLM-вызовом.',
            tools: [],
            commands: [
                '/loop — запустить интерактивный диалог loop',
                '/loop "задача" -c "критерии" -m 10 — командная строка',
                '/loop "описание" --criteria "..." --max-iterations 10 --model "model-name"'
            ],
            hotkeys: [],
            usage: 'Используй /loop для задач, которые нужно повторить до успеха. Например: /loop "Рефакторинг модуля auth" -c "Все тесты проходят" или /loop "Исправить баг #123" -c "Баг не воспроизводится" -m 5.'
        },

        {
            id: 'stack-overflow-agents',
            name: 'stack-overflow-agents',
            version: '1.0.1',
            type: 'extension',
            icon: '[SOF]',
            description: 'Интеграция со Stack Overflow for Agents. Поиск проверенных решений, создание постов, голосование, верификация и публикация в общий корпус знаний агентов.',
            details: 'Stack Overflow for Agents (SOFA) — платформа обмена знаниями для AI-агентов. Закрывает Ephemeral Intelligence Gap: агенты перестают изолированно переоткрывать решения. 10 инструментов: поиск (sofa_search), чтение (sofa_get_post с trust_summary и ответами), создание постов трёх типов (Question/TIL/Blueprint) с проверкой гайдлайнов, ответы (sofa_reply), голосование (sofa_vote с read-first guard), верификация (sofa_verify с отчётом о применении), теги (sofa_list_tags), лидерборд (sofa_leaderboard), гайдлайны (sofa_fetch_guidelines), удаление (sofa_delete_post). Автоматические подсказки в code-research, bug-fix, deep-dive: искать готовые решения до собственной реализации.',
            tools: [
                'sofa_search — поиск по корпусу с фильтрами query/tag/content_type/page',
                'sofa_get_post — чтение полного поста с trust_summary и всеми ответами',
                'sofa_create_post — создание Question/TIL/Blueprint (fetch guidelines first!)',
                'sofa_reply — ответ на существующий пост',
                'sofa_vote — голосование за достоверность (1/0/-1)',
                'sofa_verify — отчёт о применении гайдлайна (worked_as_written/worked_with_changes/did_not_work)',
                'sofa_list_tags — просмотр тегов корпуса',
                'sofa_leaderboard — топ агентов по репутации',
                'sofa_fetch_guidelines — правила для типа контента',
                'sofa_delete_post — удаление своего поста'
            ],
            commands: [
                '/sofa status — проверить подключение и сессию',
                '/sofa onboard — интерактивный онбординг (OAuth-like)',
                '/sofa init — инструкции по ручной настройке',
                '/sofa help — справка по всем командам',
                '/skill:sofa — загрузить инструкции по SOFA workflow'
            ],
            hotkeys: [],
            usage: 'Установи через fan store install stack-overflow-agents. Получи API-ключ на https://agents.stackoverflow.com/api/onboarding. Запусти /sofa onboard для интерактивной настройки. Workflow: 1) sofa_search → 2) sofa_get_post → 3) проверить trust → 4) применить решение → 5) sofa_vote → 6) sofa_verify → 7) sofa_create_post если нет аналога.'
        },

        // ====== SKILLS ======
        {
            id: 'auto-tests',
            name: 'auto-tests',
            version: '1.0.0',
            type: 'skill',
            icon: '[TST]',
            description: 'Автономная генерация тестов. Находит модули без покрытия, пишет тесты по конвенциям, запускает и фиксит до зелёных.',
            details: 'Поддерживает 8 языков: Kotlin, Java, TypeScript, Python, Rust, Go, C#, .NET. Два режима: автономный (скан всего проекта, поиск модулей без покрытия) и целевой (--target для конкретного модуля). Итеративно запускает тесты и фиксит ошибки до полного прохождения. Требует build/test инфраструктуру (Maven, Gradle, npm, pytest, cargo, go test, dotnet).',
            tools: [],
            commands: ['/skill:auto-tests — запустить скилл', 'Или используй из orchestrator с флагом --target'],
            hotkeys: [],
            usage: 'Скажи агенту "напиши тесты" или "добавь покрытие". Скилл сам найдёт непокрытые модули и сгенерирует тесты. Для конкретного модуля: "покрой тестами модуль auth".'
        },
        {
            id: 'bug-fix',
            name: 'bug-fix',
            version: '1.0.0',
            type: 'skill',
            icon: '[BUG]',
            description: 'Автономный агент исправления багов. Воспроизводит проблему, находит причину, чинит минимальным диффом и верифицирует.',
            details: 'Полный цикл: получить описание бага → воспроизвести (запустить сборку/тесты) → найти корневую причину (трассировка кода, проверка типов, зависимостей) → исправить минимальным изменением → верифицировать сборкой и тестами. Не рефакторит — только чинит. Проверяет что не сломал остальное.',
            tools: [],
            commands: ['/skill:bug-fix — запустить скилл', 'Или опиши баг агенту напрямую'],
            hotkeys: [],
            usage: 'Опиши баг агенту: "Исправь ошибку: при сохранении файла падает с TypeError". Скилл сам найдёт и починит. Для orchestrator: /delegate bug-fix "описание бага".'
        },
        {
            id: 'code-research',
            name: 'code-research',
            version: '1.0.0',
            type: 'skill',
            icon: '[RCH]',
            description: 'READ-ONLY глубокий анализ кодовой базы. Ищет файлы, читает код, трассирует зависимости, выдаёт структурированный ответ.',
            details: 'Получает вопрос по кодовой базе → находит релевантные файлы → читает и анализирует код → трассирует зависимости → синтезирует структурированный ответ с файлами, связями и выводами. НЕ изменяет код. Подходит для: понимания архитектуры, поиска реализации, трассировки flow, анализа зависимостей.',
            tools: ['read — чтение файлов', 'bash — поиск по коду (rg, grep, find)', 'memory_search — поиск в памяти'],
            commands: ['/skill:code-research — запустить скилл'],
            hotkeys: [],
            usage: 'Спроси агента: "Разберись как работает модуль auth", "Найди где обрабатываются ошибки", "Объясни архитектуру пайплайна".'
        },
        {
            id: 'deep-dive',
            name: 'deep-dive',
            version: '1.0.0',
            type: 'skill',
            icon: '[DIV]',
            description: 'Углублённое исследование по пунктам из отчёта repo-explorer. Для каждого пункта — отдельный отчёт.',
            details: 'Берёт отчёт repo-explorer, извлекает пункты "Следующие шаги" и для каждого проводит глубокое исследование исходного кода. Читает код, трассирует зависимости, синтезирует выводы. Каждый пункт — отдельный отчёт в той же директории docs/repo-research/.',
            tools: ['read — чтение отчётов и кода', 'bash — grep/find по коду', 'web_search — поиск документации', 'web_reader — чтение найденных страниц'],
            commands: ['/skill:deep-dive — запустить скилл'],
            hotkeys: [],
            usage: 'После того как repo-explorer создал отчёт, используй deep-dive для углублённого анализа конкретных аспектов репозитория.'
        },
        {
            id: 'fan-forge',
            name: 'fan-forge',
            version: '1.0.0',
            type: 'skill',
            icon: '[FRG]',
            description: 'Фабрика расширений и скиллов для FAN. 7-фазный pipeline от идеи до готового артефакта.',
            details: 'Полный цикл создания fan-артефактов: постановка → исследование/спецификация → план → проектирование → тестирование (5 уровней) → документация → деплой. Создаёт extensions (.ts с lifecycle hooks) и skills (SKILL.md с метаданными). Учитывает совместимость, конвенции FAN, структуру файлов.',
            tools: ['read, write, edit, bash — создание файлов', 'question, questionnaire — интервью с пользователем'],
            commands: ['/skill:fan-forge — запустить скилл'],
            hotkeys: [],
            usage: 'Опиши свою идею: "Создай расширение для работы с GitLab" или "Сделай скилл для автоматического форматирования кода". Скилл сам проведёт через все 7 фаз.'
        },
        {
            id: 'idea-lab',
            name: 'idea-lab',
            version: '1.0.0',
            type: 'skill',
            icon: '[IDEA]',
            description: 'Исследователь идей. Определяет тип, проводит SWOT-анализ, веб-исследование, брейншторм и формирует план действий.',
            details: 'Обрабатывает идеи трёх типов: technical (фичи, архитектура), business (стартапы, рынки), creative (контент, дизайн). Процесс: определение типа → оценка неопределённости → интервью → веб-исследование → SWOT-анализ → брейншторм альтернатив → финальный документ с выводами и планом. Результат сохраняется в docs/research/idea-lab/.',
            tools: ['question, questionnaire — опрос пользователя', 'web_search, web_reader — исследование рынка/технологий'],
            commands: ['/skill:idea-lab — запустить скилл'],
            hotkeys: [],
            usage: 'Поделись идеей: "У меня есть идея стартапа для AI-тестирования", "Хочу сделать новый формат заметок". Скилл проведёт структурированный анализ.'
        },
        {
            id: 'repo-explorer',
            name: 'repo-explorer',
            version: '1.0.0',
            type: 'skill',
            icon: '[REPO]',
            description: 'Исследователь Git-репозиториев. Составляет схему, определяет технологии, выявляет модули, генерирует отчёт.',
            details: 'Исследует GitHub и локальные репозитории. Составляет схему структуры проекта, определяет технологии и стек, выявляет ключевые модули, извлекает символы (AST для поддерживаемых языков), определяет зависимости между модулями. Генерирует полный отчёт в docs/repo-research/ с выводами и "Следующими шагами" для deep-dive.',
            tools: ['bash — git clone/log/diff', 'read — чтение кода', 'memory_search — поиск в памяти'],
            commands: ['/skill:repo-explorer — запустить скилл'],
            hotkeys: [],
            usage: 'Дай ссылку на GitHub репозиторий: "Изучи https://github.com/user/repo" или "Разберись в текущем проекте". Получишь структурированный отчёт.'
        },
        {
            id: 'research-spec-generator',
            name: 'research-spec-generator',
            version: '1.0.0',
            type: 'skill',
            icon: '[SPEC]',
            description: 'Исследует тему, задаёт уточняющие вопросы и создаёт файл спецификации в docs/specs/.',
            details: 'Цикл: исследование темы из множества источников → анализ → интервью с уточняющими вопросами → повторное исследование (если нужно) → создание спецификации. Результат: docs/specs/<topic>.md с полным описанием, требованиями, архитектурой и рекомендациями. Подходит для подготовки ТЗ, изучения технологий, документирования идей.',
            tools: ['web_search, web_reader — исследование', 'question, questionnaire — уточняющие вопросы', 'read, write — создание спецификации'],
            commands: ['/skill:research-spec-generator — запустить скилл'],
            hotkeys: [],
            usage: 'Скажи: "Исследуй Bun vs Node.js для микросервисов", "Подготовь спецификацию для системы логирования". Скилл проведёт полное исследование.'
        },
        {
            id: 'dev-docs-pack',
            name: 'dev-docs-pack',
            version: '1.3.0',
            type: 'skill',
            icon: '[DOC]',
            description: 'Генератор полного пакета разработки: roadmap, диаграммы, UI/UX, API, тестирование, релиз.',
            details: 'Принимает спецификацию фичи, оценивает полноту, проводит интервью для заполнения пробелов, генерирует: roadmap с этапами, блочные диаграммы (ASCII), TDD-roadmap на каждый этап, UI/UX-документы, API-документы, стратегию тестирования, план релиза. Результат: docs/features/<feature>/.',
            tools: ['read, write, bash — создание документов', 'question, questionnaire — интервью'],
            commands: ['/skill:dev-docs-pack — запустить скилл'],
            hotkeys: [],
            usage: 'Есть спецификация фичи? Скилл создаст полный пакет документов для разработки: от roadmap до плана релиза.'
        },
        {
            id: 'feature-pipeline',
            name: 'feature-pipeline',
            version: '2.0.0',
            type: 'skill',
            icon: '[PPL]',
            description: 'Полный TDD-пайплайн разработки фичи от roadmap до готового результата.',
            details: 'Берёт roadmap из docs/features/<slug>/roadmap.md, проходит по всем этапам и функциям. Для каждой: план → реализация → верификация (цикл до чистого вердикта) → тестирование → коммит. Финальный этап: полная верификация, smoke/e2e-тесты, обновление документации, финальный коммит и отчёт.',
            tools: ['delegate_task — запуск воркеров', 'read, write, edit, bash — код'],
            commands: ['/skill:feature-pipeline — запустить скилл'],
            hotkeys: [],
            usage: 'Этот скилл — продолжение dev-docs-pack и feature-roadmap. После того как roadmap готов, запусти feature-pipeline для автоматической реализации.'
        },
        {
            id: 'feature-roadmap',
            name: 'feature-roadmap',
            version: '1.2.0',
            type: 'skill',
            icon: '[MAP]',
            description: 'Генерирует TDD-роадмапу в стиле чеклиста на основе спецификации фичи.',
            details: 'Парсит спецификацию, извлекает функции, проверяет обособленность (одна фича = один логический слой: API ИЛИ UI ИЛИ storage ИЛИ модель данных). Определяет приоритеты и зависимости, группирует по этапам (лимит 8). Для каждой функции создаёт SMART-формулировки TDD-тестов и критериев приёмки. Результат: docs/features/<slug>/roadmap.md.',
            tools: ['read, write, bash — создание roadmap', 'question, questionnaire — уточнение'],
            commands: ['/skill:feature-roadmap — запустить скилл'],
            hotkeys: [],
            usage: 'Есть спецификация фичи? Запусти feature-roadmap для создания TDD-плана. Результат — готовый roadmap.md с чеклистом.'
        }
    ];

    let storeInitialized = false;

    /**
     * Initialize Store section: render menu and content
     */
    function initStore() {
        if (storeInitialized) return;
        storeInitialized = true;

        const menuEl = document.getElementById('storeMenu');
        const contentEl = document.getElementById('storeContent');

        if (!menuEl || !contentEl) return;

        // Render menu
        renderStoreMenu(menuEl);

        // Select first item by default
        selectStoreItem(storeData[0].id);
    }

    function renderStoreMenu(menuEl) {
        const extensions = storeData.filter(d => d.type === 'extension');
        const skills = storeData.filter(d => d.type === 'skill');

        let html = '';

        // Extensions group
        html += '<div class="store-menu-group">';
        html += '<div class="store-menu-group-title">▸ EXTENSIONS</div>';
        extensions.forEach(item => {
            html += '<div class="store-menu-item" data-id="' + item.id + '">';
            html += '<span class="item-icon">' + item.icon + '</span>';
            html += '<span class="item-name">' + item.name + '</span>';
            html += '<span class="item-version">v' + item.version + '</span>';
            html += '</div>';
        });
        html += '</div>';

        // Skills group
        html += '<div class="store-menu-group">';
        html += '<div class="store-menu-group-title">▸ SKILLS</div>';
        skills.forEach(item => {
            html += '<div class="store-menu-item" data-id="' + item.id + '">';
            html += '<span class="item-icon">' + item.icon + '</span>';
            html += '<span class="item-name">' + item.name + '</span>';
            html += '<span class="item-version">v' + item.version + '</span>';
            html += '</div>';
        });
        html += '</div>';

        menuEl.innerHTML = html;

        // Click handler via delegation on the menu itself
        menuEl.addEventListener('click', function(e) {
            var target = e.target.closest('.store-menu-item');
            if (target) {
                selectStoreItem(target.dataset.id);
            }
        });
    }

    function selectStoreItem(id) {
        const item = storeData.find(d => d.id === id);
        if (!item) return;

        // Update menu active state
        document.querySelectorAll('.store-menu-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === id);
        });

        // Render detail
        renderStoreDetail(item);
    }

    function renderStoreDetail(item) {
        const contentEl = document.getElementById('storeContent');
        if (!contentEl) return;

        let toolsHtml = '';
        if (item.tools && item.tools.length > 0) {
            toolsHtml += '<div class="store-detail-section">';
            toolsHtml += '<h4>▸ Инструменты (Tools)</h4>';
            toolsHtml += '<div class="store-tool-grid">';
            item.tools.forEach(t => {
                const parts = t.split(' — ');
                const name = parts[0] || t;
                const desc = parts[1] || '';
                toolsHtml += '<div class="store-tool-item">';
                toolsHtml += '<span class="tool-name">' + name + '</span>';
                if (desc) toolsHtml += '<span class="tool-desc">' + desc + '</span>';
                toolsHtml += '</div>';
            });
            toolsHtml += '</div></div>';
        }

        let commandsHtml = '';
        if (item.commands && item.commands.length > 0) {
            commandsHtml += '<div class="store-detail-section">';
            commandsHtml += '<h4>▸ Команды (Commands)</h4>';
            item.commands.forEach(c => {
                commandsHtml += '<code class="store-cmd">' + c + '</code>';
            });
            commandsHtml += '</div>';
        }

        let hotkeysHtml = '';
        if (item.hotkeys && item.hotkeys.length > 0) {
            hotkeysHtml += '<div class="store-detail-section">';
            hotkeysHtml += '<h4>▸ Горячие клавиши</h4>';
            hotkeysHtml += '<p>';
            item.hotkeys.forEach(h => {
                const parts = h.split(' — ');
                const key = parts[0] || h;
                const desc = parts[1] || '';
                hotkeysHtml += '<span class="hotkey">' + key + '</span> ' + desc + '<br>';
            });
            hotkeysHtml += '</p></div>';
        }

        let usageHtml = '';
        if (item.usage) {
            usageHtml += '<div class="store-detail-section">';
            usageHtml += '<h4>▸ Как использовать</h4>';
            usageHtml += '<p>' + item.usage + '</p>';
            usageHtml += '</div>';
        }

        let installHtml = '';
        if (item.type === 'extension') {
            installHtml = '<div class="store-install-bar">';
            installHtml += 'УСТАНОВКА: <code>fan store install ' + item.name + '</code>';
            installHtml += '</div>';
        } else {
            installHtml = '<div class="store-install-bar">';
            installHtml += 'ЗАПУСК: <code>/skill:' + item.name + '</code> или через <code>/delegate</code>';
            installHtml += '</div>';
        }

        const html = '<div class="store-detail">' +
            '<div class="store-detail-header">' +
            '<h3>' + item.icon + ' ' + item.name + '</h3>' +
            '<span class="detail-version">v' + item.version + '</span>' +
            '<span class="detail-type">' + item.type + '</span>' +
            '</div>' +
            '<div class="store-detail-section">' +
            '<p><strong>' + item.description + '</strong></p>' +
            '</div>' +
            '<div class="store-detail-section">' +
            '<h4>▸ Описание</h4>' +
            '<p>' + item.details + '</p>' +
            '</div>' +
            toolsHtml +
            commandsHtml +
            hotkeysHtml +
            usageHtml +
            installHtml +
            '</div>';

        contentEl.innerHTML = html;
    }

    /**
     * Initialize everything
     */
    function init() {
        // Header typewriter
        if (typingEl) {
            const text = typingEl.dataset.text;
            typeWriter(typingEl, text, 40);
        }

        initEventListeners();
        initBootSequence();
        initScanlines();
        randomFlicker();

        // Clock
        updateClock();
        setInterval(updateClock, 1000);

        // Auto-animate stats if URL hash is about
        if (window.location.hash === '#about') {
            showSection('about');
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();