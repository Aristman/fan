// Минимальный vitest-конфиг для unit-тестов расширения (node-окружение).
// DEPLOY.toml исключает vitest.config.* и *.test.ts из бандла.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["*.test.ts"],
	},
});
