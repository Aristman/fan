/**
 * FIXTURE (TC-F-2.2-2) — чистый файл без секретов.
 * Обычный TS-код: ни одной строки, похожей на ключ/токен/присваивание секрета.
 */

export interface Greeting {
	name: string;
	greeting: string;
}

export function greet(name: string): Greeting {
	return { name, greeting: `Hello, ${name}!` };
}

export const MAX_RETRIES = 3;

export function sum(values: number[]): number {
	return values.reduce((acc, value) => acc + value, 0);
}

export function retryDelay(attempt: number): number {
	return Math.min(attempt * MAX_RETRIES * 100, 5_000);
}
