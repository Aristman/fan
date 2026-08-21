// vitest.config.ts
// F-H: Reporter config — verbose output for CI readability.
//
// vitest 3.x заменил "spec" reporter на "verbose" (readable, иерархический).
// CLI: CI=true npx vitest run --reporter=verbose  (для ad-hoc CI запусков).

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.mjs"],
		exclude: ["node_modules/**"],
		environment: "node",
		reporters: process.env.CI ? ["verbose", "json"] : ["default"],
	},
});