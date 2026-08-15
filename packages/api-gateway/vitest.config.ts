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
		include: ["src/**/*.test.ts"],
		globals: true,
		testTimeout: 10_000,
	},
});
