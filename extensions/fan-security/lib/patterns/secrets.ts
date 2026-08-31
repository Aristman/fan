/**
 * Data-driven таблица паттернов секретов (F-2.2, REFACTOR-фаза).
 *
 * Единственный источник правил для cli/scan-secrets.ts (спека §4.4: расширение
 * без изменения логики сканера — добавление нового паттерна = запись в
 * SECRET_PATTERNS: name, regex, captureGroup, severity, cwe, title, description).
 *
 * Здесь же — именованные константы entropy-эвристики (§2.3) и таблица
 * исключённых значений: undefined|null|true|false|process.env.* и пустые —
 * НЕ секреты (наблюдения verify F-2.2).
 *
 * Без внешних зависимостей; типы Severity/Confidence — из lib/report.ts (F-2.1).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §2.3, §4, §6.
 */

import type { Confidence, Severity } from "../report.ts";

/** Описание одного правила поиска секрета (data-driven запись §4.4). */
export interface SecretPattern {
	/** Имя правила (диагностика). */
	name: string;
	/**
	 * Построчный regex (флаг g обязателен для matchAll). Флаг d добавляется,
	 * когда сканеру нужны indices (см. {@link SecretPattern.bareValueConfidence}).
	 */
	regex: RegExp;
	/** Группа захвата с самим секретом (0 — всё совпадение). */
	captureGroup: number;
	severity: Severity;
	/**
	 * confidence для НЕзакавыченного (bare) значения захвата — напр. код
	 * `apiKey: resolvedApiKey` передаёт переменную, а не литерал (needs-verification).
	 * Закавыченные литералы всегда confirmed. Поле отсутствует → всегда confirmed.
	 */
	bareValueConfidence?: Confidence;
	cwe: string;
	title: string;
	description: string;
	exploit: string;
	remediation: string;
}

