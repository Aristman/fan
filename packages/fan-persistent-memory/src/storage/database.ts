import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ──────────────────────────────────────────────
// Schema version
// ──────────────────────────────────────────────

const CURRENT_VERSION = 1;

// ──────────────────────────────────────────────
// Migrations (ordered by version)
// ──────────────────────────────────────────────

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id                TEXT PRIMARY KEY,
      content           TEXT NOT NULL,
      summary           TEXT,
      category          TEXT NOT NULL
        CHECK(category IN ('operator', 'preference', 'project', 'event', 'instruction', 'decision')),
      tags              TEXT DEFAULT '[]',
      metadata          TEXT DEFAULT '{}',
      confidence        REAL NOT NULL DEFAULT 1.0
        CHECK(confidence >= 0.0 AND confidence <= 1.0),
      scope             TEXT NOT NULL DEFAULT 'project'
        CHECK(scope IN ('global', 'project')),
      project_path      TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      last_accessed_at  INTEGER,
      access_count      INTEGER NOT NULL DEFAULT 0,
      archived          INTEGER NOT NULL DEFAULT 0
        CHECK(archived IN (0, 1)),
      archived_at       INTEGER,
      cluster_id        TEXT,
      embedding         BLOB,
      embedding_model   TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, summary, tags,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, summary, tags)
      VALUES (new.rowid, new.content, new.summary, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
      VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
      VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
      INSERT INTO memories_fts(rowid, content, summary, tags)
      VALUES (new.rowid, new.content, new.summary, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS memory_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      session_id      TEXT,
      prompt_hash     TEXT,
      was_useful      INTEGER
        CHECK(was_useful IS NULL OR was_useful IN (0, 1)),
      retrieved_at    INTEGER NOT NULL,
      retrieved_score REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      category    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      category    TEXT,
      tags        TEXT DEFAULT '[]',
      source_turn TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER,
      status      TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'expired'))
    );

    CREATE TABLE IF NOT EXISTS maintenance_meta (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL
    );

    INSERT OR IGNORE INTO schema_version (version, applied_at)
    VALUES (1, ${Date.now()});
  `,
};

// ──────────────────────────────────────────────
// Database manager
// ──────────────────────────────────────────────

export class MemoryDatabase {
  private db: Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.runMigrations();
  }

  private runMigrations(): void {
    // Create schema_version table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL
      );
    `);

    const currentVersion = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) as v FROM schema_version")
      .get() as { v: number };

    const version = currentVersion.v;

    for (let v = version + 1; v <= CURRENT_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) {
        console.error(`[persistent-memory] Missing migration for version ${v}`);
        continue;
      }

      try {
        this.db.exec(migration);
        // Update version (INSERT the version record for v=1 since it's embedded in migration)
        this.db
          .prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(v, Date.now());
      } catch (err) {
        console.error(`[persistent-memory] Migration v${v} failed:`, err);
        throw err;
      }
    }
  }

  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ──────────────────────────────────────────
  // Transaction helper
  // ──────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ──────────────────────────────────────────
  // Maintenance meta helpers
  // ──────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM maintenance_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO maintenance_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  // ──────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────

  getStats(): { active: number; archived: number; byCategory: Record<string, number> } {
    const active = (
      this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0").get() as { c: number }
    ).c;
    const archived = (
      this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 1").get() as { c: number }
    ).c;
    const byCat = this.db
      .prepare("SELECT category, COUNT(*) as c FROM memories WHERE archived = 0 GROUP BY category")
      .all() as { category: string; c: number }[];

    return {
      active,
      archived,
      byCategory: Object.fromEntries(byCat.map((r) => [r.category, r.c])),
    };
  }
}
