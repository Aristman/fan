/**
 * FAN Orchestrator — Pipeline State
 *
 * Executive layer for Pipeline Mode (Feature Pipeline v3.1.0).
 * Manages 3 working artifacts:
 *   1. docs/development-plan.md — máquina-readable roadmap
 *   2. docs/development-log.md   — append-only change log
 *   3. .fan/tracking/phase-status.json — JSON state machine
 *
 * All file writes are atomic (temp → rename). Concurrent writes to the same
 * file are serialised per-path. No external dependencies beyond node built-ins.
 *
 * @module pipeline-state
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-path write locks to serialise concurrent writes. */
const writeLocks = new Map();

/**
 * Acquire a serialisation lock for a given file path.
 * Returns a promise that resolves when the lock is released.
 *
 * @param {string} filePath — Canonical absolute path to lock on
 * @returns {Promise<() => void>} Release function
 */
async function _acquireLock(filePath) {
  while (writeLocks.get(filePath)) {
    await writeLocks.get(filePath);
  }
  let release;
  const lock = new Promise((resolve) => { release = resolve; });
  writeLocks.set(filePath, lock);
  return /** @type {() => void} */ (release);
}

/**
 * Convert an arbitrary string to kebab-case.
 *
 * @param {string} str
 * @returns {string}
 */
