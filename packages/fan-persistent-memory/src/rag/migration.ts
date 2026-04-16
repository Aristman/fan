import type { MemoryRepository } from "../storage/repositories.js";
import type { MemoryConfig } from "../config.js";
import { generateEmbedding, initEmbeddingRouter } from "./embeddings.js";

// ──────────────────────────────────────────────
// Embedding migration types & helpers
// ──────────────────────────────────────────────

export interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
  newDimension: number;
}

/**
 * Determine the expected embedding dimension based on current config.
 */
function getExpectedDimension(config: MemoryConfig): number {
  return config.embeddings.ollama.dimension;
}

/**
 * Determine the expected model name based on current config.
 */
function getExpectedModelName(config: MemoryConfig): string {
  return config.embeddings.ollama.model;
}

// ──────────────────────────────────────────────
// needsMigration — quick synchronous check
// ──────────────────────────────────────────────

/**
 * Quick check: returns true if any active memory with an embedding
 * has a different dimension or model than the current config.
 * If no memories have embeddings, returns false.
 */
export function needsMigration(
  repo: MemoryRepository,
  config: MemoryConfig
): boolean {
  const rows = repo.findAllWithEmbeddings({ includeArchived: true });
  if (rows.length === 0) return false;

  const expectedDimension = getExpectedDimension(config);
  const expectedModel = getExpectedModelName(config);

  for (const row of rows) {
    const storedDimension = row.embedding ? row.embedding.byteLength / 4 : 0;
    const storedModel = row.embedding_model;

    if (storedDimension !== expectedDimension || storedModel !== expectedModel) {
      return true;
    }
  }

  return false;
}

// ──────────────────────────────────────────────
// migrateEmbeddings — full async migration
// ──────────────────────────────────────────────

/**
 * Migrate all embeddings that don't match the current model/dimension.
 * Runs idempotently — already-migrated records are skipped.
 * Individual record failures do not stop the migration.
 */
export async function migrateEmbeddings(
  repo: MemoryRepository,
  config: MemoryConfig,
  onProgress?: (current: number, total: number) => void
): Promise<MigrationResult> {
  // 1. Ensure router is initialized
  initEmbeddingRouter(config);

  const expectedDimension = getExpectedDimension(config);
  const expectedModel = getExpectedModelName(config);

  // 2. Get all memories with embeddings (including archived)
  const rows = repo.findAllWithEmbeddings({ includeArchived: true });

  // 3. Filter to those needing migration
  const toMigrate = rows.filter((row) => {
    const storedDimension = row.embedding ? row.embedding.byteLength / 4 : 0;
    const storedModel = row.embedding_model;
    return storedDimension !== expectedDimension || storedModel !== expectedModel;
  });

  const total = toMigrate.length;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  // 4. Re-embed each memory that needs migration
  for (let i = 0; i < toMigrate.length; i++) {
    const row = toMigrate[i]!;

    // Notify progress (caller may throttle notifications)
    onProgress?.(i + 1, total);

    try {
      const newEmbedding = await generateEmbedding(row.content, config);
      if (newEmbedding) {
        repo.update(row.id, {
          embedding: newEmbedding,
          embeddingModel: expectedModel,
        });
        migrated++;
      } else {
        // Embedding generation returned null (provider unavailable, etc.)
        skipped++;
      }
    } catch {
      // Individual record failure — log and continue
      errors++;
    }
  }

  // 5. Return result
  return {
    total,
    migrated,
    skipped,
    errors,
    newDimension: expectedDimension,
  };
}
