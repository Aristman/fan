import { lexer, type Tokens } from "marked";

const MAX_PAGE_SIZE = 100_000; // 100 KB

export function convertMarkdownToStorage(markdown: string): string {
  const tokens = lexer(markdown);
  let html = "";

  for (const token of tokens) {
    html += renderToken(token);
  }

  return html;
}

function renderToken(token: Tokens.Generic): string {
  switch (token.type) {
    case "heading":
      return `<h${token.depth}>${inlineTokens(token.tokens)}</h${token.depth}>`;
    case "paragraph":
      return `<p>${inlineTokens(token.tokens)}</p>`;
    case "code":
      return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${token.lang || ""}</ac:parameter><ac:plain-text-body><![CDATA[${token.text}]]></ac:plain-text-body></ac:structured-macro>`;
    case "list": {
      const tag = token.ordered ? "ol" : "ul";
      const items = token.items
        .map((item) => {
          const checked =
            item.task && item.checked !== undefined
              ? ` data-task-status="${item.checked ? "complete" : "incomplete"}"`
              : "";
          const content = inlineTokens(item.tokens);
          if (item.task) {
            return `<li${checked}><ac:task-status>${item.checked ? "complete" : "incomplete"}</ac:task-status>${content}</li>`;
          }
          return `<li>${content}</li>`;
        })
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "table": {
      const headerCells = token.header
        .map(
          (h, i) =>
            `<th>${inlineTokens(h.tokens)}</th>`,
        )
        .join("");
      const header = `<tr>${headerCells}</tr>`;

      const bodyRows = token.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inlineTokens(cell.tokens)}</td>`).join("")}</tr>`,
        )
        .join("");

      return `<table><thead>${header}</thead><tbody>${bodyRows}</tbody></table>`;
    }
    case "blockquote":
      return `<blockquote>${inlineTokens(token.tokens)}</blockquote>`;
    case "hr":
      return `<hr/>`;
    case "space":
      return "";
    default:
      return "";
  }
}

function inlineTokens(tokens: (Tokens.Generic | Tokens.Inline)[] | undefined): string {
  if (!tokens) return "";

  return tokens
    .map((t) => {
      switch (t.type) {
        case "text":
          return t.text;
        case "strong":
          return `<strong>${inlineTokens(t.tokens)}</strong>`;
        case "em":
          return `<em>${inlineTokens(t.tokens)}</em>`;
        case "codespan":
          return `<code>${t.text}</code>`;
        case "del":
          return `<del>${inlineTokens(t.tokens)}</del>`;
        case "link":
          return `<a href="${t.href}">${inlineTokens(t.tokens)}</a>`;
        case "image":
          return `<ac:image ac:alt="${t.text || ""}"><ri:url ri:value="${t.href}"/></ac:image>`;
        case "br":
          return "<br/>";
        default:
          return t.raw || "";
      }
    })
    .join("");
}

export function truncateContent(content: string): {
  content: string;
  truncated: boolean;
  originalLength: number;
} {
  const buf = Buffer.byteLength(content, "utf8");
  if (buf <= MAX_PAGE_SIZE) {
    return { content, truncated: false, originalLength: buf };
  }

  // Truncate to ~90% to leave room for metadata
  const targetBytes = Math.floor(MAX_PAGE_SIZE * 0.9);
  let truncated = "";
  let currentBytes = 0;

  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + charBytes > targetBytes) break;
    truncated += char;
    currentBytes += charBytes;
  }

  return {
    content: truncated + "\n\n[Content truncated]",
    truncated: true,
    originalLength: buf,
  };
}
