import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

let _service: TurndownService | null = null;

/**
 * Pre-process Confluence Storage Format HTML to replace custom XML tags
 * with standard HTML tags that turndown/domino can parse.
 *
 * domino (turndown's built-in HTML parser) does not create DOM nodes
 * for custom XML elements like <ac:...> and <ri:...>. We replace them
 * with <div> elements carrying data attributes so turndown rules can
 * match them.
 */
function preprocessHtml(html: string): string {
  let result = html;

  // ac:structured-macro[ac:name="code"] → div[data-macro="code"]
  result = result.replace(
    /<ac:structured-macro\s+ac:name="code"([^>]*)>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, attrs, inner) => {
      // Extract language from ac:parameter
      const langMatch = inner.match(/<ac:parameter\s+ac:name="language">([\s\S]*?)<\/ac:parameter>/i);
      const lang = langMatch ? langMatch[1].trim() : "";
      // Extract body content from ac:plain-text-body
      const bodyMatch = inner.match(/<ac:plain-text-body(?:[^>]*)>([\s\S]*?)<\/ac:plain-text-body>/i);
      const code = bodyMatch ? bodyMatch[1] : inner.replace(/<[^>]+>/g, "");
      return `<div data-macro="code" data-lang="${lang}">${escapeHtml(code)}</div>`;
    },
  );

  // ac:structured-macro[ac:name="info|warning|note|tip"] → div[data-panel="type"]
  result = result.replace(
    /<ac:structured-macro\s+ac:name="(info|warning|note|tip)"([^>]*)>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, type, _attrs, inner) => {
      return `<div data-panel="${type}">${inner}</div>`;
    },
  );

  // ac:link → div[data-link]
  result = result.replace(
    /<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi,
    (_match, inner) => {
      // Extract ri:page attribute
      const pageMatch = inner.match(/ri:content-title="([^"]*)"/);
      const title = pageMatch ? pageMatch[1] : inner.replace(/<[^>]+>/g, "").trim();
      return `<span data-link="true" data-title="${escapeHtml(title)}">${title}</span>`;
    },
  );

  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getService(): TurndownService {
  if (_service) return _service;

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
  });

  td.use(gfm);

  // Code macro: div[data-macro="code"] → fenced code block
  td.addRule("code-macro", {
    filter(node) {
      return node.nodeName === "DIV" && node.getAttribute("data-macro") === "code";
    },
    replacement(_content, node) {
      const lang = node.getAttribute("data-lang") || "";
      const code = node.textContent || "";
      return `\n\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
    },
  });

  // Panel macro: div[data-panel] → blockquote
  td.addRule("panel-macro", {
    filter(node) {
      return node.nodeName === "DIV" && !!node.getAttribute("data-panel");
    },
    replacement(content, node) {
      const type = node.getAttribute("data-panel") || "info";
      const icons: Record<string, string> = {
        info: "ℹ️",
        warning: "⚠️",
        note: "📝",
        tip: "💡",
      };
      const icon = icons[type] || "";
      const lines = content.trim().split("\n");
      return `\n\n> ${icon} **${type}:** ${lines.join("\n> ")}\n\n`;
    },
  });

  // ac:link: span[data-link] → markdown link
  td.addRule("ac-link", {
    filter(node) {
      return node.nodeName === "SPAN" && node.getAttribute("data-link") === "true";
    },
    replacement(_content, node) {
      const title = node.getAttribute("data-title") || node.textContent?.trim() || "page";
      return `[${title}]()`;
    },
  });

  _service = td;
  return _service;
}

export function convertStorageToMarkdown(html: string): string {
  const preprocessed = preprocessHtml(html);
  return getService().turndown(preprocessed);
}
