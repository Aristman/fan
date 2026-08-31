/**
 * TDD RED tests for F-2.8 «Упаковка extension-пакета fan-security».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.8» (TC-F-2.8-1/2).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЗАФИКСИРОВАННЫЕ ИНСТАЛЛЕР-ЭВРИСТИКИ (по ИСХОДНИКАМ, не по докам):
 *
 * 1) Extension loader — packages/coding-agent/src/core/extensions/loader.ts:
 *    • resolveExtensionEntries(dir): package.json с fan.extensions[] (существующие
 *      пути) → эти файлы; ИНАЧЕ index.ts; ИНАЧЕ index.js; иначе null.
 *    • discoverExtensionsInDir сканирует <cwd>/.fan/extensions (project scope) и
 *      <agentDir>/extensions (= ~/.fan/agent/extensions, user scope): подкаталог
 *      с index.ts / package.json(fan) → загрузка; прямые *.ts/*.js — тоже.
 *    • loadExtensionModule: jiti.import(resolvedPath, { default: true }) →
 *      default-экспорт ОБЯЗАН быть функцией → `await factory(api)`.
 *      jiti-инстанс (Node/dev-ветка): createJiti(import.meta.url,
 *      { moduleCache: false, fsCache: true, alias: { "@seaagents/fan-coding-agent":
 *      <packages/coding-agent/index.js> } }); в Bun-бинаре — virtualModules.
 *      Тест TC-F-2.8-2 воспроизводит dev-ветку (alias на dist, при его
 *      отсутствии — на src; для index.ts alias не нужен: импорт @seaagents/
 *      fan-coding-agent type-only и стирается jiti-трансформом).
 *
 * 2) Store installer — packages/store/src/installer.ts, ArchiveInstaller.detectType
 *    (~строки 66–92) — ПОРЯДОК ПРОВЕРОК ВАЖЕН:
 *    • подкаталоги extensions/ | skills/ | themes/ → "bundle";
 *    • SKILL.md              → "skill";     ← проверяется РАНЬШЕ extension!
 *    • theme.json            → "theme";
 *    • index.ts | index.js | package.json → "extension";
 *    • иначе undefined → ошибка «Cannot determine package type».
 *    • detectName (~906): имя пакета = package.json#.name → целевой каталог
 *      ~/.fan/agent/extensions/<name> (user) | .fan/extensions/<name> (project);
 *      для skill — ~/.fan/agent/skills/<name> | .fan/skills/<name>.
 *    • Явный type-аргумент install СТАРШЕ авто-детекта: `type ?? detectType(...)`
 *      (LLM-инструмент store_install принимает type для локальных архивов).
 *
 *    ⚠ ДОКУМЕНТИРОВАННЫЙ КОНФЛИКТ ДЛЯ ДВОЙНОГО ПАКЕТА (вне скоупа фичи —
 *    продакшн-код installer'а не меняем): fan-security содержит И SKILL.md
 *    (F-2.7), И index.ts (F-2.6) → detectType вернёт "skill", т.к. SKILL.md
 *    проверяется ПЕРВЫМ. Критерий приёмки 1 roadmap («автоопределение даст
 *    extension») достижим только ЯВНЫМ типом установки (store_install
 *    type-параметр) — README (Green) обязан это описывать. Ниже тест
 *    «detectType-реплика» фиксирует фактическое поведение как исполняемую
 *    документацию (Green-фаза НЕ должна «исправлять» этот тест).
 *
 * КОНТРАКТ package.json ДЛЯ GREEN (roadmap F-2.8 + конвенции установленных
 * extension-пакетов fan-loop / fan-orchestrator / fan-confluence):
 *
 *   {
 *     "name": "fan-security",          ← БЕЗ scope (не @fan/security):
 *     "version": "0.1.0",                 installer detectName берёт pkg.name как
 *     "type": "module",                   имя пакета стора и каталог установки;
 *     "main": "index.ts",                 соседи по extensions/ и index.json стора
 *     "fan": {                            — без scope. Совпадает с SKILL.md#name.
 *       "type": "extension",
 *       "name": "fan-security"
 *     },
 *     без "dependencies" (или {})      ← пакет без внешних рантайм-зависимостей:
 *   }                                     index.ts и cli/* — только node:-билтины;
 *                                         @seaagents/fan-coding-agent — type-only;
 *                                         vitest — dev-only, резолвится из монорепо.
 *
 * Red-ожидание (roadmap): TC-F-2.8-1 — падает первым: package.json пакета нет;
 * README-тесты (б) падают следом (README.md нет). TC-F-2.8-2 УЖЕ зелёный
 * (index.ts реализован в F-2.6 — здесь он прогоняется сквозным путём реального
 * jiti-загрузчика, а не через vitest-импорт), тесты структуры (а) — зелёные
 * (файлы существуют). 131 старый тест остаётся зелёным.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(PACKAGE_ROOT, "tests");

/** Контрактный main пакета (roadmap F-2.8: «main → index.ts»). */
const ENTRY_BASENAME = "index.ts";

