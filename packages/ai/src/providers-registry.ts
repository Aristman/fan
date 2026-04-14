import { providersRegistryData } from "./providers-registry-data.js";

	export interface ProviderMeta {
	displayName: string;
	envVars: readonly string[];
	primaryEnvVar: string;
	wizardModels: readonly string[];
	authType: "apiKey" | "token" | "oauth" | "adc" | "aws";
}

export interface ProvidersRegistry {
	version: number;
	providers: Record<string, ProviderMeta>;
	wizardOrder: readonly string[];
}

const registry: ProvidersRegistry = providersRegistryData;

/** Get the full providers registry */
export function getProvidersRegistry(): ProvidersRegistry {
	return registry;
}

/** Get metadata for a specific provider */
export function getProviderMeta(provider: string): ProviderMeta | undefined {
	return registry.providers[provider];
}

/** Get providers in wizard display order (only those with wizardModels) */
export function getWizardProviders(): Array<{ id: string; meta: ProviderMeta }> {
	return registry.wizardOrder
		.filter((id) => registry.providers[id]?.wizardModels.length > 0)
		.map((id) => ({ id, meta: registry.providers[id]! }));
}

/** Get primary env var for a provider */
export function getEnvVarForProvider(provider: string): string | undefined {
	return registry.providers[provider]?.primaryEnvVar;
}

/** Get all env vars to check for a provider */
export function getAllEnvVarsForProvider(provider: string): string[] {
	return [...(registry.providers[provider]?.envVars ?? [])];
}

/** Check if any env var for a provider is set */
export function isProviderConfigured(provider: string): boolean {
	const meta = registry.providers[provider];
	return meta ? meta.envVars.some((v) => process.env[v]) : false;
}
