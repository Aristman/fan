/**
 * FAN Orchestrator — Task Complexity Classifier
 *
 * Multi-level task complexity assessment:
 *   Level 1 — Keyword-based heuristic (fast, deterministic)
 *   Level 2 — Rule-based scoring (syntactic analysis)
 *   Level 3 — LLM-based assessment (semantic, optional, uses quick inline model call)
 *
 * Returns a verdict: "direct" (coordinator can do it), "delegate" (needs worker),
 * or "uncertain" (recommendation provided, LLM decides).
 *
 * Each level can short-circuit: if Level 1 is confident enough, skip Levels 2-3.
 */

// ─── SIMPLE KEYWORDS — task is almost certainly trivial ───
const SIMPLE_KEYWORDS = [
  /typo/i,
  /spelling?/i,
  /rename/i,
  /переименуй/i,
  /опичатк/i,
  /fix (typo|spelling)/i,
  /replace ['"][^'"]+['"]\s*(with|to)\s*['"][^'"]+['"]/i,
  /change\s+['"][^'"]+['"]\s*(to|→)\s*['"][^'"]+['"]/i,
  /удали\s+(строку|лишн)/i,
  /добавь\s+(комментарий|пробел)/i,
  /remove\s+(line|comment)/i,
  /add\s+(comment|space)/i,
  /bump\s+(version|patch)/i,
  /update\s+(version|dependency)/i,
];

// ─── COMPLEX KEYWORDS — task is almost certainly complex ───
const COMPLEX_KEYWORDS = [
  /\b(implement(?:s|ing|ed)?|creat(?:e|es|ed|ing)?|(?:build(?:s|ing)?|built)|develop(?:s|ed|ing)?|design(?:s|ed|ing)?|refactor(?:s|ed|ing)?|migrat(?:e|es|ed|ing)?|generat(?:e|es|ed|ing)?|redesign(?:s|ed|ing)?|restructur(?:e|es|ed|ing)?)\b/i,
  /\b(architecture|architectural|system\s*design)\b/i,
  /(?:^|[\s,.;:!?\-])(реализуй|создай|разработай|спроектируй|отрефактори)(?:$|[\s,.;:!?\-])/i,
  /\b(add|implement(?:s|ing|ed)?)\s+(auth|authentication|authorization|login|register|database|schema)\b/i,
  /\b(feature|module|component|service|endpoint|api)\b/i,
  /\b(multistep|multi-step|multi\s*step)\b/i,
  /\b(dependency|migration|schema\s*change)\b/i,
  /\b(deploy|ci\/?cd|pipeline|workflow)\b/i,
  /\b(tests?|testing|coverage|e2e|integration\s*test)\b/i,
  /\b(security|vulnerability|exploit|audit)\b/i,
  /\b(performance|optimize|optimization|profile|bottleneck)\b/i,
];

// ─── WORKER PATTERNS — mentions of specific agent types ───
const EXPLORE_PATTERNS = [
  /explore|find|search|locate|grep|look for|what files|structure/i,
  /(?:^|[\s,.;:!?\-])(исследуй|найди|поищи|структур)/i,
];
const PLAN_PATTERNS = [
  /plan|design|архитектур/i,
  /(?:^|[\s,.;:!?\-])(спланируй|спроектируй)/i,
];
const VERIFY_PATTERNS = [
  /review|verify|check|test|audit|inspect|validate/i,
  /(?:^|[\s,.;:!?\-])(проверь|верифицируй|проинспектируй)/i,
];

// ─── COMPLEXITY WEIGHTS ───
const WEIGHTS = {
  simpleKeyword: -2,   // each simple keyword match reduces score
  complexKeyword: 3,   // each complex keyword match increases score
  fileCountWord: 1,    // mentions of "file(s)" or file paths
  multiStepWord: 4,    // mentions of ordering, steps, phases
  newFileCreation: 3,  // "create file", "new file", "add file"
  codeGeneration: 2,   // "generate", "write code", "produce"
};

// ─── PATTERNS BY WEIGHT CATEGORY ───
const FILE_COUNT_PATTERNS = [
  /\d+\s+(files?|файлов?)/i,
  /multiple\s+(files?|modules?)/i,
  /(?:^|[\s,.;:!?\-])несколько\s+файлов/i,
];

const MULTI_STEP_PATTERNS = [
  /\b(first|then|next|after|finally|step|phase|stage|этап|шаг)\b/i,
  /\bпосле\s+этого\b/i,
  /\bзатем\b/i,
];

const NEW_FILE_PATTERNS = [
  /(create|add|new)\s+(file|module|class|function|component)/i,
  /(?:^|[\s,.;:!?\-])создай\s+(файл|модуль|класс)/i,
];

