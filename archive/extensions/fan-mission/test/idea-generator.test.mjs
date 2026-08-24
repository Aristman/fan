// F-19: Генератор идей — Red-фаза
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-19
// Спека:     docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3
//            (генерация и оценка идей, протокол «5 вопросов»).
//
// Все тесты ожидают модуль `extensions/fan-mission/idea-generator.ts`, компилируемый
// в `idea-generator.js`. На момент Red-фазы модуль не существует — динамический
// import в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит его,
// символ `createIdeaGenerator` остаётся undefined. Файл при этом ЗАГРУЖАЕТСЯ,
// все it-блоки собираются и падают ИНДИВИДУАЛЬНО на вызове undefined (правильный
// TDD Red: тесты запускаются и падают, а не «файл не загрузился»). После
// реализации модуля по контракту ниже тесты должны пройти.
//
// ────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ API (DI-стиль, для Green-фазы)
// ────────────────────────────────────────────────────────────────────────────
//
//   createIdeaGenerator(opts?: {
//     llm?: (prompt: string) => Promise<string>,   // DI mock LLM; промпт → raw-ответ
//     now?: () => Date | Promise<Date>,              // DI clock; default () => new Date()
//   }): IdeaGenerator
//
//   interface IdeaGenerator {
//     buildPrompt(missionDir: string): Promise<string>
//     generate(missionDir: string): Promise<{ added: number; skippedDuplicates: number }>
//   }
//
// ─── Формат ответа LLM (ЗАФИКСИРОВАН) ────────────────────────────────────────
//   LLM возвращает raw-строку, содержащую JSON-массив кандидатов:
//     [{ "idea": "<текст идеи>", "source": "<источник>" }, ...]
//   Генератор извлекает JSON из ответа (ответ может быть обёрнут прозой или
//   fenced code block «```json ... ```»), парсит массив и берёт поле `idea`
//   (и опциональное `source`; если `source` отсутствует — дефолт "idea-generator").
//   JSON выбран вместо маркдаун-списков «- идея» ради надёжности парсинга.
//
// ─── Поведение generate(missionDir) ───────────────────────────────────────────
//   1. Читает количество завершённых итераций: `currentIteration` из
//      `.mission-loop.json` (или, при отсутствии файла, длину «Сделано» в STATE.md).
//   2. Читает «итерацию последней генерации» (lastGenerationIteration) с диска
//      (файл `.mission-ideas.json` вида `{ "lastGenerationIteration": <n> }`,
//      default 0 при отсутствии). Процессы смертны по дизайну спеки — состояние
//      генерации персистентно на диске, не в памяти.
//   3. Если (currentIteration − lastGenerationIteration) < 3 → НЕ вызывает llm,
//      возвращает { added: 0, skippedDuplicates: 0 }. («минимум 1 идея на каждые
//      3 завершённых итерации»: порог — 3 итерации с последней генерации.)
//   4. Иначе: buildPrompt(missionDir) → llm(prompt) → парсит JSON-массив идей →
//      дедупликация против существующих записей BACKLOG.md (нормализованное
//      сравнение: lowercase + trim + схлопывание внутренних пробелов) →
//      добавляет уникальные идеи в BACKLOG.md (format таблицы фикстуры:
//      | id | date | idea | source | fit | value | risk | cost | score | status |)
//      → обновляет lastGenerationIteration = currentIteration на диске →
//      возвращает { added: <кол-во уникальных>, skippedDuplicates: <кол-во дублей> }.
//   5. LLM вернул невалидный JSON / мусор → added: 0, BACKLOG не испорчен, без throw.
//   6. LLM вернул пустой массив [] → added: 0, skippedDuplicates: 0.
//   7. LLM бросил ошибку → generate НЕ выбрасывает, возвращает { added: 0,
//      skippedDuplicates: 0 } (контур не должен умирать из-за генерации идей).
//   8. Записи BACKLOG создаются с: id (idea-NNN, zero-padded последовательный,
//      продолжается от максимального существующего номера или с idea-001),
//      date = now().toISOString(), idea, source, fit/value/risk/cost/score = 0
//      (плейсхолдеры до скоринга F-20), status = "IDEA".
//
// ─── Поведение buildPrompt(missionDir) ───────────────────────────────────────
//   - Читает STATE.md (сделано/блокеры); если readState бросает (файл отсутствует
//     или невалиден) — трактует как пустые массивы (robust).
//   - Читает ROADMAP.md (незавершённые пункты «- [ ]»).
//   - Возвращает промпт, содержащий протокол «5 вопросов» (спека §3.1.3):
//       (1) какая цель?            → подстрока «цель»
//       (2) какой критерий успеха? → подстрока «критер»
//       (3) какие риски?           → подстрока «риск»
//       (4) какая оценка стоимости?→ подстрока «стоимост»
//       (5) есть ли метрика?       → подстрока «метрик»
//   - Промпт содержит контекст из STATE.md (записи «Сделано» + «Блокеры»).
//   - НЕ вызывает llm (buildPrompt только формирует строку).
//   - На пустом/отсутствующем STATE.md промпт всё равно валиден (5 вопросов есть).
//
// ─── Red-фаза ─────────────────────────────────────────────────────────────────
//   На момент написания idea-generator.ts не существует → createIdeaGenerator
//   undefined → каждый it падает на «createIdeaGenerator is not a function»
//   (или на undefined.generate/undefined.buildPrompt). Существующие 354 теста
//   fan-mission не затронуты (динамический import изолирован в beforeAll).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBacklog, initMission, readBacklog } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля под верификацию (SUT). На Red-фазе модуля нет — динамический
// import выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит, символ остаётся
// undefined. Файл теста при этом ЗАГРУЖАЕТСЯ, все it-блоки собираются и падают
// ИНДИВИДУАЛЬНО на вызове undefined-символа. На Green-фазе import подтянет символ.
// ────────────────────────────────────────────────────────────────────────────

