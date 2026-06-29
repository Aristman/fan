import type { SearchResult, ProviderError, ReaderResult, FormatConfig } from "./types.js";

export function formatSearchResults(
  result: SearchResult,
  fallbackFrom: ProviderError[],
  _config?: FormatConfig,
): string {
  const lines: string[] = [];

  if (fallbackFrom.length > 0) {
    lines.push(`⚠ Fallback from: ${fallbackFrom.map(e => e.provider).join(" → ")}\n`);
  }

  if (result.items.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  lines.push(`Found ${result.items.length} results (via ${result.provider}):\n`);

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    lines.push(`${i + 1}. **${item.title}**`);
    if (item.date) lines.push(`   Date: ${item.date}`);
    if (item.source) lines.push(`   Source: ${item.source}`);
    lines.push(`   ${item.url}`);
    lines.push(`   ${item.snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatReaderResult(result: ReaderResult, config?: FormatConfig): string {
  const maxLinks = config?.maxLinks ?? 20;
  const maxImages = config?.maxImages ?? 10;
  const lines: string[] = [];

  lines.push(`## ${result.title}`);
  if (result.description) {
    lines.push(`> ${result.description}`);
  }
  lines.push(`Source: ${result.url}`);
  lines.push(`Provider: ${result.provider}`);
  lines.push("");
  lines.push(result.content);

  if (result.links && result.links.length > 0) {
    lines.push("\n### Links");
    for (const link of result.links.slice(0, maxLinks)) {
      lines.push(`- [${link.title}](${link.url})`);
    }
  }

  if (result.images && result.images.length > 0) {
    lines.push("\n### Images");
    for (const img of result.images.slice(0, maxImages)) {
      lines.push(`- ${img.alt}: ${img.url}`);
    }
  }

  return lines.join("\n");
}

export function formatSearchError(errors: ProviderError[], attempted: string[]): string {
  const lines: string[] = [];
  lines.push("❌ Web search failed — all providers exhausted:\n");
  lines.push(`Attempted: ${attempted.join(" → ")}\n`);
  for (const err of errors) {
    lines.push(`- **${err.provider}**: ${err.error}`);
  }
  return lines.join("\n");
}

export function formatReaderError(message: string): string {
  return `❌ Web reader failed: ${message}`;
}
