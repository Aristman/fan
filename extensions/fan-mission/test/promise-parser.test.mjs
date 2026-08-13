// F-16: Promise-tag parser — Red-фаза (TC-F16-1, TC-F16-2, TC-F16-3 + edge cases)
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-16
// Спека:     docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4
//
// Все тесты ожидают модуль `extensions/fan-mission/promise-parser.ts`,
// компилируемый в `promise-parser.js`. На момент Red-фазы модуль ещё
// не существует, поэтому `import` падает (ERR_MODULE_NOT_FOUND), и каждый
// `it` помечается как failing. После реализации модуля по контракту ниже
// тесты должны проходить.
//
// Контракт API (по карточке F-16 + спека §3.2.4):
//
//   parsePromise(response: string)
//     -> { tag: "COMPLETE"|"BLOCKED"|"DECIDE"|"FAILED", reason?: string } | null
//
//   Правила (из спеки §3.2.4):
//     1. Regex: /<promise>(COMPLETE|BLOCKED(?::[^\n<]+)?|DECIDE(?::[^\n<]+)?|FAILED(?::[^\n<]+)?)<\/promise>/
//     2. Теги внутри fenced code block (``` ``` ```) игнорируются
//     3. При нескольких тегах — последний валидный
//     4. BLOCKED без причины → reason: "не указана"
//     5. Отсутствие тега → null (эскалация I3 — на уровне контура, не парсера)
//
//   Эталонные форматы тегов (из спеки §3.2.4):
//     <promise>COMPLETE</promise>              — задача выполнена
//     <promise>BLOCKED:<причина></promise>     — блокер, нужна помощь
//     <promise>DECIDE:<вопрос></promise>       — требуется решение оператора
//     <promise>FAILED:<диагноз></promise>      — провал с диагностикой
//
// Callback эскалации `onUnknown()` (I3) — на уровне контура (F-17/F-22),
// а не парсера. Парсер остаётся чистой функцией, возвращающей null.
// Минимализм API: не расширяем parsePromise callback'ом.
//
// Refactor-цель (НЕ тестируется в Red-фазе; появится в Refactor-шаге):
//   stripCodeBlocks(text) — утилита для фильтрации fenced code blocks,
//   выделяется для переиспользования в аудите. Тесты выше покрывают её
//   поведение через parsePromise (end-to-end контракт).

import { describe, expect, it } from "vitest";

import { parsePromise } from "../promise-parser.js";

// ────────────────────────────────────────────────────────────────────────────
// TC-F16-1: Парсер извлекает все 4 типа тегов
// ────────────────────────────────────────────────────────────────────────────

