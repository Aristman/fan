/**
 * Pipeline State — manages FAN feature pipeline artifacts.
 *
 * @class PipelineState
 */
export class PipelineState {
    /**
     * Static helper: detect project slug from package.json, Cargo.toml, pyproject.toml,
     * or the basename of the working directory.
     *
     * @param {string} [cwd] — Directory to probe (defaults to process.cwd())
     * @returns {Promise<string>} kebab-case slug
     */
    static detectProjectSlug(cwd?: string): Promise<string>;
    /**
     * Create a PipelineState instance.
     *
     * @param {string} [cwd] — Working directory (defaults to process.cwd())
     * @param {object} [options]
     * @param {string} [options.featureName] — Human-readable feature name
     * @param {string} [options.slug] — kebab-case slug (auto-derived if omitted)
     * @param {import("./types.js").Phase[]} [options.phases] — Phase descriptors
     * @param {"per-phase"|"per-function"|"manual"} [options.commitStrategy="per-phase"]
     * @param {string} [options.source] — Reference to the originating spec
     * @param {string} [options.description] — Optional overview description
     * @param {(mode: "overwrite"|"append"|"cancel") => "overwrite"|"append"|"cancel"} [options.onConflict]
     * @param {boolean} [options.nonBlocking=false] — If true, recordStatusChange runs fire-and-forget
     */
    constructor(cwd?: string, options?: {
        featureName?: string;
        slug?: string;
        phases?: import("./types.js").Phase[];
        commitStrategy?: "per-phase" | "per-function" | "manual";
        source?: string;
        description?: string;
        onConflict?: (mode: "overwrite" | "append" | "cancel") => "overwrite" | "append" | "cancel";
        nonBlocking?: boolean;
    });
    /**
     * Ensure required directories exist (.fan/tracking/ and docs/).
     * Does NOT overwrite existing files.
     *
     * @returns {Promise<{planPath: string, logPath: string, statusPath: string}>}
     */
    ensureArtifacts(): Promise<{
        planPath: string;
        logPath: string;
        statusPath: string;
    }>;
    /**
     * Initialise all three pipeline artifacts.
     *
     * If a file already exists, the conflict strategy from options.onConflict
     * is used (default "append" — keep existing, work with it).
     *
     * @returns {Promise<{planPath: string, logPath: string, statusPath: string}>}
     */
    init(): Promise<{
        planPath: string;
        logPath: string;
        statusPath: string;
    }>;
    /**
     * Record a phase status change.
     *
     * Writes an entry to the log and updates phase-status.json atomically.
     *
     * @param {object} params
     * @param {number} params.phaseId
     * @param {"PENDING"|"IN_PROGRESS"|"COMPLETED"|"FAILED"} params.status
     * @param {string} params.action — Short description of what happened
     * @param {string} [params.notes]
     * @param {string} [params.commitSha]
     * @returns {Promise<void>}
     */
    recordPhaseChange({ phaseId, status, action, notes, commitSha }: {
        phaseId: number;
        status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
        action: string;
        notes?: string;
        commitSha?: string;
    }): Promise<void>;
    /**
     * Append an arbitrary log entry to development-log.md.
     *
     * Used e.g. at TaskCreate to record the start of a new task.
     *
     * @param {object} params
     * @param {number} params.phaseId
     * @param {string} params.action — Short label
     * @param {string} params.content — Full markdown block to append
     * @returns {Promise<void>}
     */
    recordLogEntry({ phaseId, action, content }: {
        phaseId: number;
        action: string;
        content: string;
    }): Promise<void>;
    /**
     * Hook for TaskUpdate — called on each task status change.
     *
     * Updates the task in phase-status.json and, if nonBlocking is true,
     * runs as fire-and-forget.
     *
     * @param {object} params
     * @param {string} params.taskId
     * @param {number} params.phaseId
     * @param {"pending"|"in_progress"|"completed"|"failed"|"blocked"} params.status
     * @param {string} [params.description]
     * @param {object} [params.result]
     * @returns {Promise<void>}
     */
    recordStatusChange({ taskId, phaseId, status, description, result }: {
        taskId: string;
        phaseId: number;
        status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
        description?: string;
        result?: object;
    }): Promise<void>;
    /**
     * Parse and return the current phase-status.json.
     *
     * @returns {Promise<object|null>} Parsed JSON, or null if file doesn't exist / parse fails
     */
    getStatus(): Promise<object | null>;
    /**
     * Return the full content of development-log.md.
     *
     * @returns {Promise<string>}
     */
    getLog(): Promise<string>;
    /**
     * Return the full content of development-plan.md.
     *
     * @returns {Promise<string>}
     */
    getPlan(): Promise<string>;
    /**
     * Return the current IN_PROGRESS phase, or null if none is active.
     *
     * @returns {Promise<object|null>} Phase object or null
     */
    getCurrentPhase(): Promise<object | null>;
    /**
     * Determine whether a git commit should be made based on commitStrategy.
     *
     * @param {number} phaseId
     * @returns {Promise<boolean>}
     */
    shouldCommit(phaseId: number): Promise<boolean>;
    /**
     * Format a conventional-commit message based on the action.
     *
     * @param {object} params
     * @param {number} params.phaseId
     * @param {string} params.action — e.g. "complete", "progress", "bugfix"
     * @param {string} [params.summary] — Short description for the commit body
     * @param {string} [params.feature] — Feature identifier (for per-function)
     * @returns {string}
     */
    formatCommitMessage({ phaseId, action, summary, feature }: {
        phaseId: number;
        action: string;
        summary?: string;
        feature?: string;
    }): string;
    #private;
}
