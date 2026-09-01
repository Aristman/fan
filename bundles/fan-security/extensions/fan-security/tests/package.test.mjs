/**
 * Contract tests for F-2.8 «Упаковка fan-security для FAN Store» —
 * ВЕРСИЯ БАНДЛА (реструктуризация: extension + skill = bundle v1.0.0).
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.8» (TC-F-2.8-1/2).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * РЕСТРУКТУРИЗАЦИЯ В БАНДЛ (приказ оператора: extension+skill = bundle, v1.0.0):
 *
 *   bundles/fan-security/
 *   ├── DEPLOY.toml              ← schema v1, type="bundle" (по DEPLOY-FORMAT.md)
 *   ├── package.json             ← {name, version:"1.0.0", description, license,
 *   │                               keywords[...,"bundle"]} — БЕЗ fan-секции
 *   │                               (эталон: bundles/fan-mission/package.json)
 *   ├── README.md                ← обзор бандла: состав + версии, установка одной
 *   │                               командой (авто-детект bundle — без --type)
 *   ├── extensions/fan-security/ ← extension-компонент (index.ts, cli/, lib/,
 *   │                               tests/, vitest.config.ts, package.json v1.0.0,
 *   │                               README.md; SKILL.md отсюда УДАЛЁН)
 *   └── skills/fan-security/     ← skill-компонент (SKILL.md + package.json v1.0.0)
 *
 * ЗАФИКСИРОВАННЫЕ ИНСТАЛЛЕР-ЭВРИСТИКИ (по ИСХОДНИКАМ, не по докам):
 *
 * 1) Extension loader — packages/coding-agent/src/core/extensions/loader.ts:
 *    • resolveExtensionEntries(dir): package.json с fan.extensions[] → эти файлы;
 *      ИНАЧЕ index.ts; ИНАЧЕ index.js; иначе null.
 *    • loadExtensionModule: jiti.import(resolvedPath, { default: true }) →
 *      default-экспорт ОБЯЗАН быть функцией → `await factory(api)`.
 *      Тест TC-F-2.8-2 воспроизводит dev-ветку (alias на dist, при его
 *      отсутствии — на src; для index.ts alias не нужен: импорт @seaagents/
 *      fan-coding-agent type-only и стирается jiti-трансформом).
 *
 * 2) Store installer — packages/store/src/installer.ts, ArchiveInstaller.detectType
 *    (~строки 66–92) — ПОРЯДОК ПРОВЕРОК ВАЖЕН:
 *    • подкаталоги extensions/ | skills/ | themes/ → "bundle";   ← ПЕРВЫМ!
 *    • SKILL.md              → "skill";
 *    • theme.json            → "theme";
 *    • index.ts | index.js | package.json → "extension";
 *    • иначе undefined → ошибка «Cannot determine package type».
 *    • detectName: имя пакета = package.json#.name → целевые каталоги:
 *      bundle → компоненты в ~/.fan/agent/extensions/<name> и ~/.fan/agent/skills/<name>.
 *    • Явный type-аргумент install СТАРШЕ авто-детекта, но для бандла НЕ нужен:
 *      поддиректории extensions/ + skills/ детектятся раньше SKILL.md-эвристики.
 *
 *    Реструктуризация сняла документированный конфликт двойного пакета
 *    (SKILL.md проверялся раньше extension-признаков → авто-детект давал
 *    "skill"): теперь SKILL.md живёт в skills/fan-security/ бандла, а корень
 *    extension-компонента содержит только extension-признаки. Оба факта
 *    фиксируются ниже как исполняемая документация (реплика detectType).
 *
 * КОНТРАКТ package.json (версии синхронизированы приказом оператора — 1.0.0
 * у всех трёх манифестов):
 *
 *   bundle:  bundles/fan-security/package.json      — без fan-секции
 *   ext:     bundles/fan-security/extensions/fan-security/package.json
 *            {name:"fan-security", version:"1.0.0", type:"module",
 *             main:"index.ts", fan:{type:"extension", name:"fan-security"},
 *             без "dependencies" (или {})}
 *   skill:   bundles/fan-security/skills/fan-security/package.json
 *            {name:"fan-security", version:"1.0.0", type:"module"}
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

/** Корень extension-компонента (здесь лежит этот tests/). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Корень бандла: bundles/fan-security. */
const BUNDLE_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
/** Корень репо монорепо (для dist/src coding-agent). */
const repoRoot = path.resolve(PACKAGE_ROOT, "..", "..", "..", "..");

