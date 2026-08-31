/**
 * Data-driven таблица CWE-сигнатур кода (F-2.3).
 *
 * Единственный источник правил для cli/scan-patterns.ts (спека §4.4: расширение
 * без изменения логики сканера — добавление новой сигнатуры = запись в
 * CWE_PATTERNS: name, regex, cwe, severity, title, description, remediation).
 *
 * Построчное исполнение таблицы: каждое совпадение regex в строке файла
 * становится finding'ом, ЕСЛИ строка проходит контекстную проверку
 * (см. {@link CwePattern.contextRegex}). Контекстная чувствительность нужна
 * для CWE-338: Math.random() флагуется только при security-словах
 * (token/secret/password/…) на строке; кубик/тест-данные — не finding.
 *
 * Вторичная проверка confidence (verify F-2.3 №1): finding создаётся при любом
 * совпадении regex, но confidence зависит от {@link CwePattern.confidenceContextRegex}.
 * Нужно для CWE-89: SELECT/UPDATE/DELETE — английские слова в UI-строках, логах
 * и комментариях («Delete session? ${…}»); SQL подтверждается словами
 * FROM|WHERE|INTO|SET|TABLE|JOIN той же строки (SQL_CONTEXT_REGEX) — с ними
 * confidence записи (confirmed), без — fallbackConfidence (needs-verification).
 * Резолвер — {@link resolvePatternConfidence}.
 *
 * Пары «уязвимая строка → безопасный аналог» покрыты так (§4):
 * - CWE-89  — параметризованный запрос («?», параметры массивом) без «+»/«${…}» не матчится;
 * - CWE-78  — execFile с массивом аргументов не матчится (требуется exec/execSync/system
 *             и сразу «(» — «execFile(» не проходит `\s*\(`);
 * - CWE-22  — negative lookahead на normalize( внутри вызова path.join/resolve;
 * - CWE-79  — только .innerHTML/.outerHTML присваивание идентификатора; .textContent не матчится;
 * - CWE-327 — только md5/sha1; sha256/sha512 не матчатся (альтернатива точная);
 * - CWE-338 — контекстный regex из SECURITY_CONTEXT_WORDS;
 * - CWE-329 — IV обязан быть строковым литералом (или Buffer.from(<литерал>));
 *             переменная/randomBytes не матчится.
 *
 * Evidence — совпавший фрагмент (match[0]), обрезанный до MAX_CWE_EVIDENCE_LENGTH.
 * Маскирование секретов здесь не применяется (секреты — зона scan-secrets F-2.2):
 * в CWE-цитатах кода литеральных секретов нет.
 *
 * Без внешних зависимостей; типы Severity/Confidence — из lib/report.ts (F-2.1).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4, §4.4, §6.1.
 */

import type { Confidence, Severity } from "../report.ts";

/** Описание одного правила поиска CWE-сигнатуры (data-driven запись §4.4). */
export interface CwePattern {
	/** Имя правила (диагностика). */
	name: string;
	/** CWE-идентификатор, напр. "CWE-89". */
	cwe: string;
	/** Построчный regex (флаг g обязателен для matchAll). */
	regex: RegExp;
	/**
	 * Контекстная чувствительность: строка должна ДОПОЛНИТЕЛЬНО совпасть с
	 * contextRegex, чтобы совпадение regex стало finding'ом. Не задан —
	 * совпадение regex само по себе достаточно. Regex БЕЗ флага g (проверка
	 * всей строки, stateless .test()).
	 */
	contextRegex?: RegExp;
	/**
	 * Вторичная контекстная проверка, влияющая ТОЛЬКО на confidence (verify
	 * F-2.3 №1): finding создаётся при любом совпадении regex, но confidence —
	 * confidence записи при совпадении этого regex со строкой и
	 * fallbackConfidence — при несовпадении. Не задан — всегда confidence.
	 * Regex БЕЗ флага g (stateless .test()).
	 */
	confidenceContextRegex?: RegExp;
	/** Confidence при несовпадении confidenceContextRegex (напр. "needs-verification"). */
	fallbackConfidence?: Confidence;
	severity: Severity;
	title: string;
	description: string;
	exploit: string;
	remediation: string;
	/** Подтверждённость находки: прямая сигнатура — confirmed, эвристика — needs-verification. */
	confidence: Confidence;
}

/** Предел длины evidence (§6.1: цитата совпавшего фрагмента, «≤ 300 символов»). */
export const MAX_CWE_EVIDENCE_LENGTH = 300;

