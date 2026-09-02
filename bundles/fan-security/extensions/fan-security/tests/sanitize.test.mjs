/**
 * Unit-тесты lib/sanitize.ts — санитизация evidence и лимиты скана
 * (patch 1.0.1: fix security-аудита F-1, F-2).
 *
 * Контракт (шапка lib/sanitize.ts):
 * - sanitizeEvidence(text): string —
 *     1) SECRET_PATTERNS (lib/patterns/secrets.ts) → замена совпадений через
 *        maskSecret (4+4, «ghp_ABCD…wxyz»; короткие — целиком «…», fix F-3);
 *     2) высокоэнтропийные токены без известного префикса → маскированный вид;
 *     3) длина результата ≤ 300 (§6.1);
 *     детерминирована, не бросает;
 * - clampScanLine(line): string — усечение до MAX_SCAN_LINE_LENGTH = 8192
 *   (F-2 ReDoS: квадратичные CWE-regex на строке 1 МБ → десятки секунд);
 * - константы MAX_EVIDENCE_LENGTH = 300, MAX_SCAN_LINE_LENGTH = 8192,
 *   DEFAULT_TIME_BUDGET_MS = 30_000.
 *
 * Все секреты в тестах — фейковые и невалидные.
 */
import { describe, expect, it } from "vitest";

import { maskSecret } from "../lib/report.ts";

const SANITIZE_URL = "../lib/sanitize.ts";

let modulePromise;

/** Guard-загрузка (паттерн report.test.mjs: читаемая причина вместо сырого ENOENT). */
function loadSanitize() {
	if (!modulePromise) {
		modulePromise = import(SANITIZE_URL).catch((cause) => {
			modulePromise = undefined;
			throw new Error(
				`lib/sanitize.ts не существует или не импортируется (${cause?.message ?? cause}). ` +
					`Создай extensions/fan-security/lib/sanitize.ts — sanitizeEvidence + entropy-хелперы + лимиты (patch 1.0.1, F-1/F-2).`,
			);
		});
	}
	return modulePromise;
}

function requireExport(mod, name, kind = "function") {
	const value = mod?.[name];
	const missing = kind === "function" ? typeof value !== "function" : value === undefined;
	if (missing) {
		throw new Error(
			`lib/sanitize.ts не экспортирует ${kind === "function" ? "функцию" : "значение"} "${name}" ` +
				`(получено: ${typeof value}). См. контракт в шапке этого файла (patch 1.0.1, F-1/F-2).`,
		);
	}
	// Прозрачный Proxy (паттерн report.test.mjs): поддерживает ОБА стиля доступа —
	// `const fn = requireExport(mod, "fn")` и `const { fn } = requireExport(mod, "fn")`.
	// Примитивы (константы) возвращаются напрямую — Proxy требует объектный target.
	if (typeof value !== "object" && typeof value !== "function") {
		return value;
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

/** Фейковые значения (форматы SECRET_PATTERNS и entropy-кандидат). */
const FAKE = {
	github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234", // ghp_ + 36
	aws: "AKIAABCDEFGHIJKLMNOP", // AKIA + 16
	entropy: "FakeExternalSecretToken0123456789", // mixed case + цифры, без известного префикса
};

describe("sanitizeEvidence (F-1): маскирование во всех источниках evidence", () => {
	it("SECRET_PATTERNS: ghp_-токен в тексте → maskSecret (сырой токен отсутствует)", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		const text = `const dep = "github:evil/repo#${FAKE.github}";`;
		const sanitized = sanitizeEvidence(text);

		expect(sanitized).toContain(maskSecret(FAKE.github));
		expect(sanitized).not.toContain(FAKE.github);
		// окружающий текст сохранён (замена только совпадения)
		expect(sanitized).toContain(`github:evil/repo#`);
	});

	it("SECRET_PATTERNS: AKIA-ключ → маска 4+4; короткое значение api_key → «…» (fix F-3)", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		expect(sanitizeEvidence(`key = "${FAKE.aws}";`)).toContain(maskSecret(FAKE.aws));
		// 8-символьное значение присваивания api_key= маскируется ЦЕЛИКОМ (len < 9)
		const short = sanitizeEvidence(`const api_key = "shortkey";`);
		expect(short).toContain("…");
		expect(short).not.toContain("shortkey");
	});

	it("entropy: высокоэнтропийный токен без известного префикса → маскированный вид", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		const text = `token = "${FAKE.entropy}"`;
		const sanitized = sanitizeEvidence(text);

		expect(sanitized).toContain(maskSecret(FAKE.entropy));
		expect(sanitized).not.toContain(FAKE.entropy);
	});

	it("низкоэнтропийные/короткие токены НЕ трогаются (без ложного маскирования обычного кода)", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		const text = `const rows = db.query("SELECT * FROM users WHERE id = ?", [userId]); const fake-pkg = "1.2.3";`;
		const sanitized = sanitizeEvidence(text);

		// низкоэнтропийная строка (32×'a') и обычные идентификаторы остаются как есть
		expect(sanitizeEvidence(`const padding = "${"a".repeat(32)}";`)).toBe(
			`const padding = "${"a".repeat(32)}";`,
		);
		expect(sanitized).toContain("db.query");
		expect(sanitized).toContain("userId");
	});

	it("длина результата ≤ 300 (§6.1), даже если вход длиннее", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		const long = `x`.repeat(1000);
		const sanitized = sanitizeEvidence(long);
		expect(sanitized.length).toBeLessThanOrEqual(300);
	});

	it("детерминирована: повторные вызовы дают идентичный результат; пустая строка → пустая", async () => {
		const { sanitizeEvidence } = requireExport(await loadSanitize(), "sanitizeEvidence");

		const text = `const t = "${FAKE.github}";`;
		expect(sanitizeEvidence(text)).toBe(sanitizeEvidence(text));
		expect(sanitizeEvidence("")).toBe("");
	});
});

