// ──────────────────────────────────────────────
// LLM Re-ranker
// ──────────────────────────────────────────────
// Re-ranks RAG results using LLM scoring.
// Sends top-N candidates to the LLM and asks it
// to rate relevance (1-10). Falls back to
// composite score if LLM is unavailable.
//
// Uses Ollama HTTP API (same server as embeddings).
// No new dependencies — uses native fetch.
// ──────────────────────────────────────────────

import type { RetrievalResult } from "../types.js";
import type { MemoryConfig } from "../config.js";

export interface RerankResult extends RetrievalResult {
  llmScore: number;
  originalScore: number;
}

interface OllamaResponse {
  response: string;
  done: boolean;
}

/**
 * Re-rank results using LLM.
 * Returns results re-ordered by LLM relevance score.
 * Falls back to original order if LLM fails.
 */
export async function rerankWithLLM(
  query: string,
  results: RetrievalResult[],
  config: MemoryConfig,
  opts?: {
    topN?: number;
    baseUrl?: string;
    model?: string;
  }
): Promise<RetrievalResult[]> {
  if (results.length <= 1) return results;

  const topN = opts?.topN ?? config.retrieval.llmRerankThreshold;
  const baseUrl = opts?.baseUrl ?? config.embeddings.ollama.baseUrl;
  const model = opts?.model ?? "qwen3:32b";

  // Take top-N for re-ranking
  const toRerank = results.slice(0, Math.min(topN, results.length));
  const rest = results.slice(Math.min(topN, results.length));

  try {
    // Build prompt
    const candidates = toRerank
      .map((r, i) => {
        const text = r.memory.summary || r.memory.content;
        const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
        return `[${i + 1}] (${r.memory.category}) ${preview}`;
      })
      .join("\n");

    const prompt = `Rate the relevance of each memory fragment to the query on a scale of 1-10.

Query: "${query}"

Fragments:
${candidates}

Respond ONLY with a JSON array of scores (integers 1-10), in the same order. Example: [9, 3, 7]
No explanation, just the array.`;

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: 100,
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      console.error("[reranker] LLM request failed:", response.status);
      return results;
    }

    const data = (await response.json()) as OllamaResponse;
    const scores = parseScores(data.response, toRerank.length);

    if (!scores) {
      console.error("[reranker] Failed to parse LLM scores:", data.response);
      return results;
    }

    // Merge LLM scores with results
    const reranked = toRerank
      .map((r, i) => ({
        ...r,
        llmScore: scores[i] ?? 5,
        originalScore: r.score,
        // Blend: 70% LLM, 30% composite
        score: 0.7 * (scores[i] ?? 5) / 10 + 0.3 * r.score,
      }))
      .sort((a, b) => b.score - a.score);

    console.log(
      `[reranker] Re-ranked ${toRerank.length} results:`,
      reranked.map((r) => `${r.llmScore}/${10}`)
    );

    return [...reranked, ...rest];
  } catch (err) {
    console.error("[reranker] Error:", err instanceof Error ? err.message : err);
    return results;
  }
}

/**
 * Parse LLM response into array of scores.
 * Handles various formats: [1, 2, 3], "1,2,3", etc.
 */
function parseScores(response: string, expectedCount: number): number[] | null {
  // Clean response
  let cleaned = response.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");

  // Try JSON array parse
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr) && arr.length === expectedCount) {
      return arr.map((v) => {
        const n = typeof v === "number" ? v : parseInt(String(v), 10);
        return isNaN(n) ? 5 : Math.max(1, Math.min(10, n));
      });
    }
  } catch {
    // Not JSON
  }

  // Try comma-separated numbers
  const numbers = cleaned.match(/\d+/g);
  if (numbers && numbers.length >= expectedCount) {
    return numbers.slice(0, expectedCount).map((n) => {
      const v = parseInt(n!, 10);
      return isNaN(v) ? 5 : Math.max(1, Math.min(10, v));
    });
  }

  return null;
}
