import type { Memory, MemoryCategory, MemoryScope, RetrievalResult, RetrievalOptions } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { MemoryDatabase } from "../storage/database.js";
import { createHash } from "node:crypto";
import { MemoryRepository } from "../storage/repositories.js";
import { ftsSearch, preprocessQuery } from "./fts-engine.js";
import { vectorSearch } from "./vector-store.js";
import { isOllamaAvailable, isVectorAvailable } from "./embeddings.js";
import { generateEmbedding } from "./embeddings.js";
import { rerankWithLLM } from "./reranker.js";

// ──────────────────────────────────────────────
// Result cache (prompt hash → results)
// ──────────────────────────────────────────────

interface CacheEntry {
  results: RetrievalResult[];
  timestamp: number;
}

const MAX_CACHE_SIZE = 50;
const resultCache = new Map<string, CacheEntry>();

function hashQuery(query: string, options?: RetrievalOptions): string {
  const h = createHash("sha256");
  h.update(query);
  if (options?.category) h.update(options.category);
  if (options?.scope) h.update(options.scope);
  return h.digest("hex").slice(0, 16);
}

/** Invalidate cache (call after memory_remember/update/forget) */
export function invalidateResultCache(): void {
  resultCache.clear();
}

function getCachedResults(key: string): RetrievalResult[] | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  // LRU: move to end
  resultCache.delete(key);
  resultCache.set(key, entry);
  return entry.results;
}

function setCachedResults(key: string, results: RetrievalResult[]): void {
  if (resultCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest (first entry)
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, { results, timestamp: Date.now() });
}

// ──────────────────────────────────────────────
// Retriever — RAG orchestration
// ──────────────────────────────────────────────

interface InternalRetrievalResult {
  id: string;
  ftsRank: number | null;      // normalized [0..1], null if no FTS hit
  vectorScore: number | null;  // cosine similarity, null if no vector hit
  source: "fts" | "vector" | "both";
  ftsRelaxed: boolean;         // true if any FTS hit for this result was relaxed
}

export class Retriever {
  private globalRepo: MemoryRepository;
  private projectRepo: MemoryRepository | null;
  private config: MemoryConfig;

  constructor(
    globalDb: MemoryDatabase,
    projectDb: MemoryDatabase | null,
    config: MemoryConfig
  ) {
    this.globalRepo = new MemoryRepository(globalDb);
    this.projectRepo = projectDb ? new MemoryRepository(projectDb) : null;
    this.config = config;
  }

  // ──────────────────────────────────────────
  // Main retrieval method
  // ──────────────────────────────────────────

  async retrieve(
    query: string,
    options?: RetrievalOptions
  ): Promise<RetrievalResult[]> {
    const limit = options?.limit ?? this.config.retrieval.maxMemoriesPerQuery;
    const minScore = options?.minScore ?? this.config.retrieval.minRetrievalScore;
    const scope = options?.scope ?? "both";
    const category = options?.category;

    // Check result cache
    const cacheKey = hashQuery(query, options);
    const cached = getCachedResults(cacheKey);
    if (cached) return cached;

    // Preprocess query for FTS (stemming + expansion) — only for FTS, not vector search
    const preprocessed = preprocessQuery(query);
    console.log(`[retriever] FTS preprocessing: ${preprocessed.stemmed.length} stemmed tokens, ${preprocessed.expanded.size} expanded groups, strategy: exact → expanded → topn`);

    // Step 1: FTS search (uses stemmed/expanded internally via ftsSearch)
    const ftsGlobal = ftsSearch(query, this.globalRepo["db"], {
      ...(scope !== "project" && { scope: "global" }),
      ...(category !== undefined && { category }),
      limit: this.config.retrieval.ftsPoolSize,
    });

    const ftsProject = this.projectRepo
      ? ftsSearch(query, this.projectRepo["db"], {
          ...(scope !== "global" && { scope: "project" }),
          ...(category !== undefined && { category }),
          limit: this.config.retrieval.ftsPoolSize,
        })
      : [];

    // Log which strategy worked
    const globalStrategies = new Set(ftsGlobal.map((r) => r.strategy));
    const projectStrategies = new Set(ftsProject.map((r) => r.strategy));
    if (ftsGlobal.length > 0 || ftsProject.length > 0) {
      console.log(`[retriever] FTS results: ${ftsGlobal.length} global (${[...globalStrategies].join(",")}), ${ftsProject.length} project (${[...projectStrategies].join(",")})`);
    }

    // Step 2: Vector search (original query, NOT preprocessed)
    const vectorResults = await this.vectorSearchAcrossDBs(query, scope, category);

    // Step 3: Merge and deduplicate
    const merged = this.mergeResults(ftsGlobal, ftsProject, vectorResults);

    if (merged.size === 0) return [];

    // Step 4: Composite scoring
    const scored = this.compositeScore(merged);

    // Step 5: Take top candidates for re-ranking pool
    const candidatePool = scored
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, this.config.retrieval.candidatePoolSize);

