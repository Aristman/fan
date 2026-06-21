/**
 * Ollama integration for voice-ollama-tui extension (F-4.1, F-4.2)
 *
 * F-4.1: Auto-detection of Ollama models via /api/tags
 * F-4.2: Post-processing of recognised text via Ollama /api/chat
 */



// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OllamaConfig {
  ollamaBaseUrl: string;
  ollamaEnabled?: boolean;
  ollamaModel?: string;
  ollamaSystemPrompt?: string;
}

// ---------------------------------------------------------------------------
// F-4.1: listOllamaModels
// ---------------------------------------------------------------------------

/**
 * Fetch the list of available models from Ollama's /api/tags endpoint.
 *
 * Makes a GET request to `${ollamaBaseUrl}/api/tags` and parses the response:
 *   { models: [{ name: "llama3.2:latest", ... }] }
 *
 * Returns an array of model names. On connection error, returns an empty array
 * (does not throw) so the caller can gracefully degrade.
 *
 * @param config - Object containing `ollamaBaseUrl`
 * @returns Array of model name strings
 */
export interface OllamaModelList {
  models: string[];
  reachable: boolean;
}

export async function listOllamaModels(config: { ollamaBaseUrl: string }): Promise<OllamaModelList> {
  try {
    const url = `${config.ollamaBaseUrl.replace(/\/+$/, "")}/api/tags`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`[voice-ollama-tui] Ollama /api/tags returned ${response.status}`);
      return { models: [], reachable: false };
    }

    const body = (await response.json()) as { models?: Array<{ name: string }> };
    if (!body.models || !Array.isArray(body.models)) {
      return { models: [], reachable: true };
    }

    return { models: body.models.map((m) => m.name), reachable: true };
  } catch (err) {
    console.warn("[voice-ollama-tui] Ollama unreachable:", (err as Error).message);
    return { models: [], reachable: false };
  }
}

// ---------------------------------------------------------------------------
// isOllamaReachable
// ---------------------------------------------------------------------------

/**
 * Check whether the Ollama server is reachable.
 *
 * Attempts a GET to `${ollamaBaseUrl}/api/tags`. Returns `true` if the server
 * responds within the timeout, `false` otherwise. Does not throw.
 *
 * @param config - Object containing `ollamaBaseUrl`
 */
export async function isOllamaReachable(config: { ollamaBaseUrl: string }): Promise<boolean> {
  try {
    const url = `${config.ollamaBaseUrl.replace(/\/+$/, "")}/api/tags`;
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// F-4.2: improveText
// ---------------------------------------------------------------------------

/**
 * Options for {@link improveText}.
 */
export interface ImproveTextOptions {
  /**
   * Optional callback invoked when Ollama is unreachable or an error occurs
   * and the original text is used as fallback.
   */
  onFallback?: () => void;
  /**
   * Optional AbortSignal to abort the fetch request.
   */
  signal?: AbortSignal;
}

/**
 * Result of {@link improveText}.
 */
export interface ImproveTextResult {
  /** The improved (or original) text. */
  text: string;
  /** Whether Ollama was actually used to improve the text. */
  usedOllama: boolean;
}

/**
 * Send recognised text to Ollama for punctuation/typo correction.
 *
 * Behaviour:
 * - If `ollamaEnabled !== true` → returns `{ text, usedOllama: false }` without any network call.
 * - If Ollama is unreachable (`isOllamaReachable` returns false) → returns `{ text, usedOllama: false }`
 *   and calls `onFallback()` if provided.
 * - Otherwise sends a POST to `${ollamaBaseUrl}/api/chat` with `stream: false`,
 *   the configured model, a system prompt, and the user text (temperature 0.3).
 * - On any HTTP/parse error → falls back to original text.
 *
 * @param config - Ollama configuration
 * @param text - Recognised text to improve
 * @param options - Optional settings (e.g. onFallback callback)
 * @returns Object with the (possibly improved) text and a flag indicating whether Ollama was used.
 */
export async function improveText(
  config: OllamaConfig,
  text: string,
  options?: ImproveTextOptions,
): Promise<ImproveTextResult> {
  const { onFallback } = options ?? {};

  // F-4.2 TC-3: if ollamaEnabled !== true, skip immediately
  if (config.ollamaEnabled !== true) {
    return { text, usedOllama: false };
  }

  // Build the /api/chat request directly (no separate reachability check)
  // MEDIUM-01: removed isOllamaReachable() call to eliminate double network hop
  const baseUrl = config.ollamaBaseUrl.replace(/\/+$/, "");
  const model = config.ollamaModel?.trim() || "llama3.2";
  const systemPrompt =
    config.ollamaSystemPrompt ??
    "You are a helpful assistant. Fix punctuation and obvious typos in the user's dictated text. Preserve the original meaning and language. Return ONLY the corrected text, nothing else.";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    stream: false,
    options: { temperature: 0.3 },
  };

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal ?? AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.warn(
        `[voice-ollama-tui] Ollama /api/chat returned ${response.status}`,
      );
      onFallback?.();
      return { text, usedOllama: false };
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };

    const improved = data?.message?.content?.trim();
    if (!improved) {
      console.warn(
        "[voice-ollama-tui] Ollama returned empty content, using original text",
      );
      onFallback?.();
      return { text, usedOllama: false };
    }

    return { text: improved, usedOllama: true };
  } catch (err) {
    console.warn(
      "[voice-ollama-tui] Ollama request failed:",
      (err as Error).message,
    );
    onFallback?.();
    return { text, usedOllama: false };
  }
}