// ── Guard-чтение пакета (читаемая причина падения в Red) ────────────────────

/** Guard: package.json существует и парсится; иначе Error с инструкцией для Green. */
function readPackageJson() {
	const pkgPath = path.join(PACKAGE_ROOT, "package.json");
	if (!existsSync(pkgPath)) {
		throw new Error(
			"package.json не существует. Создай extensions/fan-security/package.json по контракту из шапки этого файла " +
				"(roadmap F-2.8, Red-фаза TDD): name='fan-security', version semver (0.1.0), type='module', " +
				"main='index.ts', fan={type:'extension', name:'fan-security'}, без внешних dependencies.",
		);
	}
	return JSON.parse(readFileSync(pkgPath, "utf8"));
}

/** Guard: README.md существует; иначе Error с содержательным чек-листом. */
function readReadme() {
	const readmePath = path.join(PACKAGE_ROOT, "README.md");
	if (!existsSync(readmePath)) {
		throw new Error(
			"README.md не существует. Создай extensions/fan-security/README.md (roadmap F-2.8): " +
				"установка user scope (fan store install, локальный .tar.gz-архив, явный type=extension), " +
				"использование (CLI-сканеры + /security-scan), зависимость от Этапа 1 " +
				"(agent type security в orchestrator для воркер-сценария).",
		);
	}
	return readFileSync(readmePath, "utf8");
}

// ── Mock ExtensionAPI (зеркало mockAPI из tests/index.test.mjs) ─────────────

/** Mock ExtensionAPI: все методы-регистрации — spy; factory должен пережить вызов. */
function mockAPI() {
	return {
		registerCommand: vi.fn(),
		on: vi.fn(),
		registerTool: vi.fn(),
		unregisterTool: vi.fn(),
		updateTool: vi.fn(),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerMessageRenderer: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		setSessionName: vi.fn(),
		setLabel: vi.fn(),
		setActiveTools: vi.fn(),
		setModel: vi.fn(),
		setThinkingLevel: vi.fn(),
	};
}

// ── Реальный jiti-путь загрузки (зеркало loader.ts, dev-ветка) ──────────────

const repoRoot = path.resolve(PACKAGE_ROOT, "..", "..");
const codingAgentDist = path.join(repoRoot, "packages", "coding-agent", "index.js");
const codingAgentSrc = path.join(repoRoot, "packages", "coding-agent", "src", "index.ts");

/**
 * jiti-инстанс с опциями рантайм-лоадера (loader.ts getSharedJiti):
 * moduleCache: false (изоляция расширений), fsCache: true, alias на
 * @seaagents/fan-coding-agent (dist после сборки, иначе src).
 */
function createRuntimeJiti() {
	return createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: true,
		alias: {
			"@seaagents/fan-coding-agent": existsSync(codingAgentDist) ? codingAgentDist : codingAgentSrc,
		},
	});
}

/** Абсолютный путь к entry (loader.resolvePath резолвит в абсолютный перед jiti). */
const INDEX_ABSOLUTE = path.join(PACKAGE_ROOT, ENTRY_BASENAME);

