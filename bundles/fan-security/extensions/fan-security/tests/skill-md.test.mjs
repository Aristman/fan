/**
 * TDD RED tests for F-2.7 «SKILL.md методология fan-security».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.7» (TC-F-2.7-1/2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md (методология аудита для
 *       обычных сессий), правила skill-движка — packages/coding-agent/src/core/skills.ts.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза) —
 * bundles/fan-security/skills/fan-security/SKILL.md (перенесён из корня
 * extension при реструктуризации в bundle):
 *
 *   1) Frontmatter (YAML, «---»-ограничители, парсится parseFrontmatter ядра):
 *      - name: fan-security — по правилам движка (skills.ts:validateName):
 *          совпадает с именем родительской директории пакета; /^[a-z0-9-]+$/;
 *          длина ≤ 64; не начинается/не заканчивается дефисом; без «--» подряд;
 *      - description: непустой (не только пробелы), длина ≤ 1024 символов
 *          (skills.ts:validateDescription / MAX_DESCRIPTION_LENGTH);
 *          рекомендация: сценарий авто-инвокации («используй, когда…»),
 *          как у skills в ~/.fan/agent/skills/<name>/SKILL.md.
 *
 *   2) Body (после frontmatter) — методология аудита безопасности для обычных
 *      сессий. 7 обязательных маркеров (все проверки case-insensitive,
 *      multi-condition):
 *        M1 OWASP/CWE-чеклист кода:        «OWASP» + «CWE» + «чеклист|checklist»;
 *        M2 secret scanning:               «секрет|secret» + «сканир|scan»;
 *        M3 dependency audit:              «dependenc|зависимост» + «audit|аудит»;
 *        M4 IaC:                           «IaC|infrastructure as code|инфраструктура»
 *                                          + «Dockerfile|compose|k8s|kubernetes»;
 *        M5 configuration audit:           «audit|аудит» + «config|конфигур»
 *                                          + каждый из «CORS», «CSP», «debug», «TLS»;
 *        M6 формат отчёта с severity:      «формат|format» + «отчёт|report»
 *                                          + ВСЕ уровни из lib/report.ts SEVERITIES
 *                                          (CRITICAL, HIGH, MEDIUM, LOW, INFO);
 *        M7 маскирование секретов (4+4):   «маскир|mask» + «4+4|4…4|первые 4|first 4»
 *                                          (семантика maskSecret: первые 4 + хвост ≤ 4).
 *
 *   3) Ссылки на CLI-сканеры пакета — ТОЛЬКО относительные пути от директории
 *      skill (движок резолвит их от SKILL.md, см. formatSkillsForPrompt):
 *          cli/scan-secrets.ts, cli/scan-patterns.ts, cli/dep-audit.ts.
 *      Абсолютные пути запрещены (drive-буквы «C:\», «/home/», «/Users/» и т.п.).
 *
 * РЕШЕНИЕ ПО ВАЛИДАЦИИ: тесты переиспользуют РЕАЛЬНЫЙ skill-движок —
 * loadSkillsFromDir из packages/coding-agent/src/core/skills.ts (загрузка skill из
 * временной директории fan-security — копия тестируемого SKILL.md; правила
 * name/description применяются самим движком, ожидаем 0 diagnostics) и
 * parseFrontmatter из packages/coding-agent/src/utils/frontmatter.ts (тот же
 * парсер, что в движке). SEVERITIES реиспользованы из lib/report.ts (F-2.1).
 *
 * Red-ожидание (roadmap): «TC-F-2.7-1 — падает первым: SKILL.md отсутствует».
 * Guard-паттерн (как в scan-patterns.test.mjs): каждый тест падает с читаемой
 * причиной «SKILL.md не существует — …», а не с сырым ENOENT. Сам тест-файл
 * SKILL.md НЕ создаёт — это работа Green-воркера.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Реальный парсер frontmatter ядра (тот же, что использует skill-движок)
// (coding-agent живёт в packages/ монорепо — 5 уровней вверх от tests/)
import { parseFrontmatter } from "../../../../../packages/coding-agent/src/utils/frontmatter.ts";
// Реальный загрузчик skills (правила validateName/validateDescription применяет сам движок)
import { loadSkillsFromDir } from "../../../../../packages/coding-agent/src/core/skills.ts";
// Enum severity из схемы отчёта F-2.1 (уже существует, COMPLETED)
import { SEVERITIES } from "../lib/report.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(testsDir, "..");
// Skill переехал в skill-компонент бандла (реструктуризация F-2.8 → bundle):
// <repo>/bundles/fan-security/skills/fan-security/SKILL.md
// (от tests/: 4 уровня вверх → bundles/, затем fan-security/skills/fan-security/)
const SKILL_PATH = path.resolve(
	testsDir, "..", "..", "..", "..", "fan-security", "skills", "fan-security", "SKILL.md",
);
const SKILL_DIR_NAME = path.basename(path.dirname(SKILL_PATH)); // "fan-security" — ожидаемое name
const REL_SKILL_PATH = "bundles/fan-security/skills/fan-security/SKILL.md";

/** Лимиты и правила — копия констант skills.ts (для читаемых сообщений вне движка). */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Guard: чтение SKILL.md с читаемой причиной падения (Red: файла нет).
 * Каждый тест вызывает skillDoc() → guard срабатывает вместо сырого ENOENT.
 */
