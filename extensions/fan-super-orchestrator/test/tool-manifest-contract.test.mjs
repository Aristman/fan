// F-37: Контракт ALLOWED_TOOLS ↔ ядро fan.
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-37
//
// ALLOWED_TOOLS (tool-manifest.ts) — дефолтный манифест, конвертируемый в
// `--tools` argv дочернего fan server. Контракт:
//   • read/write/edit/bash/grep/find/ls — КЛЮЧИ allTools ядра
//     (packages/coding-agent/dist/core/tools/index.js); CLI-парсер --tools
//     (packages/coding-agent/src/cli/args.ts) отклоняет имена вне allTools.
//   • store_search/store_install — инструменты FAN Store, регистрируются
//     расширением (packages/store/src/store-tools.ts → registerStoreTools),
//     НЕ входят в allTools ядра.
//
// Импорт из dist ядра: динамический import по file-URL от корня монорепо
// (test → ../../.. → packages/...). Требует `npm run build` (dist собран).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const CORE_TOOLS_URL = new URL("../../../packages/coding-agent/dist/core/tools/index.js", import.meta.url);
const STORE_TOOLS_DIST = fileURLToPath(
	new URL("../../../packages/store/dist/store-tools.js", import.meta.url),
);

/** Инструменты FAN Store — регистрируются расширением, вне allTools ядра. */
const STORE_TOOLS = ["store_search", "store_install"];

let ALLOWED_TOOLS;
let allToolsKeys;
let storeToolsSource;

beforeAll(async () => {
	const manifestMod = await import("../tool-manifest.js");
	ALLOWED_TOOLS = manifestMod.ALLOWED_TOOLS;
	// dist ядра — нужен `npm run build`; иначе импорт падает (как phase-gate-a).
	const coreMod = await import(CORE_TOOLS_URL.href);
	allToolsKeys = Object.keys(coreMod.allTools);
	storeToolsSource = readFileSync(STORE_TOOLS_DIST, "utf8");
});

describe("контракт ALLOWED_TOOLS ↔ allTools ядра (packages/coding-agent)", () => {
	it("ядро экспортирует allTools с CLI-инструментами", () => {
		expect(allToolsKeys).toContain("read");
		expect(allToolsKeys).toContain("write");
		expect(allToolsKeys).toContain("edit");
		expect(allToolsKeys).toContain("bash");
		expect(allToolsKeys).toContain("grep");
		expect(allToolsKeys).toContain("find");
		expect(allToolsKeys).toContain("ls");
	});

	it("каждый CORE-инструмент ALLOWED_TOOLS присутствует в ключах allTools (подмножество)", () => {
		const coreTools = ALLOWED_TOOLS.filter((name) => !STORE_TOOLS.includes(name));
		for (const name of coreTools) {
			expect(allToolsKeys).toContain(name);
		}
	});

	it("store-инструменты ALLOWED_TOOLS регистрируются FAN Store (packages/store)", () => {
		for (const name of STORE_TOOLS) {
			expect(ALLOWED_TOOLS).toContain(name);
			// packages/store/dist/store-tools.js объявляет инструмент с этим именем.
			expect(storeToolsSource).toContain(`name: "${name}"`);
		}
	});

	it("нет неизвестных имён: ALLOWED_TOOLS = allTools-ядро ∪ store-инструменты", () => {
		for (const name of ALLOWED_TOOLS) {
			const known = allToolsKeys.includes(name) || storeToolsSource.includes(`name: "${name}"`);
			expect(known, `ALLOWED_TOOLS '${name}' отсутствует и в ядре, и в FAN Store`).toBe(true);
		}
	});
});
