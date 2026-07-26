import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["lib/**/*.test.ts"],
		globals: true,
		testTimeout: 10_000,
	},
});
