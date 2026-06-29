import type { Memory, MemoryCategory, MemoryScope, RetrievalResult, RetrievalOptions } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { MemoryDatabase } from "../storage/database.js";
import { MemoryRepository } from "../storage/repositories.js";
import { ftsSearch } from "./fts-engine.js";
import { vectorSearch } from "./vector-store.js";
import { isOllamaAvailable } from "./embeddings.js";
import { generateEmbedding } from "./embeddings.js";

// ──────────────────────────────────────────────
// Retriever — RAG orchestration
// ──────────────────────────────────────────────

/**
 * Redistribute a portion of weight proportionally across other weights.
 * Ensures the total weight sum remains the same.
 */
function redistributeWeights(
  weights: { fts: number; vector: number; recency: number; frequency: number; confidence: number },
  redistributeAmount: number
): { fts: number; vector: number; recency: number; frequency: number; confidence: number } {
  const others = ["fts", "recency", "frequency", "confidence"] as const;
  const totalOther = others.reduce((sum, k) => sum + weights[k], 0);
  if (totalOther <= 0) {
    // If all other weights are zero, distribute evenly
    const share = redistributeAmount / others.length;
    return {
      fts: weights.fts + share,
      vector: 0,
      recency: weights.recency + share,
      frequency: weights.frequency + share,
      confidence: weights.confidence + share,
    };
  }
  return {
    fts: weights.fts + redistributeAmount * (weights.fts / totalOther),
    vector: 0,
    recency: weights.recency + redistributeAmount * (weights.recency / totalOther),
    frequency: weights.frequency + redistributeAmount * (weights.frequency / totalOther),
    confidence: weights.confidence + redistributeAmount * (weights.confidence / totalOther),
  };
}

interface InternalRetrievalResult {
  id: string;
  ftsRank: number | null;      // normalized [0..1], null if no FTS hit
  vectorScore: number | null;  // cosine similarity, null if no vector hit
  source: "fts" | "vector" | "both";
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

    // Step 1: FTS search
    // NOTE: bracket access to private `db` works because TS `private` is erased at runtime.
    // Repo provides getDb() for type-safe access.
    const ftsGlobal = ftsSearch(query, this.globalRepo["db"], {
      scope: scope === "project" ? undefined : "global",
      category,
      limit: this.config.retrieval.ftsPoolSize,
    });

    const ftsProject = this.projectRepo
      ? ftsSearch(query, this.projectRepo["db"], {
          scope: scope === "global" ? undefined : "project",
          category,
          limit: this.config.retrieval.ftsPoolSize,
        })
      : [];

    // Step 2: Vector search
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

    // Step 6: Take top results (no LLM re-rank for now — will add as tool)
    const finalIds = candidatePool
      .filter((c) => c.compositeScore >= minScore)
      .slice(0, limit);

    // Step 7: Load full memories
    const results: RetrievalResult[] = [];
    for (const item of finalIds) {
      const memory = this.findMemoryById(item.id);
      if (memory) {
        results.push({
          memory,
          score: item.compositeScore,
          source: item.source,
        });

        // Touch access
        this.touchAccess(item.id);
      }
    }

    // Enforce token budget
    return this.enforceTokenBudget(results);
  }

  // ──────────────────────────────────────────
  // Token budget enforcement
  // ──────────────────────────────────────────

  private enforceTokenBudget(results: RetrievalResult[]): RetrievalResult[] {
    let totalChars = 0;
    const maxChars = this.config.retrieval.maxInjectionChars;
    const filtered: RetrievalResult[] = [];

    for (const r of results) {
      const text = r.memory.summary || r.memory.content;
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
    ftsGlobal: { id: string; rank: number }[],
    ftsProject: { id: string; rank: number }[],
    vectorResults: { id: string; score: number }[]
  ): Map<string, InternalRetrievalResult> {
    // Normalize each DB's FTS results independently using its own max rank
    const normalizeFts = (results: { id: string; rank: number }[]): { id: string; rank: number; normalized: number }[] => {
      const maxRank = results.length > 0 ? Math.max(...results.map((r) => r.rank)) : 1;
      const range = maxRank || 1;
      return results.map((r) => ({ id: r.id, rank: r.rank, normalized: r.rank / range }));
    };

    const normalizedGlobal = normalizeFts(ftsGlobal);
    const normalizedProject = normalizeFts(ftsProject);

    const map = new Map<string, InternalRetrievalResult>();

    for (const r of normalizedGlobal) {
      map.set(r.id, { id: r.id, ftsRank: r.normalized, vectorScore: null, source: "fts" });
    }

    for (const r of normalizedProject) {
      const existing = map.get(r.id);
      if (existing) {
        existing.ftsRank = Math.max(existing.ftsRank ?? 0, r.normalized);
        existing.source = "both";
      } else {
        map.set(r.id, { id: r.id, ftsRank: r.normalized, vectorScore: null, source: "fts" });
      }
    }

    for (const r of vectorResults) {
      const existing = map.get(r.id);
      if (existing) {
        existing.vectorScore = r.score;
        existing.source = "both";
      } else {
        map.set(r.id, { id: r.id, ftsRank: null, vectorScore: r.score, source: "vector" });
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
    const ollamaUp = isOllamaAvailable();

    // Dynamically redistribute vector weight proportionally across other weights if Ollama is down
    const effectiveWeights = !ollamaUp
      ? redistributeWeights(weights, weights.vector)
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

      // FTS score
      const ftsScore = r.ftsRank ?? 0;

      // Vector score: normalize cosine similarity [-1, 1] to [0, 1]
      const vecScore = r.vectorScore !== null ? (r.vectorScore + 1) / 2 : 0;

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
        category,
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
          category,
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
