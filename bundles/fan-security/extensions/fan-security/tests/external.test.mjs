/**
 * TDD RED tests for F-2.5 «Гибридный режим авто-детекта внешних тулов».
 * Roadmap: docs/features/security-worker/roadmap.md → «#### ☐ F-2.5» (TC-F-2.5-1/2).
 * Spec: docs/specs/spec_security-worker_2026-08-31.md §4 (гибрид, F2.4-строка),
 *       §2.3 (маскирование — инвариант и для внешних findings), §3.3 (exit-коды),
 *       §6.1 (схема Finding), §5.3 (gitleaks/semgrep — опциональные усилители).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ЦЕЛЕВОЙ КОНТРАКТ (спецификация для implement-воркера, Green-фаза) —
 * extensions/fan-security/lib/external.ts экспортирует:
 *
 *   0) type ExternalMode = "off" | "auto" | "only" (можно в lib/report.ts —
 *      см. расширение схемы ниже).
 *
 *   1) detectExternalTools(options?: { env?: { PATH?: string } })
 *        → { gitleaks: boolean; semgrep: boolean }            (СИНХРОННАЯ)
 *      - PATH для поиска: options?.env?.PATH ?? process.env.PATH ?? "";
 *      - механизм детекта — «which-подобный» поиск по PATH БЕЗ child_process
 *        (which/where НЕ вызываются): PATH режется по path.delimiter, пустые
 *        сегменты и несуществующие директории молча пропускаются;
 *      - имена-кандидаты (existence-check, statSync isFile; бит исполнения
 *        НЕ проверяется — кроссплатформенно):
 *          win32:  <name>.cmd, <name>.bat, <name>.exe, <name>
 *          posix:  <name>
 *        где name ∈ {"gitleaks", "semgrep"}; порядок PATH соблюдается;
 *      - ошибки statSync проглатываются → тулза считается не найденной;
 *      - функция никогда не бросает; process.env НЕ мутирует.
 *
 *   2) mergeFindings(base: Finding[], external: Finding[]) → Finding[]  (pure)
 *      - ключ дедупликации: [нормализованный file, line, cwe || title].join("|"),
 *        где нормализация file — обратные слэши → «/» + trim (POSIX-вид);
 *        «тип нарушения» = cwe, при пустом cwe — title (прокси rule-id);
 *      - при коллизии выигрывает БАЗОВЫЙ finding (у него богаче структура);
 *        внешние дубликаты отбрасываются;
 *      - выжившие внешние идут ПОСЛЕ всех базовых, в порядке входа external[];
 *      - внешние получают СВЕЖИЕ id «EXT-001», «EXT-002», … по порядку ВСЕХ
 *        входных external (включая слитые дубликаты) — детерминизм и гарантия
 *        уникальности против SEC-* базовых; id базовых не трогаются;
 *      - поле scanner проходит насквозь без изменений (маркировка
 *        «external:<tool>» — забота конвертера, п.3);
 *      - входные массивы НЕ мутируются.
 *
 *   3) Конвертеры вывода внешних тулов в Finding (имена/экспорты — свобода Green,
 *      поведение зафиксировано интеграционными тестами ниже):
 *      - gitleaks: stdout = JSON-массив [{RuleID, File, Commit, StartLine,
 *        Secret, Match}…] →
 *          scanner: "external:gitleaks"; title содержит RuleID;
 *          file: File (POSIX); line: StartLine; cwe: "CWE-798";
 *          severity: RuleID /aws/i → "CRITICAL", иначе "HIGH";
 *          confidence: "confirmed";
 *          evidence: Match (или Secret) ПРОМАСКИРОВАННЫЙ через maskSecret —
 *          полный Secret НЕ попадает ни в одно поле отчёта (§2.3);
 *      - semgrep: stdout = JSON {results: [{check_id, path, start: {line},
 *        extra: {message, severity, lines?, metadata?}}…]} →
 *          scanner: "external:semgrep"; title содержит check_id;
 *          file: path; line: start.line;
 *          severity: ERROR → "HIGH", WARNING → "MEDIUM", INFO → "INFO",
 *                    иное/отсутствует → "LOW";
 *          cwe: extra.metadata.cwe (строка ИЛИ массив) → первый /^CWE-\d+/,
 *               без него → "CWE-798" (дефолт пакета);
 *          confidence: "confirmed"; evidence: extra.lines ?? extra.message.
 *
 *   4) Раннер (механика — свобода Green, поведенческий контракт зафиксирован):
 *      - тулза запускается через Bun.spawnSync с АБСОЛЮТНЫМ путём из детекта,
 *        cwd = корень сканирования, env = { …process.env, PATH: injected ??
 *        process.env.PATH } (инъекция протаскивается в дочерний процесс);
 *      - Windows: .cmd/.bat требуют shell/cmd /c (прямой spawn даст EINVAL);
 *      - аргументы тулзе — на усмотрение Green (моки игнорируют их и печатают
 *        фиксированный JSON в stdout);
 *      - ЛЮБАЯ ошибка запуска/парсинга (не-0 exit, мусорный вывод, пусто) →
 *        0 внешних findings, скан продолжается, отчёт остаётся валидным.
 *
 *   5) ДОМЕНЫ ТУЛЗ: scan-secrets ↔ gitleaks, scan-patterns ↔ semgrep.
 *      scanSecrets не запускает semgrep (даже если он в PATH), scanPatterns —
 *      не запускает gitleaks. externalTools в отчёте отражает РЕЗУЛЬТАТ ДЕТЕКТА
 *      (оба могут быть true), а не список запущенных.
 *
 *   6) РЕЖИМЫ (опции useExternal в ScanSecretsOptions/ScanPatternsOptions,
 *      зарезервировано в F-2.2; CLI-флаг --use-external off|auto|only:
 *      формы "--use-external VALUE" и "--use-external=VALUE"; auto — дефолт):
 *      - "off":  детект и запуск НЕ выполняются; report.external = "off";
 *                report.externalTools ОТСУТСТВУЕТ (undefined); findings —
 *                только базовые сканеры; недопустимое значение флага → exit 2;
 *      - "auto" (дефолт): детект выполняется всегда → externalTools = результат
 *                детекта; ничего не найдено → report.external = "off" (TC-F-2.5-1),
 *                findings — только базовые; найдена доменная тулза →
 *                report.external = "auto", мердж (п.2) + дедуп (TC-F-2.5-2);
 *      - "only": базовый regex-скан ПРОПУСКАЕТСЯ, findings — только внешние;
 *                report.external = "only"; тулза не найдена → findings = []
 *                (явное намерение оператора); дедуп среди внешних — тот же ключ.
 *
 *   7) ИНЪЕКЦИЯ env ДЛЯ ТЕСТОВ: ScanSecretsOptions/ScanPatternsOptions получают
 *      env?: { PATH?: string } — прокидывается в detectExternalTools/раннер
 *      (п.1, п.4). process.env надёжно НЕ мутируется; vi.stubEnv не требуется.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * РАСШИРЕНИЕ СХЕМЫ ОТЧЁТА (уточнение спеки, НЕ ломающее §6.1) — решение (а):
 * Report (lib/report.ts) + вход createReport получают ОПЦИОНАЛЬНЫЕ top-level
 * поля:
 *      external?: ExternalMode            — ФАКТИЧЕСКИ применённый режим:
 *                                           "off" | "auto" | "only" (см. п.6);
 *      externalTools?: { gitleaks?: boolean; semgrep?: boolean }
 *                                         — результат детекта; присутствует
 *                                           только если детект запускался
 *                                           (auto/only), в "off" — отсутствует.
 * §6.1/§6.2 не ломаются: поля опциональные, старые потребители читают отчёт как
 * раньше. Обязательное следствие: strict-проверки «ровно 6 ключей Report» в
 * tests/scan-secrets.test.mjs (TC-F-2.2-1) и tests/scan-patterns.test.mjs
 * (expectF2_1Schema) ослаблены до «6 обязательных + допустимые external*» —
 * правка тестовая, поведение F-2.1/F-2.2/F-2.3 не меняется. dep-audit внешние
 * тулы не подключает — tests/dep-audit.test.mjs остаётся строгим.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOCK-БИНАРИ (НЕ настоящие gitleaks/semgrep) — создаются тестом во временной
 * директории (mkdtemp, авто-очистка) и инжектируются через env.PATH:
 *      gitleaks.cmd / gitleaks.bat : "@echo off" + type payload + exit /b 0
 *      gitleaks (sh, mode 755)     : #!/bin/sh + cat "$(dirname "$0")/payload"
 *      семейство broken-*          : echo мусора + exit 1
 *      semgrep.cmd/.bat/(sh)       : аналогично, payload semgrep-output.json
 * Payload-JSON лежат рядом (gitleaks-output.json / semgrep-output.json); номера
 * строк в payload ВЫЧИСЛЯЮТСЯ из fixture (маркерные подстроки), тесты не привязаны
 * к номерам строк fixture.
 *
 * РЕШЕНИЕ ПО ЗАПУСКУ (как F-2.2/F-2.3): scanSecrets/scanPatterns/detect/merge
 * тестируются НАПРЯМУЮ через import (guard + requireExport); stdout/stderr
 * перехват vi.spyOn(console, …). Надёжно на Windows/Bun.
 *
 * Red-ожидание (roadmap): «TC-F-2.5-2 — падает первым: lib/external.ts не
 * существует, мерджа нет». Все падения — читаемые (guard-хелпер: «модуля/экспорта
 * нет» либо отсутствие external-полей в отчёте), а не «тест сломан». Все секреты
 * в моках/fixture — фейковые и невалидные.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/report.ts уже существует (F-2.1 COMPLETED) — статический импорт
import { maskSecret, resolveExitCode, SEVERITIES } from "../lib/report.ts";

const EXTERNAL_URL = "../lib/external.ts";
const SECRETS_CLI_URL = "../cli/scan-secrets.ts";
const PATTERNS_CLI_URL = "../cli/scan-patterns.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(testsDir, "fixtures");
const SECRETS_SAMPLE = path.join(FIXTURES, "secrets-sample.ts");

/** Фейковые, невалидные значения (дубликаты fixtures + синтетика для мока). */
const FAKE = {
	aws: "AKIAABCDEFGHIJKLMNOP", // AKIA + 16 — строка 11 fixture, невалидный
	external: "FakeExternalSecretToken0123456789", // уникальный finding мока gitleaks
};