function readSkillRaw() {
	if (!existsSync(SKILL_PATH)) {
		throw new Error(
			`${REL_SKILL_PATH} не существует — создай bundles/fan-security/skills/fan-security/SKILL.md по контракту из шапки этого файла ` +
				`(roadmap F-2.7 + реструктуризация в bundle): frontmatter (name: ${SKILL_DIR_NAME}, description ≤ ${MAX_DESCRIPTION_LENGTH}) ` +
				`+ методология аудита (7 маркеров: OWASP/CWE, secret scanning, dependency audit, IaC, config audit, ` +
				`формат отчёта с severity, маскирование 4+4) + относительные ссылки на ` +
				`cli/scan-secrets.ts, cli/scan-patterns.ts, cli/dep-audit.ts ` +
				`+ абзац в начале: сканеры — в корне установленного расширения fan-security ` +
				`(обычно ~/.fan/agent/extensions/fan-security/), команды выполняются оттуда.`,
		);
	}
	return readFileSync(SKILL_PATH, "utf8");
}

/** Разобранный SKILL.md (кэш): { raw, frontmatter, body }. */
let skillDocCache;
function skillDoc() {
	if (!skillDocCache) {
		const raw = readSkillRaw();
		const { frontmatter, body } = parseFrontmatter(raw);
		skillDocCache = { raw, frontmatter, body };
	}
	return skillDocCache;
}

/**
 * Мультиусловия 7 обязательных маркеров методологии (см. контракт в шапке).
 * Каждое условие — (body) => boolean; маркер засчитан, когда все условия true.
 */
const METHOD_MARKERS = [
	{
		id: "M1",
		label: "OWASP/CWE-чеклист кода",
		conditions: [/owasp/i, /cwe/i, /чек-?лист|checklist|check-?list/i],
	},
	{
		id: "M2",
		label: "secret scanning",
		conditions: [/(секрет|secret)/i, /(сканир|scan)/i],
	},
	{
		id: "M3",
		label: "dependency audit",
		conditions: [/(dependenc|зависимост)/i, /(audit|аудит)/i],
	},
	{
		id: "M4",
		label: "IaC (Dockerfile/compose/k8s)",
		conditions: [/\biac\b|infrastructure[- ]as[- ]code|инфраструктур/i, /dockerfile|compose|k8s|kubernetes/i],
	},
	{
		id: "M5",
		label: "configuration audit (CORS/CSP/debug/TLS)",
		conditions: [/(audit|аудит)/i, /(config|конфигур)/i, /\bcors\b/, /\bcsp\b/, /\bdebug\b/, /\btls\b/i],
	},
	{
		id: "M6",
		label: "формат отчёта с severity CRITICAL..INFO",
		conditions: [
			/(формат|format)/i,
			/(отч[её]т|report)/i,
			...SEVERITIES.map((s) => new RegExp(`\\b${s}\\b`, "i")),
		],
	},
	{
		id: "M7",
		label: "маскирование секретов (4+4)",
		conditions: [/(маскир|mask)/i, /(4\s*\+\s*4)|(4\s*…\s*4)|(4\s*\.\.\.\s*4)|(первые\s*4)|(first\s*4)/i],
	},
];

/** Относительные ссылки на CLI-сканеры, обязательные в body (контракт §3). */
const REQUIRED_CLI_REFS = ["cli/scan-secrets.ts", "cli/scan-patterns.ts", "cli/dep-audit.ts"];

/** Абсолютные пути в body запрещены: drive-буквы и POSIX-абсолютные префиксы. */
const ABSOLUTE_PATH_PATTERNS = [
	/[A-Za-z]:[/\\]/,
	/\/(home|Users|root)\//,
];

/** Дубликат правил skills.ts:validateName — только для читаемого списка ошибок (движок проверяет сам). */
function describeNameIssues(name) {
	const issues = [];
	if (name !== SKILL_DIR_NAME) {
		issues.push(`name "${name}" не совпадает с именем директории пакета "${SKILL_DIR_NAME}"`);
	}
	if (name.length > MAX_NAME_LENGTH) {
		issues.push(`name длиннее ${MAX_NAME_LENGTH} символов (${name.length})`);
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		issues.push("name содержит недопустимые символы (нужны строчные a-z, 0-9, дефисы)");
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		issues.push("name не должен начинаться/заканчиваться дефисом");
	}
	if (name.includes("--")) {
		issues.push("name не должен содержать двойные дефисы");
	}
	return issues;
}