/** Контрактные пути новой структуры. */
const BUNDLE_PKG_PATH = path.join(BUNDLE_ROOT, "package.json");
const BUNDLE_README_PATH = path.join(BUNDLE_ROOT, "README.md");
const DEPLOY_TOML_PATH = path.join(BUNDLE_ROOT, "DEPLOY.toml");
const SKILL_DIR = path.join(BUNDLE_ROOT, "skills", "fan-security");
const SKILL_PKG_PATH = path.join(SKILL_DIR, "package.json");
const SKILL_MD_PATH = path.join(SKILL_DIR, "SKILL.md");

/** Синхронизированная версия всех трёх манифестов (patch-release 1.0.1, приказ оператора). */
const SHIPPED_VERSION = "1.0.1";

/** Контрактный main пакета (roadmap F-2.8: «main → index.ts»). */
const ENTRY_BASENAME = "index.ts";

// ── Guard-чтение манифестов (читаемая причина падения) ──────────────────────

function readJsonGuard(filePath, instruction) {
	if (!existsSync(filePath)) {
		throw new Error(`${filePath} не существует. ${instruction}`);
	}
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function readTextGuard(filePath, instruction) {
	if (!existsSync(filePath)) {
		throw new Error(`${filePath} не существует. ${instruction}`);
	}
	return readFileSync(filePath, "utf8");
}

/** Guard: package.json extension-компонента. */
function readPackageJson() {
	return readJsonGuard(
		path.join(PACKAGE_ROOT, "package.json"),
		"Создай bundles/fan-security/extensions/fan-security/package.json по контракту из шапки этого файла (roadmap F-2.8): name='fan-security', version='1.0.0', type='module', main='index.ts', fan={type:'extension', name:'fan-security'}, без внешних dependencies.",
	);
}

/** Guard: package.json бандла. */
function readBundlePkg() {
	return readJsonGuard(
		BUNDLE_PKG_PATH,
		"Создай bundles/fan-security/package.json: {name:'fan-security', version:'1.0.0', description, license:'MIT', keywords:[...,'bundle']}, без fan-секции (эталон: bundles/fan-mission/package.json).",
	);
}

/** Guard: package.json skill-компонента. */
function readSkillPkg() {
	return readJsonGuard(
		SKILL_PKG_PATH,
		"Создай bundles/fan-security/skills/fan-security/package.json: {name:'fan-security', version:'1.0.0', description, type:'module', keywords}.",
	);
}

/** Guard: README.md extension-компонента. */
function readReadme() {
	return readTextGuard(
		path.join(PACKAGE_ROOT, "README.md"),
		"Создай bundles/fan-security/extensions/fan-security/README.md (roadmap F-2.8): установка через бандл fan-security (fan store install fan-security, авто-детект bundle — БЕЗ '--type extension'), использование (CLI-сканеры + /security-scan), зависимость от Этапа 1.",
	);
}

/** Guard: README.md бандла. */
function readBundleReadme() {
	return readTextGuard(
		BUNDLE_README_PATH,
		"Создай bundles/fan-security/README.md: обзор бандла (состав + версии компонентов), установка одной командой `fan store install fan-security`, использование.",
	);
}

/** Guard: DEPLOY.toml бандла. */
function readDeployToml() {
	return readTextGuard(
		DEPLOY_TOML_PATH,
		"Создай bundles/fan-security/DEPLOY.toml по DEPLOY-FORMAT.md (schema v1): заголовок «Schema version: 1», [package] name='fan-security' type='bundle', непустые include/exclude/preserve; bundle-паттерны с префиксом **/.",
	);
}

// ── TOML-мини-парсер (только то, что проверяем: плоские строковые массивы) ──

/** Извлекает строковый массив `key = [ ... ]` из TOML-текста; null если нет ключа. */
function readTomlStringArray(toml, key) {
	const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(toml);
	if (!match) return null;
	return match[1]
		.split(",")
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
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
// TC-F-2.8-1: package.json соответствует контракту extension (+ версии 1.0.0)
// ═════════════════════════════════════════════════════════════════════════════

describe("TC-F-2.8-1: package.json extension-компонента соответствует контракту", () => {
	it("package.json существует и валиден как JSON", () => {
		const pkg = readPackageJson();
		expect(pkg, "package.json должен парситься как непустой JSON-объект").toBeTypeOf("object");
	});

	it("поля верхнего уровня: name='fan-security', version='1.0.0', type='module', main → index.ts (файл существует)", () => {
		const pkg = readPackageJson();

		// name: без scope — installer detectName берёт pkg.name как имя пакета
		// стора и каталог установки (~/.fan/agent/extensions/<name>).
		expect(pkg.name, "name пакета (detectName installer'а)").toBe("fan-security");

		// version: синхронизирована с бандлом и skill-компонентом (приказ оператора)
		expect(pkg.version, "version extension-компонента").toBe(SHIPPED_VERSION);

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
// НОВОЕ (реструктуризация): манифесты бандла и skill-компонента
// ═════════════════════════════════════════════════════════════════════════════

describe("Бандл: bundles/fan-security/package.json (без fan-секции, эталон fan-mission)", () => {
	it("существует и валиден как JSON", () => {
		const pkg = readBundlePkg();
		expect(pkg).toBeTypeOf("object");
	});

	it("name='fan-security', version='1.0.0' (имя/версия бандла — из package.json, installer-контракт)", () => {
		const pkg = readBundlePkg();
		expect(pkg.name, "name бандла").toBe("fan-security");
		expect(pkg.version, "version бандла").toBe(SHIPPED_VERSION);
	});

	it("description, license='MIT', keywords содержит 'bundle'; БЕЗ fan-секции", () => {
		const pkg = readBundlePkg();
		expect(typeof pkg.description, "description бандла — непустая строка").toBe("string");
		expect(pkg.description.length).toBeGreaterThan(0);
		expect(pkg.license, "license бандла").toBe("MIT");
		expect(Array.isArray(pkg.keywords), "keywords — массив").toBe(true);
		expect(pkg.keywords, "keywords содержит 'bundle'").toContain("bundle");
		expect(pkg.fan, "у package.json бандла НЕ должно быть fan-секции (эталон fan-mission)").toBeUndefined();
	});
});

describe("Skill-компонент: bundles/fan-security/skills/fan-security/package.json", () => {
	it("существует и валиден как JSON", () => {
		const pkg = readSkillPkg();
		expect(pkg).toBeTypeOf("object");
	});

	it("name='fan-security', version='1.0.0', type='module'", () => {
		const pkg = readSkillPkg();
		expect(pkg.name, "name skill-компонента (detectName installer'а)").toBe("fan-security");
		expect(pkg.version, "version skill-компонента").toBe(SHIPPED_VERSION);
		expect(pkg.type, "type пакета").toBe("module");
		expect(typeof pkg.description === "string" && pkg.description.length > 0).toBe(true);
	});
});

describe("Синхронизация версий: bundle === extension === skill === SHIPPED_VERSION (1.0.1)", () => {
	it("все три манифеста имеют одну и ту же версию (приказ оператора)", () => {
		const bundlePkg = readBundlePkg();
		const extPkg = readPackageJson();
		const skillPkg = readSkillPkg();

		const versions = new Set([bundlePkg.version, extPkg.version, skillPkg.version]);
		expect(
			[...versions],
			"версии bundle/extension/skill должны совпадать",
		).toEqual([SHIPPED_VERSION]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// НОВОЕ (реструктуризация): DEPLOY.toml бандла — структурные проверки (schema v1)
// ═════════════════════════════════════════════════════════════════════════════

describe("DEPLOY.toml: schema v1, type='bundle', три непустых массива, bundle-паттерны", () => {
	it("заголовок «Schema version: 1» (по DEPLOY-FORMAT.md)", () => {
		const toml = readDeployToml();
		expect(toml, "заголовок схемы").toMatch(/#\s*Schema version:\s*1/);
	});

	it("[package]: name='fan-security', type='bundle'", () => {
		const toml = readDeployToml();
		const section = /\[package\]([\s\S]*?)(?=\n\[|\ninclude\s*=)/.exec(toml)?.[1] ?? "";
		expect(section, "секция [package] не найдена").toBeTruthy();
		expect(section).toMatch(/name\s*=\s*"fan-security"/);
		expect(section).toMatch(/type\s*=\s*"bundle"/);
	});

	it("все три массива обязательны и непусты: include/exclude; preserve присутствует", () => {
		const toml = readDeployToml();

		const include = readTomlStringArray(toml, "include");
		expect(include, "include обязателен (массив)").not.toBeNull();
		expect(include.length, "include непустой — иначе архив пуст").toBeGreaterThan(0);

		const exclude = readTomlStringArray(toml, "exclude");
		expect(exclude, "exclude обязателен (массив)").not.toBeNull();
		expect(exclude.length, "exclude непустой (tests/fixtures/node_modules и др.)").toBeGreaterThan(0);

		const preserve = readTomlStringArray(toml, "preserve");
		expect(preserve, "preserve обязателен (может быть [])").not.toBeNull();
	});

	it("include покрывает код расширения и SKILL.md скилла (bundle-паттерны с **/)", () => {
		const toml = readDeployToml();
		const include = readTomlStringArray(toml, "include") ?? [];

		for (const pattern of [
			"package.json",
			"README.md",
			"extensions/**/*.ts",
			"extensions/**/package.json",
			"extensions/**/*.md",
			"skills/**/SKILL.md",
			"skills/**/package.json",
		]) {
			expect(include, `include обязан покрывать «${pattern}»`).toContain(pattern);
		}
	});

	it("exclude отсекает тесты/фикстуры/node_modules/dist (состав архива без мусора)", () => {
		const toml = readDeployToml();
		const exclude = readTomlStringArray(toml, "exclude") ?? [];

		for (const pattern of ["**/node_modules/**", "**/tests/**", "**/fixtures/**", "**/*.test.*", "**/vitest.config.*"]) {
			expect(exclude, `exclude обязан содержать «${pattern}»`).toContain(pattern);
		}
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
// (а) Структура бандла — соответствие эвристикам installer/loader
// ═════════════════════════════════════════════════════════════════════════════

describe("(а) Структура бандла: SKILL.md — в skills/, extension — без SKILL.md, cli/ + lib/ на месте", () => {
	it("SKILL.md ОТСУТСТВУЕТ в корне extension-компонента (переехал в skills/fan-security/ бандла)", () => {
		expect(
			existsSync(path.join(PACKAGE_ROOT, "SKILL.md")),
			"SKILL.md больше не должен лежать в корне расширения: skill-компонент — bundles/fan-security/skills/fan-security/SKILL.md " +
				"(иначе авто-детект archive/install снова даст 'skill' вместо 'extension')",
		).toBe(false);
	});

	it("SKILL.md присутствует в skill-компоненте бандла (источник методологии /skill:fan-security)", () => {
		expect(
			existsSync(SKILL_MD_PATH),
			"bundles/fan-security/skills/fan-security/SKILL.md — skill-компонент бандла",
		).toBe(true);
	});

	it("index.ts присутствует (installer: entries.includes('index.ts') → 'extension'; loader resolveExtensionEntries fallback)", () => {
		expect(
			existsSync(INDEX_ABSOLUTE),
			"index.ts — триггер extension-эвристики installer'а и entry loader'а (index.ts → index.js)",
		).toBe(true);
	});

	it("cli/ + lib/ файлы на месте: 3 сканера + report/walker/external (состав архива пакета)", () => {
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

describe("(б) README.md extension-компонента: установка через бандл, использование, Этап 1", () => {
	it("README.md существует", () => {
		readReadme();
	});

	it("секция установки: fan store install (бандл) + локальный .tar.gz-архив", () => {
		const readme = readReadme();

		expect(readme, "должна быть инструкция «fan store install»").toMatch(
			/fan\s+store\s+install/i,
		);
		expect(readme, "должен упоминаться локальный архив (.tar.gz)").toMatch(
			/\.tar\.gz|\.tgz/i,
		);
	});

	it("установка — ЧЕРЕЗ БАНДЛ: warning «--type extension» удалён (авто-детект bundle по extensions/+skills/)", () => {
		const readme = readReadme();

		expect(
			readme,
			"README не должен требовать «--type extension»: installer детектит bundle по поддиректориям extensions/ + skills/",
		).not.toContain("--type extension");
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
// НОВОЕ (реструктуризация): README.md бандла
// ═════════════════════════════════════════════════════════════════════════════

describe("(б-2) README.md бандла: состав + версии, установка одной командой", () => {
	it("README.md бандла существует", () => {
		readBundleReadme();
	});

	it("установка одной командой: «fan store install fan-security» (авто-детект bundle, без --type)", () => {
		const readme = readBundleReadme();

		expect(readme, "должна быть команда установки бандла").toMatch(
			/fan\s+store\s+install/i,
		);
		expect(
			readme,
			"должен описываться авто-детект bundle (поддиректории extensions/ + skills/)",
		).toMatch(/extensions\/?\s*\+\s*skills|авто-детект|auto-?detect/i);
	});

	it("состав + версии компонентов (extension и skill, 1.0.1)", () => {
		const readme = readBundleReadme();

		expect(readme, "должны перечисляться оба компонента (extension + skill)").toMatch(
			/extension/i,
		);
		expect(readme).toMatch(/skill/i);
		expect(readme, "должна указываться версия компонентов 1.0.0").toContain(SHIPPED_VERSION);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// (документирующее) Реплика detectType installer'а — исполняемая фиксация
// фактических эвристик (packages/store/src/installer.ts ~66–92).
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

	it("поддиректории extensions/ + skills/ → 'bundle': bundle-эвристика проверяется ПЕРВОЙ (до SKILL.md)", () => {
		// Фактический состав корня бандла fan-security: extensions/ + skills/ +
		// package.json + README.md + DEPLOY.toml. Авто-детект даёт 'bundle' БЕЗ
		// явного --type — это контракт установки «одной командой».
		const bundleSubdirs = ["extensions", "skills"];
		const bundleEntries = ["package.json", "README.md", "DEPLOY.toml"];
		expect(detectTypeReplica(bundleEntries, bundleSubdirs)).toBe("bundle");

		// Даже если бы в корне бандла лежал SKILL.md — bundle-эвристика старше.
		expect(detectTypeReplica(["SKILL.md", "package.json"], bundleSubdirs)).toBe("bundle");
	});

	it("extension-компонент после реструктуризации (index.ts + package.json + README.md, БЕЗ SKILL.md) → 'extension': конфликт двойного пакета снят", () => {
		// До реструктуризации корень пакета содержал И SKILL.md, И index.ts →
		// авто-детект давал 'skill' (SKILL.md проверяется раньше). Теперь SKILL.md
		// переехал в skills/fan-security/ бандла, и standalone-детект extension-
		// компонента даёт 'extension'.
		const shippingEntries = ["index.ts", "package.json", "README.md"];
		expect(detectTypeReplica(shippingEntries)).toBe("extension");
	});
});
