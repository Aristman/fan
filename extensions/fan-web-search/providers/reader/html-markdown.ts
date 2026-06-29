import type { ReaderProvider } from "./interface.js";
import type { ReaderParams, ReaderResult, ReaderConfig } from "../../types.js";

export class HtmlMarkdownReader implements ReaderProvider {
  readonly id = "node-html-markdown";
  readonly name = "HTML → Markdown";

  private config: ReaderConfig;

  constructor(config: ReaderConfig) {
    this.config = config;
  }

  async read(params: ReaderParams, html: string, _signal?: AbortSignal): Promise<ReaderResult> {
    let { NodeHtmlMarkdown } = await import("node-html-markdown");

    const markdown = NodeHtmlMarkdown.translate(html, {
      ignore: ["script", "style", "noscript", "iframe", "svg"],
      maxConsecutiveNewlines: this.config.maxConsecutiveNewlines,
    });

    // Extract metadata from HTML
    const title = this.extractMeta(html, "title") || this.extractTitleTag(html);
    const description = this.extractMeta(html, "description") || this.extractMeta(html, "og:description");

    // Extract links if requested
    const links = params.withLinksSummary ? this.extractLinks(html) : undefined;

    // Extract images if requested
    const images = params.withImagesSummary ? this.extractImages(html) : undefined;

    // For text format, strip markdown
    const content = params.returnFormat === "text" ? this.stripMarkdown(markdown) : markdown;

    return {
      title: title || new URL(params.url).hostname,
      url: params.url,
      description: description || "",
      content,
      links,
      images,
      provider: this.id,
    };
  }

  private extractMeta(html: string, property: string): string {
    const ogMatch = html.match(new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']*)["']`, "i"));
    if (ogMatch) return ogMatch[1];
    const nameMatch = html.match(new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"));
    if (nameMatch) return nameMatch[1];
    const revMatch = html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${property}["']`, "i"));
    if (revMatch) return revMatch[1];
    return "";
  }

  private extractTitleTag(html: string): string {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim() : "";
  }

  private extractLinks(html: string): Array<{ title: string; url: string }> {
    const links: Array<{ title: string; url: string }> = [];
    const regex = /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const url = match[1];
      const title = match[2].trim();
      if (url && !url.startsWith("#") && !url.startsWith("javascript:") && title) {
        links.push({ title, url });
      }
      if (links.length >= this.config.maxLinks) break;
    }

    return links;
  }

  private extractImages(html: string): Array<{ alt: string; url: string }> {
    const images: Array<{ alt: string; url: string }> = [];
    const regex = /<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      images.push({ url: match[1], alt: match[2] });
      if (images.length >= this.config.maxImages) break;
    }

    // Also try alt before src
    const regex2 = /<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi;
    while ((match = regex2.exec(html)) !== null) {
      const url = match[2];
      const alt = match[1];
      if (!images.some(img => img.url === url)) {
        images.push({ url, alt });
      }
      if (images.length >= this.config.maxImages) break;
    }

    return images;
  }

  private stripMarkdown(md: string): string {
    return md
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/_(.*?)_/g, "$1")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`{1,3}[^`]*`{1,3}/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[-*+]\s+/gm, "• ")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/^>\s+/gm, "")
      .replace(/---+/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
