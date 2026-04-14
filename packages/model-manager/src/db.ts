import type { PrismaClient } from "@fan/db";
import { getPrismaClient } from "@fan/db";

/** Get Prisma client, throws if DB not available */
function db(): PrismaClient {
	return getPrismaClient();
}

// --- Routing Rules ---

/** Get all enabled routing rules from DB */
export async function getRoutingRules() {
	return db().routingRule.findMany({ where: { enabled: true } });
}

/** Get routing rule by name */
export async function getRoutingRule(name: string) {
	return db().routingRule.findUnique({ where: { name } });
}

/** Create or update a routing rule */
export async function upsertRoutingRule(data: {
	name: string;
	provider: string;
	model: string;
	fallback?: string;
	enabled?: boolean;
}) {
	return db().routingRule.upsert({
		where: { name: data.name },
		update: {
			provider: data.provider,
			model: data.model,
			fallback: data.fallback,
			enabled: data.enabled,
		},
		create: {
			name: data.name,
			provider: data.provider,
			model: data.model,
			fallback: data.fallback,
			enabled: data.enabled,
		},
	});
}

/** Delete a routing rule by name */
export async function deleteRoutingRule(name: string) {
	return db().routingRule.delete({ where: { name } });
}

/** Enable/disable a routing rule by name */
export async function toggleRoutingRule(name: string, enabled: boolean) {
	return db().routingRule.update({
		where: { name },
		data: { enabled },
	});
}

// --- Model Settings ---

/** Get model setting for a specific provider+model */
export async function getModelSetting(provider: string, model: string) {
	return db().modelSetting.findUnique({
		where: { provider_model: { provider, model } },
	});
}

/** Get all model settings */
export async function getAllModelSettings() {
	return db().modelSetting.findMany();
}

/** Create or update a model setting */
export async function upsertModelSetting(data: {
	provider: string;
	model: string;
	temperature?: number | null;
	maxTokens?: number | null;
	thinking?: string | null;
	isDefault?: boolean;
	priority?: number;
}) {
	return db().modelSetting.upsert({
		where: { provider_model: { provider: data.provider, model: data.model } },
		update: {
			temperature: data.temperature,
			maxTokens: data.maxTokens,
			thinking: data.thinking,
			isDefault: data.isDefault,
			priority: data.priority,
		},
		create: {
			provider: data.provider,
			model: data.model,
			temperature: data.temperature,
			maxTokens: data.maxTokens,
			thinking: data.thinking,
			isDefault: data.isDefault,
			priority: data.priority,
		},
	});
}

/** Delete a model setting */
export async function deleteModelSetting(provider: string, model: string) {
	return db().modelSetting.delete({
		where: { provider_model: { provider, model } },
	});
}

// --- Budget ---

/** Get budget for a provider + period */
export async function getBudget(provider: string | null, period: string) {
	return db().budget.findFirst({
		where: { provider, period },
	});
}

/** Get all budget entries */
export async function getAllBudgets() {
	return db().budget.findMany();
}

/** Update budget usage (increment tokensUsed and costUsed) */
export async function updateBudgetUsage(id: string, tokens: number, cost: number) {
	return db().budget.update({
		where: { id },
		data: {
			tokensUsed: { increment: tokens },
			costUsed: { increment: cost },
		},
	});
}

/** Create or update budget configuration (limits) */
export async function upsertBudgetConfig(data: {
	provider?: string;
	period: string;
	tokenLimit?: number | null;
	costLimit?: number | null;
}) {
	const existing = await db().budget.findFirst({
		where: { provider: data.provider ?? null, period: data.period },
	});

	if (existing) {
		return db().budget.update({
			where: { id: existing.id },
			data: {
				tokenLimit: data.tokenLimit,
				costLimit: data.costLimit,
			},
		});
	}

	return db().budget.create({
		data: {
			provider: data.provider,
			period: data.period,
			tokenLimit: data.tokenLimit,
			costLimit: data.costLimit,
			resetAt: new Date(),
		},
	});
}

/** Reset budget counters (tokensUsed, costUsed to 0, update resetAt) */
export async function resetBudget(id: string) {
	return db().budget.update({
		where: { id },
		data: {
			tokensUsed: 0,
			costUsed: 0,
			resetAt: new Date(),
		},
	});
}