const CODE_GEN_PATTERNS = [
  /\b(generat(?:e|es|ed|ing)?|produce(?:s|d|ing)?|write\s+code|сгенерируй|напиши\s+код)\b/i,
];

// ─── LIMIT CONSTANTS ───
const MAX_COMMIT_LINES = 15;          // max lines of change for "direct"
const MAX_CHANGE_CHARS = 200;         // max total chars changed for "direct"
const MAX_FILES = 1;                  // max files affected for "direct"

/**
 * Level 1: Keyword-based heuristic.
 * Returns { verdict, confidence, reasons } or null if confidence is too low.
 */
function keywordHeuristic(description) {
  const simpleMatches = [];
  const complexMatches = [];

  for (const re of SIMPLE_KEYWORDS) {
    const m = description.match(re);
    if (m) simpleMatches.push(m[0]);
  }

  for (const re of COMPLEX_KEYWORDS) {
    const m = description.match(re);
    if (m) complexMatches.push(m[0]);
  }

  const reasons = [];

  // Strong simple signal: simple keywords AND no complex keywords
  if (simpleMatches.length > 0 && complexMatches.length === 0) {
    reasons.push(`Simple keywords: "${simpleMatches.join('", "')}"`);
    const combinedLen = simpleMatches.reduce((s, m) => s + m.length, 0);
    const confidence = Math.min(0.95, 0.6 + simpleMatches.length * 0.12 + combinedLen * 0.005);
    if (confidence >= 0.7) {
      return { verdict: "direct", confidence, reasons };
    }
  }

  // Strong complex signal
  if (complexMatches.length > 0 && simpleMatches.length === 0) {
    reasons.push(`Complex keywords: "${complexMatches.join('", "')}"`);
    const confidence = Math.min(0.95, 0.65 + complexMatches.length * 0.1);
    return { verdict: "delegate", confidence, reasons };
  }

  // Mixed signals — low confidence, fall through
  return null;
}

/**
 * Level 2: Rule-based scoring.
 * Returns { verdict, confidence, reasons }.
 */
function ruleBasedScoring(description, taskContext) {
  let score = 0;
  const reasons = [];
  const lower = description.toLowerCase();

  // ─── Simple keyword matches (lower score) ───
  let simpleHits = 0;
  for (const re of SIMPLE_KEYWORDS) {
    if (re.test(description)) {
      simpleHits++;
    }
  }
  if (simpleHits > 0) {
    score -= simpleHits * Math.abs(WEIGHTS.simpleKeyword);
    reasons.push(`-${simpleHits * Math.abs(WEIGHTS.simpleKeyword)} from ${simpleHits} simple keyword(s)`);
  }

  // ─── Complex keyword matches ───
  let complexHits = 0;
  for (const re of COMPLEX_KEYWORDS) {
    if (re.test(description)) {
      complexHits++;
    }
  }
  if (complexHits > 0) {
    score += complexHits * WEIGHTS.complexKeyword;
    reasons.push(`+${complexHits * WEIGHTS.complexKeyword} from ${complexHits} complex keyword(s)`);
  }

  // ─── File count mentions ───
  for (const re of FILE_COUNT_PATTERNS) {
    if (re.test(description)) {
      score += WEIGHTS.fileCountWord;
      reasons.push(`+${WEIGHTS.fileCountWord} from multi-file mention`);
      break;
    }
  }

  // ─── Multi-step mentions ───
  for (const re of MULTI_STEP_PATTERNS) {
    if (re.test(description)) {
      score += WEIGHTS.multiStepWord;
      reasons.push(`+${WEIGHTS.multiStepWord} from multi-step mention`);
      break;
    }
  }

  // ─── New file creation ───
  for (const re of NEW_FILE_PATTERNS) {
    if (re.test(description)) {
      score += WEIGHTS.newFileCreation;
      reasons.push(`+${WEIGHTS.newFileCreation} from new file creation`);
      break;
    }
  }

  // ─── Code generation ───
  for (const re of CODE_GEN_PATTERNS) {
    if (re.test(description)) {
      score += WEIGHTS.codeGeneration;
      reasons.push(`+${WEIGHTS.codeGeneration} from code generation`);
      break;
    }
  }

  // ─── Worker-specific patterns ───
  const hasExplore = EXPLORE_PATTERNS.some(re => re.test(description));
  const hasPlan = PLAN_PATTERNS.some(re => re.test(description));
  const hasVerify = VERIFY_PATTERNS.some(re => re.test(description));
  if (hasExplore || hasPlan || hasVerify) {
    reasons.push(`+4 from worker-specific pattern (research/plan/verify)`);
    score += 4;
  }

  // ─── Context-aware: if taskContext says which files ───
  if (taskContext?.files) {
    const fileCount = Array.isArray(taskContext.files) ? taskContext.files.length : 0;
    if (fileCount > MAX_FILES) {
      score += 2;
      reasons.push(`+2 from ${fileCount} file(s) in context`);
    }
  }

  // ─── Description length heuristic ───
  const wordCount = description.split(/\s+/).length;
  if (wordCount > 30) {
    score += 1.5;
    reasons.push(`+1.5 from long description (${wordCount} words)`);
  } else if (wordCount < 8 && complexHits === 0) {
    score -= 1;
    reasons.push(`-1 from very short description (${wordCount} words)`);
  }

  // ─── Verdict from score ───
  const hasMixedSignals = simpleHits > 0 && complexHits > 0;
  if (score <= -1 && !hasMixedSignals) {
    const confidence = Math.min(0.9, 0.6 + Math.abs(score) * 0.05);
    return { verdict: "direct", confidence, score, reasons };
  }
  // Score in delegate range
  if (score >= 4) {
    const confidence = Math.min(0.9, 0.55 + score * 0.04);
    return { verdict: "delegate", confidence, score, reasons };
  }
  // Mixed signals — don't decide, return uncertain
  if (hasMixedSignals) {
    return { verdict: "uncertain", confidence: 0.3, score, reasons };
  }
  // Uncertain zone (-1 < score < 4), clean signal
  const recommendation = score > 1 ? "delegate" : (score < 0.5 ? "direct" : "uncertain");
  return { verdict: recommendation, confidence: 0.4, score, reasons };
}

