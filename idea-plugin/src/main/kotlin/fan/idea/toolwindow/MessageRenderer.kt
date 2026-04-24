package fan.idea.toolwindow

import org.intellij.markdown.flavours.commonmark.CommonMarkFlavourDescriptor
import org.intellij.markdown.html.HtmlGenerator
import org.intellij.markdown.parser.MarkdownParser

/**
 * Renders Markdown text to HTML for display in chat messages.
 * Uses IntelliJ's built-in markdown library.
 */
object MessageRenderer {
    private val flavour = CommonMarkFlavourDescriptor()
    private val parser = MarkdownParser(flavour)

    /**
     * Full CommonMark rendering via IntelliJ's markdown parser.
     */
    fun renderToHtml(markdown: String): String {
        val root = parser.buildMarkdownTreeFromString(markdown)
        return HtmlGenerator(markdown, root, flavour).generateHtml()
    }

    /**
     * Render with IntelliJ styling wrapper.
     */
    fun renderStyled(markdown: String): String {
        val html = renderToHtml(markdown)
        return """<html><body style="font-family: sans-serif; font-size: 13px;">$html</body></html>"""
    }

    /**
     * Simple markdown → HTML for inline display (JLabel).
     * Handles: code blocks, inline code, bold, italic, links.
     * This is faster than full CommonMark rendering and avoids
     * complex HTML that JLabel can't handle well.
     */
    fun renderSimple(markdown: String): String {
        var html = escapeHtmlBasic(markdown)

        // Code blocks: ```lang\ncode\n``` → <pre><code>
        html = html.replace(
            Regex("```\\w*\\n(.*?)```", RegexOption.DOT_MATCHES_ALL)
        ) { match ->
            val code = match.groupValues[1].trim()
            "<pre style='background:#f0f0f0;padding:4px 8px;border-radius:3px;font-family:monospace;font-size:12px;'>$code</pre>"
        }

        // Inline code
        html = html.replace(Regex("`(.*?)`")) {
            "<code style='background:#f0f0f0;padding:1px 4px;border-radius:2px;font-family:monospace;'>${it.groupValues[1]}</code>"
        }

        // Bold
        html = html.replace(Regex("\\*\\*(.*?)\\*\\*")) {
            "<b>${it.groupValues[1]}</b>"
        }

        // Italic
        html = html.replace(Regex("(?<!\\*)\\*([^*]+)\\*(?!\\*)")) {
            "<i>${it.groupValues[1]}</i>"
        }

        // Links: [text](url)
        html = html.replace(Regex("\\[(.*?)\\]\\((.*?)\\)")) {
            "<a href='${it.groupValues[2]}'>${it.groupValues[1]}</a>"
        }

        return "<html>$html</html>"
    }

    private fun escapeHtmlBasic(text: String): String {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
    }
}
