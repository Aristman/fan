import type { AnalyticsConfig, DetectFn, Finding } from "../types.js";

/**
 * D12: Worker Routing — heuristic check whether the worker type matches the task.
 *
 * Inspects delegate_task tool_call steps, extracts (agent, task), classifies
 * the task by keyword markers, and flags mismatches between detected category
 * and the chosen agent type.
 *
 * Severity: low for a single mismatch, medium for ≥ 2 mismatches in a session.
 * Never high — this is a heuristic.
 */

interface MarkerCategory {
	category: string;
	patterns: RegExp[];
	/** Agent types that are acceptable for this category (including aliases). */
	allowedAgents: Set<string>;
}

const CATEGORIES: MarkerCategory[] = [
	{
		category: "bug-fix",
		patterns: [
			/\bfix\b/i, /баг/i, /\bbug\b/i, /ошибк/i, /падает/i, /\bfailing\b/i,
			/сломан/i, /исправь/i, /\bregression\b/i, /не работает/i,
		],
		allowedAgents: new Set(["bug-fix"]),
	},
	{
		category: "implement",
		patterns: [
			/создай/i, /добавь/i, /реализуй/i, /новая фич/i,
			/\badd\s/i, /\bimplement\b/i, /\bcreate\b/i, /\bfeature\b/i,
		],
		allowedAgents: new Set(["implement"]),
	},
	{
		category: "explore",
		patterns: [
			/исследуй/i, /найди/i, /как устроен/i, /\bexplore\b/i, /\bresearch\b/i,
			/проанализируй/i, /разберись/i,
		],
		// explore and code-research are mutually acceptable aliases
		allowedAgents: new Set(["explore", "code-research"]),
	},
	{
		category: "verify",
		patterns: [
			/проверь/i, /верифиц/i, /\breview\b/i, /\bаудит\b/i,
		],
		allowedAgents: new Set(["verify"]),
	},
	{
		category: "tests-impl",
		patterns: [
			/тест/i, /\btest\b/i,
		],
		allowedAgents: new Set(["tests-impl"]),
	},
	{
		category: "docs-impl",
		patterns: [
			/документ/i, /\breadme\b/i, /\bdocs\b/i,
		],
		allowedAgents: new Set(["docs-impl"]),
	},
];

/**
 * Classify a task description by markers. Returns ALL matching categories.
 */
function classifyTaskAll(task: string): string[] {
	const matched: string[] = [];
	for (const cat of CATEGORIES) {
		for (const pat of cat.patterns) {
			if (pat.test(task)) {
				matched.push(cat.category);
				break;
			}
		}
	}
	return matched;
}

/**
 * Check if the given agent type is acceptable for the detected category.
 */
function isAgentAllowed(category: string, agent: string): boolean {
	const cat = CATEGORIES.find((c) => c.category === category);
	if (!cat) return true; // unknown category → skip
	return cat.allowedAgents.has(agent);
}

/** Friendly Russian names for categories (for finding titles). */
const CATEGORY_LABELS: Record<string, string> = {
	"bug-fix": "bug-fix (исправление ошибок)",
	"implement": "implement (реализация)",
	"explore": "explore / code-research (исследование)",
	"verify": "verify (проверка)",
	"tests-impl": "tests-impl (тестирование)",
	"docs-impl": "docs-impl (документация)",
};

export const detectWorkerRouting: DetectFn = (t, cfg) => {
	// Respect config toggle
	if (cfg.detectors?.d12Enabled === false) {
		return [];
	}

	const findings: Finding[] = [];

	// Collect delegate_task calls
	const delegateCalls: Array<{
		entryId: string;
		agent: string;
		task: string;
	}> = [];

	for (const step of t.steps) {
		if (step.kind === "tool_call" && step.toolName === "delegate_task") {
			const args = step.args || {};
			// Handle both flat (agent, task) and chain modes
			if (args.agent) {
				delegateCalls.push({
					entryId: step.entryId,
					agent: String(args.agent),
					task: typeof args.task === "string" ? args.task : "",
				});
			}
			if (Array.isArray(args.chain)) {
				for (const item of args.chain) {
					if (item && item.agent) {
						delegateCalls.push({
							entryId: step.entryId,
							agent: String(item.agent),
							task: typeof item.task === "string" ? item.task : "",
						});
					}
				}
			}
		}
	}

	// Check each call for mismatches
	const mismatches: Array<{
		entryId: string;
		agent: string;
		task: string;
		detectedCategory: string;
	}> = [];

	for (const call of delegateCalls) {
		const matched = classifyTaskAll(call.task);
		if (matched.length === 0) continue; // no markers → skip

		// Разрешено, если ХОТЯ БЫ одна из совпавших категорий допускает агента
		// (например, verify, проверяющий баг-фикс, — это норма, а не мисроутинг)
		if (matched.some((cat) => isAgentAllowed(cat, call.agent))) continue;

		mismatches.push({
			entryId: call.entryId,
			agent: call.agent,
			task: call.task,
			detectedCategory: matched[0],
		});
	}

	if (mismatches.length === 0) return findings;

	const severity = mismatches.length >= 2 ? "medium" as const : "low" as const;

	for (const m of mismatches) {
		const expectedLabel = CATEGORY_LABELS[m.detectedCategory] || m.detectedCategory;
		findings.push({
			detectorId: "D12",
			severity,
			title: `Несоответствие типа воркера задаче: agent="${m.agent}", но задача относится к категории "${expectedLabel}"`,
			evidence: {
				entryIds: [m.entryId],
				excerpt: `Агент: ${m.agent}\nЗадача: ${m.task.slice(0, 200)}`,
			},
			recommendation: `Для задач категории "${expectedLabel}" рекомендуется использовать воркер типа "${m.detectedCategory}" или его алиас.`,
		});
	}

	return findings;
};
