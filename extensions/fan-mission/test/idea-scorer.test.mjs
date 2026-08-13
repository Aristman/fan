// F-20: Скорер идей (гибридный LLM + арифметика) — Red-фаза
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-20
// Спека:     docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3
//            (генерация и оценка идей, гибридный скоринг).
//
// Все тесты ожидают модуль `extensions/fan-mission/idea-scorer.ts`, компилируемый
// в `idea-scorer.js`. На момент Red-фазы модуль не существует — динамический
// import в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит его,
// символ `createIdeaScorer` остаётся undefined. Файл при этом ЗАГРУЖАЕТСЯ,
// все it-блоки собираются и падают ИНДИВИДУАЛЬНО на вызове undefined (правильный
// TDD Red: тесты запускаются и падаются, а не «файл не загрузился»). После
// реализации модуля по контракту ниже тесты должны пройти.
//
// ────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ API (DI-стиль, для Green-фазы)
// ────────────────────────────────────────────────────────────────────────────
//
//   createIdeaScorer(opts?: {
//     llm?: (prompt: string) => Promise<string>,     // DI mock LLM; промпт → raw-ответ
//     requestDecision?: (question: string) => void,  // DI callback DECIDE-прерывания (эмуляция missionLoop)
//     now?: () => Date | Promise<Date>,               // DI clock; default () => new Date()
//   }): IdeaScorer
//
//   interface IdeaScorer {
//     // Чистая детерминированная формула (без side-эффектов, БЕЗ clamp —
//     // clamp — ответственность scoreIdea, см. ниже):
//     computeScore(scores: { relevance: number; value: number; risk: number; cost: number }): number
//     // score = 0.3*relevance + 0.2*value + 0.2*(1-risk) + 0.3*(1-cost)
//
//     // Полный цикл скоринга одной идеи:
//     scoreIdea(missionDir: string, idea: { id: string; idea: string; source: string })
//       : Promise<{ id: string; score: number; status: "ROADMAP" | "DECIDE" | "REJECTED" }>
//   }
//
// ─── Формула (ЗАФИКСИРОВАНА, спека §3.1.3) ────────────────────────────────────
//   score = 0.3 × relevance + 0.2 × value + 0.2 × (1 − risk) + 0.3 × (1 − cost)
//   Веса: 0.3 / 0.2 / 0.2 / 0.3 (сумма 1.0). Чистая функция: один вход → один
//   выход, несколько вызовов с одинаковым входом дают идентичный результат.
//   computeScore НЕ делает clamp — формула применяется к полученным числам
//   как есть (чистота и предсказуемость для тестов весов/воспроизводимости).
//
// ─── Формат ответа LLM (ЗАФИКСИРОВАН) ──────────────────────────────────────────
//   llm(prompt) → raw-строка, содержащая JSON-ОБЪЕКТ с 4 числовыми полями 0.0–1.0:
//     { "relevance": <0..1>, "value": <0..1>, "risk": <0..1>, "cost": <0..1> }
//   Скорер извлекает JSON из ответа (ответ может быть обёрнут прозой или fenced
//   code block «```json ... ```» — как в idea-generator). JSON выбран ради
//   надёжности парсинга. relevance LLM-ответа маппится в поле BACKLOG `fit`
//   (имя поля BACKLOG: fit, см. backlog-format.ts / фикстуру BACKLOG.md).
//
// ─── Поведение scoreIdea(missionDir, idea) ───────────────────────────────────
//   1. Формирует промпт (рубрика): содержит ТЕКСТ ИДЕИ + 4 критерия рубрики
//      (соответствие / ценность / риск / стоимость) + запрос JSON-ответа.
//      Промпт — на русском (стиль проекта, как idea-generator). llm НЕ нужен
//      для формирования промпта (только для вызова).
//   2. llm(prompt) → raw-ответ.
//   3. Извлекает JSON-объект { relevance, value, risk, cost }. Ответ должен быть
//      JSON-объектом с 4 числовыми полями. Невалидный JSON / не-объект / поля
//      отсутствуют / значения не-числа → БРОСАЕТ Error("invalid scorer response")
//      (скоринг не должен угадывать; контур обработает ошибку).
//   4. CLAMP каждого критерия в [0, 1]: relevance/value/risk/cost > 1 → 1,
//      < 0 → 0. (clamp — до computeScore; в BACKLOG логируются CLAMPED-значения,
//      см. ниже.)
//   5. computeScore(clamped) → score.
//   6. ПОРОГИ (спека §3.1.3):
//        score >= 0.7  → статус "ROADMAP"  (идея одобрена для плана)
//        0.5 <= score < 0.7 → статус "DECIDE" (DECIDE-прерывание оператору)
//        score < 0.5  → статус "REJECTED"  (отклонить, причина в DECISIONS.md)
//      FP-РОБАСТНОСТЬ: для точных границ (математически 0.7 / 0.5) реализация
//      ДОЛЖНА давать корректный статус вопреки FP-шуму — рекомендуется
//      нормализовать score перед сравнением (например Math.round(score*1e5)/1e5
//      или epsilon). Тесты ниже проверяют точные границы явно.
//   7. DECIDE: если передан requestDecision — вызвать requestDecision(question),
//      где question СОДЕРЖИТ текст идеи И score. Возвращает status "DECIDE".
//      DECIDE НЕ пишет в DECISIONS.md (ответ оператора запишется позже через F-17).
//   8. REJECTED: appendDecision (ADR-блок) в DECISIONS.md со status "REJECTED",
//      контекст содержит текст идеи и числовые оценки. Возвращает status "REJECTED".
//      requestDecision НЕ вызывается.
//   9. ROADMAP: НЕ вызывает requestDecision, НЕ пишет в DECISIONS.md. Запись в
//      файл ROADMAP.md НЕ входит в контракт scoreIdea (отдельная интеграция);
//      статус "ROADMAP" в BACKLOG = идея одобрена для плана.
//  10. ОБНОВЛЕНИЕ BACKLOG (по idea.id): fit=clamped relevance, value=clamped value,
//      risk=clamped risk, cost=clamped cost, score, status. Прочие поля записи
//      (id, date, idea, source) сохраняются. Обновление наблюдаемо через readBacklog.
//      (file-state-manager не экспортирует updateBacklog — реализация Green-фазы
//      добавит его или перепишет BACKLOG; тест проверяет лишь наблюдаемый результат.)
//  11. Возвращает { id: idea.id, score, status }.
//
// ─── Контраст с idea-generator (F-19) ─────────────────────────────────────────
//   - idea-generator ЛОВИТ ошибки LLM и возвращает { added: 0 } (контур не умирает).
//   - idea-scorer ПРОБРАСЫВАЕТ ошибки LLM (scoreIdea бросает, контур обработает).
//     Скоринг одной идеи — терминальная операция; тихий fallback («оценил как 0»)
//     опаснее явной ошибки. Поэтому: llm throw → scoreIdea пробрасывает.
//
// ─── Логирование в BACKLOG (воспроизводимость, критерий 3 карточки) ───────────
//   После scoreIdea readBacklog показывает для записи idea.id: fit/value/risk/cost
//   (CLAMPED per-criterion оценки) + score (агрегат). Воспроизводимость: пересчёт
//   формулы от логированных fit/value/risk/cost даёт логированный score (в рамках
//   toBeCloseTo-допуска). Логируются CLAMPED-значения (валидные на шкале 0–1),
//   НЕ сырые вне-диапазона — иначе score нельзя воспроизвести из лога.
//
// ─── Red-фаза ─────────────────────────────────────────────────────────────────
//   На момент написания idea-scorer.ts не существует → createIdeaScorer
//   undefined → каждый it падает на «createIdeaScorer is not a function»
//   (или на undefined.computeScore/undefined.scoreIdea). Существующие тесты
//   fan-mission не затронуты (динамический import изолирован в beforeAll).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBacklog, initMission, readBacklog, readDecisions } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля под верификацию (SUT). На Red-фазе модуля нет — динамический
// import выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит, символ остаётся
// undefined. Файл теста при этом ЗАГРУЖАЕТСЯ, все it-блоки собираются и падают
// ИНДИВИДУАЛЬНО на вызове undefined-символа. На Green-фазе import подтянет символ.
// ────────────────────────────────────────────────────────────────────────────

