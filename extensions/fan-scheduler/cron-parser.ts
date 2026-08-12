// F-13: Утилиты для парсинга и сопоставления cron-выражений (5 полей).
// Вынесено из scheduler.ts для переиспользования и изолированного тестирования.

export interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	domRestricted: boolean;
	dowRestricted: boolean;
}

export const CRON_RANGES: Array<[number, number]> = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7], // 0 и 7 — воскресенье
];

/**
 * Строгая валидация: строка должна состоять только из десятичных цифр.
 * Отклоняет "1.5", "0x1", "1e2", "-1" и т.п. — всё, что parseInt молча
 * обрезает до целого, создавая иллюзию корректного ввода.
 */
function parseStrictInt(str: string): number {
	if (!/^\d+$/.test(str)) {
		throw new Error(`Invalid cron value: '${str}' is not a valid integer`);
	}
	return Number.parseInt(str, 10);
}

export function parseCronField(field: string, index: number): { values: Set<number>; restricted: boolean } {
	const [min, max] = CRON_RANGES[index];
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart === undefined ? 1 : parseStrictInt(stepPart);
		if (step < 1) {
			throw new Error(`Invalid cron expression: bad step in '${part}'`);
		}
		let from = min;
		let to = max;
		if (rangePart !== "*") {
			if (rangePart.includes("-")) {
				const parts = rangePart.split("-");
				if (parts.length !== 2) {
					throw new Error(`Invalid cron expression: bad range '${rangePart}'`);
				}
				const lo = parseStrictInt(parts[0]);
				const hi = parseStrictInt(parts[1]);
				if (lo > hi) {
					throw new Error(`Invalid cron expression: bad range '${rangePart}'`);
				}
				from = lo;
				to = hi;
			} else {
				const value = parseStrictInt(rangePart);
				from = value;
				to = stepPart === undefined ? value : max;
			}
		}
		if (from < min || to > max) {
			throw new Error(`Invalid cron expression: value out of range in '${field}'`);
		}
		for (let v = from; v <= to; v += step) {
			values.add(index === 4 && v === 7 ? 0 : v); // 7 → воскресенье (0)
		}
	}
	return { values, restricted: field !== "*" };
}

export function parseCronExpression(expression: string): CronFields {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length} ('${expression}')`);
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseCronField(f, i));
	return {
		minute: minute.values,
		hour: hour.values,
		dayOfMonth: dayOfMonth.values,
		month: month.values,
		dayOfWeek: dayOfWeek.values,
		domRestricted: dayOfMonth.restricted,
		dowRestricted: dayOfWeek.restricted,
	};
}

export function cronMatches(parsed: CronFields, date: Date): boolean {
	if (!parsed.minute.has(date.getMinutes()) || !parsed.hour.has(date.getHours())) {
		return false;
	}
	if (!parsed.month.has(date.getMonth() + 1)) {
		return false;
	}
	const domMatch = parsed.dayOfMonth.has(date.getDate());
	const dowMatch = parsed.dayOfWeek.has(date.getDay());
	// Классический cron: если ограничены и dom, и dow — достаточно одного совпадения.
	if (parsed.domRestricted && parsed.dowRestricted) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}

/** Задержка (мс) до следующего совпадения cron после `from` (поиск по минутам). */
export function nextCronDelayMs(parsed: CronFields, from: Date): number {
	const cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	// Горизонт поиска — ~4 года: покрывает редкие расписания (29 февраля и т.п.).
	for (let i = 0; i < 366 * 24 * 60 * 4; i++) {
		if (cronMatches(parsed, cursor)) {
			return Math.max(cursor.getTime() - from.getTime(), 0);
		}
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	throw new Error("Invalid cron expression: no matching date within search horizon");
}
