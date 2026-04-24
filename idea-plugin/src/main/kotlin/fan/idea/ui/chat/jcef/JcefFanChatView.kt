package fan.idea.ui.chat.jcef

import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBuilder
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import javax.swing.JPanel

class JcefFanChatView : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(JcefFanChatView::class.java)

    private val cefBrowser: JBCefBrowser = JBCefBrowserBuilder()
        .setOffScreenRendering(false)
        .build()

    @Volatile private var isReady = false
    @Volatile private var isDisposed = false
    private val pendingScripts = mutableListOf<String>()
    private var clarificationQuery: JBCefJSQuery? = null

    var onClarificationSelected: ((String) -> Unit)? = null

    init {
        add(cefBrowser.component, BorderLayout.CENTER)

        cefBrowser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(browser: CefBrowser?,
                                              isLoading: Boolean,
                                              canGoBack: Boolean,
                                              canGoForward: Boolean) {
                if (!isLoading && !isDisposed) {
                    isReady = true
                    flushPending()
                }
            }
        }, cefBrowser.cefBrowser)

        setupClarificationBridge()
    }

    fun loadHtml(html: String) {
        isReady = false
        pendingScripts.clear()
        cefBrowser.loadHTML(html)
    }

    fun executeJs(script: String) {
        if (isDisposed) return
        if (isReady) {
            try {
                cefBrowser.cefBrowser.executeJavaScript(script, cefBrowser.cefBrowser.url, 0)
            } catch (e: Exception) {
                log.info("Failed to execute JS: ${e.message}")
            }
        } else {
            pendingScripts.add(script)
        }
    }

    private fun flushPending() {
        val scripts = pendingScripts.toList()
        pendingScripts.clear()
        for (script in scripts) {
            try {
                cefBrowser.cefBrowser.executeJavaScript(script, cefBrowser.cefBrowser.url, 0)
            } catch (e: Exception) {
                log.info("Failed to execute pending JS: ${e.message}")
            }
        }
    }

    private fun setupClarificationBridge() {
        clarificationQuery = JBCefJSQuery.create(cefBrowser)
        clarificationQuery?.addHandler { result ->
            log.info("Clarification selected: $result")
            onClarificationSelected?.invoke(result)
            null
        }
        // Inject JS bridge after page loads
        executeJs("""
            (function() {
                if (window.__fan_onClarificationClick) return;
                window.__fan_onClarificationClick = function(blockId, option) {
                    ${clarificationQuery?.inject("blockId + '|' + option") ?: ""}
                };
            })();
        """.trimIndent())
    }

    fun ensureNotDisposed() {
        if (isDisposed) {
            log.info("JcefFanChatView accessed after dispose")
        }
    }

    fun dispose() {
        if (isDisposed) return
        isDisposed = true
        isReady = false
        clarificationQuery?.dispose()
        try {
            cefBrowser.jbCefClient.dispose()
        } catch (e: Exception) {
            log.info("Error disposing CEF client: ${e.message}")
        }
    }
}

fun String.toJsString(): String {
    return this.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\"", "\\\"")
        .replace("'", "\\'")
}
