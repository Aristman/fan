// F-37: Манифесты инструментов (декларативные, на узел) — RED-фаза TDD.
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-37
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
//
// Целевой модуль: extensions/fan-super-orchestrator/tool-manifest.ts (НЕ СУЩЕСТВУЕТ)
//
// Целевое API:
//   const ALLOWED_TOOLS: readonly string[]
//     — полный набор допустимых имён: read, write, edit, bash, grep, find,
//       ls, store_search, store_install (9 инструментов)
//   class InvalidToolManifestError extends Error
//     — бросается при невалидном манифесте; message содержит имя невалидного
//       инструмента или описание проблемы (пустой массив, не-массив, не-строка)
//   validateManifest(manifest: unknown): string[]
//     — undefined/null → полный ALLOWED_TOOLS (дефолт)
//     — не-массив → InvalidToolManifestError
//     — пустой массив → InvalidToolManifestError
//     — массив с не-строками → InvalidToolManifestError
//     — массив с недопустимым именем → InvalidToolManifestError (message содержит имя)
//     — дубликаты → ok (dedupe); порядок сохраняется
//     — валидный массив → dedupe'd копия
//   toFlag(manifest: string[]): string
//     — "--tools read,write,edit,bash" формат для spawn-аргументов
//     — пустой массив → "" (не должен вызываться после validateManifest,
//       но безопасен)
//   isAllowed(manifest: string[], toolName: string): { allowed: boolean; diag?: string }
//     — { allowed: true } если toolName в манифесте
//     — { allowed: false, diag: "tool '<name>' not in manifest" } если нет
//
// Интеграционные точки:
//   • work-package (F-27): поле toolManifest — парсинг и валидация
//   • process-manager / depth2-integration: --tools флаг в argv дочернего
//   • tree-journal (F-32): событие tool_blocked (future — в GREEN-фазе)
//
// Покрытие (TC-карточки roadmap):
//   TC-F37-1  isAllowed(["read","bash"], "write") → { allowed:false, diag содержит 'write' }
//   TC-F37-2  validateManifest(["read","delete_all"]) → InvalidToolManifestError('delete_all')
//   TC-F37-3  toFlag(["read","write","edit","bash"]) → "--tools read,write,edit,bash"
//   Доп.      пустой массив, не-массив, не-строки, дубликаты, undefined/null → дефолт,
//             все 9 ALLOWED_TOOLS, интеграция work-package, spawn-argv

import { beforeAll, describe, expect, it } from "vitest";

let ALLOWED_TOOLS;
let InvalidToolManifestError;
let validateManifest;
let toFlag;
let isAllowed;

beforeAll(async () => {
	const mod = await import("../tool-manifest.js");
	ALLOWED_TOOLS = mod.ALLOWED_TOOLS;
	InvalidToolManifestError = mod.InvalidToolManifestError;
	validateManifest = mod.validateManifest;
	toFlag = mod.toFlag;
	isAllowed = mod.isAllowed;
});

// ─── TC-F37-2: validateManifest — недопустимое имя инструмента ─────────────

