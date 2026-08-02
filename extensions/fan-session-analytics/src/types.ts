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
}

export type DetectFn = (t: Trajectory, cfg: AnalyticsConfig) => Finding[] | Promise<Finding[]>;
