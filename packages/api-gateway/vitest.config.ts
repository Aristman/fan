import { defineConfig } from "vitest/config";

export default defineConfig({
	// Phase-gate B3 e2e импортирует Lit-компоненты Dashboard (tsconfig.base.json:
	// experimentalDecorators + useDefineForClassFields:false). Из корня api-gateway
	// они трансформируются вне своего tsconfig-скоупа, поэтому фиксируем семантику
	// esbuild явно: без этого class fields ([[Define]]) затирают Lit-аксессоры
	// (lit.dev/msg/class-field-shadowing) и @decorator-синтаксис не компилируется.
	esbuild: {
		target: "es2024",
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields: false,
			},
		},
	},
	test: {
		// F-0 refactor verification tests live alongside the package's bun
		// smoke tests in `test/` (originally only bun:test). They're vitest
		// unit tests today (no spawn, no external services) and run via the
		// explicit invocation `npx vitest run test/server-bootstrap.test.ts`.
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		// `test/transport-smoke.test.ts` uses `bun:test` imports and is run
		// exclusively via `bun test` (Phase 6 harness). Exclude it from vitest
		// so the imported-file heuristic does not attempt to resolve
		// `bun:test` from the vitest runtime.
		exclude: ["**/transport-smoke.test.ts"],
		globals: true,
		testTimeout: 10_000,
	},
});