/**
 * Level 3: LLM-based assessment.
 * Spawns a quick inline model call to classify the task.
 * Uses a separate subprocess with minimal prompt to keep it cheap.
 *
 * @param {string} description - Task description
 * @param {object} taskContext - Optional context (files, current task)
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<{ verdict: string, confidence: number, reasoning: string } | null>}
 */
async function llmAssessment(description, taskContext, signal) {
  const { runSingleAgent } = await import("./subagent-runner.js");
  const { discoverAgents } = await import("./agents.js");

  // Build a minimal "assessor" agent on the fly
  const assessorAgent = {
    name: "assessor",
    description: "Task complexity assessor",
    readOnly: true,
    model: undefined, // will use session default
    systemPrompt: [
      `You are a task complexity assessor. Your ONLY job is to classify a task as one of:`,
      `- "direct" — the task is SIMPLE and can be done directly by the coordinator without spawning a worker.`,
      `  Criteria: ≤1 file, ≤5 lines change, deterministic change (typo fix, rename, single edit).`,
      `- "delegate" — the task is COMPLEX and NEEDS a worker subagent.`,
      `  Criteria: multiple files, architectural change, code generation, testing, research, planning.`,
      `- "uncertain" — you can't confidently decide.`,
      ``,
      `Output ONLY a JSON object with NO markdown, NO code fences:`,
      `{"verdict":"direct|delegate|uncertain","confidence":0.0-1.0,"reasoning":"brief explanation"}`,
      `Do NOT include any text before or after the JSON. Do NOT wrap in \`\`\`json.`,
    ].join("\n"),
  };

  const taskPrompt = [
    `Classify this task:`,
    ``,
    description,
    ``,
    taskContext?.files?.length > 0
      ? `Files in context: ${taskContext.files.join(", ")}`
      : "",
    taskContext?.currentTask
      ? `Current task: ${taskContext.currentTask}`
      : "",
    ``,
    `Output ONLY JSON. No markdown, no code fences.`,
  ].filter(Boolean).join("\n");

  // Setup timeout — LLM call should be fast
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      return null;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const result = await runSingleAgent(
      process.cwd(),
      [assessorAgent],
      "assessor",
      taskPrompt,
      0.0, // zero temperature for deterministic output
      undefined,
      undefined,
      controller.signal,
    );

    const output = result.text || "";
    const json = extractJson(output);
    if (json && ["direct", "delegate", "uncertain"].includes(json.verdict)) {
      return {
        verdict: json.verdict,
        confidence: typeof json.confidence === "number" ? json.confidence : 0.5,
        reasoning: json.reasoning || "",
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract JSON object from text, tolerating minor noise.
 */
function extractJson(text) {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object" && parsed.verdict) return parsed;
  } catch {}

  // Try to find {...} in the text
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object" && parsed.verdict) return parsed;
    } catch {}
  }

  return null;
}

// ─── COMPLEXITY RULES (used in prompt as clear guidelines) ───

/**
 * Rules that describe DIRECT tasks — written so LLM can reference them.
 */
export const DIRECT_TASK_RULES = [
  "Affects only 1 file",
  "Change is ≤5 lines or ≤200 characters total",
  "Change is deterministic (find → replace, no logic)",
  "No risk of breaking build, tests, or other functionality",
  "No exploration, research, or analysis needed",
  "No dependencies on other changes or tasks",
  "Examples: typo fix, rename variable, bump version, add comment, replace string",
];