let createIdeaGenerator;

beforeAll(async () => {
	try {
		({ createIdeaGenerator } = await import("../idea-generator.js"));
	} catch {
		// Red: idea-generator.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock LLM, mock clock, временный missionDir, STATE/ROADMAP/loop-state
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт mock llm (async-функция с полем .calls[]) — стиль makeRunCommand из
 * verification-ladder.test.mjs. impl может быть:
 *   - string            → всегда возвращает эту строку
 *   - Array             → возвращает по индексу вызова (последний — на исчерпание)
 *   - function          → вызывает fn(prompt)
 *   - { throw: "<msg>" } → бросает Error(msg) (edge «LLM упал»)
 */
function makeMockLlm(impl) {
	const calls = [];
	const fn = async (prompt) => {
		calls.push(prompt);
		let entry = impl;
		if (Array.isArray(impl)) {
			entry = impl[Math.min(calls.length - 1, impl.length - 1)];
		}
		if (typeof entry === "function") {
			return entry(prompt);
		}
		if (entry !== null && typeof entry === "object" && "throw" in entry) {
			throw new Error(entry.throw);
		}
		return entry; // string
	};
	fn.calls = calls;
	return fn;
}

/** Создать mock clock, всегда возвращающий одну и ту же дату (детерминизм). */
function makeMockClock(iso = "2026-08-13T12:00:00.000Z") {
	const d = new Date(iso);
	return () => d;
}

/** Обернуть массив идей в JSON-строку (raw LLM-ответ). */
function llmJson(ideas) {
	return JSON.stringify(ideas);
}

/** Свежий tmp-каталог для теста. */
function freshBaseDir(prefix = "fan-f19-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Записать STATE.md с заданными done/blockers/nextSteps (формат file-state-manager). */
function writeState(missionDir, { done = [], blockers = [], nextSteps = [] } = {}) {
	const lines = ["## Сделано"];
	for (const d of done) lines.push(`- ${d}`);
	lines.push("", "## Блокеры");
	for (const b of blockers) lines.push(`- ${b}`);
	lines.push("", "## Следующие шаги");
	for (const n of nextSteps) lines.push(`- ${n}`);
	lines.push("");
	writeFileSync(join(missionDir, "STATE.md"), lines.join("\n"), "utf8");
}

/** Записать .mission-loop.json с заданным currentIteration. */
function writeLoopState(missionDir, currentIteration) {
	writeFileSync(
		join(missionDir, ".mission-loop.json"),
		JSON.stringify(
			{
				currentIteration,
				lastStep: 7,
				interrupted: false,
				budgetUsed: { tokens: 0, usd: 0 },
			},
			null,
			2,
		),
		"utf8",
	);
}

/** Записать ROADMAP.md со списком пунктов (mix «- [x] done» / «- [ ] undone»). */
function writeRoadmap(missionDir, items) {
	const lines = ["# Roadmap", ""];
	for (const it of items) lines.push(it);
	lines.push("");
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

/**
 * Создать mission-директорию с заданным числом «завершённых итераций».
 * doneCount → STATE.md «Сделано» содержит doneCount записей И .mission-loop.json
 * currentIteration = doneCount (оба источника согласованы — контракт допускает
 * чтение итераций из любого из них).
 */
async function makeMission({
	doneCount = 0,
	blockers = [],
	roadmapItems = null,
	baseDir,
}) {
	const missionDir = await initMission("f19-test", { baseDir });
	const done = [];
	for (let i = 1; i <= doneCount; i++) done.push(`итерация ${i}: завершена`);
	writeState(missionDir, { done, blockers });
	writeLoopState(missionDir, doneCount);
	if (roadmapItems) writeRoadmap(missionDir, roadmapItems);
	return missionDir;
}

/** Записать готовую запись BACKLOG (format таблицы фикстуры) — для предзаполнения. */
function seedBacklogEntry(missionDir, entry) {
	return appendBacklog(missionDir, {
		fit: 0,
		value: 0,
		risk: 0,
		cost: 0,
		score: 0,
		status: "IDEA",
		...entry,
	});
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F19-1: Генератор создаёт ≥1 идеи после 3 итераций
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / TC-F19-1: генератор создаёт ≥1 идеи после 3 итераций", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-tc1-");
		missionDir = await makeMission({
			doneCount: 3,
			blockers: [],
			roadmapItems: ["- [x] bootstrap", "- [ ] pending item A", "- [ ] pending item B"],
			baseDir,
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("после 3 завершённых итераций BACKLOG.md пополнен ≥1 записью", async () => {
		const ideas = [
			{ idea: "Добавить кэширование Redis", source: "итерация #3" },
			{ idea: "Рефакторинг логирования", source: "итерация #3" },
			{ idea: "Параллелизировать сборку", source: "итерация #3" },
		];
		const llm = makeMockLlm(llmJson(ideas));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		// Критерий карточки: ≥1 идея после 3 итераций.
		expect(result.added).toBeGreaterThanOrEqual(1);
		// 3 уникальные идеи → ровно 3 добавлено.
		expect(result.added).toBe(3);

		// BACKLOG.md пополнен в формате таблицы (readBacklog разбирает записи).
		const entries = await readBacklog(missionDir);
		expect(entries.length).toBeGreaterThanOrEqual(3);
		const ideasInBacklog = entries.map((e) => e.idea);
		for (const idea of ideas.map((i) => i.idea)) {
			expect(ideasInBacklog).toContain(idea);
		}
	});

	it("llm вызван ровно 1 раз", async () => {
		const llm = makeMockLlm(llmJson([{ idea: "одна идея", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		await gen.generate(missionDir);
		expect(llm.calls.length).toBe(1);
	});

	it("новые записи BACKLOG в формате таблицы (id, date, idea, source)", async () => {
		const llm = makeMockLlm(llmJson([{ idea: "Идея А", source: "src-a" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock("2026-08-13T09:00:00.000Z") });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const newEntry = entries.find((e) => e.idea === "Идея А");
		expect(newEntry).toBeTruthy();
		// id — непустая строка (формат idea-NNN проверяется в EDGE ниже).
		expect(typeof newEntry.id).toBe("string");
		expect(newEntry.id.length).toBeGreaterThan(0);
		// date — присутствует (ISO-формат проверяется в EDGE ниже).
		expect(newEntry.date).toBeTruthy();
		// source — из ответа LLM.
		expect(newEntry.source).toBe("src-a");
		// Запись валидна как строка таблицы: fit/value/risk/cost/score/status есть.
		expect(typeof newEntry.status).toBe("string");
		expect(newEntry.status.length).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F19-2: Генератор не дублирует идеи
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / TC-F19-2: генератор не дублирует идеи", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-tc2-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
		// BACKLOG.md уже содержит идею «Рефакторинг auth middleware».
		await seedBacklogEntry(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "Рефакторинг auth middleware",
			source: "итерация #1",
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("дубликат с вариациями регистра/пробелов отфильтрован (нормализация)", async () => {
		const llm = makeMockLlm(
			llmJson([{ idea: "рефакторинг  AUTH middleware", source: "итерация #3" }]),
		);
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		// Дубликат отфильтрован: 0 добавлено, ≥1 пропущен.
		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBeGreaterThanOrEqual(1);

		// BACKLOG не получил вторую запись — осталась одна, исходная.
		const entries = await readBacklog(missionDir);
		expect(entries.length).toBe(1);
		expect(entries[0].idea).toBe("Рефакторинг auth middleware");
	});

	it("если все идеи — дубли, added = 0 и skippedDuplicates считает их", async () => {
		const llm = makeMockLlm(
			llmJson([{ idea: "РЕФАКТОРИНГ  auth  MIDDLEWARE", source: "s1" }]),
		);
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F19-3: Протокол «5 вопросов» формирует контекст
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / TC-F19-3: протокол «5 вопросов» формирует контекст", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-tc3-");
		missionDir = await makeMission({
			doneCount: 3,
			blockers: ["нет доступа к staging БД"],
			roadmapItems: ["- [x] bootstrap", "- [ ] реализовать JWT auth", "- [ ] добавить метрики миссии"],
			baseDir,
		});
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("buildPrompt содержит 5 структурированных вопросов (цель/критерий/риски/стоимость/метрика)", async () => {
		// llm НЕ передаём — buildPrompt не должен его вызывать.
		const gen = createIdeaGenerator({ now: makeMockClock() });
		const prompt = await gen.buildPrompt(missionDir);

		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);

		// Регистронезависимо (toLowerCase корректно работает с кириллицей).
		const p = prompt.toLowerCase();
		expect(p).toContain("цель");
		expect(p).toContain("критер");
		expect(p).toContain("риск");
		expect(p).toContain("стоимост");
		expect(p).toContain("метрик");
	});

	it("buildPrompt содержит контекст из STATE.md (сделано/блокеры)", async () => {
		const gen = createIdeaGenerator({ now: makeMockClock() });
		const prompt = await gen.buildPrompt(missionDir);

		// Запись из «Сделано» (done-итерации).
		expect(prompt).toContain("итерация 1");
		// Запись из «Блокеры».
		expect(prompt).toContain("staging БД");
	});

	it("buildPrompt содержит незавершённые пункты ROADMAP", async () => {
		const gen = createIdeaGenerator({ now: makeMockClock() });
		const prompt = await gen.buildPrompt(missionDir);

		// Незавершённый пункт ROADMAP попадает в контекст.
		expect(prompt).toContain("JWT auth");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: итераций < 3 с последней генерации → { added:0 }, llm НЕ вызывается
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: итераций < 3 с последней генерации → skip, llm НЕ вызывается", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-thr-");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("currentIteration=2 → { added:0, skippedDuplicates:0 }, llm не вызван", async () => {
		missionDir = await makeMission({ doneCount: 2, baseDir });
		const llm = makeMockLlm(llmJson([{ idea: "не должна сгенериться", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBe(0);
		expect(llm.calls.length).toBe(0);
	});

	it("currentIteration=0 (нет итераций) → { added:0 }, llm не вызван", async () => {
		missionDir = await makeMission({ doneCount: 0, baseDir });
		const llm = makeMockLlm(llmJson([{ idea: "не должна сгенериться", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		expect(result.added).toBe(0);
		expect(llm.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: повторный generate на той же итерации → skip (since-last-gen tracking)
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: «с последней генерации» — повторный вызов skip", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-since-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("второй generate на той же iter=3 → added:0, llm вызван 1 раз суммарно", async () => {
		const llm = makeMockLlm(llmJson([{ idea: "идея раз", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });

		const r1 = await gen.generate(missionDir); // iter=3, lastGen=0 → генерит
		expect(r1.added).toBe(1);

		const r2 = await gen.generate(missionDir); // iter=3, lastGen=3 → 0<3 → skip
		expect(r2.added).toBe(0);

		// llm вызван ровно 1 раз за оба вызова.
		expect(llm.calls.length).toBe(1);
	});

	it("новый экземпляр генератора тоже skip (lastGen персистентен на диске)", async () => {
		// Процессы смертны по спеке — lastGen обязан переживать рестарт (быть на диске).
		const llm1 = makeMockLlm(llmJson([{ idea: "идея раз", source: "s" }]));
		const gen1 = createIdeaGenerator({ llm: llm1, now: makeMockClock() });
		await gen1.generate(missionDir); // iter=3 → генерит, lastGen=3 на диске

		// Новый экземпляр + свежий llm-mock: lastGen=3 прочитан с диска → skip.
		const llm2 = makeMockLlm(llmJson([{ idea: "другая идея", source: "s" }]));
		const gen2 = createIdeaGenerator({ llm: llm2, now: makeMockClock() });
		const r2 = await gen2.generate(missionDir);

		expect(r2.added).toBe(0);
		expect(llm2.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM вернул невалидный JSON / мусор → added:0, BACKLOG не испорчен
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: LLM вернул невалидный JSON → added:0, без throw, BACKLOG цел", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-garbage-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("мусорный текст (не JSON) → added:0, generate не выбрасывает, BACKLOG без новых записей", async () => {
		const llm = makeMockLlm("это вообще не json, просто проза без массива");
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });

		const result = await gen.generate(missionDir); // не бросает
		expect(result.added).toBe(0);

		// BACKLOG не испорчен: новых записей нет.
		const entries = await readBacklog(missionDir);
		expect(entries.length).toBe(0);
	});

	it("частичный/битый JSON в code-fence → added:0, без throw", async () => {
		const llm = makeMockLlm("```json\n[{ \"idea\": \"битая идея\" , broken\n```");
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });

		const result = await gen.generate(missionDir);
		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM вернул пустой массив → added:0
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: LLM вернул пустой массив → added:0", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-empty-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("llm возвращает '[]' → { added:0, skippedDuplicates:0 }", async () => {
		const llm = makeMockLlm("[]");
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		const result = await gen.generate(missionDir);

		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBe(0);

		const entries = await readBacklog(missionDir);
		expect(entries.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM бросает ошибку → generate НЕ падает, added:0
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: LLM бросает ошибку → generate НЕ падает, added:0", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-throw-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("llm throw → { added:0 }, generate не выбрасывает", async () => {
		const llm = makeMockLlm({ throw: "LLM unavailable: 503" });
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });

		// Контур не должен умирать из-за генерации идей.
		const result = await gen.generate(missionDir);
		expect(result.added).toBe(0);
		expect(result.skippedDuplicates).toBe(0);

		// llm был вызван (попытка), но упал — обработано gracefully.
		expect(llm.calls.length).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: ID идей уникальны и последовательны (idea-001, idea-002...)
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: ID идей уникальны и последовательны (idea-NNN)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-ids-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("3 новые идеи на пустом BACKLOG → idea-001, idea-002, idea-003", async () => {
		const llm = makeMockLlm(
			llmJson([
				{ idea: "идея один", source: "s" },
				{ idea: "идея два", source: "s" },
				{ idea: "идея три", source: "s" },
			]),
		);
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const ids = entries.map((e) => e.id);
		expect(ids).toEqual(["idea-001", "idea-002", "idea-003"]);
		// Формат: zero-padded 3 цифры.
		for (const id of ids) {
			expect(id).toMatch(/^idea-\d{3}$/);
		}
	});

	it("ID продолжаются от максимального существующего номера (idea-005 → idea-006...)", async () => {
		await seedBacklogEntry(missionDir, {
			id: "idea-005",
			date: "2026-08-10",
			idea: "существующая идея",
			source: "s",
		});
		const llm = makeMockLlm(
			llmJson([
				{ idea: "новая идея A", source: "s" },
				{ idea: "новая идея B", source: "s" },
			]),
		);
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const newIds = entries.filter((e) => e.idea.startsWith("новая идея")).map((e) => e.id);
		expect(newIds).toEqual(["idea-006", "idea-007"]);
	});

	it("ID уникальны — нет повторов с существующими записями", async () => {
		await seedBacklogEntry(missionDir, {
			id: "idea-001",
			date: "2026-08-10",
			idea: "существующая идея",
			source: "s",
		});
		const llm = makeMockLlm(llmJson([{ idea: "уникальная новая", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const ids = entries.map((e) => e.id);
		// Никаких дублей ID.
		expect(new Set(ids).size).toBe(ids.length);
		// Существующий idea-001 не переиспользован.
		const newId = entries.find((e) => e.idea === "уникальная новая").id;
		expect(newId).not.toBe("idea-001");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: дата записи — ISO, детерминирована через DI clock
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: дата записи — ISO, детерминирована через DI clock", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-date-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("entry.date === now().toISOString()", async () => {
		const iso = "2026-08-13T09:30:00.000Z";
		const llm = makeMockLlm(llmJson([{ idea: "идея с датой", source: "s" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock(iso) });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.idea === "идея с датой");
		expect(entry).toBeTruthy();
		expect(entry.date).toBe(iso);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: пустой STATE.md → buildPrompt валиден, генерация не падает
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: пустой STATE.md → buildPrompt валиден (5 вопросов есть)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-empty-state-");
		// doneCount=0 → STATE.md с пустыми секциями «Сделано»/«Блокеры».
		missionDir = await makeMission({ doneCount: 0, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("buildPrompt на пустом STATE не бросает и содержит 5 вопросов", async () => {
		const gen = createIdeaGenerator({ now: makeMockClock() });
		const prompt = await gen.buildPrompt(missionDir);

		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
		const p = prompt.toLowerCase();
		expect(p).toContain("цель");
		expect(p).toContain("критер");
		expect(p).toContain("риск");
		expect(p).toContain("стоимост");
		expect(p).toContain("метрик");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: unicode в идеях сохраняется 1:1
// ────────────────────────────────────────────────────────────────────────────

describe("F-19 / EDGE: unicode в идеях сохраняется 1:1", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f19-edge-unicode-");
		missionDir = await makeMission({ doneCount: 3, baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("кириллица + эмодзи + спецсимволы в идее сохраняются в BACKLOG без потерь", async () => {
		const unicodeIdea = "Рефакторинг аутентификации — использовать JWT 🔐 с кириллицей";
		const llm = makeMockLlm(llmJson([{ idea: unicodeIdea, source: "итерация №3" }]));
		const gen = createIdeaGenerator({ llm, now: makeMockClock() });
		await gen.generate(missionDir);

		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.idea === unicodeIdea);
		expect(entry).toBeTruthy();
		// Unicode сохранён 1:1 (включая тире, эмодзи, №).
		expect(entry.idea).toBe(unicodeIdea);
		expect(entry.source).toBe("итерация №3");
	});
});
