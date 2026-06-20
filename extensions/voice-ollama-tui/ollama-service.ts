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
// F-4.2: improveText (stub — will be extended in F-4.2)
// ---------------------------------------------------------------------------

/**
 * Send recognised text to Ollama for punctuation/typo correction.
 *
 * If `ollamaEnabled` is false or the server is unreachable, the original text
 * is returned unchanged. This is a stub for F-4.2 — it only checks reachability
 * and returns the original text.
 *
 * @param config - Ollama configuration
 * @param text - Recognised text to improve
 * @returns Improved text, or original text on failure
 */
export async function improveText(config: OllamaConfig, text: string): Promise<string> {
  if (config.ollamaEnabled === false) {
    return text;
  }

  const reachable = await isOllamaReachable(config);
  if (!reachable) {
    return text;
  }

  // F-4.2 full implementation will call /api/chat here.
  // For now, just return the original text.
  return text;
}
