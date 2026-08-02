import type { DetectFn } from "../types.js";
import { detectToolErrors } from "./d1-tool-errors.js";
import { detectLoops } from "./d2-loops.js";
import { detectDuration } from "./d3-duration.js";
import { detectPathEfficiency } from "./d4-path-efficiency.js";
import { detectOrchestratorFlow } from "./d5-orchestrator-flow.js";
import { detectSkillUsage } from "./d6-skill-usage.js";
import { detectExtensionTools } from "./d7-extension-tools.js";
import { detectCompactions } from "./d8-compactions.js";
import { detectTokensCost } from "./d9-tokens-cost.js";
import { detectOrphanedCalls } from "./d10-orphaned-calls.js";
import { detectProportionality } from "./d11-proportionality.js";
import { detectEmptyRetries } from "./d13-empty-retries.js";
import { detectWorkerRouting } from "./d12-worker-routing.js";

export const ALL_DETECTORS: Array<{ id: string; fn: DetectFn }> = [
	{ id: "D1", fn: detectToolErrors },
	{ id: "D2", fn: detectLoops },
	{ id: "D3", fn: detectDuration },
	{ id: "D4", fn: detectPathEfficiency },
	{ id: "D5", fn: detectOrchestratorFlow },
	{ id: "D6", fn: detectSkillUsage },
	{ id: "D7", fn: detectExtensionTools },
	{ id: "D8", fn: detectCompactions },
	{ id: "D9", fn: detectTokensCost },
	{ id: "D10", fn: detectOrphanedCalls },
	{ id: "D11", fn: detectProportionality },
	{ id: "D12", fn: detectWorkerRouting },
	{ id: "D13", fn: detectEmptyRetries },
];
