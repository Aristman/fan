import type { MemoryConfig } from "../config.js";
import { cosineSimilarity, deserializeEmbedding } from "../types.js";
import { generateEmbedding, isOllamaAvailable } from "./embeddings.js";
import type { MemoryDatabase } from "../storage/database.js";

// ──────────────────────────────────────────────
// Vector search (brute-force cosine similarity)
// ──────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  score: number;
}

export async function vectorSearch(
  queryText: string,
  db: MemoryDatabase,
  config: MemoryConfig,
  opts?: {
    scope?: "global" | "project" | "both";
    category?: string;
    limit?: number;
    minScore?: number;
  }
): Promise<VectorSearchResult[]> {
  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(queryText, config);
  if (!queryEmbedding) {
    return []; // Ollama unavailable, fallback to FTS-only
  }

  const scope = opts?.scope ?? "both";
  const category = opts?.category;
  const limit = opts?.limit ?? 15;
  const minScore = opts?.minScore ?? 0.3;

  // Build query
  let sql = "SELECT id, embedding FROM memories WHERE archived = 0 AND embedding IS NOT NULL";
  const params: unknown[] = [];

  if (scope === "global") {
    sql += " AND scope = 'global'";
  } else if (scope === "project") {
    sql += " AND scope = 'project'";
  }
  // 'both' = no filter

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  const rows = db.getDb().prepare(sql).all(...params) as { id: string; embedding: Buffer }[];

  // Compute cosine similarity
  const results: VectorSearchResult[] = [];

  for (const row of rows) {
    try {
      const emb = deserializeEmbedding(row.embedding);
      const score = cosineSimilarity(queryEmbedding, emb);

      if (score >= minScore) {
        results.push({ id: row.id, score });
      }
    } catch {
      // Skip invalid embeddings
    }
  }

  // Sort by score descending and take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ──────────────────────────────────────────────
// All-pairs similarity (for dedup/clustering)
// ──────────────────────────────────────────────

export interface PairwiseResult {
  idA: string;
  idB: string;
  similarity: number;
}

export function computePairwiseSimilarity(
  db: MemoryDatabase,
  threshold: number = 0.9
): PairwiseResult[] {
  const rows = db
    .getDb()
    .prepare("SELECT id, embedding FROM memories WHERE archived = 0 AND embedding IS NOT NULL")
    .all() as { id: string; embedding: Buffer }[];

  const results: PairwiseResult[] = [];

  // Load all embeddings
  const entries: { id: string; embedding: Float32Array }[] = [];
  for (const row of rows) {
    try {
      entries.push({ id: row.id, embedding: deserializeEmbedding(row.embedding) });
    } catch {
      // Skip invalid
    }
  }

  // Compare all pairs
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = cosineSimilarity(entries[i].embedding, entries[j].embedding);
      if (sim >= threshold) {
        results.push({ idA: entries[i].id, idB: entries[j].id, similarity: sim });
      }
    }
  }

  return results;
}