let createIdeaScorer;

beforeAll(async () => {
	try {
		({ createIdeaScorer } = await import("../idea-scorer.js"));
	} catch {
		// Red: idea-scorer.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock LLM, mock requestDecision, mock clock, tmp missionDir, seed идеи
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт mock llm (async-функция с полем .calls[]) — стиль makeMockLlm из
 * idea-generator.test.mjs / makeRunCommand из verification-ladder.test.mjs.
 * impl может быть:
 *   - string            → всегда возвращает эту строку (raw LLM-ответ)
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

/** Создать mock requestDecision (записывает вопросы в .calls[]). */
function makeRequestDecision() {
	const calls = [];
	const fn = (question) => {
		calls.push(question);
	};
	fn.calls = calls;
	return fn;
}

/** Создать mock clock, всегда возвращающий одну и ту же дату (детерминизм ADR-даты). */
function makeMockClock(iso = "2026-08-13T12:00:00.000Z") {
	const d = new Date(iso);
	return () => d;
}

/** Обернуть 4 оценки в JSON-строку (raw LLM-ответ скорера). */
function scorerJson({ relevance, value, risk, cost }) {
	return JSON.stringify({ relevance, value, risk, cost });
}

/** Свежий tmp-каталог для теста. */
function freshBaseDir(prefix = "fan-f20-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Создать mission-директорию (initMission создаёт 5 файлов incl. BACKLOG/DECISIONS). */
async function makeMission({ baseDir }) {
	return initMission("f20-test", { baseDir });
}

/**
 * Записать в BACKLOG «свежую» идею-кандидата (status "IDEA", оценки 0) —
 * имитация вывода idea-generator F-19. Скорер F-20 затем обновит эту запись.
 */
function seedIdea(missionDir, { id, idea, source, date = "2026-08-13" }) {
	return appendBacklog(missionDir, {
		id,
		date,
		idea,
		source,
		fit: 0,
		value: 0,
		risk: 0,
		cost: 0,
		score: 0,
		status: "IDEA",
	});
}

/** Найти запись BACKLOG по id (readBacklog уже парсит таблицу). */
async function findBacklogEntry(missionDir, id) {
	const entries = await readBacklog(missionDir);
	return entries.find((e) => e.id === id);
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F20-1: Скорер вычисляет детерминированный score (0.75 → ROADMAP)
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / TC-F20-1: детерминированный score 0.75 → ROADMAP", () => {
	let baseDir;
	let missionDir;
	const idea = { id: "idea-001", idea: "Добавить кэширование Redis", source: "итерация #3" };
	const scores = { relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-tc1-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("computeScore({0.9,0.8,0.3,0.4}) = 0.3*0.9+0.2*0.8+0.2*0.7+0.3*0.6 = 0.75", () => {
		const scorer = createIdeaScorer();
		const score = scorer.computeScore(scores);
		// ±0.001 по карточке (toBeCloseTo numDigits=3 → допуск 0.0005).
		expect(score).toBeCloseTo(0.75, 3);
	});

	it("scoreIdea с теми же LLM-оценками → score 0.75, статус ROADMAP", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		const result = await scorer.scoreIdea(missionDir, idea);

		expect(result.id).toBe(idea.id);
		expect(result.score).toBeCloseTo(0.75, 3);
		expect(result.status).toBe("ROADMAP");
	});

	it("запись BACKLOG обновлена: fit/value/risk/cost/score/status", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		// relevance LLM → fit в BACKLOG.
		expect(entry.fit).toBeCloseTo(0.9, 3);
		expect(entry.value).toBeCloseTo(0.8, 3);
		expect(entry.risk).toBeCloseTo(0.3, 3);
		expect(entry.cost).toBeCloseTo(0.4, 3);
		expect(entry.score).toBeCloseTo(0.75, 3);
		expect(entry.status).toBe("ROADMAP");
		// idea/source/id сохранены (не затёрты при обновлении).
		expect(entry.idea).toBe(idea.idea);
		expect(entry.source).toBe(idea.source);
	});

	it("llm вызван ровно 1 раз; промпт содержит идею + рубрику 4 критериев + JSON", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		expect(llm.calls.length).toBe(1);
		const prompt = String(llm.calls[0]);
		const p = prompt.toLowerCase();
		// Текст идеи попадает в промпт.
		expect(prompt).toContain(idea.idea);
		// Рубрика — 4 критерия (рус., стиль проекта).
		expect(p).toContain("соответств");
		expect(p).toContain("ценност");
		expect(p).toContain("риск");
		expect(p).toContain("стоимост");
		// Запрос JSON-ответа.
		expect(p).toContain("json");
	});

	it("ROADMAP не вызывает requestDecision и не пишет в DECISIONS.md", async () => {
		const requestDecision = makeRequestDecision();
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, requestDecision, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		expect(requestDecision.calls.length).toBe(0);
		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F20-2: Спорная идея (0.5–0.7) → DECIDE
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / TC-F20-2: спорная идея score 0.50 → DECIDE + requestDecision", () => {
	let baseDir;
	let missionDir;
	const idea = {
		id: "idea-002",
		idea: "Спорная идея: вынести логирование в отдельный сервис",
		source: "итерация #3",
	};
	const scores = { relevance: 0.6, value: 0.5, risk: 0.5, cost: 0.6 };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-tc2-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("computeScore({0.6,0.5,0.5,0.6}) = 0.18+0.10+0.10+0.12 = 0.50", () => {
		const scorer = createIdeaScorer();
		const score = scorer.computeScore(scores);
		expect(score).toBeCloseTo(0.5, 3);
	});

	it("scoreIdea → score 0.50, статус DECIDE", async () => {
		const requestDecision = makeRequestDecision();
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, requestDecision, now: makeMockClock() });
		const result = await scorer.scoreIdea(missionDir, idea);

		expect(result.id).toBe(idea.id);
		expect(result.score).toBeCloseTo(0.5, 3);
		expect(result.status).toBe("DECIDE");
	});

	it("requestDecision вызван 1 раз; вопрос содержит текст идеи и score", async () => {
		const requestDecision = makeRequestDecision();
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, requestDecision, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		expect(requestDecision.calls.length).toBe(1);
		const question = String(requestDecision.calls[0]);
		// Вопрос содержит текст идеи.
		expect(question).toContain(idea.idea);
		// Вопрос содержит score (0.5 / 0.50 / 0.500 — любой формат, подстрока "0.5").
		expect(question).toContain("0.5");
	});

	it("DECIDE НЕ пишет в DECISIONS.md (ответ оператора запишется позже через F-17)", async () => {
		const requestDecision = makeRequestDecision();
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, requestDecision, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBe(0);
		// BACKLOG при этом обновлён статусом DECIDE.
		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry.status).toBe("DECIDE");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F20-2 (границы): точные пороги 0.7 / 0.5 / 0.69997 / 0.49997
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / TC-F20-2 (границы): score = 0.7 ровно → ROADMAP; 0.5 ровно → DECIDE", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-tc2-bnd-");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	async function scoreWith(scores) {
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, { id: "idea-bnd", idea: "граничная идея", source: "s" });
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		// Сперва убеждаемся, что computeScore даёт ожидаемое значение — связка
		// чистой функции и полного цикла на одних и тех же входах.
		const raw = scorer.computeScore(scores);
		const result = await scorer.scoreIdea(missionDir, { id: "idea-bnd", idea: "граничная идея", source: "s" });
		return { raw, result };
	}

	it("score = 0.7 ровно → ROADMAP", async () => {
		// 0.3*0.5 + 0.2*1 + 0.2*1 + 0.3*0.5 = 0.15+0.2+0.2+0.15 = 0.70
		const scores = { relevance: 0.5, value: 1.0, risk: 0.0, cost: 0.5 };
		const { raw, result } = await scoreWith(scores);
		expect(raw).toBeCloseTo(0.7, 3);
		expect(result.status).toBe("ROADMAP");
		expect(result.score).toBeCloseTo(0.7, 3);
	});

	it("score = 0.5 ровно → DECIDE", async () => {
		// {0.6,0.5,0.5,0.6} = 0.50 (он же основной кейс TC-F20-2)
		const scores = { relevance: 0.6, value: 0.5, risk: 0.5, cost: 0.6 };
		const { raw, result } = await scoreWith(scores);
		expect(raw).toBeCloseTo(0.5, 3);
		expect(result.status).toBe("DECIDE");
	});

	it("score = 0.69997 (чуть ниже 0.7) → DECIDE", async () => {
		// 0.3*0.5 + 0.2*1 + 0.2*1 + 0.3*(1-0.5001) = 0.15+0.2+0.2+0.14997 = 0.69997
		const scores = { relevance: 0.5, value: 1.0, risk: 0.0, cost: 0.5001 };
		const { raw, result } = await scoreWith(scores);
		expect(raw).toBeCloseTo(0.69997, 3);
		expect(raw).toBeLessThan(0.7);
		expect(result.status).toBe("DECIDE");
	});

	it("score = 0.49997 (чуть ниже 0.5) → REJECTED", async () => {
		// 0.3*0.6 + 0.2*0.5 + 0.2*0.5 + 0.3*(1-0.6001) = 0.18+0.1+0.1+0.11997 = 0.49997
		const scores = { relevance: 0.6, value: 0.5, risk: 0.5, cost: 0.6001 };
		const { raw, result } = await scoreWith(scores);
		expect(raw).toBeCloseTo(0.49997, 3);
		expect(raw).toBeLessThan(0.5);
		expect(result.status).toBe("REJECTED");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F20-3: Отклонённая идея → DECISIONS.md
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / TC-F20-3: отклонённая идея (score 0.35) → REJECTED + DECISIONS.md", () => {
	let baseDir;
	let missionDir;
	const idea = {
		id: "idea-003",
		idea: "Слабая идея: переписать всё на Rust",
		source: "итерация #3",
	};
	// 0.3*0.3 + 0.2*0.3 + 0.2*0.4 + 0.3*0.4 = 0.09+0.06+0.08+0.12 = 0.35
	const scores = { relevance: 0.3, value: 0.3, risk: 0.6, cost: 0.6 };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-tc3-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("computeScore({0.3,0.3,0.6,0.6}) = 0.35", () => {
		const scorer = createIdeaScorer();
		expect(scorer.computeScore(scores)).toBeCloseTo(0.35, 3);
	});

	it("scoreIdea → score 0.35, статус REJECTED, requestDecision не вызван", async () => {
		const requestDecision = makeRequestDecision();
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, requestDecision, now: makeMockClock() });
		const result = await scorer.scoreIdea(missionDir, idea);

		expect(result.id).toBe(idea.id);
		expect(result.score).toBeCloseTo(0.35, 3);
		expect(result.status).toBe("REJECTED");
		expect(requestDecision.calls.length).toBe(0);
	});

	it("в DECISIONS.md записана причина отклонения (ADR): status REJECTED + идея + числовые оценки", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const clock = makeMockClock("2026-08-13T15:30:00.000Z");
		const scorer = createIdeaScorer({ llm, now: clock });
		await scorer.scoreIdea(missionDir, idea);

		// readDecisions парсит ADR-блоки (### id + - **Date**: ...).
		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBeGreaterThanOrEqual(1);
		const rejected = decisions.find((d) => /reject/i.test(d.status));
		expect(rejected).toBeTruthy();
		expect(rejected.date).toBe("2026-08-13T15:30:00.000Z");

		// Сырой файл DECISIONS.md содержит текст идеи, статус REJECTED и числовую
		// оценку score (≈0.35 — формат /0\.3/ покрывает "0.35"/"0.350"/"0.3499").
		const raw = readFileSync(join(missionDir, "DECISIONS.md"), "utf8");
		expect(raw).toContain(idea.idea);
		expect(raw).toContain("REJECTED");
		expect(raw).toMatch(/0\.3/);
	});

	it("запись BACKLOG обновлена статусом REJECTED + числовыми оценками", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		expect(entry.fit).toBeCloseTo(0.3, 3);
		expect(entry.value).toBeCloseTo(0.3, 3);
		expect(entry.risk).toBeCloseTo(0.6, 3);
		expect(entry.cost).toBeCloseTo(0.6, 3);
		expect(entry.score).toBeCloseTo(0.35, 3);
		expect(entry.status).toBe("REJECTED");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM вернул оценки вне диапазона (1.5, -0.2) → clamp в [0,1]
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: LLM-оценки вне диапазона → clamp в [0,1]", () => {
	let baseDir;
	let missionDir;
	const idea = { id: "idea-004", idea: "Идея с завышенными оценками", source: "s" };
	// relevance 1.5 → clamp 1.0; risk -0.2 → clamp 0.0; остальные в норме.
	const scores = { relevance: 1.5, value: 0.8, risk: -0.2, cost: 0.4 };
	// clamped {1.0, 0.8, 0.0, 0.4} → 0.3*1 + 0.2*0.8 + 0.2*1 + 0.3*0.6 = 0.3+0.16+0.2+0.18 = 0.84
	const clamped = { relevance: 1.0, value: 0.8, risk: 0.0, cost: 0.4 };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-edge-clamp-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("computeScore на clamped-входах = 0.84 (clamp — в scoreIdea, не в computeScore)", () => {
		const scorer = createIdeaScorer();
		// computeScore НЕ клампит (чистая формула) — передаём уже clamped.
		expect(scorer.computeScore(clamped)).toBeCloseTo(0.84, 3);
	});

	it("scoreIdea clamps LLM-оценки → score 0.84 → статус ROADMAP", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		const result = await scorer.scoreIdea(missionDir, idea);

		expect(result.score).toBeCloseTo(0.84, 3);
		expect(result.status).toBe("ROADMAP");
	});

	it("BACKLOG логирует CLAMPED-значения (fit=1.0, risk=0.0), не сырые 1.5/-0.2", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		expect(entry.fit).toBeCloseTo(1.0, 3);
		expect(entry.value).toBeCloseTo(0.8, 3);
		expect(entry.risk).toBeCloseTo(0.0, 3);
		expect(entry.cost).toBeCloseTo(0.4, 3);
		expect(entry.score).toBeCloseTo(0.84, 3);
		// Воспроизводимость: из clamped-лога формула даёт тот же score.
		const recomputed = scorer.computeScore({
			relevance: entry.fit,
			value: entry.value,
			risk: entry.risk,
			cost: entry.cost,
		});
		expect(recomputed).toBeCloseTo(entry.score, 3);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM вернул невалидный JSON → scoreIdea бросает Error("invalid scorer response")
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: невалидный ответ LLM → throw Error('invalid scorer response')", () => {
	let baseDir;
	let missionDir;
	const idea = { id: "idea-005", idea: "Идея для невалидного скоринга", source: "s" };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-edge-invalid-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("мусорный текст (не JSON) → бросает, BACKLOG-запись не изменена", async () => {
		const llm = makeMockLlm("это вообще не json, просто проза без объекта");
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });

		await expect(scorer.scoreIdea(missionDir, idea)).rejects.toThrow(/invalid scorer response/i);

		// Запись не обновлена: оценки 0, статус остался "IDEA".
		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		expect(entry.fit).toBe(0);
		expect(entry.value).toBe(0);
		expect(entry.score).toBe(0);
		expect(entry.status).toBe("IDEA");
	});

	it("битый JSON в fenced code block → бросает", async () => {
		const llm = makeMockLlm("```json\n{ \"relevance\": 0.9, broken\n```");
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await expect(scorer.scoreIdea(missionDir, idea)).rejects.toThrow(/invalid scorer response/i);
	});

	it("валидный JSON, но не объект с 4 числовыми полями → бросает", async () => {
		// Не-объект (массив).
		const llm1 = makeMockLlm('[{ "relevance": 0.9, "value": 0.8, "risk": 0.3, "cost": 0.4 }]');
		const scorer1 = createIdeaScorer({ llm: llm1, now: makeMockClock() });
		await expect(scorer1.scoreIdea(missionDir, idea)).rejects.toThrow(/invalid scorer response/i);
	});

	it("объект без нужных полей → бросает", async () => {
		const llm = makeMockLlm('{ "foo": 1 }');
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await expect(scorer.scoreIdea(missionDir, idea)).rejects.toThrow(/invalid scorer response/i);
	});

	it("объект с не-числовыми значениями → бросает", async () => {
		const llm = makeMockLlm(
			'{ "relevance": "высокое", "value": 0.8, "risk": 0.3, "cost": 0.4 }',
		);
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await expect(scorer.scoreIdea(missionDir, idea)).rejects.toThrow(/invalid scorer response/i);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: LLM бросает ошибку → scoreIdea ПРОБРАСЫВАЕТ (контур обработает)
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: LLM бросает ошибку → scoreIdea пробрасывает", () => {
	let baseDir;
	let missionDir;
	const idea = { id: "idea-006", idea: "Идея при падении LLM", source: "s" };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-edge-throw-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("llm throw → scoreIdea пробрасывает ту же ошибку, BACKLOG не тронут", async () => {
		const llm = makeMockLlm({ throw: "LLM unavailable: 503" });
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });

		// Контраст с idea-generator: скорер НЕ глотает ошибки LLM.
		await expect(scorer.scoreIdea(missionDir, idea)).rejects.toThrow(/LLM unavailable: 503/);

		// llm был вызван (попытка), но упал — BACKLOG не обновлён.
		expect(llm.calls.length).toBe(1);
		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		expect(entry.score).toBe(0);
		expect(entry.status).toBe("IDEA");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: формула воспроизводима — один вход → один выход (несколько вызовов)
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: формула воспроизводима (один вход → один выход)", () => {
	it("3 вызова computeScore с одинаковым входом дают идентичный результат", () => {
		const scorer = createIdeaScorer();
		const scores = { relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 };
		const s1 = scorer.computeScore(scores);
		const s2 = scorer.computeScore(scores);
		const s3 = scorer.computeScore(scores);
		expect(s1).toBe(s2);
		expect(s2).toBe(s3);
		expect(s1).toBeCloseTo(0.75, 3);
	});

	it("разные входы дают детерминированно разные выходы", () => {
		const scorer = createIdeaScorer();
		const a = scorer.computeScore({ relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 });
		const b = scorer.computeScore({ relevance: 0.3, value: 0.3, risk: 0.6, cost: 0.6 });
		expect(a).not.toBe(b);
		expect(a).toBeCloseTo(0.75, 3);
		expect(b).toBeCloseTo(0.35, 3);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: сырые оценки и score логируются в BACKLOG (воспроизводимость)
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: после scoreIdea readBacklog показывает fit/value/risk/cost/score", () => {
	let baseDir;
	let missionDir;
	const idea = { id: "idea-007", idea: "Идея для проверки лога", source: "s" };
	const scores = { relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 };

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-edge-log-");
		missionDir = await makeMission({ baseDir });
		await seedIdea(missionDir, idea);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("пересчёт формулы от логированных fit/value/risk/cost = логированному score", async () => {
		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		await scorer.scoreIdea(missionDir, idea);

		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		// Все 5 числовых полей присутствуют и не 0 (логирование состоялось).
		expect(entry.fit).toBeCloseTo(0.9, 3);
		expect(entry.value).toBeCloseTo(0.8, 3);
		expect(entry.risk).toBeCloseTo(0.3, 3);
		expect(entry.cost).toBeCloseTo(0.4, 3);
		expect(entry.score).toBeCloseTo(0.75, 3);

		// Воспроизводимость: формула от логированных per-criterion = score.
		const recomputed = scorer.computeScore({
			relevance: entry.fit,
			value: entry.value,
			risk: entry.risk,
			cost: entry.cost,
		});
		expect(recomputed).toBeCloseTo(entry.score, 3);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: Unicode в идее — запись BACKLOG не ломается
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: unicode в идее сохраняется 1:1 в BACKLOG", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f20-edge-unicode-");
		missionDir = await makeMission({ baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("кириллица + эмодзи + спецсимволы: BACKLOG-запись цела, скоринг проходит", async () => {
		const idea = {
			id: "idea-008",
			idea: "Рефакторинг аутентификации 🔐 — JWT + кириллица №1",
			source: "итерация №3",
		};
		const scores = { relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 };
		await seedIdea(missionDir, idea);

		const llm = makeMockLlm(scorerJson(scores));
		const scorer = createIdeaScorer({ llm, now: makeMockClock() });
		const result = await scorer.scoreIdea(missionDir, idea);

		expect(result.status).toBe("ROADMAP");
		expect(result.score).toBeCloseTo(0.75, 3);

		const entry = await findBacklogEntry(missionDir, idea.id);
		expect(entry).toBeTruthy();
		// Unicode сохранён 1:1 (включая тире, эмодзи, №).
		expect(entry.idea).toBe(idea.idea);
		expect(entry.source).toBe("итерация №3");
		expect(entry.status).toBe("ROADMAP");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: все 4 веса формулы 0.3 / 0.2 / 0.2 / 0.3 (наборы, изолирующие каждый вес)
// ────────────────────────────────────────────────────────────────────────────

describe("F-20 / EDGE: веса формулы 0.3 / 0.2 / 0.2 / 0.3", () => {
	// Каждый набор изолирует вклад одного веса (остальные слагаемые = 0).
	// score = 0.3*r + 0.2*v + 0.2*(1-risk) + 0.3*(1-cost)
	const cases = [
		// [name, relevance, value, risk, cost, expected, isolatedWeight]
		["relevance→0.3 (вес 0.3)", 1.0, 0.0, 1.0, 1.0, 0.3],
		["value→0.2 (вес 0.2)", 0.0, 1.0, 1.0, 1.0, 0.2],
		["(1-risk)→0.2 (вес 0.2)", 0.0, 0.0, 0.0, 1.0, 0.2],
		["(1-cost)→0.3 (вес 0.3)", 0.0, 0.0, 1.0, 0.0, 0.3],
		["all-max → 1.0", 1.0, 1.0, 0.0, 0.0, 1.0],
		["all-min → 0.0", 0.0, 0.0, 1.0, 1.0, 0.0],
		["TC-F20-1 {0.9,0.8,0.3,0.4} → 0.75", 0.9, 0.8, 0.3, 0.4, 0.75],
		["TC-F20-3 {0.3,0.3,0.6,0.6} → 0.35", 0.3, 0.3, 0.6, 0.6, 0.35],
	];

	for (const [name, relevance, value, risk, cost, expected] of cases) {
		it(`${name}: computeScore = ${expected}`, () => {
			const scorer = createIdeaScorer();
			const score = scorer.computeScore({ relevance, value, risk, cost });
			expect(score).toBeCloseTo(expected, 3);
		});
	}

	it("веса суммируются в 1.0 (all-max даёт ровно 1.0)", () => {
		const scorer = createIdeaScorer();
		const score = scorer.computeScore({ relevance: 1.0, value: 1.0, risk: 0.0, cost: 0.0 });
		// 0.3+0.2+0.2+0.3 = 1.0 — сумма весов.
		expect(score).toBeCloseTo(1.0, 3);
	});
});