/**
 * Security-слова для контекста CWE-338 (§4): имя переменной на строке должно
 * содержать одно из них (подстрока, без границ слова — «sessionToken» содержит
 * и «session», и «token»).
 */
export const SECURITY_CONTEXT_WORDS = "token|secret|password|nonce|session|csrf|otp|salt|key";

/** Regex контекстной проверки CWE-338, собранный из SECURITY_CONTEXT_WORDS. */
const SECURITY_CONTEXT_REGEX = new RegExp(`(?:${SECURITY_CONTEXT_WORDS})`, "i");

/**
 * SQL-контекстные слова для CWE-89 (verify F-2.3 №1): SQL-ключевое слово первой
 * части regex (SELECT/UPDATE/…) — обычное английское слово в UI-текстах, логах
 * и комментариях, поэтому SQL подтверждается словами FROM|WHERE|INTO|SET|TABLE|JOIN
 * в той же строке (case-insensitive, whole-word).
 */
export const SQL_CONTEXT_WORDS = "FROM|WHERE|INTO|SET|TABLE|JOIN";

/** Regex SQL-контекста CWE-89, собранный из SQL_CONTEXT_WORDS. */
export const SQL_CONTEXT_REGEX = new RegExp(`\\b(?:${SQL_CONTEXT_WORDS})\\b`, "i");

/**
 * Confidence находки с учётом вторичной контекстной проверки (§4.4, verify
 * F-2.3 №1). Без confidenceContextRegex у паттерна — confidence записи; при
 * наличии — confidence записи, если строка матчит confidenceContextRegex,
 * иначе fallbackConfidence (сам finding НЕ отбрасывается — понижается только
 * уверенность, severity не меняется).
 */
export function resolvePatternConfidence(line: string, pattern: CwePattern): Confidence {
	if (!pattern.confidenceContextRegex) {
		return pattern.confidence;
	}
	return pattern.confidenceContextRegex.test(line)
		? pattern.confidence
		: (pattern.fallbackConfidence ?? pattern.confidence);
}

/**
 * Таблица CWE-сигнатур — единственное место расширения правил сканера (§4.4).
 * Порядок записей определяет порядок findings в отчёте (после сортировки файлов).
 */