/** Все 12 обязательных полей Finding по §6.1 (схема F-2.1). */
const FINDING_FIELDS = [
	"id",
	"scanner",
	"severity",
	"title",
	"file",
	"line",
	"cwe",
	"evidence",
	"description",
	"exploit",
	"remediation",
	"confidence",
];

// ── Guards (стиль scan-secrets.test.mjs / scan-patterns.test.mjs) ───────────

const modulePromises = new Map();

function guardedImport(url, feature) {
	if (!modulePromises.has(url)) {
		modulePromises.set(
			url,
			import(url).catch((cause) => {
				modulePromises.delete(url); // разрешить повторную попытку в следующем тесте
				throw new Error(
					`${url} не существует или не импортируется (${cause?.message ?? cause}). ` +
						`Создай/дополни по контракту F-2.5 — шапка этого файла, roadmap F-2.5: ${feature}.`,
				);
			}),
		);
	}
	return modulePromises.get(url);
}

/** Guard-загрузка lib/external.ts (в Red её нет — все тесты файла падают на ней). */
function loadExternal() {
	return guardedImport(
		EXTERNAL_URL,
		"экспорт detectExternalTools(options?) → {gitleaks, semgrep} + mergeFindings(base, external) → Finding[]",
	);
}

function loadSecretsCli() {
	return guardedImport(SECRETS_CLI_URL, "scanSecrets с useExternal/env и мерджем внешних findings");
}

