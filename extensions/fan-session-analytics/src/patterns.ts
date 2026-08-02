/**
 * F13 — Майнинг паттернов и синтез воркеров/скилов.
 *
 * Анализирует набор траекторий из пакетного режима (dir/weekly) и находит:
 * - worker_chain: повторяющиеся последовательности типов воркеров
 * - tool_sequence: n-граммы (n=3) последовательных tool_call имён
 * - prompt_template: схожие промпты воркеров (Jaccard ≥ 0.7)
 *
 * Результат — PatternCandidate[] с предложениями по синтезу артефактов.
 */

import type { AnalyticsConfig, PatternCandidate, Trajectory } from "./types.js";
import { ORCHESTRATOR_TOOLS } from "./registry.js";

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run pattern mining on a set of trajectories.
 * Returns candidates that meet the patternMinSessions threshold.
 */
export function minePatterns(
	trajectories: Trajectory[],
	cfg: AnalyticsConfig,
): PatternCandidate[] {
	const minSessions = cfg.orchestration.patternMinSessions;
	const candidates: PatternCandidate[] = [];

	// Worker chain patterns
	const workerChains = mineWorkerChains(trajectories, minSessions);
	candidates.push(...workerChains);

	// Tool sequence patterns (n=3)
	const toolSequences = mineToolSequences(trajectories, minSessions);
	candidates.push(...toolSequences);

	// Prompt template patterns
	const promptTemplates = minePromptTemplates(trajectories, minSessions);
	candidates.push(...promptTemplates);

	// Global sort by sessionsCount descending (across all types)
	candidates.sort((a, b) => b.sessionsCount - a.sessionsCount);

	return candidates;
}

// ============================================================================
// Worker chain mining
// ============================================================================

/**
 * Enumerate all unique subsequences of `types` with length between minLen and maxLen.
 * Uses recursive combinatorial generation (not just contiguous slices).
 * Results are added to `out` as "type1→type2→..." strings.
 */