// ═════════════════════════════════════════════════════════════════════════════
// TC-F-2.8-1: package.json соответствует контракту extension
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.8-1: package.json соответствует контракту extension", () => {
	it("package.json существует и валиден как JSON", () => {
		const pkg = readPackageJson();
		expect(pkg, "package.json должен парситься как непустой JSON-объект").toBeTypeOf("object");
	});

	it("поля верхнего уровня: name='fan-security', version — sane semver, type='module', main → index.ts (файл существует)", () => {
		const pkg = readPackageJson();

		// name: без scope — installer detectName берёт pkg.name как имя пакета
		// стора и каталог установки (~/.fan/agent/extensions/<name>); конвенция
		// соседей (fan-loop, fan-orchestrator) и SKILL.md#name — без scope.
		expect(pkg.name, "name пакета (detectName installer'а)").toBe("fan-security");

		// version: sane semver (roadmap: «готовый к публикации пакет v0.1.0»)
		expect(pkg.version, "version обязан быть строкой semver").toMatch(
			/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
		);

		// type: module (ESM; конвенция fan-loop/fan-orchestrator/fan-confluence)
		expect(pkg.type, "type пакета").toBe("module");

		// main → index.ts: файл существует относительно корня пакета
		expect(pkg.main, "main обязан быть строкой").toBeTypeOf("string");
		const mainNormalized = String(pkg.main).replace(/^\.\//, "");
		expect(mainNormalized, "main должен указывать на index.ts (roadmap F-2.8)").toBe(
			ENTRY_BASENAME,
		);
		expect(
			existsSync(path.join(PACKAGE_ROOT, mainNormalized)),
			`файл из main (${pkg.main}) должен существовать`,
		).toBe(true);
	});

	it("fan-секция: {type:'extension', name:'fan-security'} (контракт installer/loader)", () => {
		const pkg = readPackageJson();

		expect(pkg.fan, "обязательна fan-секция (объект)").toBeTypeOf("object");
		expect(pkg.fan.type, "fan.type — тип ресурса стора").toBe("extension");
		expect(pkg.fan.name, "fan.name — имя пакета").toBe("fan-security");
	});

	it("без внешних production-зависимостей: dependencies отсутствует или {}", () => {
		const pkg = readPackageJson();

		const deps = pkg.dependencies ?? {};
		expect(
			Object.keys(deps),
			"пакет не должен тянуть внешние рантайм-зависимости (index.ts/cli/* — только node:-билтины; " +
				"@seaagents/fan-coding-agent — type-only; vitest — dev-only из монорепо)",
		).toEqual([]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// TC-F-2.8-2: Factory загружается без ошибок — сквозной путь реального
// рантайм-загрузчика (jiti.import({default:true}) → factory(api))
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.8-2: Factory загружается без ошибок (реальный jiti-путь loader'а)", () => {
	it("jiti.import(index.ts, {default:true}) возвращает функцию-factory (контракт loadExtensionModule)", async () => {
		const jiti = createRuntimeJiti();
		const factory = await jiti.import(INDEX_ABSOLUTE, { default: true });

		expect(
			typeof factory,
			"default-экспорт index.ts обязан быть функцией (иначе loader вернёт " +
				"«Extension does not export a valid factory function»)",
		).toBe("function");
	});

	it("factory(mockAPI) — без исключений; registerCommand ровно 1 раз: 'security-scan' + description + handler", async () => {
		const jiti = createRuntimeJiti();
		const factory = await jiti.import(INDEX_ABSOLUTE, { default: true });

		const api = mockAPI();
		// loader.ts: `await factory(api)` — factory может быть sync (await прозрачен);
		// исключение внутри factory упадёт в тест естественным образом.
		await expect(Promise.resolve(factory(api))).resolves.toBeUndefined();

		expect(api.registerCommand, "registerCommand — ровно 1 вызов").toHaveBeenCalledTimes(1);
		const [name, options] = api.registerCommand.mock.calls[0];
		expect(name).toBe("security-scan");
		expect(options).toEqual(
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// (а) Структура пакета — соответствие эвристикам installer/loader
// ═════════════════════════════════════════════════════════════════════════════

describe("(а) Структура пакета: SKILL.md → skill-эвристика, index.ts → extension-эвристика, cli/ + lib/ на месте", () => {
	it("SKILL.md присутствует (installer detectType: entries.includes('SKILL.md') → 'skill'; skill-движок F-2.7)", () => {
		expect(
			existsSync(path.join(PACKAGE_ROOT, "SKILL.md")),
			"SKILL.md — триггер skill-эвристики installer'а и источник методологии /skill:fan-security",
		).toBe(true);
	});

	it("index.ts присутствует (installer: entries.includes('index.ts') → 'extension'; loader resolveExtensionEntries fallback)", () => {
		expect(
			existsSync(INDEX_ABSOLUTE),
			"index.ts — триггер extension-эвристики installer'а и entry loader'а (index.ts → index.js)",
		).toBe(true);
	});

	it("cli/ + lib/ файлы на месте: 3 сканера + report/walker/external (состав архивa пакета)", () => {
		const required = [
			"cli/scan-secrets.ts",
			"cli/scan-patterns.ts",
			"cli/dep-audit.ts",
			"lib/report.ts",
			"lib/walker.ts",
			"lib/external.ts",
		];
		for (const rel of required) {
			expect(
				existsSync(path.join(PACKAGE_ROOT, rel)),
				`${rel} обязан входить в пакет (импортируется сканерами/factory)`,
			).toBe(true);
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// (б) README.md — установка, использование, зависимость от Этапа 1
// ═════════════════════════════════════════════════════════════════════════════

describe("(б) README.md: установка user scope, использование, зависимость от Этапа 1", () => {
	it("README.md существует", () => {
		readReadme();
	});

	it("секция установки: fan store install + локальный .tar.gz-архив (user scope)", () => {
		const readme = readReadme();

		expect(readme, "должна быть инструкция «fan store install»").toMatch(
			/fan\s+store\s+install/i,
		);
		expect(readme, "должен упоминаться локальный архив (.tar.gz)").toMatch(
			/\.tar\.gz|\.tgz/i,
		);
	});

	it("секция использования: /security-scan + три CLI-сканера", () => {
		const readme = readReadme();

		expect(readme, "должна описываться slash-команда /security-scan").toMatch(
			/\/security-scan/,
		);
		for (const cli of ["scan-secrets", "scan-patterns", "dep-audit"]) {
			expect(readme, `CLI-сканер ${cli} должен быть описан`).toContain(cli);
		}
	});

	it("зависимость от Этапа 1: agent type security в orchestrator для воркер-сценария", () => {
		const readme = readReadme();

		expect(readme, "упоминание Этапа 1").toMatch(/этап\s*1|stage\s*1/i);
		expect(readme, "упоминание orchestrator/оркестратора").toMatch(
			/orchestrator|оркестратор/i,
		);
		expect(readme, "упоминание agent type security").toMatch(/security/i);
		expect(readme, "упоминание воркер-сценария (worker/агент)").toMatch(
			/воркер|worker|субагент|subagent/i,
		);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// (документирующее) Реплика detectType installer'а — исполняемая фиксация
// фактических эвристик (packages/store/src/installer.ts ~66–92).
// Green-фаза НЕ должна менять эти ожидания: порядок проверок — продакшн-код
// installer'а, вне скоупа фичи security-worker.
// ═════════════════════════════════════════════════════════════════════════════

/** Дословная реплика ArchiveInstaller.detectType (по состоянию installer.ts). */
function detectTypeReplica(entries, subdirs = []) {
	if (subdirs.some((d) => d === "extensions" || d === "skills" || d === "themes")) {
		return "bundle";
	}
	if (entries.includes("SKILL.md")) return "skill";
	if (entries.includes("theme.json")) return "theme";
	if (
		entries.includes("index.ts") ||
		entries.includes("index.js") ||
		entries.includes("package.json")
	) {
		return "extension";
	}
	return undefined;
}

describe("(документирующее) detectType-эвристики installer'а (реплика по installer.ts)", () => {
	it("SKILL.md один → 'skill' (skill-эвристика)", () => {
		expect(detectTypeReplica(["SKILL.md"])).toBe("skill");
	});

	it("index.ts + package.json (без SKILL.md) → 'extension' (extension-эвристика)", () => {
		expect(detectTypeReplica(["index.ts", "package.json"])).toBe("extension");
	});

	it("фактический состав fan-security (SKILL.md + index.ts + package.json) → 'skill': SKILL.md проверяется ПЕРВЫМ; явный type установки — старше авто-детекта", () => {
		// Зафиксировано как известное поведение: двойной пакет (extension+skill)
		// авто-детектится как 'skill'. Критерий приёмки roadmap «автоопределение
		// даст extension» выполняется через явный type-аргумент store_install
		// (`type ?? detectType(...)` в installer.ts) — README обязан это описывать.
		const shippingEntries = ["SKILL.md", "index.ts", "package.json", "README.md"];
		expect(detectTypeReplica(shippingEntries)).toBe("skill");
	});
});