function loadPatternsCli() {
	return guardedImport(PATTERNS_CLI_URL, "scanPatterns с useExternal/env и мерджем внешних findings");
}

/** Guard: наличие экспорта с читаемым сообщением (дубль из scan-secrets.test.mjs). */
function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`Модуль не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). Дополни экспорты по контракту F-2.5 — шапка этого файла.`,
		);
	}
	return new Proxy(value, {
		get(target, prop) {
			if (prop === name) {
				return target;
			}
			return Reflect.get(target, prop);
		},
	});
}

/** Перехват stdout/stderr (контракт: main()/раннер печатают только через console.*). */
function captureConsole() {
	const out = [];
	const err = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
	const errSpy = vi
		.spyOn(console, "error")
		.mockImplementation((...args) => err.push(args.join(" ")));
	return {
		out,
		err,
		stdout: () => out.join("\n"),
		stderr: () => err.join("\n"),
		restore() {
			logSpy.mockRestore();
			errSpy.mockRestore();
		},
	};
}

// ── Временные директории и mock-бинари ──────────────────────────────────────

const tempDirs = [];
function makeTempDir(prefix = "fan-external-") {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Пустая PATH-директория (детект по ней обязан давать false/false). */
function emptyPathDir() {
	return makeTempDir("fan-external-empty-");
}

/**
 * Mock-бинарь <tool>: cmd/bat печатают payload через type, sh — через cat.
 * broken-вариант печатает мусор и завершается с exit 1.
 */
function writeMockTool(dir, tool, payloadFile, { broken = false } = {}) {
	const cmdBody = broken
		? ["@echo off", "echo external-tool-internal-error not-json", "exit /b 1", ""].join("\r\n")
		: ["@echo off", `type "%~dp0${payloadFile}"`, "exit /b 0", ""].join("\r\n");
	writeFileSync(path.join(dir, `${tool}.cmd`), cmdBody, "utf8");
	writeFileSync(path.join(dir, `${tool}.bat`), cmdBody, "utf8");
	const shBody = broken
		? "#!/bin/sh\necho external-tool-internal-error not-json\nexit 1\n"
		: `#!/bin/sh\ncat "$(dirname "$0")/${payloadFile}"\n`;
	writeFileSync(path.join(dir, tool), shBody, { encoding: "utf8", mode: 0o755 });
}

/**
 * Директория с mock-бинарями для инъекции в PATH.
 * gitleaks: "ok" | "broken" | null; semgrep: "ok" | null.
 */
function makeToolsDir({ gitleaks = null, gitleaksPayload = null, semgrep = null, semgrepPayload = null } = {}) {
	const dir = makeTempDir();
	if (gitleaks) {
		writeFileSync(
			path.join(dir, "gitleaks-output.json"),
			JSON.stringify(gitleaksPayload ?? [], null, "\t"),
			"utf8",
		);
		writeMockTool(dir, "gitleaks", "gitleaks-output.json", { broken: gitleaks === "broken" });
	}
	if (semgrep) {
		writeFileSync(
			path.join(dir, "semgrep-output.json"),
			JSON.stringify(semgrepPayload ?? { results: [] }, null, "\t"),
			"utf8",
		);
		writeMockTool(dir, "semgrep", "semgrep-output.json");
	}
	return dir;
}

/** env для инъекции: PATH из перечисленных директорий (хост-разделитель). */
function envWith(...dirs) {
	return { env: { PATH: dirs.filter(Boolean).join(path.delimiter) } };
}

/** 1-based номер первой строки файла, содержащей needle (fixture-маркер). */
function lineInFile(file, needle) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const index = lines.findIndex((line) => line.includes(needle));
	expect(index, `fixture не содержит маркер «${needle}» — обнови fixture или тест`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** Строки временного файла (запись массивом — 1-based снаружи). */
function writeTempFile(dir, name, lines) {
	const file = path.join(dir, name);
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
	return file;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Фабрики Finding для unit-тестов mergeFindings ───────────────────────────

function mkBase(over = {}) {
	return {
		id: "SEC-001",
		scanner: "scan-secrets",
		severity: "HIGH",
		title: "AWS Access Key",
		file: "src/auth.ts",
		line: 10,
		cwe: "CWE-798",
		evidence: `apiKey = "${maskSecret(FAKE.aws)}"`,
		description: "d",
		exploit: "e",
		remediation: "r",
		confidence: "confirmed",
		...over,
	};
}

function mkExt(over = {}) {
	return {
		...mkBase(),
		id: "EXT-001",
		scanner: "external:gitleaks",
		title: "aws-access-token (gitleaks)",
		...over,
	};
}

// ═════════════════════════════════════════════════════════════════════════════
describe("Контракт модуля: lib/external.ts существует и экспортирует API F-2.5", () => {
	it("detectExternalTools (sync) и mergeFindings — функции", async () => {
		const mod = await loadExternal();
		expect(typeof requireExport(mod, "detectExternalTools")).toBe("function");
		expect(typeof requireExport(mod, "mergeFindings")).toBe("function");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("detectExternalTools: детект по инъецированному PATH (юнит, без spawn)", () => {
	it("пустой PATH ('') → оба false", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		expect(detectExternalTools({ env: { PATH: "" } })).toEqual({ gitleaks: false, semgrep: false });
	});

	it("PATH из пробелов → оба false (мусорные сегменты игнорируются)", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		expect(detectExternalTools({ env: { PATH: "   " } })).toEqual({ gitleaks: false, semgrep: false });
	});

	it("PATH с mock-gitleaks → gitleaks true, semgrep false", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		const dir = makeToolsDir({ gitleaks: "ok" });
		expect(detectExternalTools(envWith(dir))).toEqual({ gitleaks: true, semgrep: false });
	});

	it("PATH с mock-semgrep → semgrep true, gitleaks false", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		const dir = makeToolsDir({ semgrep: "ok" });
		expect(detectExternalTools(envWith(dir))).toEqual({ gitleaks: false, semgrep: true });
	});

	it("PATH с обоими моками → оба true", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		const dir = makeToolsDir({ gitleaks: "ok", semgrep: "ok" });
		expect(detectExternalTools(envWith(dir))).toEqual({ gitleaks: true, semgrep: true });
	});

	it("PATH: пустые сегменты, несуществующие директории, поиск во второй директории — без throw", async () => {
		const { detectExternalTools } = requireExport(await loadExternal(), "detectExternalTools");
		const dir = makeToolsDir({ semgrep: "ok" });
		const missing = path.join(makeTempDir(), "no-such-dir");
		const mixed = ["", missing, dir, ""].join(path.delimiter);
		expect(detectExternalTools({ env: { PATH: mixed } })).toEqual({ gitleaks: false, semgrep: true });
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("mergeFindings: дедуп file+line+(cwe|тип), base wins (юнит, pure)", () => {
	it("дубль (тот же file/line/cwe) слит: ровно 1 из пары, выживает БАЗОВЫЙ", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const base = mkBase();
		const ext = mkExt(); // тот же file/line/cwe, scanner external:gitleaks

		const merged = mergeFindings([base], [ext]);

		expect(merged).toHaveLength(1);
		expect(merged[0].scanner).toBe("scan-secrets"); // base wins
		expect(merged[0].id).toBe("SEC-001"); // id базового не тронут
	});

	it("нормализация путей: 'src\\\\auth.ts' (base) и 'src/auth.ts' (external) — дедуп срабатывает", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const base = mkBase({ file: "src\\auth.ts" });
		const ext = mkExt({ file: "src/auth.ts" });

		const merged = mergeFindings([base], [ext]);

		expect(merged).toHaveLength(1);
		expect(merged[0].scanner).toBe("scan-secrets");
	});

	it("другая строка → НЕ дубликат: оба finding сохранены", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const merged = mergeFindings([mkBase()], [mkExt({ line: 11 })]);
		expect(merged).toHaveLength(2);
	});

	it("другой cwe (тот же file/line) → НЕ дубликат: оба finding сохранены", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const merged = mergeFindings([mkBase()], [mkExt({ cwe: "CWE-778" })]);
		expect(merged).toHaveLength(2);
	});

	it("пустой cwe → тип сравнивается по title: совпал — дедуп, различается — оба", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const same = mergeFindings([mkBase({ cwe: "" })], [mkExt({ cwe: "", title: "AWS Access Key" })]);
		expect(same).toHaveLength(1);

		const diff = mergeFindings([mkBase({ cwe: "" })], [mkExt({ cwe: "", title: "generic-api-key" })]);
		expect(diff).toHaveLength(2);
	});

	it("уникальные внешние выживают: свежие id EXT-*, scanner насквозь, порядок base→external", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const base = mkBase();
		// id входных внешних collide с базовым "SEC-001" — merge обязан переназначить
		const extUnique1 = mkExt({ id: "SEC-001", line: 42, title: "generic-api-key" });
		const extUnique2 = mkExt({ id: "SEC-001", line: 43, title: "slack-token" });

		const merged = mergeFindings([base], [mkExt(), extUnique1, extUnique2]);

		expect(merged).toHaveLength(3); // дубль слит, 2 уникальных добавлено
		expect(merged.map((f) => f.id)).toEqual(["SEC-001", "EXT-002", "EXT-003"]);
		expect(merged[0].scanner).toBe("scan-secrets");
		expect(merged[1].scanner).toBe("external:gitleaks");
		expect(merged[2].scanner).toBe("external:gitleaks");
	});

	it("mergeFindings не мутирует входные массивы (и id внешних в них сохранены)", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");
		const base = [mkBase()];
		const ext = [mkExt({ id: "SEC-001" })];
		const baseSnapshot = JSON.stringify(base);
		const extSnapshot = JSON.stringify(ext);

		mergeFindings(base, ext);

		expect(JSON.stringify(base)).toBe(baseSnapshot);
		expect(JSON.stringify(ext)).toBe(extSnapshot);
	});

	it("пустые входы: [], [] → []; (base, []) → base как есть; ([], ext) → ext со свежими EXT-id", async () => {
		const { mergeFindings } = requireExport(await loadExternal(), "mergeFindings");

		expect(mergeFindings([], [])).toEqual([]);
		expect(mergeFindings([mkBase()], [])).toHaveLength(1);

		const onlyExternal = mergeFindings([], [mkExt({ id: "SEC-009" }), mkExt({ id: "SEC-009", line: 99 })]);
		expect(onlyExternal.map((f) => f.id)).toEqual(["EXT-001", "EXT-002"]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("TC-F-2.5-1: нет внешних тулов — чисто базовый режим (scanSecrets, auto)", () => {
	it("PATH без тулов: report.external='off', externalTools={false,false}, findings только базовые, exit 1", async () => {
		const external = await loadExternal(); // guard: в Red падает здесь (модуля нет)
		requireExport(external, "detectExternalTools");
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const off = await scanSecrets(SECRETS_SAMPLE, { useExternal: "off", ...envWith(emptyPathDir()) });
		const baseCount = off.findings.length;
		expect(baseCount, "предусловие: базовый скан fixture находит секреты").toBeGreaterThan(0);

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "auto", ...envWith(emptyPathDir()) });

		expect(report.external).toBe("off"); // auto выродился в off — roadmap TC-F-2.5-1
		expect(report.externalTools).toEqual({ gitleaks: false, semgrep: false });
		expect(report.findings.length).toBe(baseCount);
		for (const finding of report.findings) {
			expect(finding.scanner).toBe("scan-secrets");
		}
		expect(resolveExitCode(report)).toBe(1);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("TC-F-2.5-2: mock gitleaks — мердж и дедуп (scanSecrets, auto)", () => {
	/** Gitleaks-payload: (1) дубль базового AWS-finding, (2) уникальный. Номера строк — из fixture. */
	function gitleaksPayload() {
		const awsLine = lineInFile(SECRETS_SAMPLE, "export const AWS_ACCESS_KEY_ID");
		const githubLine = lineInFile(SECRETS_SAMPLE, "export const GITHUB_TOKEN");
		const slackLine = lineInFile(SECRETS_SAMPLE, "export const SLACK_BOT_TOKEN");
		const uniqueLine = awsLine - 1; // строка-комментарий над AWS: базовых findings там нет
		expect(uniqueLine).toBeGreaterThan(0);
		expect([awsLine, githubLine, slackLine], "уникальная строка мока не должна совпадать с базовой").not.toContain(
			uniqueLine,
		);
		return {
			awsLine,
			uniqueLine,
			items: [
				{
					RuleID: "aws-access-token",
					Description: "AWS Access Key (mock, fake value)",
					File: "secrets-sample.ts",
					Commit: "0000000000000000000000000000000000000000",
					StartLine: awsLine,
					Secret: FAKE.aws,
					Match: `AWS_ACCESS_KEY_ID = "${FAKE.aws}"`,
				},
				{
					RuleID: "generic-api-key",
					Description: "Generic API key (mock, fake value)",
					File: "secrets-sample.ts",
					Commit: "0000000000000000000000000000000000000000",
					StartLine: uniqueLine,
					Secret: FAKE.external,
					Match: `externalToken = "${FAKE.external}"`,
				},
			],
		};
	}

	it("дубль слит (ровно 1 из пары), уникальный добавлен с scanner='external:gitleaks', total корректен", async () => {
		const external = await loadExternal(); // guard: в Red падает здесь
		requireExport(external, "mergeFindings");
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const payload = gitleaksPayload();
		const toolsDir = makeToolsDir({ gitleaks: "ok", gitleaksPayload: payload.items });
		const off = await scanSecrets(SECRETS_SAMPLE, { useExternal: "off", ...envWith(emptyPathDir()) });
		const baseCount = off.findings.length;

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "auto", ...envWith(toolsDir) });

		// Режим: auto, найден gitleaks
		expect(report.external).toBe("auto");
		expect(report.externalTools).toEqual({ gitleaks: true, semgrep: false });

		// Дедуп: на строке AWS ровно ОДИН finding — базовый (base wins)
		const onAws = report.findings.filter((f) => f.file === "secrets-sample.ts" && f.line === payload.awsLine);
		expect(onAws, "дубль (gitleaks + base) не слит в один finding").toHaveLength(1);
		expect(onAws[0].scanner).toBe("scan-secrets");

		// Уникальный внешний: ровно один, со всеми 12 полями Finding
		const externals = report.findings.filter((f) => f.scanner === "external:gitleaks");
		expect(externals).toHaveLength(1);
		const ext = externals[0];
		expect(Object.keys(ext).sort()).toEqual([...FINDING_FIELDS].sort());
		expect(ext.file).toBe("secrets-sample.ts");
		expect(ext.line).toBe(payload.uniqueLine);
		expect(ext.cwe).toBe("CWE-798");
		expect(ext.severity, "RuleID 'generic-api-key' (без aws) → HIGH").toBe("HIGH");
		expect(ext.confidence).toBe("confirmed");
		expect(ext.id).toMatch(/^EXT-/);
		expect(ext.evidence.length).toBeGreaterThan(0);
		expect(SEVERITIES).toContain(ext.severity);

		// total: базовые + 1 уникальный внешний; id уникальны; exit 1
		expect(report.findings.length).toBe(baseCount + 1);
		expect(report.summary.total).toBe(report.findings.length);
		const ids = report.findings.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(resolveExitCode(report)).toBe(1);
	});

	it("маскирование §2.3 распространяется на внешние findings: полный Secret НЕ попадает в отчёт", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const payload = gitleaksPayload();
		const toolsDir = makeToolsDir({ gitleaks: "ok", gitleaksPayload: payload.items });

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "auto", ...envWith(toolsDir) });
		const json = JSON.stringify(report);

		expect(json).not.toContain(FAKE.aws); // Secret дубликата
		expect(json).not.toContain(FAKE.external); // Secret уникального
		expect(json).toContain(maskSecret(FAKE.external)); // evidence промаскирован
	});

	it("домены тулз: scan-secrets не запускает semgrep (детект видит оба, мержится только gitleaks)", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const toolsDir = makeToolsDir({
			gitleaks: "ok",
			gitleaksPayload: gitleaksPayload().items,
			semgrep: "ok",
			semgrepPayload: { results: [] },
		});

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "auto", ...envWith(toolsDir) });

		expect(report.externalTools).toEqual({ gitleaks: true, semgrep: true }); // детект видит оба
		expect(report.findings.some((f) => f.scanner === "external:semgrep")).toBe(false);
		expect(report.findings.some((f) => f.scanner === "external:gitleaks")).toBe(true);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Режим off: детект и запуск внешних не выполняются даже при наличии бинаря", () => {
	it("mock gitleaks в PATH: external='off', externalTools отсутствует, findings только базовые", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const payload = [];
		const toolsDir = makeToolsDir({ gitleaks: "ok", gitleaksPayload: payload });

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "off", ...envWith(toolsDir) });

		expect(report.external).toBe("off");
		expect(report.externalTools).toBeUndefined(); // детект не запускался
		for (const finding of report.findings) {
			expect(finding.scanner).toBe("scan-secrets");
		}
		expect(resolveExitCode(report)).toBe(1);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Режим only: только внешние findings, базовый regex-скан пропущен", () => {
	it("mock gitleaks в PATH: все findings scanner='external:gitleaks' (оба мок-finding'а, без базовых)", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const payload = [
			{
				RuleID: "aws-access-token",
				File: "secrets-sample.ts",
				StartLine: lineInFile(SECRETS_SAMPLE, "export const AWS_ACCESS_KEY_ID"),
				Secret: FAKE.aws,
				Match: `AWS_ACCESS_KEY_ID = "${FAKE.aws}"`,
			},
			{
				RuleID: "generic-api-key",
				File: "secrets-sample.ts",
				StartLine: 1,
				Secret: FAKE.external,
				Match: `externalToken = "${FAKE.external}"`,
			},
		];
		const toolsDir = makeToolsDir({ gitleaks: "ok", gitleaksPayload: payload });

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "only", ...envWith(toolsDir) });

		expect(report.external).toBe("only");
		expect(report.externalTools).toEqual({ gitleaks: true, semgrep: false });
		expect(report.findings.length).toBe(2); // базовый скан пропущен — дедупить не с чем
		expect(report.findings.every((f) => f.scanner === "external:gitleaks")).toBe(true);
		expect(report.findings.every((f) => /^EXT-/.test(f.id))).toBe(true);
		const json = JSON.stringify(report);
		expect(json).not.toContain(FAKE.aws);
		expect(json).not.toContain(FAKE.external);
		expect(resolveExitCode(report)).toBe(1);
	});

	it("тулз нет: findings=[] (явное намерение оператора), external='only', exit 0", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "only", ...envWith(emptyPathDir()) });

		expect(report.external).toBe("only");
		expect(report.externalTools).toEqual({ gitleaks: false, semgrep: false });
		expect(report.findings).toEqual([]);
		expect(resolveExitCode(report)).toBe(0);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Отказоустойчивость: внешняя тулза падает (exit 1, мусорный вывод)", () => {
	it("broken gitleaks: внешних findings нет, базовые работают, отчёт валиден, скан не падает", async () => {
		await loadExternal();
		const { scanSecrets } = requireExport(await loadSecretsCli(), "scanSecrets");

		const toolsDir = makeToolsDir({ gitleaks: "broken" });
		const off = await scanSecrets(SECRETS_SAMPLE, { useExternal: "off", ...envWith(emptyPathDir()) });
		const baseCount = off.findings.length;

		const console$ = captureConsole(); // предупреждение в stderr допустимо
		const report = await scanSecrets(SECRETS_SAMPLE, { useExternal: "auto", ...envWith(toolsDir) });
		console$.restore();

		expect(report.external).toBe("auto"); // запуск пытались выполнить
		expect(report.externalTools).toEqual({ gitleaks: true, semgrep: false });
		expect(report.findings.length).toBe(baseCount);
		for (const finding of report.findings) {
			expect(finding.scanner).toBe("scan-secrets");
		}
		expect(report.summary.total).toBe(report.findings.length);
		expect(resolveExitCode(report)).toBe(1);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CLI: --use-external парсится в scan-secrets main (off|auto|only)", () => {
	it("--use-external off: exit 1, весь stdout — валидный JSON с external='off'", async () => {
		await loadExternal();
		const main = requireExport(await loadSecretsCli(), "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE, "--use-external", "off", "--format", "json"]);

		expect(exitCode).toBe(1);
		const report = JSON.parse(console$.stdout());
		expect(report.external).toBe("off");
		expect(report.externalTools).toBeUndefined();
	});

	it("--use-external=off: форма с '=' тоже поддерживается", async () => {
		await loadExternal();
		const main = requireExport(await loadSecretsCli(), "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE, "--use-external=off", "--format", "json"]);

		expect(exitCode).toBe(1);
		const report = JSON.parse(console$.stdout());
		expect(report.external).toBe("off");
	});

	it("--use-external bogus → exit 2, stderr упоминает --use-external и допустимые значения", async () => {
		await loadExternal();
		const main = requireExport(await loadSecretsCli(), "main");

		const console$ = captureConsole();
		const exitCode = await main([SECRETS_SAMPLE, "--use-external", "bogus", "--format", "json"]);

		expect(exitCode).toBe(2);
		const stderr = console$.stderr();
		expect(stderr).toContain("--use-external");
		expect(stderr).toMatch(/off.*auto.*only|auto.*off.*only/);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
describe("scan-patterns: mock semgrep — конвертация JSON → Finding и режимы", () => {
	/** Временный скан-таргет: строка 2 — CWE-89 (база), строка 3 — безопасный аналог. */
	function makeVulnTarget() {
		const dir = makeTempDir("fan-external-patterns-");
		const SQL_LINE = 2;
		const SAFE_LINE = 3;
		writeTempFile(dir, "vuln.ts", [
			`import crypto from "node:crypto";`,
			`const sql = "SELECT * FROM users WHERE name = " + userName + ";";`,
			`const rows = db.query("SELECT * FROM users WHERE id = ?", [userId]);`,
		]);
		return { dir, SQL_LINE, SAFE_LINE };
	}

	/** Semgrep-payload: дубль SQL-строки (ERROR) + уникальный на safe-строке (WARNING). */
	function semgrepPayload(SQL_LINE, SAFE_LINE) {
		return {
			results: [
				{
					check_id: "generic.sql.concat-injection",
					path: "vuln.ts",
					start: { line: SQL_LINE },
					extra: {
						message: "Possible SQL injection: query built by string concatenation.",
						severity: "ERROR",
						lines: `const sql = "SELECT * FROM users WHERE name = " + userName + ";";`,
						metadata: { cwe: "CWE-89: SQL Injection" },
					},
				},
				{
					check_id: "generic.sql.parameterized-query",
					path: "vuln.ts",
					start: { line: SAFE_LINE },
					extra: {
						message: "Review parameterized query flagged by generic rule.",
						severity: "WARNING",
						lines: `const rows = db.query("SELECT * FROM users WHERE id = ?", [userId]);`,
						metadata: { cwe: "CWE-89: SQL Injection" },
					},
				},
			],
		};
	}

	it("auto: дубль слит (база побеждает), уникальный добавлен (check_id→title, WARNING→MEDIUM, metadata.cwe→CWE)", async () => {
		await loadExternal();
		const { scanPatterns } = requireExport(await loadPatternsCli(), "scanPatterns");

		const { dir, SQL_LINE, SAFE_LINE } = makeVulnTarget();
		const toolsDir = makeToolsDir({ semgrep: "ok", semgrepPayload: semgrepPayload(SQL_LINE, SAFE_LINE) });
		const off = await scanPatterns(dir, { useExternal: "off", ...envWith(emptyPathDir()) });
		const baseCount = off.findings.length;
		expect(baseCount, "предусловие: базовый скан находит CWE-89 на SQL-строке").toBeGreaterThan(0);

		const report = await scanPatterns(dir, { useExternal: "auto", ...envWith(toolsDir) });

		expect(report.external).toBe("auto");
		expect(report.externalTools).toEqual({ gitleaks: false, semgrep: true });

		// Дубль: на SQL-строке ровно один finding — базовый
		const onSql = report.findings.filter((f) => f.file === "vuln.ts" && f.line === SQL_LINE);
		expect(onSql).toHaveLength(1);
		expect(onSql[0].scanner).toBe("scan-patterns");

		// Уникальный semgrep-finding: полный конверт
		const externals = report.findings.filter((f) => f.scanner === "external:semgrep");
		expect(externals).toHaveLength(1);
		const ext = externals[0];
		expect(Object.keys(ext).sort()).toEqual([...FINDING_FIELDS].sort());
		expect(ext.file).toBe("vuln.ts");
		expect(ext.line).toBe(SAFE_LINE);
		expect(ext.title).toContain("generic.sql.parameterized-query");
		expect(ext.cwe).toBe("CWE-89"); // из extra.metadata.cwe
		expect(ext.severity).toBe("MEDIUM"); // WARNING → MEDIUM
		expect(ext.confidence).toBe("confirmed");
		expect(ext.id).toMatch(/^EXT-/);
		expect(ext.evidence.length).toBeGreaterThan(0);

		expect(report.findings.length).toBe(baseCount + 1);
		expect(resolveExitCode(report)).toBe(1);
	});

	it("only: базовый скан пропущен — оба semgrep-finding'а присутствуют, ERROR→HIGH на SQL-строке", async () => {
		await loadExternal();
		const { scanPatterns } = requireExport(await loadPatternsCli(), "scanPatterns");

		const { dir, SQL_LINE, SAFE_LINE } = makeVulnTarget();
		const toolsDir = makeToolsDir({ semgrep: "ok", semgrepPayload: semgrepPayload(SQL_LINE, SAFE_LINE) });

		const report = await scanPatterns(dir, { useExternal: "only", ...envWith(toolsDir) });

		expect(report.external).toBe("only");
		expect(report.findings.length).toBe(2);
		expect(report.findings.every((f) => f.scanner === "external:semgrep")).toBe(true);
		const severityByLine = new Map(report.findings.map((f) => [f.line, f.severity]));
		expect(severityByLine.get(SQL_LINE)).toBe("HIGH"); // ERROR → HIGH
		expect(severityByLine.get(SAFE_LINE)).toBe("MEDIUM"); // WARNING → MEDIUM
		expect(resolveExitCode(report)).toBe(1);
	});

	it("off при наличии semgrep в PATH: внешние не запускаются, externalTools отсутствует", async () => {
		await loadExternal();
		const { scanPatterns } = requireExport(await loadPatternsCli(), "scanPatterns");

		const { dir, SQL_LINE } = makeVulnTarget();
		const toolsDir = makeToolsDir({ semgrep: "ok", semgrepPayload: semgrepPayload(SQL_LINE, 3) });

		const report = await scanPatterns(dir, { useExternal: "off", ...envWith(toolsDir) });

		expect(report.external).toBe("off");
		expect(report.externalTools).toBeUndefined();
		expect(report.findings.some((f) => f.scanner.startsWith("external:"))).toBe(false);
	});

	it("домены тулз: scan-patterns не запускает gitleaks (детект видит оба, мержится только semgrep)", async () => {
		await loadExternal();
		const { scanPatterns } = requireExport(await loadPatternsCli(), "scanPatterns");

		const { dir, SQL_LINE, SAFE_LINE } = makeVulnTarget();
		const toolsDir = makeToolsDir({
			gitleaks: "ok",
			gitleaksPayload: [],
			semgrep: "ok",
			semgrepPayload: semgrepPayload(SQL_LINE, SAFE_LINE),
		});

		const report = await scanPatterns(dir, { useExternal: "auto", ...envWith(toolsDir) });

		expect(report.externalTools).toEqual({ gitleaks: true, semgrep: true }); // детект видит оба
		expect(report.findings.some((f) => f.scanner === "external:gitleaks")).toBe(false);
		expect(report.findings.some((f) => f.scanner === "external:semgrep")).toBe(true);
	});
});
