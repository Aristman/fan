import type { MemoryConfig } from "../config.js";
import { cosineSimilarity, deserializeEmbedding } from "../types.js";
import { generateEmbedding, isVectorAvailable } from "./embeddings.js";
import type { MemoryDatabase } from "../storage/database.js";
import { HNSWIndex, type SearchResult } from "./ann-index.js";

// ──────────────────────────────────────────────
// ANN Index singleton
// ──────────────────────────────────────────────

const annIndices = new WeakMap<MemoryDatabase, HNSWIndex>();

/**
 * Get or create the HNSW index for a database.
 * Index is built lazily on first access.
 */
function getANNIndex(db: MemoryDatabase): HNSWIndex {
  let index = annIndices.get(db);
  if (!index) {
    index = new HNSWIndex({ M: 16, M0: 32, efConstruction: 100, efSearch: 50 });
    annIndices.set(db, index);
  }
  return index;
}

/**
 * Build/rebuild the ANN index from all embeddings in the database.
 */
export function buildANNIndex(db: MemoryDatabase): number {
  const index = getANNIndex(db);
  index.clear();

  const rows = db
    .getDb()
    .prepare("SELECT id, embedding FROM memories WHERE archived = 0 AND embedding IS NOT NULL")
    .all() as { id: string; embedding: Buffer }[];

  const vectors = new Map<string, Float32Array>();
  for (const row of rows) {
    try {
      vectors.set(row.id, deserializeEmbedding(row.embedding));
    } catch {
      // Skip invalid embeddings
    }
  }

  index.buildFromVectors(vectors);
  return vectors.size;
}

/**
 * Add a single vector to the ANN index.
 */
export function addVectorToIndex(db: MemoryDatabase, id: string, embedding: Float32Array): void {
  const index = getANNIndex(db);
  index.add(id, embedding);
}

/**
 * Remove a vector from the ANN index.
 */
export function removeVectorFromIndex(db: MemoryDatabase, id: string): void {
  const index = getANNIndex(db);
  index.remove(id);
}

/**
 * Update a vector in the ANN index.
 */
export function updateVectorInIndex(db: MemoryDatabase, id: string, embedding: Float32Array): void {
  const index = getANNIndex(db);
  index.update(id, embedding);
}

/**
 * Check if the ANN index is built and has entries.
 */
export function isANNIndexReady(db: MemoryDatabase): boolean {
  const index = annIndices.get(db);
  return index !== undefined && !index.isEmpty;
}

/**
 * Get the number of vectors in the ANN index.
 */
export function getANNIndexSize(db: MemoryDatabase): number {
  return annIndices.get(db)?.size ?? 0;
}

/**
 * Get the total number of vectors in the database.
 */
export function getDBVectorCount(db: MemoryDatabase): number {
  const row = db
    .getDb()
    .prepare("SELECT count(*) as c FROM memories WHERE archived = 0 AND embedding IS NOT NULL")
    .get() as { c: number };
  return row.c;
}

/**
 * Check if ANN index is out of sync with the database.
 */
export function isANNIndexStale(db: MemoryDatabase): boolean {
  return getANNIndexSize(db) !== getDBVectorCount(db);
}

// ──────────────────────────────────────────────
// Vector search (ANN with brute-force fallback)
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
    return []; // Embedding provider unavailable, fallback to FTS-only
  }

  const scope = opts?.scope ?? "both";
  const category = opts?.category;
  const limit = opts?.limit ?? 15;
  const minScore = opts?.minScore ?? 0.5;

  // Try ANN index first (fast path)
  const index = annIndices.get(db);
  if (index && !index.isEmpty) {
    return annSearch(index, queryEmbedding, db, scope, category, limit, minScore);
  }

  // Fallback: brute-force (also used when no scope/category filter needed)
  return bruteForceSearch(queryEmbedding, db, scope, category, limit, minScore);
}

/**
 * ANN search with post-filtering for scope/category.
 * ANN doesn't natively support metadata filters, so we over-fetch
 * and filter results.
 */
function annSearch(
  index: HNSWIndex,
  queryEmbedding: Float32Array,
  db: MemoryDatabase,
  scope: string,
  category: string | undefined,
  limit: number,
  minScore: number
): VectorSearchResult[] {
  // Over-fetch to compensate for post-filtering
  const overFetch = (scope !== "both" || category) ? limit * 5 : limit;
  const annResults = index.search(queryEmbedding, Math.max(overFetch, limit));

  // Post-filter by scope/category
  const results: VectorSearchResult[] = [];

  for (const r of annResults) {
    if (results.length >= limit) break;

    // Check score threshold
    if (r.score < minScore) continue;

    // For unfiltered queries, no need to check DB
    if (scope === "both" && !category) {
      results.push(r);
      continue;
    }

    // Check metadata filter
    const row = db
      .getDb()
      .prepare("SELECT scope, category FROM memories WHERE id = ? AND archived = 0")
      .get(r.id) as { scope: string; category: string } | undefined;

    if (!row) continue;

    if (scope === "both" || row.scope === scope) {
      if (!category || row.category === category) {
        results.push(r);
      }
    }
  }

  return results;
}

/**
 * Brute-force fallback: SELECT ALL + cosine similarity in JS.
 */
function bruteForceSearch(
  queryEmbedding: Float32Array,
  db: MemoryDatabase,
  scope: string,
  category: string | undefined,
  limit: number,
  minScore: number
): VectorSearchResult[] {
  // Build query
  let sql = "SELECT id, embedding FROM memories WHERE archived = 0 AND embedding IS NOT NULL";
  const params: unknown[] = [];

  if (scope === "global") {
    sql += " AND scope = 'global'";
  } else if (scope === "project") {
    sql += " AND scope = 'project'";
  }

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
      const sim = cosineSimilarity(entries[i]!.embedding, entries[j]!.embedding);
      if (sim >= threshold) {
        results.push({ idA: entries[i]!.id, idB: entries[j]!.id, similarity: sim });
      }
    }
  }

  return results;
}