/** Временные директории для интеграционного прогона движка (auto-cleanup в afterEach). */
const tempDirs = [];
function makeTempSkillRoot() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-skill-md-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) {
		rmSync(tempDirs.pop(), { recursive: true, force: true });
	}
});

describe(`TC-F-2.7-1: SKILL.md валиден по правилам skill-движка (${REL_SKILL_PATH})`, () => {
	it("файл SKILL.md существует в skill-компоненте бандла", () => {
		// Guard: читаемая причина вместо сырого ENOENT (Red: файла нет)
		expect(existsSync(SKILL_PATH), `${REL_SKILL_PATH} не существует — см. контракт в шапке tests/skill-md.test.mjs`).toBe(true);
	});

	it("frontmatter парсится: name и description — непустые строки", () => {
		const { frontmatter } = skillDoc();
		expect(typeof frontmatter.name, "frontmatter.name отсутствует или не строка — нужен YAML-frontmatter «---…---»").toBe("string");
		expect(frontmatter.name.length, "frontmatter.name пуст").toBeGreaterThan(0);
		expect(typeof frontmatter.description, "frontmatter.description отсутствует или не строка").toBe("string");
		expect(frontmatter.description.trim().length, "frontmatter.description пуст (только пробелы)").toBeGreaterThan(0);
	});

	it("name валиден по правилам движка (skills.ts:validateName)", () => {
		const { frontmatter } = skillDoc();
		const name = frontmatter.name;
		const issues = describeNameIssues(name);
		expect(
			issues,
			`name "${name}" нарушает правила skill-движка:\n  - ${issues.join("\n  - ")}`,
		).toEqual([]);
	});

	it(`description присутствует и ≤ ${MAX_DESCRIPTION_LENGTH} символов (skills.ts:validateDescription)`, () => {
		const { frontmatter } = skillDoc();
		const description = frontmatter.description;
		expect(
			description.trim().length,
			"description пуст — без него движок не загрузит skill (loadSkillFromFileAsync вернёт null)",
		).toBeGreaterThan(0);
		expect(
			description.length,
			`description длиннее ${MAX_DESCRIPTION_LENGTH} символов (${description.length})`,
		).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
	});

	it("реальный движок loadSkillsFromDir грузит skill без diagnostics", async () => {
		const raw = readSkillRaw();
		// Копия в одноразовую директорию <tmp>/fan-security/SKILL.md — так движок
		// видит ровно тот layout, что и в пакете (name = имя родительской директории).
		const root = makeTempSkillRoot();
		const skillDir = path.join(root, SKILL_DIR_NAME);
		mkdirSync(skillDir);
		writeFileSync(path.join(skillDir, "SKILL.md"), raw, "utf8");

		const { skills, diagnostics } = await loadSkillsFromDir({ dir: root, source: "test" });

		expect(
			diagnostics,
			`движок вернул diagnostics по SKILL.md:\n${diagnostics.map((d) => `  - [${d.type}] ${d.message}`).join("\n") || "  (пусто)"}`,
		).toEqual([]);
		expect(skills, "движок не загрузил skill (ожидается ровно 1)").toHaveLength(1);
		expect(skills[0].name, "движок загрузил skill с чужим name").toBe(SKILL_DIR_NAME);
		expect(skills[0].description, "description в загруженном skill пуст").toBeTruthy();
	});
});

describe("TC-F-2.7-2: Методология полна (7 маркеров + относительные ссылки на CLI)", () => {
	for (const marker of METHOD_MARKERS) {
		it(`маркер ${marker.id}: ${marker.label}`, () => {
			const { body } = skillDoc();
			const failed = marker.conditions.filter((re) => !re.test(body));
			expect(
				failed,
				`body ${REL_SKILL_PATH} не покрывает маркер ${marker.id} «${marker.label}» — не найдено: ` +
					`${failed.map((re) => `/${re.source}/${re.flags}`).join(", ")}. См. контракт в шапке tests/skill-md.test.mjs.`,
			).toEqual([]);
		});
	}

	it("ссылки на CLI-сканеры — относительными путями (cli/scan-*.ts, cli/dep-audit.ts)", () => {
		const { body } = skillDoc();
		for (const ref of REQUIRED_CLI_REFS) {
			expect(
				body.includes(ref),
				`body ${REL_SKILL_PATH} должен содержать относительную ссылку «${ref}» (движок резолвит пути от директории skill)`,
			).toBe(true);
		}
	});

	it("ссылки на CLI НЕ абсолютные (без drive-букв и POSIX-абсолютных префиксов)", () => {
		const { body } = skillDoc();
		const absoluteHits = ABSOLUTE_PATH_PATTERNS.filter((re) => re.test(body));
		expect(
			absoluteHits,
			`body ${REL_SKILL_PATH} содержит абсолютные пути (${absoluteHits.map((re) => `/${re.source}/`).join(", ")}) — ` +
				"используй относительные пути от директории skill, например «cli/scan-secrets.ts»",
		).toEqual([]);
	});
});
