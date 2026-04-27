package fan.idea.ui.chat.markdown

class FanMarkdownRenderer {
    
    fun render(blocks: List<ContentBlock>): String {
        return buildString {
            for (block in blocks) {
                append(renderBlock(block))
            }
        }
    }
    
    fun renderInline(text: String): String {
        var result = escapeHtml(text)
        // Inline code (must be first to avoid processing inside code)
        result = result.replace(Regex("`([^`]+)`")) { match ->
            "<code>${match.groupValues[1]}</code>"
        }
        // Bold + italic
        result = result.replace(Regex("\\*\\*\\*([^*]+)\\*\\*\\*")) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        result = result.replace(Regex("___([^_]+)___")) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        // Bold
        result = result.replace(Regex("\\*\\*([^*]+)\\*\\*")) { "<strong>${it.groupValues[1]}</strong>" }
        result = result.replace(Regex("__([^_]+)__")) { "<strong>${it.groupValues[1]}</strong>" }
        // Italic
        result = result.replace(Regex("\\*([^*]+)\\*")) { "<em>${it.groupValues[1]}</em>" }
        result = result.replace(Regex("_([^_]+)_")) { "<em>${it.groupValues[1]}</em>" }
        // Strikethrough
        result = result.replace(Regex("~~([^~]+)~~")) { "<del>${it.groupValues[1]}</del>" }
        // Links
        result = result.replace(Regex("\\[([^\\]]+)\\]\\(([^)]+)\\)")) { "<a href=\"${it.groupValues[2]}\">${it.groupValues[1]}</a>" }
        // Images
        result = result.replace(Regex("!\\[([^\\]]*)\\]\\(([^)]+)\\)")) { "<img alt=\"${it.groupValues[1]}\" src=\"${it.groupValues[2]}\" />" }
        return result
    }
    
    private fun renderBlock(block: ContentBlock): String {
        return when (block) {
            is ContentBlock.TextBlock -> {
                val rendered = renderInline(block.content)
                if (rendered.contains("\n")) {
                    "<p>$rendered</p>"
                } else {
                    rendered
                }
            }
            is ContentBlock.CodeBlock -> {
                val lang = block.language ?: ""
                val escapedCode = escapeHtml(block.code)
                "<div class=\"fan-code-block\"><div class=\"fan-code-header\"><span class=\"fan-code-lang\">$lang</span><button class=\"fan-code-copy\" onclick=\"__fan_copyCode(this)\">📋 Copy</button></div><pre><code class=\"language-$lang\">$escapedCode</code></pre></div>"
            }
            is ContentBlock.HeadingBlock -> {
                "<h${block.level}>${renderInline(block.content)}</h${block.level}>"
            }
            is ContentBlock.ListBlock -> {
                val tag = if (block.ordered) "ol" else "ul"
                val items = block.items.joinToString("\n") { item ->
                    val prefix = if (block.ordered) "" else "→ "
                    "<li>${prefix}${renderInline(item.content)}</li>"
                }
                "<$tag>$items</$tag>"
            }
            is ContentBlock.BlockquoteBlock -> {
                "<blockquote>${renderInline(block.content)}</blockquote>"
            }
            is ContentBlock.HorizontalRuleBlock -> {
                "<hr>"
            }
            is ContentBlock.TableBlock -> {
                val headerCells = block.headers.joinToString("") { "<th>${renderInline(it)}</th>" }
                val bodyRows = block.rows.joinToString("\n") { row ->
                    "<tr>${row.joinToString("") { "<td>${renderInline(it)}</td>" }}</tr>"
                }
                "<table><thead><tr>$headerCells</tr></thead><tbody>$bodyRows</tbody></table>"
            }
            is ContentBlock.ImageBlock -> {
                "<img alt=\"${escapeHtml(block.alt)}\" src=\"${escapeHtml(block.url)}\" />"
            }
        }
    }
    
    private fun escapeHtml(text: String): String {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
    }
}