describe("clampScanLine и лимиты (F-2: ReDoS-защита, тайм-бюджет)", () => {
	it("константы: MAX_SCAN_LINE_LENGTH=8192, MAX_EVIDENCE_LENGTH=300, DEFAULT_TIME_BUDGET_MS=30000", async () => {
		const mod = await loadSanitize();
		expect(requireExport(mod, "MAX_SCAN_LINE_LENGTH", "const")).toBe(8192);
		expect(requireExport(mod, "MAX_EVIDENCE_LENGTH", "const")).toBe(300);
		expect(requireExport(mod, "DEFAULT_TIME_BUDGET_MS", "const")).toBe(30_000);
	});

	it("строка в пределах лимита возвращается без изменений (тот же контент)", async () => {
		const mod = await loadSanitize();
		const clampScanLine = requireExport(mod, "clampScanLine");
		const line = `const sql = "SELECT * FROM users WHERE id = " + userName + ";";`;
		expect(clampScanLine(line)).toBe(line);
	});

	it("строка длиннее 8192 усекается ровно до 8192 символов (потеря хвоста задокументирована)", async () => {
		const mod = await loadSanitize();
		const clampScanLine = requireExport(mod, "clampScanLine");
		const MAX_SCAN_LINE_LENGTH = requireExport(mod, "MAX_SCAN_LINE_LENGTH", "const");

		const line = "a".repeat(MAX_SCAN_LINE_LENGTH + 5000);
		const clamped = clampScanLine(line);
		expect(clamped.length).toBe(MAX_SCAN_LINE_LENGTH);
		expect(clamped).toBe(line.slice(0, MAX_SCAN_LINE_LENGTH));
	});

	it("entropy-хелперы экспортируются (общий код scan-secrets и sanitizeEvidence, F-1)", async () => {
		const mod = await loadSanitize();
		expect(typeof requireExport(mod, "shannonEntropy")).toBe("function");
		expect(typeof requireExport(mod, "isHighEntropyToken")).toBe("function");
		expect(typeof requireExport(mod, "entropyCandidates")).toBe("function");

		const isHighEntropyToken = requireExport(mod, "isHighEntropyToken");
		expect(isHighEntropyToken(FAKE.entropy)).toBe(true); // mixed case + цифры, 34 симв.
		expect(isHighEntropyToken("a".repeat(32))).toBe(false); // низкая энтропия
		expect(isHighEntropyToken("abc")).toBe(false); // короче порога 24
	});
});
