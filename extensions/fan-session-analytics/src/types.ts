// Shared types for session-analytics extension

export interface TrajectoryStep {
	entryId: string;
	ts: number; // Unix ms
	kind: "user" | "assistant_text" | "thinking" | "tool_call" | "tool_result" | "system" | "model_change" | "thinking_level_change" | "compaction" | "branch_summary" | "other";
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	model?: string;
	tokens?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	durationMs?: number;
	durationKind?: "tool_exec" | "generation" | "user_idle";
}

export interface WorkerSpawn {
	type: string;
	verdict?: string;
	task?: string;
}

export interface Trajectory {
	sessionId: string;
	path: string;
	cwd: string;
	startedAt: number;
	endedAt: number;
	steps: TrajectoryStep[];
	skillsActivated: string[];
	workersSpawned: WorkerSpawn[];
	compactions: number;
	truncated: boolean;
	invalidLines: number;
	totalLines: number;
	dbTokensInfo?: { tokens: number; cost: number; source: string } | null;
	delegateTaskResults?: Map<string, { verdict: string; agentType: string }>;
}

export interface Finding {
	detectorId: string;
	severity: "high" | "medium" | "low";
	title: string;
	evidence: {
		entryIds: string[];
		excerpt: string;
	};
	recommendation?: string;
	metrics?: Record<string, number>;
}

export interface SessionScore {
	total: number;
	findings: Finding[];
	metrics: Record<string, number | string>;
	truncated: boolean;
	judge?: JudgeResult;
	/** Combined score: deterministic × 0.6 + judgeScore × 0.4 (when judge available) */
	combinedScore?: number;
}

export interface AnalyticsConfig {
	judge: {
		provider?: string;
		model?: string;
		batchMaxSteps: number;
		batchMaxChars: number;
		excerptLimit: number;
	};
	autoAnalyze: { enabled: boolean; mode: "metrics" | "full" };
	weeklyBatch: { enabled: boolean; silent: boolean };
	filters: {
		excludePathPatterns: string[];
		minEntries: number;
	};
	orchestration: {
		overheadRatioWarn: number;
		heavySkills: string[];
		smallChangeLines: number;
		smallChangeFiles: number;
		retryPromptSimilarity: number;
		patternMinSessions: number;
	};
	reports: { dir: string };
	detectors: {
		idleThresholdMin: number;
		d12Enabled: boolean;
	};
}

export type DetectFn = (t: Trajectory, cfg: AnalyticsConfig) => Finding[] | Promise<Finding[]>;

// ============================================================================
// Judge types (Stage B)
// ============================================================================

/** A single batch of compressed trajectory for the judge. */
export interface JudgeBatch {
	index: number;
	totalBatches: number;
	header: string;
	steps: string[];
	isLast: boolean;
}

/** Single rubric evaluation from the judge. */
export interface RubricEvaluation {
	score: number; // 0-3
	justification: string;
	stepRefs: number[];
}

/** A recommendation from the judge. */
export interface JudgeRecommendation {
	target: "skill" | "prompt" | "config" | "worker";
	suggestion: string;
	reason: string;
}

/** Result of the full judge run. */
export interface JudgeResult {
	rubrics: Record<string, RubricEvaluation | "n/a">;
	judgeScore: number; // 0-100
	recommendations: JudgeRecommendation[];
	usage: JudgeUsage;
	model: string;
	unavailable?: boolean;
	batchCount: number;
}

/** Token usage for judge calls. */
export interface JudgeUsage {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	calls: number;
}

/** Dependencies for the judge client (injected for testability). */
export interface JudgeDeps {
	complete: (model: any, context: { systemPrompt?: string; messages: any[] }, options?: any) => Promise<any>;
	modelRegistry: {
		find: (provider: string, modelId: string) => any | undefined;
		getAvailable: () => any[];
	};
	currentModel: any | undefined;
}
