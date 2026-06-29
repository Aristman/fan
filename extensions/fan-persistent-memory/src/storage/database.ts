// storage/database.ts — sql.js (WASM) backend, no native deps
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import type initSqlJsDefault from "sql.js";
import type { SqlJsStatic, SqlJsDatabase, SqlJsStmt } from "sql.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Returned by Statement.run(), matching better-sqlite3's shape. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

// ──────────────────────────────────────────────
// Schema version
// ──────────────────────────────────────────────

const CURRENT_VERSION = 2;

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

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_memories_archived_scope ON memories(archived, scope);
    CREATE INDEX IF NOT EXISTS idx_memories_archived_updated ON memories(archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_cluster ON memories(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_memories_usage_memory ON memory_usage(memory_id);
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

    INSERT OR IGNORE INTO schema_version (version, applied_at)
    VALUES (1, ${Date.now()});
  `,
  2: `
    -- Migration v2 placeholder — actual FTS5 cleanup is done externally
    -- via Python before sql.js opens the DB (see cleanupFts5Artifacts()).
    -- This migration just records that cleanup was performed.
    -- The shadow tables and sqlite_master entries are already gone by
    -- the time this migration runs.

    -- Drop any FTS triggers that may survive
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;

    -- Drop shadow tables (should already be gone, but safe to retry)
    DROP TABLE IF EXISTS memories_fts_data;
    DROP TABLE IF EXISTS memories_fts_idx;
    DROP TABLE IF EXISTS memories_fts_docsize;
    DROP TABLE IF EXISTS memories_fts_config;

    INSERT OR IGNORE INTO schema_version (version, applied_at)
    VALUES (2, ${Date.now()});
  `,
};

// ──────────────────────────────────────────────
// External FTS5 cleanup (via Python sqlite3)
// ──────────────────────────────────────────────
// sql.js WASM cannot modify sqlite_master or DROP FTS5 virtual tables
// ("no such module: fts5"). We use the system's Python sqlite3 module
// to clean up FTS5 artifacts BEFORE sql.js opens the database.

function cleanupFts5Artifacts(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const tmpScript = join(tmpdir(), `fan-fts5-cleanup-${Date.now()}.py`);
  try {
    writeFileSync(tmpScript, CLEANUP_PY_SCRIPT);
    execSync(`"${pythonCmd}" "${tmpScript}" "${dbPath}"`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    // Python not available or DB doesn't need cleanup — not critical
    console.warn(`[persistent-memory] FTS5 external cleanup skipped (${pythonCmd} unavailable or DB doesn't need cleanup).`);
  } finally {
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

/** Python script to remove FTS5 virtual tables and their shadow tables.
 *  Written to a temp file and executed before sql.js opens the DB. */
const CLEANUP_PY_SCRIPT = `\
import sqlite3, sys

PATH = sys.argv[1]
db = sqlite3.connect(PATH)
db.execute("PRAGMA writable_schema = ON")

# 1. Drop FTS triggers
for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall():
    if "fts" in name.lower():
        try:
            db.execute(f'DROP TRIGGER IF EXISTS "{name}"')
        except Exception:
            pass

# 2. Drop FTS5 shadow tables (real tables)
for suffix in ("_data", "_idx", "_docsize", "_config", "_content", "_segments", "_segdir", "_stat"):
    tbl = "memories_fts" + suffix
    try:
        db.execute(f'DROP TABLE IF EXISTS "{tbl}"')
    except Exception:
        pass

# 3. Remove ALL FTS-related entries (tables, indexes, triggers, views)
for (itype, iname) in db.execute("SELECT type, name FROM sqlite_master").fetchall():
    if "memories_fts" in (iname or "").lower():
        try:
            db.execute(f"DELETE FROM sqlite_master WHERE type='{itype}' AND name='{iname}'")
        except Exception:
            pass

db.execute("PRAGMA writable_schema = OFF")
db.commit()
db.close()
`;

// ──────────────────────────────────────────────
// sql.js lazy loader
// ──────────────────────────────────────────────

let cachedSqlJs: SqlJsStatic | null = null;

function findSqlJsPath(): string | null {
  const nodeRequire = createRequire(import.meta.url);

  // 1. Try relative to this file: storage/../../node_modules/sql.js/dist/sql-wasm.js
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const extRoot = resolve(thisDir, "..", "..");
  const candidateDir = join(extRoot, "node_modules", "sql.js");
  if (existsSync(candidateDir)) {
    const candidateEntry = join(candidateDir, "dist", "sql-wasm.js");
    if (existsSync(candidateEntry)) return candidateEntry;
    try {
      const pkg = JSON.parse(readFileSync(join(candidateDir, "package.json"), "utf-8"));
      const exp = pkg.exports?.["."];
      if (exp) {
        const resolved = typeof exp === "string" ? exp : (exp.import ?? exp.default);
        if (resolved) return resolve(candidateDir, resolved);
      }
      if (pkg.main) return resolve(candidateDir, pkg.main);
    } catch {
      // ignore
    }
  }

  // 2. Try require.resolve with extension root as path
  try {
    return nodeRequire.resolve("sql.js", { paths: [extRoot] });
  } catch {
    // ignore
  }

  // 3. Try import.meta.resolve
  try {
    return fileURLToPath(import.meta.resolve("sql.js"));
  } catch {
    // ignore
  }

  return null;
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!cachedSqlJs) {
    const sqlJsPath = findSqlJsPath();
    let rawMod: unknown;
    if (sqlJsPath) {
      rawMod = await import(sqlJsPath);
    } else {
      rawMod = await import("sql.js");
    }
    const mod = rawMod as { default?: typeof initSqlJsDefault } & typeof initSqlJsDefault;
    const initFn = mod.default ?? mod;
    const sqlJsDist = dirname(sqlJsPath ?? fileURLToPath(import.meta.resolve("sql.js")));
    cachedSqlJs = await initFn({
      locateFile(file: string): string {
        // Next to executable first (SEA mode)
        const exeDir = dirname(process.execPath);
        const exePath = join(exeDir, file);
        if (existsSync(exePath)) return exePath;
        // Relative to sql.js dist
        const distPath = join(sqlJsDist, file);
        if (existsSync(distPath)) return distPath;
        return file;
      },
    });
  }
  return cachedSqlJs;
}

// ──────────────────────────────────────────────
// better-sqlite3-compatible Statement wrapper
// ──────────────────────────────────────────────

export class Statement {
  private stmt: SqlJsStmt;
  private db: SqlJsDb;

  constructor(stmt: SqlJsStmt, db: SqlJsDb) {
    this.stmt = stmt;
    this.db = db;
  }

  /** Execute a DML statement. Returns changes/lastInsertRowid. Statement is reusable (reset, not free). */
  run(...params: unknown[]): RunResult {
    this.stmt.reset();
    this.stmt.bind(params);
    this.stmt.step();
    this.stmt.reset();
    this.db.markDirty();
    if (!this.db._inTransaction) this.db.flush();
    return {
      changes: this.db.getRowsModified(),
      lastInsertRowid: this.db.getLastInsertRowId(),
    };
  }

  /** Execute a query returning exactly one row, or undefined. */
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
    this.stmt.reset();
    this.stmt.bind(params);
    try {
      if (this.stmt.step()) {
        return this.stmt.getAsObject() as T;
      }
      return undefined;
    } finally {
      this.stmt.reset();
    }
  }

  /** Execute a query returning all matching rows. */
  all<T = Record<string, unknown>>(...params: unknown[]): T[] {
    this.stmt.reset();
    this.stmt.bind(params);
    const results: T[] = [];
    while (this.stmt.step()) {
      results.push(this.stmt.getAsObject() as T);
    }
    this.stmt.reset();
    return results;
  }

  /** Explicitly free the underlying sql.js statement. */
  free(): void {
    this.stmt.free();
  }
}

// ──────────────────────────────────────────────
// sql.js Database wrapper (better-sqlite3 API)
// ──────────────────────────────────────────────

export class SqlJsDb {
  private _filePath: string;
  private _dirty = false;
  private _inTransaction = false;
  private _db: SqlJsDatabase;

  constructor(sqlJs: SqlJsStatic, filePath: string) {
    this._filePath = filePath;
    if (existsSync(filePath)) {
      const buf = readFileSync(filePath);
      this._db = new sqlJs.Database(buf);
    } else {
      this._db = new sqlJs.Database();
    }
  }

  pragma(pragmas: string): void {
    const parts = pragmas.split(";");
    for (const raw of parts) {
      const trimmed = raw.trim();
      if (trimmed) {
        try {
          this._db.run("PRAGMA " + trimmed);
        } catch {
          // some pragmas not supported in WASM
        }
      }
    }
  }

  exec(sql: string): void {
    this._db.run(sql);
    this._dirty = true;
    if (!this._inTransaction) this.flush();
  }

  prepare(sql: string): Statement {
    return new Statement(this._db.prepare(sql), this);
  }

  getRowsModified(): number {
    return this._db.getRowsModified();
  }

  getLastInsertRowId(): number {
    const result = this._db.exec("SELECT last_insert_rowid()");
    if (result?.[0]?.values?.[0]?.[0] !== undefined) {
      return result[0].values[0][0] as number;
    }
    return 0;
  }

  close(): void {
    this.flush();
    this._db.close();
  }

  flush(): void {
    if (this._dirty && this._filePath) {
      const dir = dirname(this._filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      try {
        const data = this._db.export();
        writeFileSync(this._filePath, Buffer.from(data));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[persistent-memory] flush failed:", message);
      }
      this._dirty = false;
    }
  }

  /** Mark the database as modified without immediately flushing. */
  markDirty(): void {
    this._dirty = true;
  }

  forceFlush(): void {
    this._dirty = true;
    this.flush();
  }
}

// ──────────────────────────────────────────────
// MemoryDatabase (public API)
// ──────────────────────────────────────────────

export class MemoryDatabase {
  private dbPath: string;
  private db: SqlJsDb | null = null;
  private _hasFts = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Load WASM, create/open database, set pragmas, create schema. Must be called before use. */
  async init(): Promise<void> {
    const sqlJs = await getSqlJs();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Clean up FTS5 artifacts from old versions BEFORE sql.js opens the DB.
    // sql.js cannot modify sqlite_master or DROP FTS5 virtual tables,
    // so we use Python's sqlite3 module as an external helper.
    cleanupFts5Artifacts(this.dbPath);

    this.db = new SqlJsDb(sqlJs, this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.runMigrations();
    this.setupFts();
  }

  private runMigrations(): void {
    // Create schema_version table if not exists
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL
      );
    `);

    const currentVersion = this.db!
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
        this.db!.exec(migration);
        this.db!
          .prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(v, Date.now());
      } catch (err) {
        console.error(`[persistent-memory] Migration v${v} failed:`, err);
        throw err;
      }
    }
  }

  private setupFts(): void {
    // Clean up ALL memory-related triggers (from any FTS version)
    try {
      const triggers = this.db!.exec(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_%'"
      );
      if (triggers?.[0]?.values) {
        for (const row of triggers[0].values) {
          try {
            this.db!.exec(`DROP TRIGGER IF EXISTS ${row[0]}`);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    // Drop any remaining FTS shadow tables (from FTS5)
    for (const suffix of ["_data", "_idx", "_docsize", "_config"]) {
      try {
        this.db!.exec(`DROP TABLE IF EXISTS "memories_fts${suffix}"`);
      } catch {
        // ignore
      }
    }

    // Try normal DROP (works for FTS4 tables)
    try {
      this.db!.exec(`DROP TABLE IF EXISTS memories_fts`);
    } catch {
      // may fail for FTS5 — already cleaned by external Python script above
    }

    // Probe FTS4 support (available in sql.js WASM)
    try {
      this.db!.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts4(
          content, summary, tags,
          tokenize=unicode61
        );
      `);
      this._hasFts = true;
    } catch (err) {
      this._hasFts = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[persistent-memory] FTS4 not available, full-text search disabled:", message);
    }

    if (this._hasFts) {
      // Backfill existing memories into FTS index
      let backfillCount = 0;
      try {
        const existing = this.db!.prepare("SELECT rowid, content, summary, tags FROM memories").all<{ rowid: number; content: string; summary: string | null; tags: string }>();
        for (const row of existing) {
          this.db!.prepare("INSERT OR IGNORE INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)")
            .run(row.rowid, row.content, row.summary ?? "", row.tags);
          backfillCount++;
        }
      } catch {
        // backfill may fail on empty DB
      }

      console.log(`[persistent-memory] FTS4 ${this._hasFts ? 'enabled' : 'disabled'}, ${backfillCount} memories indexed`);

      // Create sync triggers (FTS4 uses DELETE FROM syntax)
      try {
        this.db!.exec(`
          CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;

          CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.rowid;
          END;

          CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.rowid;
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;
        `);
      } catch {
        // triggers may fail
      }
    }
  }

  /** Whether FTS full-text search is available. */
  hasFts(): boolean {
    return this._hasFts;
  }

  /** Returns the underlying SqlJsDb wrapper. */
  getDb(): SqlJsDb {
    return this.db!;
  }

  close(): void {
    try {
      this.db!.forceFlush();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[persistent-memory] close flush failed:", message);
    }
    try {
      this.db!.close();
    } catch {
      // ignore close errors
    }
  }

  // ──────────────────────────────────────────
  // Transaction helper
  // ──────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    this.db!._inTransaction = true;
    this.db!.exec("BEGIN");
    try {
      const result = fn();
      this.db!.exec("COMMIT");
      this.db!._inTransaction = false;
      this.db!.flush();
      return result;
    } catch (err) {
      try { this.db!.exec("ROLLBACK"); } catch { /* ignore if already rolled back */ }
      this.db!._inTransaction = false;
      this.db!.flush();
      throw err;
    }
  }

  // ──────────────────────────────────────────
  // Maintenance meta helpers
  // ──────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db!.prepare("SELECT value FROM maintenance_meta WHERE key = ?").get<{ value: string }>(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db!.prepare("INSERT OR REPLACE INTO maintenance_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // ──────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────

  getStats(): { active: number; archived: number; byCategory: Record<string, number> } {
    const active = (
      this.db!.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0").get<{ c: number }>()!
        .c
    );
    const archived = (
      this.db!.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 1").get<{ c: number }>()!
        .c
    );
    const byCat = this.db!
      .prepare("SELECT category, COUNT(*) as c FROM memories WHERE archived = 0 GROUP BY category")
      .all<{ category: string; c: number }>();

    return {
      active,
      archived,
      byCategory: Object.fromEntries(byCat.map((r) => [r.category, r.c])),
    };
  }
}