function enumerateSubsequences(
	types: string[],
	minLen: number,
	maxLen: number,
	out: Set<string>,
): void {
	const n = types.length;
	if (n < minLen) return;

	// Use indices to generate all combinations of length k
	for (let k = minLen; k <= Math.min(maxLen, n); k++) {
		const indices: number[] = [];
		// Start with first k indices
		for (let i = 0; i < k; i++) indices.push(i);

		while (true) {
			// Build subsequence from current indices
			const parts: string[] = [];
			for (const idx of indices) parts.push(types[idx]);
			out.add(parts.join("→"));

			// Advance to next combination (lexicographic)
			let pos = k - 1;
			while (pos >= 0 && indices[pos] === n - k + pos) pos--;
			if (pos < 0) break;
			indices[pos]++;
			for (let j = pos + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
		}
	}
}

/**
 * Find worker chain patterns: subsequences (not necessarily contiguous) of
 * worker types from delegate_task (lengths 2-4) that appear in ≥ minSessions sessions.
 * Uses two-pointer / combinatorial enumeration for true subsequence matching.
 * Example: explore→implement→verify IS found inside explore→implement→implement→verify.
 */
function mineWorkerChains(
	trajectories: Trajectory[],
	minSessions: number,
): PatternCandidate[] {
	// For each trajectory, extract worker type sequence
	const sessionChains: Array<{ sessionId: string; types: string[] }> = [];

	for (const t of trajectories) {
		if (t.workersSpawned.length < 2) continue;
		const types = t.workersSpawned.map((w) => w.type);
		sessionChains.push({ sessionId: t.sessionId, types });
	}

	// Extract all subsequences of length 2-4 and count across sessions
	const patternMap = new Map<string, {
		signature: string;
		sessionIds: Set<string>;
	}>();

	for (const { sessionId, types } of sessionChains) {
		// Extract unique subsequences within this session via combinatorial enumeration
		const seenInSession = new Set<string>();
		enumerateSubsequences(types, 2, 4, seenInSession);

		for (const key of seenInSession) {
			if (!patternMap.has(key)) {
				patternMap.set(key, { signature: key, sessionIds: new Set() });
			}
			patternMap.get(key)!.sessionIds.add(sessionId);
		}
	}

	// Filter by threshold and build candidates
	const candidates: PatternCandidate[] = [];

	for (const [, data] of patternMap) {
		if (data.sessionIds.size < minSessions) continue;

		const exampleIds = [...data.sessionIds].slice(0, 3);
		candidates.push({
			kind: "worker_chain",
			signature: data.signature,
			sessionsCount: data.sessionIds.size,
			exampleSessionIds: exampleIds,
			suggestedArtifact: "worker",
			draftProposal: `Создать тип воркера или готовую цепочку воркеров «${data.signature.replace(/→/g, " → ")}». ` +
				`Эта последовательность встречается в ${data.sessionIds.size} сессиях и может быть инкапсулирована ` +
				`в переиспользуемый артефакт для снижения координационных расходов.`,
		});
	}

	// Sort by sessionsCount descending
	candidates.sort((a, b) => b.sessionsCount - a.sessionsCount);
	return candidates;
}

// ============================================================================
// Tool sequence mining (n-grams, n=3)
// ============================================================================

/**
 * Find tool_sequence patterns: 3-grams of consecutive tool_call names
 * that appear in ≥ minSessions sessions with ≥ 3 total occurrences.
 */
function mineToolSequences(
	trajectories: Trajectory[],
	minSessions: number,
): PatternCandidate[] {
	const N = 3;
	const patternMap = new Map<string, {
		signature: string;
		sessionIds: Set<string>;
		totalOccurrences: number;
	}>();

	for (const t of trajectories) {
		// Get all tool_call names in order, excluding orchestrator meta-tools
		const toolNames = t.steps
			.filter((s) => s.kind === "tool_call" && s.toolName && !ORCHESTRATOR_TOOLS.has(s.toolName))
			.map((s) => s.toolName!);

		if (toolNames.length < N) continue;

		// Track which n-grams we've seen in THIS session (for session count)
		const seenInSession = new Set<string>();
		// Track per-session occurrence count
		const sessionOccurrences = new Map<string, number>();

		for (let i = 0; i <= toolNames.length - N; i++) {
			const ngram = toolNames.slice(i, i + N);
			const key = ngram.join("→");

			sessionOccurrences.set(key, (sessionOccurrences.get(key) || 0) + 1);

			if (!patternMap.has(key)) {
				patternMap.set(key, { signature: key, sessionIds: new Set(), totalOccurrences: 0 });
			}
			seenInSession.add(key);
		}

		// Add session to each seen n-gram and accumulate occurrences
		for (const key of seenInSession) {
			patternMap.get(key)!.sessionIds.add(t.sessionId);
			patternMap.get(key)!.totalOccurrences += sessionOccurrences.get(key) || 0;
		}
	}

	// Filter: ≥ minSessions sessions AND ≥ 3 total occurrences
	const candidates: PatternCandidate[] = [];

	for (const [, data] of patternMap) {
		if (data.sessionIds.size < minSessions) continue;
		if (data.totalOccurrences < 3) continue;

		const exampleIds = [...data.sessionIds].slice(0, 3);
		candidates.push({
			kind: "tool_sequence",
			signature: data.signature,
			sessionsCount: data.sessionIds.size,
			exampleSessionIds: exampleIds,
			suggestedArtifact: "skill",
			draftProposal: `Создать скилл, инкапсулирующий последовательность вызовов «${data.signature.replace(/→/g, " → ")}». ` +
				`Эта цепочка из ${N} инструментов встречается в ${data.sessionIds.size} сессиях ` +
				`(${data.totalOccurrences} суммарных вхождений) и может быть автоматизирована как единый скилл.`,
		});
	}

	candidates.sort((a, b) => b.sessionsCount - a.sessionsCount);
	return candidates;
}

// ============================================================================
// Prompt template mining (Jaccard clustering)
// ============================================================================

/**
 * Find prompt_template patterns: similar worker prompts (delegate_task task)
 * across different sessions. Normalization: lowercase, remove paths/numbers/quotes.
 * Jaccard ≥ 0.7 between prompts from different sessions; cluster ≥ minSessions.
 */
function minePromptTemplates(
	trajectories: Trajectory[],
	minSessions: number,
): PatternCandidate[] {
	// Collect all worker prompts with session info
	interface PromptEntry {
		sessionId: string;
		agentType: string;
		original: string;
		normalized: string;
		tokens: Set<string>;
	}

	const allPrompts: PromptEntry[] = [];

	for (const t of trajectories) {
		for (const w of t.workersSpawned) {
			if (!w.task || w.task.length < 20) continue; // skip very short tasks
			const normalized = normalizePrompt(w.task);
			const tokens = tokenize(normalized);
			allPrompts.push({
				sessionId: t.sessionId,
				agentType: w.type,
				original: w.task.slice(0, 200),
				normalized,
				tokens,
			});
		}
	}

	if (allPrompts.length < minSessions) return [];

	// Cluster prompts by Jaccard similarity ≥ 0.7
	// Use greedy clustering: assign each prompt to first matching cluster or create new
	const clusters: PromptEntry[][] = [];

	for (const prompt of allPrompts) {
		let assigned = false;
		for (const cluster of clusters) {
			// Compare with cluster representative (first element)
			const similarity = jaccardSimilarity(prompt.tokens, cluster[0].tokens);
			if (similarity >= 0.7) {
				cluster.push(prompt);
				assigned = true;
				break;
			}
		}
		if (!assigned) {
			clusters.push([prompt]);
		}
	}

	// Filter: clusters with prompts from ≥ minSessions DIFFERENT sessions
	const candidates: PatternCandidate[] = [];

	for (const cluster of clusters) {
		const uniqueSessions = new Set(cluster.map((p) => p.sessionId));
		if (uniqueSessions.size < minSessions) continue;

		// Determine if all prompts are from the same agent type
		const agentTypes = new Set(cluster.map((p) => p.agentType));
		const sameAgent = agentTypes.size === 1;
		const suggestedArtifact: PatternCandidate["suggestedArtifact"] = sameAgent ? "worker" : "skill";

		const representative = cluster[0].original.slice(0, 150);
		const typeLabel = sameAgent ? [...agentTypes][0] : [...agentTypes].join(", ");
		const exampleIds = [...uniqueSessions].slice(0, 3);

		const artifactHint = sameAgent
			? `Создать специализированный тип воркера на базе «${typeLabel}» с встроенным шаблоном промпта.`
			: `Создать скилл, автоматизирующий эту задачу (промпты от: ${typeLabel}).`;

		candidates.push({
			kind: "prompt_template",
			signature: `prompt:${representative.slice(0, 80)}...`,
			sessionsCount: uniqueSessions.size,
			exampleSessionIds: exampleIds,
			suggestedArtifact,
			draftProposal: `${artifactHint} ` +
				`Шаблон промпта встречается в ${uniqueSessions.size} сессиях (кластер из ${cluster.length} промптов). ` +
				`Пример: «${representative}».`,
		});
	}

	candidates.sort((a, b) => b.sessionsCount - a.sessionsCount);
	return candidates;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize a prompt for comparison:
 * - lowercase
 * - replace file paths with __PATH__ placeholder
 * - replace numbers with __NUM__ placeholder
 * - remove quotes
 * - strip trailing punctuation from words
 * - keep single-letter tokens (to distinguish «создай X» vs «создай Y»)
 */
export function normalizePrompt(text: string): string {
	return text
		.toLowerCase()
		// Replace file paths (Windows and Unix) with placeholder
		.replace(/[a-zA-Z]:[\\/][^\s,;)}\]]+/g, " __PATH__ ")
		.replace(/\/[\w./\\-]+/g, " __PATH__ ")
		// Replace numbers (standalone and within words) with placeholder
		.replace(/\b\d+\b/g, " __NUM__ ")
		.replace(/\d+/g, "__NUM__")
		// Remove quotes
		.replace(/["'`]/g, "")
		// Normalize whitespace
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Tokenize normalized text into a set of word tokens.
 * Strips trailing punctuation (,.;:) from each word.
 * Keeps single-letter tokens to distinguish e.g. «создай X» vs «создай Y».
 */
function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	for (const w of words) {
		// Strip trailing punctuation
		const cleaned = w.replace(/[,.;:]+$/, "");
		if (cleaned.length > 0) {
			tokens.add(cleaned);
		}
	}
	return tokens;
}

/**
 * Compute Jaccard similarity between two token sets.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;

	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}

	const union = a.size + b.size - intersection;
	return union > 0 ? intersection / union : 0;
}

// ============================================================================
// Report section formatting
// ============================================================================

/**
 * Format pattern candidates as a markdown section for the summary report.
 * Returns empty string if no patterns found.
 */
export function formatPatternsSection(
	candidates: PatternCandidate[],
	minSessions: number,
): string {
	const lines: string[] = [];

	lines.push("---");
	lines.push("");
	lines.push("## Рекомендации по синтезу");
	lines.push("");

	if (candidates.length === 0) {
		lines.push(`Повторяющихся паттернов не найдено (порог: ${minSessions} сессий).`);
		lines.push("");
		return lines.join("\n");
	}

	lines.push("> ⚠️ **Применение — только после подтверждения пользователем (BR4).**");
	lines.push("> Автоматическое создание агентов/скилов запрещено.");
	lines.push("");

	lines.push("| # | Тип | Паттерн | Сессий | Примеры сессий | Предлагаемый артефакт | Описание |");
	lines.push("|---|-----|---------|--------|----------------|----------------------|----------|");

	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const kindLabel = formatKindLabel(c.kind);
		const artifactLabel = formatArtifactLabel(c.suggestedArtifact);
		const examples = c.exampleSessionIds.map((id) => id.slice(0, 12)).join(", ");
		const signature = escapeMd(c.signature.length > 60 ? c.signature.slice(0, 57) + "..." : c.signature);
		const proposal = escapeMd(c.draftProposal.slice(0, 120)) + (c.draftProposal.length > 120 ? "..." : "");
		lines.push(`| ${i + 1} | ${kindLabel} | \`${signature}\` | ${c.sessionsCount} | ${examples} | ${artifactLabel} | ${proposal} |`);
	}

	lines.push("");

	// Detailed proposals
	lines.push("### Детальные предложения");
	lines.push("");

	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const kindLabel = formatKindLabel(c.kind);
		lines.push(`#### ${i + 1}. ${kindLabel}: \`${c.signature}\``);
		lines.push("");
		lines.push(`- **Сессий:** ${c.sessionsCount}`);
		lines.push(`- **Примеры:** ${c.exampleSessionIds.join(", ")}`);
		lines.push(`- **Артефакт:** ${formatArtifactLabel(c.suggestedArtifact)}`);
		lines.push(`- **Предложение:** ${c.draftProposal}`);
		lines.push("");
	}

	return lines.join("\n");
}

function formatKindLabel(kind: PatternCandidate["kind"]): string {
	switch (kind) {
		case "worker_chain": return "🔗 Цепочка воркеров";
		case "tool_sequence": return "🔧 Последовательность инструментов";
		case "prompt_template": return "📝 Шаблон промпта";
		default: return kind;
	}
}

function formatArtifactLabel(artifact: PatternCandidate["suggestedArtifact"]): string {
	switch (artifact) {
		case "worker": return "👷 Воркер";
		case "skill": return "🔧 Скилл";
		case "rule": return "📋 Правило";
		default: return artifact;
	}
}

/**
 * Escape text for safe insertion into markdown tables:
 * - Replace `|` with `\|`
 * - Replace newlines with spaces
 */
export function escapeMd(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
