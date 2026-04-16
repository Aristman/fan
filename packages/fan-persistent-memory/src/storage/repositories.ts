import type {
  Memory,
  MemoryCategory,
  MemoryDraft,
  MemoryRow,
  Cluster,
  MemoryScope,
} from "../types.js";
import { rowToMemory, serializeEmbedding } from "../types.js";
import type { MemoryDatabase } from "./database.js";
import { randomUUID } from "node:crypto";

// ──────────────────────────────────────────────
// Memory Repository (CRUD)
// ──────────────────────────────────────────────

export class MemoryRepository {
  constructor(private db: MemoryDatabase) {}

  // ──────────────────────────────────────────
  // Create
  // ──────────────────────────────────────────

  create(params: {
    content: string;
    category: MemoryCategory;
    tags?: string[];
    scope?: MemoryScope;
    projectPath?: string;
    confidence?: number;
    embedding?: Float32Array;
    embeddingModel?: string;
  }): Memory {
    const now = Date.now();
    const id = randomUUID();

    this.db.getDb().prepare(`
      INSERT INTO memories (id, content, summary, category, tags, metadata,
        confidence, scope, project_path, created_at, updated_at,
        last_accessed_at, access_count, archived, archived_at,
        cluster_id, embedding, embedding_model)
      VALUES (?, ?, NULL, ?, ?, '{}', ?, ?, ?, ?, ?, NULL, 0, 0, NULL, NULL, ?, ?)
    `).run(
      id,
      params.content,
      params.category,
      JSON.stringify(params.tags ?? []),
      params.confidence ?? 1.0,
      params.scope ?? "project",
      params.projectPath ?? null,
      now,
      now,
      params.embedding ? serializeEmbedding(params.embedding) : null,
      params.embeddingModel ?? null
    );

    return this.findById(id)!;
  }

  // ──────────────────────────────────────────
  // Read
  // ──────────────────────────────────────────

  findById(id: string): Memory | null {
    const row = this.db.getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToMemory(row) : null;
  }

  findActive(opts?: {
    scope?: MemoryScope;
    category?: MemoryCategory;
    limit?: number;
    offset?: number;
  }): Memory[] {
    let sql = "SELECT * FROM memories WHERE archived = 0";
    const params: unknown[] = [];

    if (opts?.scope) {
      sql += " AND scope = ?";
      params.push(opts.scope);
    }
    if (opts?.category) {
      sql += " AND category = ?";
      params.push(opts.category);
    }

    sql += " ORDER BY updated_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }

    return (this.db.getDb().prepare(sql).all(...params) as MemoryRow[]).map(rowToMemory);
  }

  findArchived(opts?: { limit?: number; offset?: number }): Memory[] {
    let sql = "SELECT * FROM memories WHERE archived = 1 ORDER BY archived_at DESC";
    const params: unknown[] = [];

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }

