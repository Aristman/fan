import type { ModelRoute, RoutingPreset, TaskType } from "./types.js";

/** Default routing presets */
const DEFAULT_PRESETS: RoutingPreset[] = [
	{
		name: "coding",
		route: { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0.2 },
		fallback: { provider: "anthropic", model: "claude-haiku-3-5-20241022" },
	},
	{
		name: "quick",
		route: { provider: "ollama", model: "llama3", temperature: 0.5 },
		fallback: { provider: "openai", model: "gpt-4o-mini" },
	},
	{
		name: "analysis",
		route: { provider: "openai", model: "gpt-4o", temperature: 0.3 },
		fallback: { provider: "google", model: "gemini-2.5-pro" },
	},
	{
		name: "chat",
		route: { provider: "google", model: "gemini-2.5-pro", temperature: 0.7 },
		fallback: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
	},
];

/**
 * ProviderRouter — resolves a TaskType to a ModelRoute.
 *
 * Skeleton implementation: returns hardcoded defaults.
 * Phase 2 will add DB-backed rules, user overrides, and dynamic resolution.
 */
export class ProviderRouter {
	private presets: Map<TaskType, RoutingPreset>;

	constructor(presets?: RoutingPreset[]) {
		this.presets = new Map((presets ?? DEFAULT_PRESETS).map((p) => [p.name, p]));
	}

	resolve(taskType: TaskType): ModelRoute {
		const preset = this.presets.get(taskType);
		if (!preset) {
			// Fallback to coding preset for unknown types
			return this.presets.get("coding")!.route;
		}
		return preset.route;
	}

	getFallback(taskType: TaskType): ModelRoute | undefined {
		const preset = this.presets.get(taskType);
		return preset?.fallback;
	}

	getPreset(taskType: TaskType): RoutingPreset | undefined {
		return this.presets.get(taskType);
	}

	listPresets(): RoutingPreset[] {
		return Array.from(this.presets.values());
	}
}
