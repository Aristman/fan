import { describe, it, expect } from "vitest";
import { convertStorageToMarkdown } from "../converters/storage-to-md.js";
import { convertMarkdownToStorage, truncateContent } from "../converters/md-to-storage.js";

// ── storage-to-md ───────────────────────────────────────────

describe("storage-to-md", () => {
  it("converts simple paragraph", () => {
    expect(convertStorageToMarkdown("<p>Hello world</p>")).toBe("Hello world");
  });

  it("converts heading", () => {
    expect(convertStorageToMarkdown("<h1>Title</h1>")).toBe("# Title");
    expect(convertStorageToMarkdown("<h2>Sub</h2>")).toBe("## Sub");
  });

  it("converts list", () => {
    const html = "<ul><li>item 1</li><li>item 2</li></ul>";
    const md = convertStorageToMarkdown(html);
    expect(md).toContain("item 1");
    expect(md).toContain("item 2");
  });

  it("converts table via GFM plugin", () => {
    const html = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>b</td></tr></table>";
    const md = convertStorageToMarkdown(html);
    expect(md).toContain("Name");
    expect(md).toContain("Value");
  });

  it("converts ac:structured-macro code", () => {
    const html = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>`;
    const md = convertStorageToMarkdown(html);
    expect(md).toContain("typescript");
    expect(md).toContain("const x = 1;");
  });

  it("converts ac:link with ri:page", () => {
    const html = `<ac:link><ri:page ri:content-title="My Page" /></ac:link>`;
    const md = convertStorageToMarkdown(html);
    expect(md).toContain("My Page");
  });

  it("converts bold and italic", () => {
    expect(convertStorageToMarkdown("<strong>bold</strong>")).toContain("**bold**");
    expect(convertStorageToMarkdown("<em>italic</em>")).toContain("*italic*");
  });

  it("converts panel macro (info) to blockquote", () => {
    const html = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note text</p></ac:rich-text-body></ac:structured-macro>`;
    const md = convertStorageToMarkdown(html);
    expect(md).toContain(">");
  });
});

// ── md-to-storage ───────────────────────────────────────────

describe("md-to-storage", () => {
  it("converts heading", () => {
    expect(convertMarkdownToStorage("# Title")).toContain("<h1>Title</h1>");
    expect(convertMarkdownToStorage("## Sub")).toContain("<h2>Sub</h2>");
  });

  it("converts list", () => {
    const s = convertMarkdownToStorage("- item 1\n- item 2");
    expect(s).toContain("<ul>");
    expect(s).toContain("<li>item 1</li>");
    expect(s).toContain("<li>item 2</li>");
  });

  it("converts ordered list", () => {
    const s = convertMarkdownToStorage("1. first\n2. second");
    expect(s).toContain("<ol>");
    expect(s).toContain("<li>first</li>");
  });

  it("converts table", () => {
    const s = convertMarkdownToStorage("| Name | Value |\n|------|-------|\n| a | b |");
    expect(s).toContain("<table>");
    expect(s).toContain("<th>Name</th>");
    expect(s).toContain("<td>a</td>");
  });

  it("converts code block to ac:structured-macro", () => {
    const s = convertMarkdownToStorage("```typescript\nconst x = 1;\n```");
    expect(s).toContain('ac:name="code"');
    expect(s).toContain("typescript");
    expect(s).toContain("const x = 1;");
  });

  it("converts bold and italic", () => {
    expect(convertMarkdownToStorage("**bold**")).toContain("<strong>bold</strong>");
    expect(convertMarkdownToStorage("*italic*")).toContain("<em>italic</em>");
  });

  it("converts links", () => {
    const s = convertMarkdownToStorage("[text](https://example.com)");
    expect(s).toContain('<a href="https://example.com">text</a>');
  });

  it("converts images to ac:image", () => {
    const s = convertMarkdownToStorage("![alt](https://example.com/img.png)");
    expect(s).toContain("ac:image");
    expect(s).toContain('ri:value="https://example.com/img.png"');
  });

  it("converts blockquote", () => {
    const s = convertMarkdownToStorage("> quoted text");
    expect(s).toContain("<blockquote>");
    expect(s).toContain("quoted text");
  });
});

// ── truncateContent ─────────────────────────────────────────

describe("truncateContent", () => {
  it("does not truncate small content", () => {
    const result = truncateContent("small");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("small");
  });

  it("truncates large content", () => {
    const large = "x".repeat(200_000);
    const result = truncateContent(large);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(200_000);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(100_000);
  });
});
