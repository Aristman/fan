/**
 * Centralized error formatting for Confluence API errors.
 * Translates HTTP status codes into actionable Russian messages for the LLM.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatConfluenceError(err: any): Error {
  // Already an Error — enhance with Confluence-specific context
  const original = err instanceof Error ? err : new Error(String(err));
  const message = original.message || String(err);

  // Extract HTTP status if available (confluence.js or fetch)
  const statusCode =
    err.status ??
    err.statusCode ??
    err.response?.status ??
    null;

  if (statusCode === 401 || statusCode === 403) {
    return new Error(
      `${message}\n\n` +
        `**Рекомендация:** Проверьте CONFLUENCE_PAT в файле ~/.fan/agent/extensions/fan-confluence/.env\n` +
        `- 401: токен недействителен или отсутствует\n` +
        `- 403: у текущего PAT нет доступа к этому ресурсу. Обратитесь к администратору Confluence.`,
    );
  }

  if (statusCode === 404) {
    return new Error(
      `${message}\n\n` +
        `**Рекомендация:** Ресурс не найден. Проверьте page_id или spaceKey.\n` +
        `- Убедитесь, что ID страницы правильный (числовой)\n` +
        `- Проверьте, что пространство существует и доступно`,
    );
  }

  if (statusCode === 429) {
    return new Error(
      `${message}\n\n` +
        `**Рекомендация:** Превышен лимит запросов к Confluence. Подождите несколько секунд и повторите.`,
    );
  }

  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("fetch failed") ||
    message.includes("network")
  ) {
    return new Error(
      `${message}\n\n` +
        `**Рекомендация:** Confluence недоступен. Проверьте:\n` +
        `- CONFLUENCE_BASE_URL в ~/.fan/agent/extensions/fan-confluence/.env\n` +
        `- Сетевое подключение к серверу Confluence`,
    );
  }

  if (statusCode && statusCode >= 500) {
    return new Error(
      `${message}\n\n` +
        `**Рекомендация:** Сервер Confluence вернул ошибку ${statusCode}. Попробуйте позже. Если проблема повторяется — обратитесь к администратору.`,
    );
  }

  // Generic: just wrap
  return new Error(`${message}`);
}
