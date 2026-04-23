/**
 * Multi-File Extension Template
 *
 * Directory-based extension with separate files for tools, events, utils.
 *
 * Structure:
 *   my-extension/
 *   ├── index.ts      — Entry point, wires everything together
 *   ├── tools.ts      — Tool definitions
 *   ├── events.ts     — Event handlers
 *   └── utils.ts      — Helper functions and types
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";
import { registerTools } from "./tools.js";
import { registerEvents } from "./events.js";

export default function (pi: ExtensionAPI) {
	registerTools(pi);
	registerEvents(pi);
}