describe("TC-F37-2: validateManifest([\"read\",\"delete_all\"]) → InvalidToolManifestError", () => {
	it("delete_all не в ALLOWED_TOOLS → бросает InvalidToolManifestError", () => {
		expect(() => validateManifest(["read", "delete_all"])).toThrow(InvalidToolManifestError);
	});

	it("сообщение ошибки содержит имя невалидного инструмента 'delete_all'", () => {
		try {
			validateManifest(["read", "delete_all"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("delete_all");
		}
	});

	it("rm — невалидный инструмент → InvalidToolManifestError с 'rm'", () => {
		try {
			validateManifest(["read", "rm"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("rm");
		}
	});

	it("exec — невалидный → InvalidToolManifestError с 'exec'", () => {
		try {
			validateManifest(["exec"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("exec");
		}
	});

	it("валидные инструменты + один невалидный → ошибка содержит невалидный", () => {
		try {
			validateManifest(["read", "write", "bash", "grep", "foo_tool"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("foo_tool");
		}
	});

	it("case-sensitive: 'Read' (заглавная) → InvalidToolManifestError с 'Read'", () => {
		try {
			validateManifest(["Read"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("Read");
		}
	});

	it("case-sensitive: 'BASH' → InvalidToolManifestError с 'BASH'", () => {
		try {
			validateManifest(["BASH"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("BASH");
		}
	});
});

// ─── TC-F37-3: toFlag ───────────────────────────────────────────────────────

describe("TC-F37-3: toFlag — конвертация манифеста в --tools флаг", () => {
	it('toFlag(["read","write","edit","bash"]) → "--tools read,write,edit,bash"', () => {
		expect(toFlag(["read", "write", "edit", "bash"])).toBe("--tools read,write,edit,bash");
	});

	it('toFlag(["read"]) → "--tools read"', () => {
		expect(toFlag(["read"])).toBe("--tools read");
	});

	it('toFlag(["read","bash","grep"]) → "--tools read,bash,grep"', () => {
		expect(toFlag(["read", "bash", "grep"])).toBe("--tools read,bash,grep");
	});

	it("toFlag([]) → пустая строка (edge case; не должен вызываться после validate)", () => {
		expect(toFlag([])).toBe("");
	});

	it("все 9 ALLOWED_TOOLS → полная строка", () => {
		const flag = toFlag([...ALLOWED_TOOLS]);
		expect(flag).toMatch(/^--tools /);
		// Все 9 имён присутствуют после "--tools "
		const toolsPart = flag.slice("--tools ".length);
		const tools = toolsPart.split(",");
		expect(tools).toHaveLength(9);
		for (const name of ALLOWED_TOOLS) {
			expect(tools).toContain(name);
		}
	});
});

// ─── TC-F37-1: isAllowed ────────────────────────────────────────────────────

describe("TC-F37-1: isAllowed — проверка допуска инструмента", () => {
	it('isAllowed(["read","bash"], "write") → { allowed: false }', () => {
		const result = isAllowed(["read", "bash"], "write");
		expect(result.allowed).toBe(false);
	});

	it("diag содержит \"tool 'write' not in manifest\"", () => {
		const result = isAllowed(["read", "bash"], "write");
		expect(result.diag).toBeDefined();
		expect(result.diag).toContain("tool");
		expect(result.diag).toContain("write");
		expect(result.diag).toContain("not in manifest");
	});

	it('isAllowed(["read","bash"], "read") → { allowed: true }', () => {
		const result = isAllowed(["read", "bash"], "read");
		expect(result.allowed).toBe(true);
	});

	it('isAllowed(["read","bash"], "bash") → { allowed: true }', () => {
		const result = isAllowed(["read", "bash"], "bash");
		expect(result.allowed).toBe(true);
	});

	it('isAllowed(["read"], "read") → { allowed: true } (единственный инструмент)', () => {
		const result = isAllowed(["read"], "read");
		expect(result.allowed).toBe(true);
	});

	it("diag отсутствует при allowed=true", () => {
		const result = isAllowed(["read", "bash"], "read");
		expect(result.diag).toBeUndefined();
	});

	it('isAllowed(["read","bash"], "edit") → diag содержит "\'edit\'"', () => {
		const result = isAllowed(["read", "bash"], "edit");
		expect(result.allowed).toBe(false);
		expect(result.diag).toContain("edit");
		expect(result.diag).toContain("not in manifest");
	});

	it('isAllowed(["read","bash"], "store_search") → { allowed: false }', () => {
		const result = isAllowed(["read", "bash"], "store_search");
		expect(result.allowed).toBe(false);
		expect(result.diag).toContain("store_search");
	});

	it("case-sensitive: 'Read' не совпадает с 'read'", () => {
		const result = isAllowed(["read"], "Read");
		expect(result.allowed).toBe(false);
	});
});

// ─── validateManifest: пустой массив → ошибка ───────────────────────────────

describe("validateManifest: пустой массив → InvalidToolManifestError", () => {
	it("[] → бросает InvalidToolManifestError", () => {
		expect(() => validateManifest([])).toThrow(InvalidToolManifestError);
	});

	it("сообщение содержит описание проблемы (пустой манифест)", () => {
		try {
			validateManifest([]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			// Сообщение должно описывать проблему: empty manifest
			expect(err.message.length).toBeGreaterThan(0);
		}
	});
});

// ─── validateManifest: не-массив → ошибка ───────────────────────────────────

describe("validateManifest: не-массив → InvalidToolManifestError", () => {
	it('"read" (строка) → InvalidToolManifestError', () => {
		expect(() => validateManifest("read")).toThrow(InvalidToolManifestError);
	});

	it("42 (число) → InvalidToolManifestError", () => {
		expect(() => validateManifest(42)).toThrow(InvalidToolManifestError);
	});

	it("{} (объект) → InvalidToolManifestError", () => {
		expect(() => validateManifest({ tools: ["read"] })).toThrow(InvalidToolManifestError);
	});

	it("true (boolean) → InvalidToolManifestError", () => {
		expect(() => validateManifest(true)).toThrow(InvalidToolManifestError);
	});
});

// ─── validateManifest: не-строки в массиве → ошибка ─────────────────────────

describe("validateManifest: не-строки в массиве → InvalidToolManifestError", () => {
	it("[1, 2] → InvalidToolManifestError", () => {
		expect(() => validateManifest([1, 2])).toThrow(InvalidToolManifestError);
	});

	it('["read", null] → InvalidToolManifestError', () => {
		expect(() => validateManifest(["read", null])).toThrow(InvalidToolManifestError);
	});

	it('["read", undefined] → InvalidToolManifestError', () => {
		expect(() => validateManifest(["read", undefined])).toThrow(InvalidToolManifestError);
	});

	it('["read", 42] → InvalidToolManifestError', () => {
		expect(() => validateManifest(["read", 42])).toThrow(InvalidToolManifestError);
	});

	it('["read", {}] → InvalidToolManifestError', () => {
		expect(() => validateManifest(["read", {}])).toThrow(InvalidToolManifestError);
	});

	it('["read", true] → InvalidToolManifestError', () => {
		expect(() => validateManifest(["read", true])).toThrow(InvalidToolManifestError);
	});

	it("[null] → InvalidToolManifestError", () => {
		expect(() => validateManifest([null])).toThrow(InvalidToolManifestError);
	});
});

// ─── validateManifest: дубликаты → ok (dedupe) ─────────────────────────────
//
// Решение: дубликаты принимаются и дедуплицируются. Манифест — allow-list;
// порядок первого появления сохраняется. Это совместимо с семантикой
// "набор разрешённых инструментов" (множество) и устойчиво к ошибкам
// конфигурации (повтор не фатален).

describe("validateManifest: дубликаты → dedupe (порядок первого появления)", () => {
	it('["read","read"] → ["read"] (один элемент)', () => {
		const result = validateManifest(["read", "read"]);
		expect(result).toEqual(["read"]);
	});

	it('["read","bash","read","write","bash"] → ["read","bash","write"]', () => {
		const result = validateManifest(["read", "bash", "read", "write", "bash"]);
		expect(result).toEqual(["read", "bash", "write"]);
	});

	it('["grep","grep","grep"] → ["grep"]', () => {
		const result = validateManifest(["grep", "grep", "grep"]);
		expect(result).toEqual(["grep"]);
	});
});

// ─── validateManifest: undefined/null → дефолтный манифест ──────────────────

describe("validateManifest: undefined/null → полный ALLOWED_TOOLS (дефолт)", () => {
	it("undefined → массив со всеми ALLOWED_TOOLS", () => {
		const result = validateManifest(undefined);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(ALLOWED_TOOLS.length);
		for (const tool of ALLOWED_TOOLS) {
			expect(result).toContain(tool);
		}
	});

	it("null → массив со всеми ALLOWED_TOOLS", () => {
		const result = validateManifest(null);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(ALLOWED_TOOLS.length);
		for (const tool of ALLOWED_TOOLS) {
			expect(result).toContain(tool);
		}
	});

	it("дефолтный манифест содержит все 9 инструментов", () => {
		const result = validateManifest(undefined);
		expect(result).toContain("read");
		expect(result).toContain("write");
		expect(result).toContain("edit");
		expect(result).toContain("bash");
		expect(result).toContain("grep");
		expect(result).toContain("find");
		expect(result).toContain("ls");
		expect(result).toContain("store_search");
		expect(result).toContain("store_install");
	});
});

// ─── validateManifest: все 9 допустимых имён ───────────────────────────────

describe("validateManifest: все 9 ALLOWED_TOOLS проходят валидацию", () => {
	it("каждый инструмент по отдельности → валиден", () => {
		for (const tool of ALLOWED_TOOLS) {
			const result = validateManifest([tool]);
			expect(result).toEqual([tool]);
		}
	});

	it("все 9 одновременно → валидны", () => {
		const result = validateManifest([...ALLOWED_TOOLS]);
		expect(result).toHaveLength(9);
		for (const tool of ALLOWED_TOOLS) {
			expect(result).toContain(tool);
		}
	});

	it("read → валиден", () => {
		expect(validateManifest(["read"])).toEqual(["read"]);
	});

	it("write → валиден", () => {
		expect(validateManifest(["write"])).toEqual(["write"]);
	});

	it("edit → валиден", () => {
		expect(validateManifest(["edit"])).toEqual(["edit"]);
	});

	it("bash → валиден", () => {
		expect(validateManifest(["bash"])).toEqual(["bash"]);
	});

	it("grep → валиден", () => {
		expect(validateManifest(["grep"])).toEqual(["grep"]);
	});

	it("find → валиден", () => {
		expect(validateManifest(["find"])).toEqual(["find"]);
	});

	it("ls → валиден", () => {
		expect(validateManifest(["ls"])).toEqual(["ls"]);
	});

	it("store_search → валиден", () => {
		expect(validateManifest(["store_search"])).toEqual(["store_search"]);
	});

	it("store_install → валиден", () => {
		expect(validateManifest(["store_install"])).toEqual(["store_install"]);
	});
});

// ─── ALLOWED_TOOLS константа ────────────────────────────────────────────────

describe("ALLOWED_TOOLS: константа допустимых имён", () => {
	it("содержит ровно 9 элементов", () => {
		expect(ALLOWED_TOOLS).toHaveLength(9);
	});

	it("содержит read, write, edit, bash, grep, find, ls, store_search, store_install", () => {
		expect(ALLOWED_TOOLS).toContain("read");
		expect(ALLOWED_TOOLS).toContain("write");
		expect(ALLOWED_TOOLS).toContain("edit");
		expect(ALLOWED_TOOLS).toContain("bash");
		expect(ALLOWED_TOOLS).toContain("grep");
		expect(ALLOWED_TOOLS).toContain("find");
		expect(ALLOWED_TOOLS).toContain("ls");
		expect(ALLOWED_TOOLS).toContain("store_search");
		expect(ALLOWED_TOOLS).toContain("store_install");
	});

	it("все элементы — непустые строки", () => {
		for (const tool of ALLOWED_TOOLS) {
			expect(typeof tool).toBe("string");
			expect(tool.length).toBeGreaterThan(0);
		}
	});

	it("нет дубликатов", () => {
		expect(new Set(ALLOWED_TOOLS).size).toBe(ALLOWED_TOOLS.length);
	});
});

// ─── validateManifest: возвращаемое значение ────────────────────────────────

describe("validateManifest: возвращает массив строк (копию)", () => {
	it("возвращает новый массив (не мутирует вход)", () => {
		const input = ["read", "write"];
		const result = validateManifest(input);
		expect(result).toEqual(["read", "write"]);
		expect(result).not.toBe(input); // не та же ссылка
	});

	it("результат — Array<string>", () => {
		const result = validateManifest(["read", "bash"]);
		expect(Array.isArray(result)).toBe(true);
		for (const item of result) {
			expect(typeof item).toBe("string");
		}
	});
});

// ─── validateManifest: opts.allowedTools override ────────────────────────────
//
// override — точка расширения допустимого набора без изменения кода
// (refactor-цель roadmap: вынести набор в конфигурацию). НЕ удалять.

describe("validateManifest: opts.allowedTools override расширяет допустимый набор", () => {
	it('с override ["read","custom_tool"] → "custom_tool" проходит валидацию', () => {
		const result = validateManifest(["read", "custom_tool"], { allowedTools: ["read", "custom_tool"] });
		expect(result).toEqual(["read", "custom_tool"]);
	});

	it('без override "custom_tool" → InvalidToolManifestError с именем', () => {
		try {
			validateManifest(["read", "custom_tool"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidToolManifestError);
			expect(err.message).toContain("custom_tool");
		}
	});
});

// ─── Интеграция: work-package + toolManifest ─────────────────────────────────
//
// F-27 (work-package.ts) уже имеет поле toolManifest и buildToolFlag/buildToolArgs.
// Тесты ниже проверяют, что манифест из пакета работ проходит валидацию
// tool-manifest (F-37) и конвертируется в spawn-аргументы.

describe("интеграция: work-package toolManifest → validateManifest → toFlag", () => {
	let createWorkPackage;
	let parseWorkPackage;
	let serializeWorkPackage;

	beforeAll(async () => {
		const wpMod = await import("../work-package.js");
		createWorkPackage = wpMod.createWorkPackage;
		parseWorkPackage = wpMod.parseWorkPackage;
		serializeWorkPackage = wpMod.serializeWorkPackage;
	});

	const VALID_WP_INPUT = {
		task: "Рефакторинг auth middleware",
		correlationId: "mission-abc/L1/node-1",
		depth: 1,
		tokenBudget: 50_000,
		deadline: "2026-08-15T00:00:00.000Z",
	};

	it("createWorkPackage с toolManifest → parseWorkPackage roundtrip", () => {
		const wp = createWorkPackage({
			...VALID_WP_INPUT,
			toolManifest: ["read", "bash", "grep"],
		});
		const serialized = serializeWorkPackage(wp);
		const restored = parseWorkPackage(serialized.message);
		expect(restored).not.toBeNull();
		expect(restored.toolManifest).toEqual(["read", "bash", "grep"]);
	});

	it("toolManifest из work-package проходит validateManifest", () => {
		const wp = createWorkPackage({
			...VALID_WP_INPUT,
			toolManifest: ["read", "write", "edit", "bash"],
		});
		const validated = validateManifest(wp.toolManifest);
		expect(validated).toEqual(["read", "write", "edit", "bash"]);
	});

	it("toFlag от wp.toolManifest → корректный --tools флаг", () => {
		const wp = createWorkPackage({
			...VALID_WP_INPUT,
			toolManifest: ["read", "write", "edit", "bash"],
		});
		expect(toFlag(wp.toolManifest)).toBe("--tools read,write,edit,bash");
	});

	it("toolManifest=[] в work-package → validateManifest бросает (пустой манифест)", () => {
		const wp = createWorkPackage({
			...VALID_WP_INPUT,
			toolManifest: [],
		});
		// work-package допускает toolManifest: [] (дефолт), но validateManifest
		// (F-37) считает пустой манифест ошибкой — интеграционная проверка.
		expect(() => validateManifest(wp.toolManifest)).toThrow(InvalidToolManifestError);
	});

	it("wp.toolManifest дефолт [] — валидация через undefined (дефолт = ALLOWED_TOOLS)", () => {
		const wp = createWorkPackage(VALID_WP_INPUT); // без toolManifest
		expect(wp.toolManifest).toEqual([]);
		// Интеграционное соглашение: пустой toolManifest в work-package
		// означает «все инструменты родителя» → validateManifest(undefined).
		const resolved = validateManifest(wp.toolManifest.length > 0 ? wp.toolManifest : undefined);
		expect(resolved).toHaveLength(ALLOWED_TOOLS.length);
	});
});

// ─── Интеграция: spawn-argv (process-manager / depth2-integration) ───────────
//
// F-37: при наличии toolManifest в пакете работ, spawn-аргументы дочернего
// fan server должны содержать --tools. depth2-integration.ts использует
// buildToolArgs из work-package.ts; tool-manifest.ts toFlag — альтернативный
// формат (строковый). Оба должны давать согласованный результат.

describe("интеграция: spawn-argv с --tools (process-manager / depth2-integration)", () => {
	let buildToolArgs;

	beforeAll(async () => {
		const wpMod = await import("../work-package.js");
		buildToolArgs = wpMod.buildToolArgs;
	});

	it("toFlag и buildToolArgs дают согласованный результат", () => {
		const manifest = ["read", "write", "edit", "bash"];
		const flag = toFlag(manifest);
		const args = buildToolArgs(manifest);
		// flag = "--tools read,write,edit,bash"
		// args = ["--tools", "read,write,edit,bash"]
		expect(flag).toBe(`--tools ${args[1]}`);
		expect(args[0]).toBe("--tools");
	});

	it("spawn argv содержит --tools при наличии toolManifest", () => {
		const manifest = validateManifest(["read", "bash"]);
		const args = buildToolArgs(manifest);
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		expect(args[toolsIdx + 1]).toBe("read,bash");
	});

	it("spawn argv содержит --tools для полного дефолтного манифеста", () => {
		const manifest = validateManifest(undefined); // все ALLOWED_TOOLS
		const args = buildToolArgs(manifest);
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		const toolsList = args[toolsIdx + 1].split(",");
		expect(toolsList).toHaveLength(9);
	});

	it("buildToolArgs от валидированного манифеста безопасен для child_process.spawn", () => {
		const manifest = validateManifest(["read", "write", "bash", "grep"]);
		const args = buildToolArgs(manifest);
		// Ровно 2 элемента: "--tools" и comma-joined список
		expect(args).toHaveLength(2);
		expect(args[0]).toBe("--tools");
		expect(args[1]).toBe("read,write,bash,grep");
		// Нет пробелов в comma-joined части (безопасно для argv)
		expect(args[1]).not.toContain(" ");
	});
});

// ─── Интеграция: isAllowed + diag-сообщение для tree-journal (tool_blocked) ──

describe("интеграция: isAllowed diag-формат совместим с tree-journal tool_blocked", () => {
	it("diag содержит имя инструмента — можно записать в tree-journal", () => {
		const result = isAllowed(["read", "bash"], "write");
		expect(result.allowed).toBe(false);
		// Формат: "tool 'write' not in manifest"
		// Это сообщение предназначено для записи в tree-journal как tool_blocked
		expect(result.diag).toMatch(/tool\s+'write'\s+not in manifest/);
	});

	it("diag для store_search — имя с underscore корректно", () => {
		const result = isAllowed(["read"], "store_search");
		expect(result.allowed).toBe(false);
		expect(result.diag).toContain("store_search");
	});

	it("diag для store_install — имя с underscore корректно", () => {
		const result = isAllowed(["read"], "store_install");
		expect(result.allowed).toBe(false);
		expect(result.diag).toContain("store_install");
	});
});

// ─── InvalidToolManifestError: структура ─────────────────────────────────────

describe("InvalidToolManifestError: структура класса", () => {
	it("наследник Error", () => {
		try {
			validateManifest(["not_a_tool"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(InvalidToolManifestError);
		}
	});

	it("имя ошибки — 'InvalidToolManifestError'", () => {
		try {
			validateManifest(["not_a_tool"]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err.name).toBe("InvalidToolManifestError");
		}
	});

	it("сериализуется в JSON (message сохраняется)", () => {
		try {
			validateManifest(["bad_tool"]);
			expect.fail("should have thrown");
		} catch (err) {
			const json = JSON.stringify(err, ["name", "message"]);
			const parsed = JSON.parse(json);
			expect(parsed.name).toBe("InvalidToolManifestError");
			expect(parsed.message).toContain("bad_tool");
		}
	});
});