/**
 * Rules that describe tasks needing DELEGATION.
 */
export const DELEGATE_TASK_RULES = [
  "Affects multiple files or modules",
  "Involves code generation or creation of new files",
  "Requires architectural decisions or design",
  "Involves testing or verification",
  "Requires research or exploration of the codebase",
  "Multi-step workflow with dependencies",
  "Involves security, performance, or correctness analysis",
];

/**
 * Main entry point: classify a task for simplicity/complexity.
 *
 * @param {string} description - Task description
 * @param {object} [options]
 * @param {number} [options.levels=3] - How many levels to run (1-3)
 * @param {object} [options.taskContext] - Optional context (files, currentTask)
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<{
 *   verdict: "direct"|"delegate"|"uncertain",
 *   confidence: number,
 *   reasons: string[],
 *   levelReached: number,
 *   score?: number,
 *   llmReasoning?: string,
 * }>}
 */
export async function classifyComplexity(description, options = {}) {
  const { levels = 3, taskContext = {}, signal } = options;
  const reasons = [];

  // ─── Empty string guard ───
  if (!description || description.trim().length === 0) {
    return { verdict: "uncertain", confidence: 0, reasons: ["Empty task description"], levelReached: 1 };
  }

  // ─── Level 1: Keyword heuristic ───
  const l1 = keywordHeuristic(description);
  if (l1) {
    reasons.push(`[L1] ${l1.reasons.join("; ")}`);
    if (l1.confidence >= 0.85 || levels < 2) {
      return {
        verdict: l1.verdict,
        confidence: l1.confidence,
        reasons,
        levelReached: 1,
      };
    }
  }

  // ─── Level 2: Rule-based scoring ───
  const l2 = ruleBasedScoring(description, taskContext);
  reasons.push(`[L2] Score: ${l2.score?.toFixed(1)} — ${l2.reasons.join(", ")}`);

  // If L2 is confident enough, return its verdict
  if (l2.verdict !== "uncertain" && l2.confidence >= 0.7) {
    return {
      verdict: l2.verdict,
      confidence: l2.confidence,
      reasons,
      levelReached: 2,
      score: l2.score,
    };
  }

  // If we stop at level 2, use L2 verdict as-is (even if uncertain)
  if (levels < 3) {
    return {
      verdict: l2.verdict,
      confidence: l2.confidence,
      reasons,
      levelReached: 2,
      score: l2.score,
    };
  }

  // ─── Level 3: LLM assessment (optional, expensive) ───
  if (levels >= 3) {
    try {
      const l3 = await llmAssessment(description, taskContext, signal);
      if (l3) {
        reasons.push(`[L3] ${l3.reasoning} (confidence: ${l3.confidence})`);
        // Blend L2 and L3
        const blendedConfidence = (l2.confidence + l3.confidence) / 2;
        const verdict = blendedConfidence >= 0.5 ? l3.verdict : l2.verdict;
        return {
          verdict,
          confidence: blendedConfidence,
          reasons,
          levelReached: 3,
          score: l2.score,
          llmReasoning: l3.reasoning,
        };
      }
      reasons.push(`[L3] LLM assessment unavailable or failed`);
    } catch (e) {
      reasons.push(`[L3] LLM assessment error: ${e.message}`);
    }
  }

  // ─── Fallback: default to uncertain ───
  return {
    verdict: "uncertain",
    confidence: 0.3,
    reasons,
    levelReached: levels < 2 ? 1 : 2,
    score: l2.score,
  };
}

/**
 * Format the complexity classification result for display.
 */
export function formatComplexityResult(result) {
  const verdict = result?.verdict || "uncertain";
  const confidence = result?.confidence ?? 0;
  const reasons = result?.reasons || [];
  const levelReached = result?.levelReached ?? 0;
  const score = result?.score;
  const llmReasoning = result?.llmReasoning;

  const verdictIcons = {
    direct: "✅",
    delegate: "🔧",
    uncertain: "⚠️",
  };
  const verdictLabels = {
    direct: "DIRECT — coordinator can handle this directly",
    delegate: "DELEGATE — spawn a worker subagent",
    uncertain: "UNCERTAIN — use judgement",
  };
  const icon = verdictIcons[verdict] || "❓";
  const label = verdictLabels[verdict] || verdict;
  const confidencePct = Math.round(confidence * 100);

  let out = `${icon} ${label} (${confidencePct}% confidence)\n`;
  out += `   Level reached: L${levelReached}`;
  if (score !== undefined) {
    out += ` | Score: ${score.toFixed(1)}`;
  }
  out += "\n";
  for (const r of reasons) {
    out += `   • ${r}\n`;
  }
  if (llmReasoning) {
    out += `   L3 reasoning: ${llmReasoning}\n`;
  }
  return out.trim();
}
