import type { MemoryConfig } from "../config.js";

// ──────────────────────────────────────────────
// Embedding Provider interface
// ──────────────────────────────────────────────

export interface EmbeddingProvider {
  generateEmbedding(text: string): Promise<Float32Array | null>;
}

// ──────────────────────────────────────────────
// Ollama Embedding Provider
// ──────────────────────────────────────────────

class OllamaEmbeddingProvider implements EmbeddingProvider {
  private failed = false;

  constructor(
    private model: string,
    private baseUrl: string,
    private dimension: number
  ) {}

  async generateEmbedding(text: string): Promise<Float32Array | null> {
    if (this.failed) return null;

    try {
      const url = `${this.baseUrl}/api/embeddings`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.failed = true;
        return null;
      }

      const data = (await response.json()) as { embedding?: number[] };

      if (!data.embedding || !Array.isArray(data.embedding)) {
        return null;
      }

      return new Float32Array(data.embedding);
    } catch {
      this.failed = true;
      return null;
    }
  }

  isAvailable(): boolean {
    return !this.failed;
  }

  resetFailed(): void {
    this.failed = false;
  }
}

// ──────────────────────────────────────────────
// Embedding Router (Ollama-only, with LRU cache)
// ──────────────────────────────────────────────

const MAX_CACHE_SIZE = 100;

class EmbeddingRouter {
  private ollamaProvider: OllamaEmbeddingProvider;
  private lruCache: Map<string, Float32Array>;
  private cacheOrder: string[];
  private currentDimension: number;
  private _vectorAvailable: boolean;

  constructor(config: MemoryConfig) {
    const ec = config.embeddings;

    this.ollamaProvider = new OllamaEmbeddingProvider(
      ec.ollama.model || ec.model,
      ec.ollama.baseUrl || ec.ollamaBaseUrl,
      ec.ollama.dimension || ec.dimension
    );

    this.currentDimension = ec.ollama.dimension || ec.dimension;
    this.lruCache = new Map();
    this.cacheOrder = [];
    this._vectorAvailable = false;
  }

  async generateEmbedding(text: string): Promise<Float32Array | null> {
    // 1. Check LRU cache
    const cached = this.getFromCache(text);
    if (cached) return cached;

    // 2. Try Ollama
    let result: Float32Array | null = null;
    try {
      result = await this.ollamaProvider.generateEmbedding(text);
    } catch {
      result = null;
    }

    // 3. Cache result if non-null
    if (result) {
      this.putInCache(text, result);
      this.currentDimension = result.length;
      this._vectorAvailable = true;
    } else {
      if (!this.ollamaProvider.isAvailable()) {
        this._vectorAvailable = false;
      }
    }

    return result;
  }

  async generateEmbeddingsBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    return results;
  }

  isVectorAvailable(): boolean {
    return this._vectorAvailable;
  }

  getCurrentDimension(): number {
    return this.currentDimension;
  }

  getOllamaProvider(): OllamaEmbeddingProvider {
    return this.ollamaProvider;
  }

  invalidateCache(): void {
    this.lruCache.clear();
    this.cacheOrder = [];
  }

  private getFromCache(key: string): Float32Array | null {
    if (this.lruCache.has(key)) {
      this.cacheOrder = this.cacheOrder.filter((k) => k !== key);
      this.cacheOrder.push(key);
      return this.lruCache.get(key)!;
    }
    return null;
  }

  private putInCache(key: string, value: Float32Array): void {
    if (this.lruCache.has(key)) {
      this.cacheOrder = this.cacheOrder.filter((k) => k !== key);
    }

    while (this.cacheOrder.length >= MAX_CACHE_SIZE) {
      const oldest = this.cacheOrder.shift()!;
      this.lruCache.delete(oldest);
    }

    this.lruCache.set(key, value);
    this.cacheOrder.push(key);
  }
}

// ──────────────────────────────────────────────
// Module-level singleton
// ──────────────────────────────────────────────

let router: EmbeddingRouter | null = null;

export function initEmbeddingRouter(config: MemoryConfig): void {
  router = new EmbeddingRouter(config);
}

// ──────────────────────────────────────────────
// Backward-compatible exports
// ──────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  config: MemoryConfig
): Promise<Float32Array | null> {
  if (!router) {
    initEmbeddingRouter(config);
  }
  return router!.generateEmbedding(text);
}

export async function generateEmbeddingsBatch(
  texts: string[],
  config: MemoryConfig
): Promise<(Float32Array | null)[]> {
  if (!router) {
    initEmbeddingRouter(config);
  }
  return router!.generateEmbeddingsBatch(texts);
}

export function isVectorAvailable(): boolean {
  return router?.isVectorAvailable() ?? false;
}

export async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok && router) {
      router.getOllamaProvider().resetFailed();
    }

    return response.ok;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// Binary serialization utilities
// ──────────────────────────────────────────────

export function serializeEmbedding(arr: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + arr.length * 4);
  const view = new DataView(buf);
  view.setUint32(0, arr.length, true);
  for (let i = 0; i < arr.length; i++) {
    view.setFloat32(4 + i * 4, arr[i]!, true);
  }
  return buf;
}

export function deserializeEmbedding(buf: ArrayBuffer): Float32Array {
  const view = new DataView(buf);
  const length = view.getUint32(0, true);
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = view.getFloat32(4 + i * 4, true);
  }
  return arr;
}