describe("F-16 / TC-F16-1: парсер извлекает все 4 типа тегов", () => {
	it("COMPLETE без причины → { tag: 'COMPLETE' }", () => {
		expect(parsePromise("<promise>COMPLETE</promise>")).toEqual({
			tag: "COMPLETE",
		});
	});

	it("BLOCKED с причиной → { tag: 'BLOCKED', reason: 'нет доступа к БД' }", () => {
		expect(parsePromise("<promise>BLOCKED:нет доступа к БД</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "нет доступа к БД",
		});
	});

	it("DECIDE с вопросом → { tag: 'DECIDE', reason: 'JWT или session?' }", () => {
		expect(parsePromise("<promise>DECIDE:JWT или session?</promise>")).toEqual({
			tag: "DECIDE",
			reason: "JWT или session?",
		});
	});

	it("FAILED с диагнозом → { tag: 'FAILED', reason: 'ошибка сборки' }", () => {
		expect(parsePromise("<promise>FAILED:ошибка сборки</promise>")).toEqual({
			tag: "FAILED",
			reason: "ошибка сборки",
		});
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F16-2: Теги внутри fenced code block игнорируются
// ────────────────────────────────────────────────────────────────────────────

describe("F-16 / TC-F16-2: теги внутри fenced code block игнорируются", () => {
	it("тег внутри ``` ``` проигнорирован, тег снаружи — извлечён", () => {
		const response = [
			"Анализ показал следующие варианты:",
			"```",
			"<promise>COMPLETE</promise>",
			"```",
			"",
			"Тест упал, передаю тег выше:",
			"<promise>FAILED:ошибка</promise>",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "FAILED",
			reason: "ошибка",
		});
	});

	it("единственный тег в fenced code block → null", () => {
		const response = [
			"Примеры тегов:",
			"```",
			"<promise>COMPLETE</promise>",
			"```",
			"",
			"Никаких реальных тегов в выводе нет.",
		].join("\n");

		expect(parsePromise(response)).toBeNull();
	});

	it("тег между двумя ``` ``` блоками (вне обоих) — извлекается", () => {
		const response = [
			"```",
			"код 1",
			"```",
			"<promise>BLOCKED:между блоками</promise>",
			"```",
			"код 2",
			"```",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "BLOCKED",
			reason: "между блоками",
		});
	});

	it("один тег внутри ``` ``` и второй внутри ``` ``` → null (все игнорированы)", () => {
		const response = [
			"```",
			"<promise>COMPLETE</promise>",
			"```",
			"",
			"```",
			"<promise>FAILED:x</promise>",
			"```",
		].join("\n");

		expect(parsePromise(response)).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F16-3: Отсутствие тега → null
// ────────────────────────────────────────────────────────────────────────────

describe("F-16 / TC-F16-3: отсутствие тега → null", () => {
	it("произвольный текст без тегов → null", () => {
		const response = [
			"Я проанализировал код.",
			"Всё работает корректно.",
			"Можно переходить к следующему этапу.",
		].join("\n");

		expect(parsePromise(response)).toBeNull();
	});

	it("пустая строка → null", () => {
		expect(parsePromise("")).toBeNull();
	});

	it("текст с похожими, но не валидными тегами → null", () => {
		// Двойные кавычки, опечатки, неполные теги — не должны извлекаться.
		const response = [
			"<<promise>COMPLETE</promise>>",
			"<promise>complete</promise>",
			"<promise></promise>",
		].join("\n");

		expect(parsePromise(response)).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases: BLOCKED без причины, множественные теги, невалидные типы,
// пробелы вокруг, Unicode, незакрытые теги, мусор внутри тега
// ────────────────────────────────────────────────────────────────────────────

describe("F-16 / EDGE: BLOCKED без причины → reason 'не указана'", () => {
	it("BLOCKED без двоеточия и причины → { tag: 'BLOCKED', reason: 'не указана' }", () => {
		expect(parsePromise("<promise>BLOCKED</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "не указана",
		});
	});

	it("BLOCKED с пустой причиной после двоеточия → { tag: 'BLOCKED', reason: 'не указана' }", () => {
		// После ':' — перевод строки → regex [^\n<]+ не совпадает → причина пустая.
		expect(parsePromise("<promise>BLOCKED:\nfoo</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "не указана",
		});
	});

	it("COMPLETE без причины не получает поля reason", () => {
		// Правило «не указана» действует ТОЛЬКО для BLOCKED.
		// COMPLETE/DECIDE/FAILED без причины → reason отсутствует.
		const result = parsePromise("<promise>COMPLETE</promise>");
		expect(result).toEqual({ tag: "COMPLETE" });
		expect(result).not.toHaveProperty("reason");
	});
});

describe("F-16 / EDGE: при нескольких тегах возвращается последний валидный", () => {
	it("COMPLETE, потом BLOCKED → последний валидный (BLOCKED)", () => {
		const response = [
			"Сначала подумал, что готово:",
			"<promise>COMPLETE</promise>",
			"",
			"Но потом обнаружил блокер:",
			"<promise>BLOCKED:нет доступа</promise>",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "BLOCKED",
			reason: "нет доступа",
		});
	});

	it("два тега одного типа → последний (с последней причиной)", () => {
		const response = [
			"<promise>FAILED:первая ошибка</promise>",
			"Пробую снова:",
			"<promise>FAILED:вторая ошибка</promise>",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "FAILED",
			reason: "вторая ошибка",
		});
	});

	it("невалидный тег между двумя валидными → пропускается, берётся последний валидный", () => {
		const response = [
			"<promise>COMPLETE</promise>",
			"<promise>UNKNOWN:foo</promise>",
			"<promise>DECIDE:как поступить?</promise>",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "DECIDE",
			reason: "как поступить?",
		});
	});

	it("тег в code block + тег вне → берётся внешний", () => {
		const response = [
			"```",
			"<promise>BLOCKED:в коде</promise>",
			"```",
			"<promise>FAILED:реальная</promise>",
		].join("\n");

		expect(parsePromise(response)).toEqual({
			tag: "FAILED",
			reason: "реальная",
		});
	});
});

describe("F-16 / EDGE: невалидный тип тега → null", () => {
	it("UNKNOWN:x → null (нет совпадения в regex)", () => {
		expect(parsePromise("<promise>UNKNOWN:x</promise>")).toBeNull();
	});

	it("unknown в нижнем регистре → null", () => {
		expect(parsePromise("<promise>complete</promise>")).toBeNull();
	});

	it("октет в верхнем регистре с хвостом → null", () => {
		// 'COMPLETE_FOO' не совпадает с 'COMPLETE' (regex строгий).
		expect(parsePromise("<promise>COMPLETE_FOO</promise>")).toBeNull();
	});

	it("PROMISE вне тега не считается тегом обещания", () => {
		expect(parsePromise("PROMISE:COMPLETE</promise>")).toBeNull();
	});
});

describe("F-16 / EDGE: пробелы и переводы строк ВОКРУГ тега", () => {
	it("пробелы перед <promise> — тег извлекается", () => {
		expect(parsePromise("   <promise>COMPLETE</promise>")).toEqual({
			tag: "COMPLETE",
		});
	});

	it("переводы строк вокруг тега — тег извлекается", () => {
		const response = "\n\n<promise>BLOCKED:х</promise>\n\n";
		expect(parsePromise(response)).toEqual({
			tag: "BLOCKED",
			reason: "х",
		});
	});

	it("тег в середине произвольного текста — причина извлекается без пробелов", () => {
		// Regex '[^\n<]+' для reason не включает пробелы вокруг, только содержимое.
		const response = "предыдущий текст <promise>DECIDE:выбор</promise> последующий текст";
		expect(parsePromise(response)).toEqual({
			tag: "DECIDE",
			reason: "выбор",
		});
	});
});

describe("F-16 / EDGE: Unicode и многословные причины", () => {
	it("Unicode (кириллица + эмодзи) в причине — сохраняется 1:1", () => {
		expect(parsePromise("<promise>BLOCKED:ошибка БД 🚨</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "ошибка БД 🚨",
		});
	});

	it("многословная причина с пробелами — сохраняется", () => {
		expect(parsePromise("<promise>FAILED:не удалось собрать модуль auth из-за конфликта зависимостей</promise>")).toEqual({
			tag: "FAILED",
			reason: "не удалось собрать модуль auth из-за конфликта зависимостей",
		});
	});

	it("причина с пунктуацией (запятая, точка, вопрос) — сохраняется", () => {
		expect(parsePromise("<promise>DECIDE:использовать Redis, или Memcached?</promise>")).toEqual({
			tag: "DECIDE",
			reason: "использовать Redis, или Memcached?",
		});
	});

	it("причина с двоеточием внутри (json, url) — сохраняется", () => {
		// Только первое ':' — разделитель, остальные — часть причины.
		// Regex жадно матчит [^\n<]+, поэтому 'http://x' будет частью reason.
		expect(parsePromise("<promise>BLOCKED:endpoint http://api.example.com не отвечает</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "endpoint http://api.example.com не отвечает",
		});
	});
});

describe("F-16 / EDGE: невалидные / незакрытые / мусорные теги", () => {
	it("незакрытый тег <promise>COMPLETE → null", () => {
		expect(parsePromise("<promise>COMPLETE")).toBeNull();
	});

	it("незакрытый тег <promise>BLOCKED:х → null", () => {
		expect(parsePromise("<promise>BLOCKED:х")).toBeNull();
	});

	it("открытый тег без </promise> в окружении текста → null", () => {
		const response = [
			"начало",
			"<promise>FAILED:ошибка",
			"продолжение без закрытия",
		].join("\n");
		expect(parsePromise(response)).toBeNull();
	});

	it("<promise> с мусором между <promise> и типом → null", () => {
		// Regex требует <promise>TYPE буквально; пробел/мусор между недопустим.
		expect(parsePromise("<promise> COMPLETE</promise>")).toBeNull();
		expect(parsePromise("<promise>\nBLOCKED:х</promise>")).toBeNull();
	});

	it("HTML-подобная обёртка <promise><b>FAILED</b></promise> → null", () => {
		// Вложенные теги ломают структуру: regex требует сразу тип после <promise>.
		expect(parsePromise("<promise><b>FAILED</b></promise>")).toBeNull();
	});

	it("тег с символом '<' внутри reason → null (regex [^\n<]+ запрещает <)", () => {
		// '<foo>' внутри reason прерывает матч на '<', </promise> не следует сразу.
		expect(parsePromise("<promise>BLOCKED:причина<foo></promise>")).toBeNull();
	});

	it("лишние угловые скобки вокруг тега → null", () => {
		// <<promise>COMPLETE</promise>> — вторая '<' слева ломает regex.
		expect(parsePromise("<<promise>COMPLETE</promise>>")).toBeNull();
	});

	it("тег в кавычках как часть строки → null", () => {
		// Это просто текст, не тег.
		expect(parsePromise('текст "<promise>COMPLETE</promise>"')).toBeNull();
	});
});

describe("F-16 / EDGE: детерминированность и идемпотентность", () => {
	it("многократный вызов на одном ответе возвращает тот же результат", () => {
		const response = "<promise>BLOCKED:причина</promise>";
		const first = parsePromise(response);
		const second = parsePromise(response);
		const third = parsePromise(response);
		expect(first).toEqual(second);
		expect(second).toEqual(third);
	});

	it("не мутирует входную строку", () => {
		const response = "<promise>FAILED:х</promise>";
		const before = JSON.stringify(response);
		parsePromise(response);
		parsePromise(response);
		expect(JSON.stringify(response)).toBe(before);
	});

	it("возвращает plain object (или null), без Symbol/iterator-артефактов", () => {
		// Сравнение «по структуре» — Object.keys в ожидаемом порядке,
		// для COMPLETE — единственный ключ 'tag'.
		const result = parsePromise("<promise>COMPLETE</promise>");
		expect(Object.keys(result)).toEqual(["tag"]);
	});
});