/** Таблица паттернов секретов — единственное место расширения правил сканера. */
export const SECRET_PATTERNS: SecretPattern[] = [
	{
		name: "aws-access-key-id",
		regex: /\bAKIA[A-Z0-9]{16}\b/g,
		captureGroup: 0,
		severity: "CRITICAL",
		cwe: "CWE-798",
		title: "AWS Access Key ID закоммичен в исходниках",
		description: "Строка формата AKIA+16 похожа на идентификатор ключа AWS, зашитый в код.",
		exploit: "Компрометация облачного аккаунта: доступ к S3/EC2/IAM от имени скомпрометированного ключа.",
		remediation: "Отозвать ключ в IAM, перевыпустить, убрать из кода и истории git; хранить в секрет-менеджере.",
	},
	{
		name: "openai-style-key",
		regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
		captureGroup: 0,
		severity: "HIGH",
		cwe: "CWE-798",
		title: "Ключ в стиле OpenAI (sk-…) закоммичен в исходниках",
		description: "Токен с префиксом sk- и телом ≥20 символов похож на API-ключ OpenAI-совместимого сервиса.",
		exploit: "Расход баланса/квот API от имени владельца ключа, доступ к моделям и данным.",
		remediation: "Отозвать ключ в консоли провайдера, перевыпустить, перенести в переменные окружения.",
	},
	{
		name: "github-pat",
		regex: /\bghp_[A-Za-z0-9]{36}\b/g,
		captureGroup: 0,
		severity: "HIGH",
		cwe: "CWE-798",
		title: "GitHub Personal Access Token (ghp_…) закоммичен в исходниках",
		description: "Токен формата ghp_+36 похож на GitHub PAT, зашитый в код.",
		exploit: "Доступ к приватным репозиториям и настройкам аккаунта GitHub от имени токена.",
		remediation: "Отозвать токен (GitHub → Settings → Developer settings), перевыпустить, использовать secret storage.",
	},
	{
		name: "slack-token",
		regex: /\bxox[bp]-[A-Za-z0-9-]{10,}/g,
		captureGroup: 0,
		severity: "HIGH",
		cwe: "CWE-798",
		title: "Slack-токен (xoxb-/xoxp-…) закоммичен в исходниках",
		description: "Токен с префиксом xoxb-/xoxp- похож на bot/user токен Slack.",
		exploit: "Чтение сообщений и отправка сообщений в workspace от имени бота/пользователя.",
		remediation: "Отозвать токен в Slack app settings, перевыпустить, перенести в переменные окружения.",
	},
	{
		name: "pem-private-key",
		regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
		captureGroup: 0,
		severity: "CRITICAL",
		cwe: "CWE-321",
		title: "Приватный ключ (PEM) закоммичен в репозиторий",
		description: "В файле найден заголовок PEM private key — приватный ключ хранится в исходниках.",
		exploit: "Полная компрометация идентичности/шифрования: подпись, расшифровка, MITM.",
		remediation: "Немедленно ротировать ключ, убрать из репозитория и истории git (filter-repo), хранить в key vault.",
	},
	{
		name: "api-key-assignment",
		// Флаг d — indices capture-группы для определения закавыченности значения.
		regex: /\bapi[_-]?key["'`]?\s*[=:]\s*["'`]?([A-Za-z0-9_\-./+=]{8,})["'`]?/gid,
		captureGroup: 1,
		severity: "HIGH",
		// Наблюдение verify F-2.2 (1): bare-идентификаторы (apiKey: resolvedApiKey)
		// — передача переменной, а не хардкод литерала → не «confirmed».
		bareValueConfidence: "needs-verification",
		cwe: "CWE-798",
		title: "Присваивание API-ключа (api_key=/apiKey=) в исходниках",
		description: "Найдено присваивание значения переменной с именем api_key/apiKey — возможный хардкод ключа.",
		exploit: "Использование украденного ключа для доступа к внешнему сервису от имени владельца.",
		remediation: "Убрать значение из кода, вынести в переменные окружения/секрет-менеджер, ротировать ключ.",
	},
];

// ── Константы entropy-эвристики (§2.3) ──────────────────────────────────────

/** Порог entropy-эвристики: минимальная длина токена (§2.3, контракт F-2.2). */
export const ENTROPY_MIN_LENGTH = 24;

/** Порог shannon-энтропии (бит/символ) для «высокоэнтропийной» строки. */
export const ENTROPY_SHANNON_THRESHOLD = 3.5;

/**
 * Минимальная длина содержимого кавычек, чтобы стать кандидатом entropy-проверки
 * (кавычки сами по себе уже сужают пространство — порог ниже «голого»).
 */
export const ENTROPY_QUOTED_MIN_LENGTH = 16;

/**
 * Минимальная длина «голого» (без кавычек) токена-кандидата: base64-тела,
 * значения в .env без кавычек. Совпадает с ENTROPY_MIN_LENGTH — без фильтра
 * на общем пороге остались бы одни кандидаты короче полезного секрета.
 */
export const ENTROPY_BARE_MIN_LENGTH = 24;

// ── Исключённые значения (наблюдение verify F-2.2 №3) ───────────────────────

/**
 * Значения-не-секреты: литералы-заглушки и доступ через окружение. Совпадение
 * целиком (якоря ^…$), регистронезависимо: `apiKey = undefined`,
 * `apiKey: process.env.FOO` и даже `process.env["X"]` (захват «process.env»)
 * не должны порождать findings.
 */
const EXCLUDED_VALUE_PATTERNS: RegExp[] = [
	/^(?:undefined|null|true|false)$/i,
	/^process\.env(?:\.[A-Za-z0-9_]+)*$/i,
];

/**
 * Значение захвата НЕ считается секретом: пустое, литерал-заглушка
 * (undefined|null|true|false) или обращение к окружению (process.env.*).
 */
export function isExcludedSecretValue(value: string): boolean {
	if (value.length === 0) {
		return true;
	}
	return EXCLUDED_VALUE_PATTERNS.some((regex) => regex.test(value));
}
