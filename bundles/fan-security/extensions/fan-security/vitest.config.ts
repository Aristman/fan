import { defineConfig } from "vitest/config";

/**
 * Тест-инфраструктура пакета fan-security (фича security-worker, этап 2).
 * Создана в RED-фазе TDD — содержит только настройку vitest, никакого продакшн-кода.
 * Green-воркер может оставить файл как есть.
 *
 * Запуск: cd extensions/fan-security && npx vitest run
 * (бинарь vitest резолвится из корневого node_modules монорепо — собственных зависимостей не нужно).
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.test.mjs"],
		environment: "node",
	},
});