function _slugify(str) {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Format a Date as an ISO-8601 string with milliseconds.
 *
 * @param {Date} [date]
 * @returns {string}
 */
function _formatLogTimestamp(date) {
  return (date ?? new Date()).toISOString();
}

/**
 * Serialise phases array to Markdown (plan.md body).
 *
 * @param {string} featureName
 * @param {string} slug
 * @param {import("./types.js").Phase[]} phases
 * @param {"per-phase"|"per-function"|"manual"} commitStrategy
 * @param {string} [source]
 * @param {string} [description]
 * @returns {string}
 */
function _phasesToMarkdown(featureName, slug, phases, commitStrategy, source, description) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push(`# Development Plan: ${featureName}`);
  lines.push("");
  lines.push(`> **Slug:** ${slug}`);
  lines.push(`> **Дата:** ${date}`);
  lines.push(`> **Commit Strategy:** ${commitStrategy}`);
  if (source) lines.push(`> **Источник:** ${source}`);
  lines.push("");

  if (description) {
    lines.push("## 1. Обзор");
    lines.push("");
    lines.push(description);
    lines.push("");
  }

  lines.push("## 2. Фазы реализации");
  lines.push("");
  lines.push("| # | Фаза | Goal | Status | Started | Completed | Commit |");
  lines.push("|---|------|------|--------|---------|-----------|--------|");

  for (const p of phases) {
    const started = p.startedAt ?? "—";
    const completed = p.completedAt ?? "—";
    const commit = p.commit ?? "—";
    lines.push(`| ${p.id} | ${p.name} | ${p.goal} | ${p.status} | ${started} | ${completed} | ${commit} |`);
  }

  lines.push("");
  lines.push("## 3. Детальный план по фазам");
  lines.push("");

  for (const p of phases) {
    lines.push(`### Phase ${p.id}: ${p.name}`);
    lines.push(`**Goal:** ${p.goal}`);
    lines.push("");

    if (p.features.length > 0) {
      lines.push("**Features:**");
      for (const f of p.features) {
        lines.push(`- ${f}`);
      }
      lines.push("");
    }

    lines.push("**Критерии приёмки:**");
    for (const c of p.criteria) {
      lines.push(`- [ ] ${c}`);
    }
    lines.push("");

    lines.push(`**Статус:** ${p.status} → [ ] IN_PROGRESS → [ ] COMPLETED`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate the initial log template.
 *
 * @param {string} featureName
 * @param {string} slug
 * @param {number} phaseCount
 * @returns {string}
 */
function _logTemplate(featureName, slug, phaseCount) {
  return `# Development Log: ${featureName}

> **Slug:** ${slug}
> **Branch:** feature/${slug}
> **Создан:** ${new Date().toISOString()}

## Формат записи

\`\`\`
YYYY-MM-DD HH:MM — [Phase N] — [Status] — [Action]
- Что сделано
- Что не сделано / блокирует
- Тесты: pass/fail
- Commit: <sha> (если есть)
- Следующий шаг
\`\`\`

## Log Entries

### ${new Date().toISOString()}
- Pipeline initialized
- Phases: ${phaseCount}
- Slug: ${slug}
- Status: 0/${phaseCount} complete

`;
}

// ---------------------------------------------------------------------------
// PipelineState
// ---------------------------------------------------------------------------

/**
 * Pipeline State — manages FAN feature pipeline artifacts.
 *
 * @class PipelineState
 */
export class PipelineState {
  /** @type {string} */
  #cwd;
  /** @type {string} */
  #featureName;
  /** @type {string} */
  #slug;
  /** @type {import("./types.js").Phase[]} */
  #phases;
  /** @type {"per-phase"|"per-function"|"manual"} */
  #commitStrategy;
  /** @type {string|undefined} */
  #source;
  /** @type {string|undefined} */
  #description;
  /** @type {(mode: "overwrite"|"append"|"cancel") => "overwrite"|"append"|"cancel"|undefined} */
  #onConflict;
  /** @type {boolean} */
  #nonBlocking;

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
  constructor(cwd, options = {}) {
    /** @type {string} */
    this.#cwd = cwd ?? process.cwd();
    /** @type {string} */
    this.#featureName = options.featureName ?? "Unnamed Feature";
    /** @type {string} */
    this.#slug = options.slug ? _slugify(options.slug) : _slugify(this.#featureName);
    /** @type {import("./types.js").Phase[]} */
    this.#phases = (options.phases ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      goal: p.goal,
      features: p.features ?? [],
      criteria: p.criteria ?? [],
      status: p.status ?? "PENDING",
      startedAt: p.startedAt ?? null,
      completedAt: p.completedAt ?? null,
      commit: p.commit ?? null,
      notes: p.notes ?? "",
    }));
    /** @type {"per-phase"|"per-function"|"manual"} */
    this.#commitStrategy = options.commitStrategy ?? "per-phase";
    this.#source = options.source;
    this.#description = options.description;
    /** @type {(mode: "overwrite"|"append"|"cancel") => "overwrite"|"append"|"cancel"|undefined} */
    this.#onConflict = options.onConflict;
    /** @type {boolean} */
    this.#nonBlocking = options.nonBlocking ?? false;

    // Valid commit strategies
    if (!["per-phase", "per-function", "manual"].includes(this.#commitStrategy)) {
      console.warn(`[PipelineState] Unknown commitStrategy "${this.#commitStrategy}", falling back to "per-phase"`);
      this.#commitStrategy = "per-phase";
    }
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  /**
   * Ensure required directories exist (.fan/tracking/ and docs/).
   * Does NOT overwrite existing files.
   *
   * @returns {Promise<{planPath: string, logPath: string, statusPath: string}>}
   */
  async ensureArtifacts() {
    const docsDir = path.resolve(this.#cwd, "docs");
    const trackingDir = path.resolve(this.#cwd, ".fan", "tracking");

    try {
      await fs.mkdir(trackingDir, { recursive: true });
    } catch (err) {
      console.warn("[PipelineState] Failed to create .fan/tracking/", err.message);
    }

    try {
      await fs.mkdir(docsDir, { recursive: true });
    } catch (err) {
      console.warn("[PipelineState] Failed to create docs/", err.message);
    }

    return {
      planPath: path.join(docsDir, "development-plan.md"),
      logPath: path.join(docsDir, "development-log.md"),
      statusPath: path.join(trackingDir, "phase-status.json"),
    };
  }

  /**
   * Initialise all three pipeline artifacts.
   *
   * If a file already exists, the conflict strategy from options.onConflict
   * is used (default "append" — keep existing, work with it).
   *
   * @returns {Promise<{planPath: string, logPath: string, statusPath: string}>}
   */
  async init() {
    const { planPath, logPath, statusPath } = await this.ensureArtifacts();

    await this.#safeCreate(planPath, () => this.#generatePlanMd());
    await this.#safeCreate(logPath, () =>
      _logTemplate(this.#featureName, this.#slug, this.#phases.length)
    );
    await this.#safeCreate(statusPath, () => JSON.stringify(this.#generateStatusJson(), null, 2));

    return { planPath, logPath, statusPath };
  }

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
  async recordPhaseChange({ phaseId, status, action, notes, commitSha }) {
    const phase = this.#phases.find((p) => p.id === phaseId);
    if (!phase) {
      console.warn(`[PipelineState] recordPhaseChange: unknown phaseId ${phaseId}`);
      return;
    }

    phase.status = status;
    if (status === "IN_PROGRESS" && !phase.startedAt) {
      phase.startedAt = new Date().toISOString();
    }
    if (status === "COMPLETED" || status === "FAILED") {
      phase.completedAt = new Date().toISOString();
    }
    if (commitSha) {
      phase.commit = commitSha;
    }

    const timestamp = _formatLogTimestamp();
    const entryParts = [
      `### ${timestamp}`,
      `- **Phase ${phaseId} → ${status}** — ${action}`,
    ];
    if (notes) entryParts.push(`- Notes: ${notes}`);
    if (commitSha) entryParts.push(`- Commit: ${commitSha}`);
    entryParts.push("");

    // Write log entry
    const logPath = path.resolve(this.#cwd, "docs", "development-log.md");
    await this.#atomicAppend(logPath, entryParts.join("\n"));

    // Update status.json
    await this.#updateStatusJson((data) => {
      const p = data.phases.find((x) => x.id === phaseId);
      if (!p) return data;
      p.status = status;
      p.startedAt = phase.startedAt;
      p.completedAt = phase.completedAt;
      p.commit = phase.commit;
      if (notes !== undefined) p.notes = notes;
      data.updatedAt = _formatLogTimestamp();
      data.currentPhase = status === "IN_PROGRESS" ? phaseId : data.currentPhase;
      data.overall = this.#calcOverall(data.phases);
      return data;
    });
  }

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
  async recordLogEntry({ phaseId, action, content }) {
    const timestamp = _formatLogTimestamp();
    const block = `### ${timestamp} — [Phase ${phaseId}] — ${action}\n${content}\n`;
    const logPath = path.resolve(this.#cwd, "docs", "development-log.md");
    await this.#atomicAppend(logPath, block);
  }

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
  async recordStatusChange({ taskId, phaseId, status, description, result }) {
    const exec = async () => {
      await this.#updateStatusJson((data) => {
        // Initialise task entry if it doesn't exist
        if (!data.tasks[taskId]) {
          data.tasks[taskId] = { phaseId, description, status: "pending", updatedAt: _formatLogTimestamp() };
        }
        data.tasks[taskId].status = status;
        data.tasks[taskId].updatedAt = _formatLogTimestamp();
        if (description) data.tasks[taskId].description = description;
        if (result) data.tasks[taskId].result = result;
        data.updatedAt = _formatLogTimestamp();
        data.overall = this.#calcOverall(Object.values(data.tasks));
        return data;
      });
    };

    if (this.#nonBlocking) {
      exec().catch((err) =>
        console.warn("[PipelineState] recordStatusChange (non-blocking) failed:", err.message)
      );
    } else {
      await exec();
    }
  }

  /**
   * Parse and return the current phase-status.json.
   *
   * @returns {Promise<object|null>} Parsed JSON, or null if file doesn't exist / parse fails
   */
  async getStatus() {
    try {
      const statusPath = path.resolve(this.#cwd, ".fan", "tracking", "phase-status.json");
      const raw = await fs.readFile(statusPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Return the full content of development-log.md.
   *
   * @returns {Promise<string>}
   */
  async getLog() {
    try {
      const logPath = path.resolve(this.#cwd, "docs", "development-log.md");
      return await fs.readFile(logPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Return the full content of development-plan.md.
   *
   * @returns {Promise<string>}
   */
  async getPlan() {
    try {
      const planPath = path.resolve(this.#cwd, "docs", "development-plan.md");
      return await fs.readFile(planPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Return the current IN_PROGRESS phase, or null if none is active.
   *
   * @returns {Promise<object|null>} Phase object or null
   */
  async getCurrentPhase() {
    const status = await this.getStatus();
    if (!status) return null;
    return status.phases.find(p => p.status === "IN_PROGRESS") || null;
  }

  /**
   * Determine whether a git commit should be made based on commitStrategy.
   *
   * @param {number} phaseId
   * @returns {Promise<boolean>}
   */
  async shouldCommit(phaseId) {
    const phase = this.#phases.find((p) => p.id === phaseId);
    if (!phase) return false;

    switch (this.#commitStrategy) {
      case "per-phase":
        return phase.status === "COMPLETED";
      case "per-function": {
        // Check if any feature inside this phase just reached a terminal state
        const json = await this.getStatus();
        if (!json || !json.tasks) return false;
        const phaseTasks = Object.values(/** @type {Record<string, any>} */ (json.tasks)).filter(
          (t) => t.phaseId === phaseId
        );
        return phaseTasks.some((t) => t.status === "completed" || t.status === "failed");
      }
      case "manual":
        return false;
      default:
        return false;
    }
  }

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
  formatCommitMessage({ phaseId, action, summary, feature }) {
    const phase = this.#phases.find((p) => p.id === phaseId);
    const phaseTag = `phase-${phaseId}`;
    const s = summary ?? "update";

    switch (action) {
      case "complete":
        return `feat(${phaseTag}): ${phase?.name ?? `phase-${phaseId}`} complete\n\n${s}`;
      case "progress":
        return feature
          ? `feat(${phaseTag}/${feature}): ${s}`
          : `feat(${phaseTag}): ${s}`;
      case "bugfix":
        return `fix(${phaseTag}): ${s}`;
      default:
        return `chore(${phaseTag}): ${s}`;
    }
  }

  /**
   * Static helper: detect project slug from package.json, Cargo.toml, pyproject.toml,
   * or the basename of the working directory.
   *
   * @param {string} [cwd] — Directory to probe (defaults to process.cwd())
   * @returns {Promise<string>} kebab-case slug
   */
  static async detectProjectSlug(cwd) {
    const dir = cwd ?? process.cwd();

    // package.json
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (pkg.name) return _slugify(pkg.name);
    } catch { /* next probe */ }

    // Cargo.toml
    try {
      const cargo = await fs.readFile(path.join(dir, "Cargo.toml"), "utf-8");
      const match = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (match) return _slugify(match[1]);
    } catch { /* next probe */ }

    // pyproject.toml
    try {
      const pyproject = await fs.readFile(path.join(dir, "pyproject.toml"), "utf-8");
      const match = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
      if (match) return _slugify(match[1]);
    } catch { /* next probe */ }

    // Fallback: directory basename
    return _slugify(path.basename(dir));
  }

  // -------------------------------------------------------------------------
  // Internal (private helpers)
  // -------------------------------------------------------------------------

  /**
   * Atomically write content to a file: temp file → rename.
   *
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<void>}
   */
  async #atomicWrite(filePath, content) {
    const release = await _acquireLock(filePath);
    try {
      const tmp = filePath + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(tmp, content, "utf-8");
      await fs.rename(tmp, filePath);
    } catch (err) {
      console.warn(`[PipelineState] atomicWrite failed for ${filePath}:`, err.message);
    } finally {
      release();
      writeLocks.delete(filePath);
    }
  }

  /**
   * Atomic append: read current content, append, write back via temp+rename.
   * Serialises per-file via the lock map.
   *
   * @param {string} filePath
   * @param {string} text — Text to append
   * @returns {Promise<void>}
   */
  async #atomicAppend(filePath, text) {
    const release = await _acquireLock(filePath);
    try {
      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist yet — start fresh
      }
      const content = existing.endsWith("\n") ? existing + text : existing + "\n" + text;
      const tmp = filePath + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(tmp, content, "utf-8");
      await fs.rename(tmp, filePath);
    } catch (err) {
      console.warn(`[PipelineState] atomicAppend failed for ${filePath}:`, err.message);
    } finally {
      release();
      writeLocks.delete(filePath);
    }
  }

  /**
   * Read → mutate → write phase-status.json atomically.
   *
   * @param {(data: object) => object} updater — Mutator function; must return (possibly mutated) data
   * @returns {Promise<void>}
   */
  async #updateStatusJson(updater) {
    const statusPath = path.resolve(this.#cwd, ".fan", "tracking", "phase-status.json");
    const release = await _acquireLock(statusPath);
    try {
      let data;
      try {
        const raw = await fs.readFile(statusPath, "utf-8");
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      if (!data) {
        data = this.#generateStatusJson();
      }
      data = updater(data) ?? data;
      const tmp = statusPath + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmp, statusPath);
    } catch (err) {
      console.warn(`[PipelineState] updateStatusJson failed:`, err.message);
    } finally {
      release();
      writeLocks.delete(statusPath);
    }
  }

  /**
   * Generate the initial phase-status.json structure.
   *
   * @returns {object}
   */
  #generateStatusJson() {
    return {
      featureName: this.#featureName,
      slug: this.#slug,
      branch: `feature/${this.#slug}`,
      commitStrategy: this.#commitStrategy,
      createdAt: _formatLogTimestamp(),
      updatedAt: _formatLogTimestamp(),
      currentPhase: null,
      phases: this.#phases.map((p) => ({
        id: p.id,
        name: p.name,
        goal: p.goal,
        status: p.status,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
        commit: p.commit,
        features: p.features,
        criteria: p.criteria,
        notes: p.notes,
      })),
      tasks: {},
      overall: {
        total: this.#phases.length,
        completed: 0,
        failed: 0,
        in_progress: 0,
      },
    };
  }

  /**
   * Generate the markdown for development-plan.md.
   *
   * @returns {string}
   */
  #generatePlanMd() {
    return _phasesToMarkdown(
      this.#featureName,
      this.#slug,
      this.#phases,
      this.#commitStrategy,
      this.#source,
      this.#description
    );
  }

  /**
   * Safely create a file if it doesn't exist, respecting conflict strategy.
   *
   * @param {string} filePath
   * @param {() => string} contentFn
   * @returns {Promise<void>}
   */
  async #safeCreate(filePath, contentFn) {
    try {
      await fs.access(filePath);
      // File exists — decide what to do
      let decision = "append";
      if (this.#onConflict) {
        decision = this.#onConflict("append") ?? "append";
      }
      if (decision === "overwrite") {
        await this.#atomicWrite(filePath, contentFn());
      }
      // "append" and "cancel" both keep the existing file as-is
    } catch {
      // File does not exist — create it
      await this.#atomicWrite(filePath, contentFn());
    }
  }

  /**
   * Recalculate overall progress counters.
   *
   * @param {Array<{status?: string}>} items — phases or tasks
   * @returns {{total: number, completed: number, failed: number, in_progress: number}}
   */
  #calcOverall(items) {
    const total = items.length;
    let completed = 0;
    let failed = 0;
    let in_progress = 0;
    for (const item of items) {
      const s = (item.status ?? "").toUpperCase();
      if (s === "COMPLETED" || s === "completed") completed++;
      else if (s === "FAILED" || s === "failed") failed++;
      else if (s === "IN_PROGRESS" || s === "in_progress") in_progress++;
    }
    return { total, completed, failed, in_progress };
  }
}
