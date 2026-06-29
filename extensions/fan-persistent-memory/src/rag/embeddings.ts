import { serializeEmbedding } from "../types.js";
import type { MemoryConfig } from "../config.js";

// ──────────────────────────────────────────────
// Embedding generation via Ollama
// ──────────────────────────────────────────────

let ollamaAvailable: boolean | null = null;

export async function generateEmbedding(
  text: string,
  config: MemoryConfig
): Promise<Float32Array | null> {
  const url = `${config.embeddings.ollamaBaseUrl}/api/embeddings`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embeddings.model,
        prompt: text,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      ollamaAvailable = false;
      return null;
    }

    const data = (await response.json()) as { embedding?: number[] };
    ollamaAvailable = true;

    if (!data.embedding || !Array.isArray(data.embedding)) {
      return null;
    }

    return new Float32Array(data.embedding);
  } catch (err) {
    ollamaAvailable = false;

    console.error("[persistent-memory] Embedding generation failed:", err instanceof Error ? err.message : String(err));

    if (config.embeddings.fallbackToFTSOnly) {
      return null; // Graceful degradation
    }

    throw err;
  }
}

export async function generateEmbeddingsBatch(
  texts: string[],
  config: MemoryConfig
): Promise<(Float32Array | null)[]> {
  // Ollama doesn't have a batch endpoint, process sequentially
  const results: (Float32Array | null)[] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text, config));
  }
  return results;
}

export function isOllamaAvailable(): boolean | null {
  return ollamaAvailable;
}

export async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    ollamaAvailable = response.ok;
    return response.ok;
  } catch (err) {
    console.error("[persistent-memory] Ollama health check failed:", err instanceof Error ? err.message : String(err));
    ollamaAvailable = false;
    return false;
  }
}
