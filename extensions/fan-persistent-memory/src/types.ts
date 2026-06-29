// ──────────────────────────────────────────────
// Persistent Memory — Type Definitions
// ──────────────────────────────────────────────

export type MemoryCategory =
  | "operator"
  | "preference"
  | "project"
  | "event"
  | "instruction"
  | "decision";

export type MemoryScope = "global" | "project";

export interface Memory {
  id: string;
  content: string;
  summary: string | null;
  category: MemoryCategory;
  tags: string[];
  metadata: Record<string, unknown>;
  confidence: number;
  scope: MemoryScope;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  accessCount: number;
  archived: boolean;
  archivedAt: number | null;
  clusterId: string | null;
  embeddingModel: string | null;
}

export interface MemoryDraft {
  id: string;
  content: string;
  category: MemoryCategory | null;
  tags: string[];
  sourceTurn: string | null;
  createdAt: number;
  expiresAt: number | null;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface Cluster {
  id: string;
  label: string;
  category: MemoryCategory | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryUsageEntry {
  id: number;
  memoryId: string;
  sessionId: string | null;
  promptHash: string | null;
  wasUseful: boolean | null;
  retrievedAt: number;
  retrievedScore: number;
}

export interface RetrievalResult {
  memory: Memory;
  score: number;
  source: "fts" | "vector" | "both";
}

export interface RetrievalOptions {
  limit?: number;
  scope?: MemoryScope | "both";
  category?: MemoryCategory;
  minScore?: number;
}

export interface MaintenanceReport {
  steps: MaintenanceStep[];
  summary: string;
  duration: number;
  activeCount: number;
  archivedCount: number;
}

export interface MaintenanceStep {
  name: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

// ──────────────────────────────────────────────
// Database row types (raw from SQLite)
// ──────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  content: string;
  summary: string | null;
  category: string;
  tags: string | null;
  metadata: string | null;
  confidence: number;
  scope: string;
  project_path: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  archived: number;
  archived_at: number | null;
  cluster_id: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    summary: row.summary,
    category: row.category as MemoryCategory,
    tags: JSON.parse(row.tags ?? "[]"),
    metadata: JSON.parse(row.metadata ?? "{}"),
    confidence: row.confidence,
    scope: row.scope as MemoryScope,
    projectPath: row.project_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
    clusterId: row.cluster_id,
    embeddingModel: row.embedding_model,
  };
}

// ──────────────────────────────────────────────
// Embedding helpers
// ──────────────────────────────────────────────

export function serializeEmbedding(arr: Float32Array): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i], i * 4);
  }
  return buf;
}

export function deserializeEmbedding(buf: Buffer): Float32Array {
  const arr = new Float32Array(buf.length / 4);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = buf.readFloatLE(i * 4);
  }
  return arr;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ──────────────────────────────────────────────
// Content sanitization
// ──────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /api[_\-]?key[\s]*[:=][\s]*["'][^"']+["']/gi,
  /password[\s]*[:=][\s]*["'][^"']+["']/gi,
  /secret[_\-]?key[\s]*[:=][\s]*["'][^"']+["']/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /bearer\s+[a-zA-Z0-9._\-]+/gi,
  /token[\s]*[:=][\s]*["'][^"']+["']/gi,
];

export function sanitizeContent(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
