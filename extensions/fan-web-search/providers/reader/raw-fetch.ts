import type { ReaderProvider } from "./interface.js";
import type { ReaderParams, ReaderResult } from "../../types.js";

export class RawFetchReader implements ReaderProvider {
  readonly id = "raw-fetch";
  readonly name = "Raw Fetch + Strip";

  async read(params: ReaderParams, html: string, _signal?: AbortSignal): Promise<ReaderResult> {
    const title = this.extractTag(html, "title") || new URL(params.url).hostname;
    const description = this.extractMetaContent(html, "description") || "";

    // Strip tags
    let text = html;

    // Remove script, style, noscript, iframe, svg, nav, footer, header, aside, form, button, input, textarea, select, meta, link, head
    const removeTags = [
      "script", "style", "noscript", "iframe", "svg", "nav", "footer",
      "header", "aside", "form", "button", "input", "textarea", "select",
      "meta", "link", "head",
    ];

    for (const tag of removeTags) {
      text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
      text = text.replace(new RegExp(`<${tag}[^>]*/?>`, "gi"), "");
    }

    // Convert br to newline
    text = text.replace(/<br\s*\/?>/gi, "\n");
    // Convert hr to separator
    text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
    // Convert img alt to text
    text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "[Image: $1]");
    // Remove remaining tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode HTML entities
    text = this.decodeEntities(text);

    // Collapse whitespace
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    // For markdown format, wrap in basic structure
    const content = params.returnFormat === "markdown"
      ? `# ${title}\n\n${text}`
      : text;

    return {
      title,
      url: params.url,
      description,
      content,
      provider: this.id,
    };
  }

  private extractTag(html: string, tag: string): string {
    const match = html.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
    return match ? match[1].trim() : "";
  }

  private extractMetaContent(html: string, name: string): string {
    // Try property first (og:description)
    const propMatch = html.match(
      new RegExp(`<meta[^>]*property=["']og:${name}["'][^>]*content=["']([^"']*?)["']`, "i")
    );
    if (propMatch) return propMatch[1];

    // Try name
    const nameMatch = html.match(
      new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*?)["']`, "i")
    );
    if (nameMatch) return nameMatch[1];

    return "";
  }

  private decodeEntities(text: string): string {
    // Named entities
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");

    // Numeric entities (decimal)
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));

    // Hex entities
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );

    return text;
  }
}
