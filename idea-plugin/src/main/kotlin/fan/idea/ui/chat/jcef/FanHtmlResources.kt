package fan.idea.ui.chat.jcef

import com.intellij.openapi.diagnostic.Logger
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist

object FanHtmlResources {
    private val log = Logger.getInstance(FanHtmlResources::class.java)

    private const val HTML_TEMPLATE = "/html/fan-chat.html"
    private const val CSS_FILE = "/html/css/fan-chat-styles.css"
    private const val JS_FILE = "/html/js/fan-chat.js"

    private const val STYLES_PLACEHOLDER = "/* FAN_CHAT_STYLES_PLACEHOLDER */"
    private const val JS_PLACEHOLDER = "/* FAN_CHAT_JS_PLACEHOLDER */"

    fun generateFullHtml(fontSize: Int = 14): String {
        val template = loadResource(HTML_TEMPLATE)
        val css = loadResource(CSS_FILE)
        val js = loadResource(JS_FILE)

        val customFontSize = "--fan-font-size: ${fontSize}px;"

        val fullCss = ":root { $customFontSize }\n$css"

        return template
            .replace(STYLES_PLACEHOLDER, fullCss)
            .replace(JS_PLACEHOLDER, js)
    }

    fun sanitizeHtml(html: String): String {
        return Jsoup.clean(html, Safelist.relaxed())
    }

    fun escapeHtml(text: String): String {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&#39;")
    }

    private fun loadResource(path: String): String {
        return try {
            FanHtmlResources::class.java.getResource(path)?.readText()
                ?: throw IllegalArgumentException("Resource not found: $path")
        } catch (e: Exception) {
            log.info("Failed to load resource $path: ${e.message}")
            ""
        }
    }
}
