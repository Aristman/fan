import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.mjs"],
		environment: "node",
		// Webhook-тесты поднимают реальный HTTP-сервер; удлиняем таймаут для CI.
		testTimeout: 10_000,
		// Сериализуем прогоны, чтобы порт-конфликты между тестами не возникали
		// (особенно для теста «port in use»).
		fileParallelism: false,
	},
});