    return (this.db.getDb().prepare(sql).all(...params) as MemoryRow[]).map(rowToMemory);
  }

  findAllWithEmbeddings(opts?: { includeArchived?: boolean }): (MemoryRow & { rowid: number })[] {
    const includeArchived = opts?.includeArchived ?? false;
    const sql = includeArchived
      ? "SELECT rowid, * FROM memories WHERE embedding IS NOT NULL"
      : "SELECT rowid, * FROM memories WHERE archived = 0 AND embedding IS NOT NULL";
    return this.db
      .getDb()
      .prepare(sql)
      .all() as (MemoryRow & { rowid: number })[];
  }

  // ──────────────────────────────────────────
  // Update
  // ──────────────────────────────────────────

  update(
    id: string,
    params: {
      content?: string;
      summary?: string;
      category?: MemoryCategory;
      tags?: string[];
      confidence?: number;
      embedding?: Float32Array;
      embeddingModel?: string;
    }
  ): Memory | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [Date.now()];

    if (params.content !== undefined) {
      sets.push("content = ?");
      vals.push(params.content);
    }
    if (params.summary !== undefined) {
      sets.push("summary = ?");
      vals.push(params.summary);
    }
    if (params.category !== undefined) {
      sets.push("category = ?");
      vals.push(params.category);
    }
    if (params.tags !== undefined) {
      sets.push("tags = ?");
      vals.push(JSON.stringify(params.tags));
    }
    if (params.confidence !== undefined) {
      sets.push("confidence = ?");
      vals.push(Math.max(0, Math.min(1, params.confidence)));
    }
    if (params.embedding !== undefined) {
      sets.push("embedding = ?");
      vals.push(serializeEmbedding(params.embedding));
    }
    if (params.embeddingModel !== undefined) {
      sets.push("embedding_model = ?");
      vals.push(params.embeddingModel);
    }

    vals.push(id);
    this.db.getDb().prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

    return this.findById(id);
  }

  touchAccess(id: string, bumpCount: boolean = true): void {
    this.db
      .getDb()
      .prepare(
        `UPDATE memories SET last_accessed_at = ?, access_count = access_count + ? WHERE id = ?`
      )
      .run(Date.now(), bumpCount ? 1 : 0, id);
  }

  // ──────────────────────────────────────────
  // Archive / Restore
  // ──────────────────────────────────────────

  archive(id: string): boolean {
    const result = this.db
      .getDb()
      .prepare("UPDATE memories SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0")
      .run(Date.now(), id);
    return result.changes > 0;
  }

  restore(id: string): boolean {
    const result = this.db
      .getDb()
      .prepare("UPDATE memories SET archived = 0, archived_at = NULL WHERE id = ? AND archived = 1")
      .run(id);
    return result.changes > 0;
  }

  hardDelete(id: string): boolean {
    const result = this.db.getDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ──────────────────────────────────────────
  // Move between scopes (promote/demote)
  // ──────────────────────────────────────────

  moveToGlobal(id: string): Memory | null {
    const mem = this.findById(id);
    if (!mem || mem.scope !== "project") return null;

    const now = Date.now();
    this.db
      .getDb()
      .prepare("UPDATE memories SET scope = 'global', project_path = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);

    return this.findById(id);
  }

  moveToProject(id: string, projectPath: string): Memory | null {
    const mem = this.findById(id);
    if (!mem || mem.scope !== "global") return null;

    const now = Date.now();
    this.db
      .getDb()
      .prepare("UPDATE memories SET scope = 'project', project_path = ?, updated_at = ? WHERE id = ?")
      .run(projectPath, now, id);

    return this.findById(id);
  }

  // ──────────────────────────────────────────
  // Cluster
  // ──────────────────────────────────────────

  setClusterId(memoryId: string, clusterId: string | null): void {
    this.db
      .getDb()
      .prepare("UPDATE memories SET cluster_id = ? WHERE id = ?")
      .run(clusterId, memoryId);
  }

  // ──────────────────────────────────────────
  // Batch operations for maintenance
  // ──────────────────────────────────────────

  batchUpdateConfidence(decayFactors: { id: string; factor: number }[]): number {
    const stmt = this.db
      .getDb()
      .prepare("UPDATE memories SET confidence = MIN(1.0, confidence * ?) WHERE id = ? AND archived = 0");
    let count = 0;
    for (const { id, factor } of decayFactors) {
      const result = stmt.run(factor, id);
      count += result.changes;
    }
    return count;
  }

  batchArchive(ids: string[]): number {
    const stmt = this.db
      .getDb()
      .prepare("UPDATE memories SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0");
    const now = Date.now();
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(now, id);
      count += result.changes;
    }
    return count;
  }

  // ──────────────────────────────────────────
  // Clone (for promote/demote between DBs)
  // ──────────────────────────────────────────

  cloneTo(otherRepo: MemoryRepository, id: string): Memory | null {
    const mem = this.findById(id);
    if (!mem) return null;

    // Copy with new ID
    return otherRepo.create({
      content: mem.content,
      category: mem.category,
      tags: mem.tags,
      scope: mem.scope,
      ...(mem.projectPath != null && { projectPath: mem.projectPath }),
      confidence: mem.confidence,
      // Don't transfer raw embedding, will re-embed
    });
  }

  remove(id: string): boolean {
    const result = this.db.getDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ──────────────────────────────────────────
  // Confidence helpers
  // ──────────────────────────────────────────

  getLowConfidenceMemories(threshold: number, limit: number = 100): Memory[] {
    return (
      this.db
        .getDb()
        .prepare(
          "SELECT * FROM memories WHERE archived = 0 AND confidence < ? ORDER BY confidence ASC LIMIT ?"
        )
        .all(threshold, limit) as MemoryRow[]
    ).map(rowToMemory);
  }

  getUnusedMemories(daysUnused: number, limit: number = 100): Memory[] {
    const threshold = Date.now() - daysUnused * 24 * 60 * 60 * 1000;
    return (
      this.db
        .getDb()
        .prepare(
          `SELECT * FROM memories 
           WHERE archived = 0 
           AND (last_accessed_at IS NULL OR last_accessed_at < ?)
           ORDER BY last_accessed_at ASC NULLS FIRST 
           LIMIT ?`
        )
        .all(threshold, limit) as MemoryRow[]
    ).map(rowToMemory);
  }
}

// ──────────────────────────────────────────────
// Draft Repository
// ──────────────────────────────────────────────

export class DraftRepository {
  constructor(private db: MemoryDatabase) {}

  create(params: {
    content: string;
    category?: MemoryCategory | null;
    tags?: string[];
    sourceTurn?: string;
    ttlHours?: number;
  }): MemoryDraft {
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = params.ttlHours ? now + params.ttlHours * 60 * 60 * 1000 : null;

    this.db.getDb().prepare(`
      INSERT INTO drafts (id, content, category, tags, source_turn, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id,
      params.content,
      params.category ?? null,
      JSON.stringify(params.tags ?? []),
      params.sourceTurn ?? null,
      now,
      expiresAt
    );

    return this.findById(id)!;
  }

  findById(id: string): MemoryDraft | null {
    const row = this.db.getDb().prepare("SELECT * FROM drafts WHERE id = ?").get(id) as
      | {
          id: string;
          content: string;
          category: string | null;
          tags: string | null;
          source_turn: string | null;
          created_at: number;
          expires_at: number | null;
          status: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      content: row.content,
      category: row.category as MemoryCategory | null,
      tags: JSON.parse(row.tags ?? "[]"),
      sourceTurn: row.source_turn,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as MemoryDraft["status"],
    };
  }

  findPending(): MemoryDraft[] {
    const rows = this.db
      .getDb()
      .prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at DESC")
      .all() as {
      id: string;
      content: string;
      category: string | null;
      tags: string | null;
      source_turn: string | null;
      created_at: number;
      expires_at: number | null;
      status: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category as MemoryCategory | null,
      tags: JSON.parse(row.tags ?? "[]"),
      sourceTurn: row.source_turn,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as MemoryDraft["status"],
    }));
  }

  updateStatus(id: string, status: MemoryDraft["status"]): boolean {
    const result = this.db.getDb().prepare("UPDATE drafts SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }

  expireOld(): number {
    const result = this.db
      .getDb()
      .prepare("UPDATE drafts SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
      .run(Date.now());
    return result.changes;
  }

  delete(id: string): boolean {
    const result = this.db.getDb().prepare("DELETE FROM drafts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  countPending(): number {
    return (
      this.db.getDb().prepare("SELECT COUNT(*) as c FROM drafts WHERE status = 'pending'").get() as {
        c: number;
      }
    ).c;
  }
}

// ──────────────────────────────────────────────
// Cluster Repository
// ──────────────────────────────────────────────

export class ClusterRepository {
  constructor(private db: MemoryDatabase) {}

  create(params: { label: string; category?: MemoryCategory | null }): Cluster {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .getDb()
      .prepare("INSERT INTO clusters (id, label, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, params.label, params.category ?? null, now, now);

    return { id, label: params.label, category: params.category ?? null, createdAt: now, updatedAt: now };
  }

  findById(id: string): Cluster | null {
    const row = this.db.getDb().prepare("SELECT * FROM clusters WHERE id = ?").get(id) as
      | { id: string; label: string; category: string | null; created_at: number; updated_at: number }
      | undefined;
    return row
      ? { id: row.id, label: row.label, category: row.category as MemoryCategory | null, createdAt: row.created_at, updatedAt: row.updated_at }
      : null;
  }

  findAll(): Cluster[] {
    return (
      this.db
        .getDb()
        .prepare("SELECT * FROM clusters ORDER BY updated_at DESC")
        .all() as { id: string; label: string; category: string | null; created_at: number; updated_at: number }[]
    ).map((r) => ({
      id: r.id,
      label: r.label,
      category: r.category as MemoryCategory | null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  update(id: string, label?: string): boolean {
    if (label) {
      const result = this.db
        .getDb()
        .prepare("UPDATE clusters SET label = ?, updated_at = ? WHERE id = ?")
        .run(label, Date.now(), id);
      return result.changes > 0;
    }
    return true;
  }

  delete(id: string): boolean {
    const result = this.db.getDb().prepare("DELETE FROM clusters WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

// ──────────────────────────────────────────────
// Usage Repository
// ──────────────────────────────────────────────

export class UsageRepository {
  constructor(private db: MemoryDatabase) {}

  log(params: {
    memoryId: string;
    sessionId?: string;
    promptHash?: string;
    score: number;
  }): void {
    this.db.getDb().prepare(`
      INSERT INTO memory_usage (memory_id, session_id, prompt_hash, retrieved_at, retrieved_score)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      params.memoryId,
      params.sessionId ?? null,
      params.promptHash ?? null,
      Date.now(),
      params.score
    );
  }

  getAccessStats(memoryId: string): { count: number; lastAccess: number | null } {
    const mem = this.db
      .getDb()
      .prepare("SELECT access_count, last_accessed_at FROM memories WHERE id = ?")
      .get(memoryId) as { access_count: number; last_accessed_at: number | null } | undefined;
    return mem ? { count: mem.access_count, lastAccess: mem.last_accessed_at } : { count: 0, lastAccess: null };
  }
}
