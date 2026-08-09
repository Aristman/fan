import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ──────────────────────────────────────────────
// Configuration types
// ──────────────────────────────────────────────

export interface EmbeddingsConfig {
  model: string;
  ollamaBaseUrl: string;
  dimension: number;
  fallbackToFTSOnly: boolean;
}

export interface RetrievalWeights {
  fts: number;
  vector: number;
  recency: number;
  frequency: number;
  confidence: number;
}

export interface RetrievalConfig {
  maxMemoriesPerQuery: number;
  maxInjectionChars: number;
  candidatePoolSize: number;
  ftsPoolSize: number;
  vectorPoolSize: number;
  llmRerankThreshold: number;
  minRetrievalScore: number;
  weights: RetrievalWeights;
}

export interface MaintenanceConfig {
  intervalHours: number;
  confidenceDecay: {
    "30d": number;
    "90d": number;
    "180d": number;
  };
  deduplicationThreshold: number;
  clusterTagSimilarity: number;
  clusterVectorSimilarity: number;
  summarizationMinClusterSize: number;
  hardDelete: boolean;
  hardDeleteMinAge: number;
}

export interface IntelligenceConfig {
  autoExtract: boolean;
  extractMinTurns: number;
  extractMinMessages: number;
  draftTTLHours: number;
  maxDraftsPerSession: number;
}

export interface MemoryConfig {
  embeddings: EmbeddingsConfig;
  retrieval: RetrievalConfig;
  maintenance: MaintenanceConfig;
  intelligence: IntelligenceConfig;
}

// ──────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────

const DEFAULTS: MemoryConfig = {
  embeddings: {
    model: "nomic-embed-text",
    ollamaBaseUrl: "http://localhost:11434",
    dimension: 768,
    fallbackToFTSOnly: true,
  },
  retrieval: {
    maxMemoriesPerQuery: 5,
    maxInjectionChars: 2000,
    candidatePoolSize: 10,
    ftsPoolSize: 15,
    vectorPoolSize: 15,
    llmRerankThreshold: 5,
    minRetrievalScore: 0.3,
    weights: {
      fts: 0.30,
      vector: 0.30,
      recency: 0.15,
      frequency: 0.15,
      confidence: 0.10,
    },
  },
  maintenance: {
    intervalHours: 12,
    confidenceDecay: { "30d": 0.85, "90d": 0.70, "180d": 0.50 },
    deduplicationThreshold: 0.90,
    clusterTagSimilarity: 0.5,
    clusterVectorSimilarity: 0.7,
    summarizationMinClusterSize: 5,
    hardDelete: false,
    hardDeleteMinAge: 365,
  },
  intelligence: {
    autoExtract: true,
    extractMinTurns: 5,
    extractMinMessages: 3,
    draftTTLHours: 24,
    maxDraftsPerSession: 10,
  },
};

// ──────────────────────────────────────────────
// Config loader
// ──────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".fan", "agent", "memory");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getGlobalDbPath(): string {
  return join(CONFIG_DIR, "global.db");
}

export function getProjectDbPath(projectDir: string): string {
  return join(projectDir, ".fan", "memory", "project.db");
}

export function loadConfig(): MemoryConfig {
  if (!existsSync(CONFIG_PATH)) {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf-8");
    return { ...DEFAULTS };
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return deepMerge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>) as unknown as MemoryConfig;
  } catch {
    return { ...DEFAULTS };
  }
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>) as T[Extract<keyof T, string>];
    } else if (sv !== undefined) {
      result[key] = sv as T[Extract<keyof T, string>];
    }
  }
  return result;
}