    if (candidatePool.length === 0) return [];

    // Step 6: Take top results
    let finalIds = candidatePool
      .filter((c) => c.compositeScore >= minScore)
      .slice(0, limit);

    // Step 6.5: LLM re-ranking (optional)
    let results: RetrievalResult[] = [];
    if ((this.config.retrieval as unknown as Record<string, unknown>).llmRerank === true) {
      // Load full memories first
      for (const item of finalIds) {
        const memory = this.findMemoryById(item.id);
        if (memory) {
          results.push({ memory, score: item.compositeScore, source: item.source });
          this.touchAccess(item.id);
        }
      }
      try {
        results = await rerankWithLLM(query, results, this.config);
      } catch {
        // Fallback: use unsorted results
      }
    } else {
      // Step 7: Load full memories (no re-ranking)
      for (const item of finalIds) {
        const memory = this.findMemoryById(item.id);
        if (memory) {
          results.push({ memory, score: item.compositeScore, source: item.source });
          this.touchAccess(item.id);
        }
      }
    }

    // Enforce token budget
    const finalResults = this.enforceTokenBudget(results);

    // Cache results
    if (finalResults.length > 0) {
      setCachedResults(cacheKey, finalResults);
    }

    return finalResults;
  }

  // ──────────────────────────────────────────
  // Adaptive token budget
  // ──────────────────────────────────────────

  private enforceTokenBudget(results: RetrievalResult[]): RetrievalResult[] {
    if (results.length === 0) return [];

    const maxChars = this.config.retrieval.maxInjectionChars;

    // Adaptive: if top-1 score is very high (> 0.9), inject only it
    const topScore = results[0]!.score;
    if (topScore > 0.9 && results.length > 1) {
      const topText = results[0]!.memory.summary || results[0]!.memory.content;
      if (topText.length <= maxChars) {
        return [results[0]!];
      }
    }

    // Adaptive: if all results are low-score (< 0.4), skip injection (noise)
    if (topScore < 0.4) {
      return [];
    }

    // Standard budget enforcement: don't cut memories in half
    let totalChars = 0;
    const filtered: RetrievalResult[] = [];

    for (const r of results) {
      const text = r.memory.summary || r.memory.content;
      // Either fit entirely or skip — no partial memories
      if (totalChars + text.length > maxChars) break;
      filtered.push(r);
      totalChars += text.length;
    }

    return filtered;
  }

  // ──────────────────────────────────────────
  // FTS + Vector merge
  // ──────────────────────────────────────────

  private mergeResults(
    ftsGlobal: { id: string; rank: number; relaxed?: boolean }[],
    ftsProject: { id: string; rank: number; relaxed?: boolean }[],
    vectorResults: { id: string; score: number }[]
  ): Map<string, InternalRetrievalResult> {
    const map = new Map<string, InternalRetrievalResult>();

    // Normalize FTS ranks (lower rank = better in FTS5, so invert)
    const allFts = [...ftsGlobal, ...ftsProject];
    const maxFtsRank = allFts.length > 0 ? Math.max(...allFts.map((r) => r.rank)) : 1;
    const minFtsRank = allFts.length > 0 ? Math.min(...allFts.map((r) => r.rank)) : 0;
    const ftsRange = maxFtsRank - minFtsRank || 1;

    for (const r of ftsGlobal) {
      const normalized = 1 - (r.rank - minFtsRank) / ftsRange; // [0..1], 1 = best
      const existing = map.get(r.id);
      if (existing) {
        existing.ftsRank = Math.max(existing.ftsRank ?? 0, normalized);
        existing.source = "both";
        if (r.relaxed) existing.ftsRelaxed = true;
      } else {
        map.set(r.id, { id: r.id, ftsRank: normalized, vectorScore: null, source: "fts", ftsRelaxed: r.relaxed ?? false });
      }
    }

    for (const r of ftsProject) {
      const normalized = 1 - (r.rank - minFtsRank) / ftsRange;
      const existing = map.get(r.id);
      if (existing) {
        existing.ftsRank = Math.max(existing.ftsRank ?? 0, normalized);
        existing.source = "both";
        if (r.relaxed) existing.ftsRelaxed = true;
      } else {
        map.set(r.id, { id: r.id, ftsRank: normalized, vectorScore: null, source: "fts", ftsRelaxed: r.relaxed ?? false });
      }
    }

    for (const r of vectorResults) {
      const existing = map.get(r.id);
      if (existing) {
        existing.vectorScore = r.score;
        existing.source = "both";
      } else {
        map.set(r.id, { id: r.id, ftsRank: null, vectorScore: r.score, source: "vector", ftsRelaxed: false });
      }
    }

    return map;
  }

  // ──────────────────────────────────────────
  // Composite scoring
  // ──────────────────────────────────────────

  private compositeScore(
    results: Map<string, InternalRetrievalResult>
  ): { id: string; compositeScore: number; source: "fts" | "vector" | "both" }[] {
    const weights = this.config.retrieval.weights;
    const vectorUp = isVectorAvailable();

    // Dynamically redistribute weights if Ollama is down
    const effectiveWeights = !vectorUp
      ? {
          fts: weights.fts + weights.vector,
          vector: 0,
          recency: weights.recency,
          frequency: weights.frequency,
          confidence: weights.confidence,
        }
      : weights;

    // Normalize weight sum
    const wSum =
      effectiveWeights.fts +
      effectiveWeights.vector +
      effectiveWeights.recency +
      effectiveWeights.frequency +
      effectiveWeights.confidence;

    // Find max access count for frequency normalization
    // (we'll load memory details for scoring)
    const ids = Array.from(results.keys());
    const memories = ids
      .map((id) => this.findMemoryById(id))
      .filter(Boolean) as Memory[];

    const maxAccess = memories.length > 0
      ? Math.max(...memories.map((m) => m.accessCount), 1)
      : 1;

    return memories.map((mem) => {
      const r = results.get(mem.id)!;

      // FTS score (apply penalty for relaxed results)
      let ftsScore = r.ftsRank ?? 0;
      if (r.ftsRelaxed) {
        ftsScore *= 0.85;
      }

      // Vector score
      const vecScore = r.vectorScore ?? 0;

      // Recency score: exponential decay
      const now = Date.now();
      const daysSince = mem.lastAccessedAt
        ? (now - mem.lastAccessedAt) / (1000 * 60 * 60 * 24)
        : 365; // Never accessed = old
      const recencyScore = Math.exp(-0.01 * daysSince);

      // Frequency score: log-based
      const freqScore = Math.log(1 + mem.accessCount) / Math.log(1 + maxAccess);

      // Confidence: raw
      const confScore = mem.confidence;

      const composite =
        (effectiveWeights.fts * ftsScore +
          effectiveWeights.vector * vecScore +
          effectiveWeights.recency * recencyScore +
          effectiveWeights.frequency * freqScore +
          effectiveWeights.confidence * confScore) /
        wSum;

      return {
        id: mem.id,
        compositeScore: composite,
        source: r.source,
      };
    });
  }

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────

  private async vectorSearchAcrossDBs(
    query: string,
    scope: MemoryScope | "both",
    category?: MemoryCategory
  ) {
    const results: { id: string; score: number }[] = [];

    if (scope !== "project") {
      const global = await vectorSearch(query, this.globalRepo["db"], this.config, {
        scope: "global",
        ...(category !== undefined && { category }),
        limit: this.config.retrieval.vectorPoolSize,
      });
      results.push(...global);
    }

    if (this.projectRepo && scope !== "global") {
      const project = await vectorSearch(
        query,
        this.projectRepo["db"],
        this.config,
        {
          scope: "project",
          ...(category !== undefined && { category }),
          limit: this.config.retrieval.vectorPoolSize,
        }
      );
      results.push(...project);
    }

    return results;
  }

  private findMemoryById(id: string): Memory | null {
    return (
      this.globalRepo.findById(id) ?? this.projectRepo?.findById(id) ?? null
    );
  }

  private touchAccess(id: string): void {
    this.globalRepo.touchAccess(id, false);
    this.projectRepo?.touchAccess(id, false);
  }

  // ──────────────────────────────────────────
  // Public accessors for tools
  // ──────────────────────────────────────────

  getGlobalRepo(): MemoryRepository {
    return this.globalRepo;
  }

  getProjectRepo(): MemoryRepository | null {
    return this.projectRepo;
  }

  getConfig(): MemoryConfig {
    return this.config;
  }
}