export const CWE_PATTERNS: CwePattern[] = [
	{
		name: "sql-injection-concat",
		cwe: "CWE-89",
		// SQL-ключевое слово и далее по строке конкатенация «+ переменная» или «${…}».
		// Параметризованный запрос («?», параметры массивом) конкатенации не содержит.
		regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*?(?:\+\s*[A-Za-z_$][A-Za-z0-9_$]*|\$\{)/gi,
		// Verify F-2.3 №1: SELECT/UPDATE/DELETE — английские слова в UI-строках,
		// логах и комментариях («Delete session? ${…}» — FP). SQL подтверждаем
		// контекстными словами той же строки; без них finding остаётся (severity
		// HIGH), но confidence понижается до needs-verification.
		confidenceContextRegex: SQL_CONTEXT_REGEX,
		fallbackConfidence: "needs-verification",
		severity: "HIGH",
		title: "SQL-запрос склеивается из пользовательского ввода (SQL injection)",
		description: "SQL-строка (SELECT/INSERT/UPDATE/DELETE) собирается конкатенацией или интерполяцией переменной.",
		exploit: "Внедрение SQL через ввод: обход авторизации, чтение/изменение/удаление произвольных данных БД.",
		remediation: "Использовать параметризованные запросы (placeholder «?», параметры массивом) или query-builder/ORM.",
		confidence: "confirmed",
	},
	{
		name: "command-injection",
		cwe: "CWE-78",
		// exec/execSync/system, где внутри вызова есть «${…}» или конкатенация
		// «+ переменная». execFile с массивом аргументов не матчится: после имени
		// функции требуется сразу «(», а «execFile(» не проходит \s*\( после «exec».
		regex: /\b(?:execSync|exec|system)\s*\([^)\n]*(?:\$\{|\+\s*[A-Za-z_$][A-Za-z0-9_$]*)/gi,
		severity: "CRITICAL",
		title: "Команда собирается из пользовательского ввода (command injection)",
		description: "exec/execSync/system получает шаблон «${…}» или склеенную строку — команда строится из ввода.",
		exploit: "Внедрение произвольных команд оболочки через ввод: RCE на хосте от имени процесса.",
		remediation: "Использовать execFile/spawn с массивом аргументов без оболочки; не собирать команду строкой.",
		confidence: "confirmed",
	},
	{
		name: "path-traversal",
		cwe: "CWE-22",
		// path.join/path.resolve с пользовательским вводом БЕЗ нормализации:
		// negative lookahead отсекает вызовы, где внутри есть normalize(.
		regex:
			/\bpath\.(?:join|resolve)\s*\((?![^)\n]*\bnormalize\s*\()[^)\n]*\b(?:userInput|req\.(?:params|query|body|cookies)|request\.(?:params|query|body|cookies)|params\.[A-Za-z_$][A-Za-z0-9_$]*|query\.[A-Za-z_$][A-Za-z0-9_$]*)/gi,
		severity: "HIGH",
		title: "Путь собирается из пользовательского ввода без нормализации (path traversal)",
		description: "path.join/path.resolve принимает пользовательский ввод (userInput, req.params/query-подобные) без path.normalize.",
		exploit: "«../» во вводе выводит за пределы базовой директории: чтение/перезапись произвольных файлов.",
		remediation: "Нормализовать ввод (path.normalize) и проверять, что итоговый путь остался внутри базовой директории.",
		confidence: "confirmed",
	},
	{
		name: "xss-innerhtml",
		cwe: "CWE-79",
		// Присваивание идентификатора в .innerHTML/.outerHTML; .textContent не матчится.
		regex: /\.(?:innerHTML|outerHTML)\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*/gi,
		severity: "MEDIUM",
		title: "Присваивание переменной в .innerHTML (XSS)",
		description: "Переменная присваивается в .innerHTML/.outerHTML — ввод попадает в разметку страницы без экранирования.",
		exploit: "Внедрение скрипта/разметки через ввод: кража сессии, действия от имени пользователя (XSS).",
		remediation: "Использовать .textContent/createTextNode или санитизацию (DOMPurify) перед вставкой разметки.",
		confidence: "confirmed",
	},
	{
		name: "weak-hash-md5-sha1",
		cwe: "CWE-327",
		// createHash("md5"/"sha1") или прямые вызовы md5()/sha1(); sha256/sha512
		// не матчатся (альтернатива точная: «sha256» ≠ «sha1»).
		regex: /\b(?:createHash\s*\(\s*["'`](?:md5|sha1)["'`]|(?:md5|sha1)\s*\([^)\n]*\))/gi,
		severity: "MEDIUM",
		title: "Слабый алгоритм хэширования (md5/sha1)",
		description: "Используется createHash(\"md5\"/\"sha1\") или прямые md5()/sha1() — алгоритмы считаются устаревшими.",
		exploit: "Коллизии/быстрый перебор: подделка подписей, подбор паролей по хэшам.",
		remediation: "Перейти на SHA-256/SHA-512 (createHash) или argon2/bcrypt/scrypt для паролей.",
		confidence: "confirmed",
	},
	{
		name: "weak-randomness-security-context",
		cwe: "CWE-338",
		// Math.random() сам по себе — не finding; нужна security-контекстная
		// проверка строки (contextRegex ниже): рядом token/secret/password/….
		regex: /\bMath\.random\s*\(\s*\)/g,
		contextRegex: SECURITY_CONTEXT_REGEX,
		severity: "MEDIUM",
		title: "Math.random() для security-значения (weak randomness)",
		description: "Math.random() используется на строке с security-именем (token/secret/password/nonce/session/csrf/otp/salt/key) — предсказуемый источник случайности.",
		exploit: "Предсказание/перебор «случайных» токенов и ключей: захват сессии, обход OTP/CSRF.",
		remediation: "Использовать криптостойкий источник: node:crypto randomBytes/randomUUID (или Web Crypto getRandomValues).",
		confidence: "needs-verification",
	},
	{
		name: "hardcoded-cipher-iv",
		cwe: "CWE-329",
		// createCipheriv/createDecipheriv, где третий аргумент (IV) — строковый
		// литерал или Buffer.from(<литерал>). IV из randomBytes/переменной не матчится.
		regex:
			/\bcreate(?:De)?Cipheriv\s*\(\s*["'`][^"'`\n]*["'`]\s*,\s*[^,()\n]+,\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|Buffer\.from\s*\(\s*["'`][^"'`\n]*["'`]\s*\))/gi,
		severity: "HIGH",
		title: "Фиксированный IV/nonce в шифровании (hardcoded IV)",
		description: "createCipheriv/createDecipheriv получает IV строковым литералом (или Buffer.from литерала) — вектор повторяется между сообщениями.",
		exploit: "Повторный IV при одном ключе вскрывает отношения открытых текстов (CBC/CTR-атаки, XOR-восстановление).",
		remediation: "Генерировать IV случайно на каждое сообщение (randomBytes(16)) и передавать вместе с шифротекстом.",
		confidence: "confirmed",
	},
];
