package fan.idea.ui.chat

import com.intellij.openapi.diagnostic.Logger
import fan.idea.ui.chat.jcef.FanHtmlResources
import fan.idea.ui.chat.jcef.JcefFanChatView
import fan.idea.ui.chat.jcef.toJsString
import fan.idea.ui.chat.markdown.FanMarkdownParser
import fan.idea.ui.chat.markdown.FanMarkdownRenderer

data class FooterData(
    val cwd: String = "",
    val branch: String = "",
    val sessionName: String = "",
    val statsUp: String = "",
    val statsDown: String = "",
    val statsRead: String = "",
    val cost: String = "",
    val contextUsed: String = "",
    val contextMax: String = "",
    val modelName: String = "",
    val temperature: String = ""
)

data class ClarificationOption(
    val value: String,
    val label: String,
    val description: String = ""
)

class FanHtmlDocumentManager(private val view: JcefFanChatView) {
    private val log = Logger.getInstance(FanHtmlDocumentManager::class.java)
    private val parser = FanMarkdownParser()
    private val renderer = FanMarkdownRenderer()

    fun loadHtml(fontSize: Int = 14) {
        val html = FanHtmlResources.generateFullHtml(fontSize)
        view.loadHtml(html)
    }

    fun updateTheme(isDark: Boolean) {
        view.executeJs("__fan_updateTheme($isDark)")
    }

    fun updateFontSize(size: Int) {
        view.executeJs("__fan_setFontSize($size)")
    }

    // ── Messages ──────────────────────────────────────────

    fun addUserMessage(content: String) {
        val sanitized = FanHtmlResources.sanitizeHtml(content)
        val renderedHtml = renderer.render(parser.parse(sanitized))
        view.executeJs("__fan_addUserMessage(\"${renderedHtml.toJsString()}\")")
    }

    fun addAssistantMessage(content: String) {
        val sanitized = FanHtmlResources.sanitizeHtml(content)
        val renderedHtml = renderer.render(parser.parse(sanitized))
        view.executeJs("__fan_addAssistantMessage(\"${renderedHtml.toJsString()}\")")
    }

    fun addSystemMessage(text: String) {
        view.executeJs("__fan_addSystemMessage(\"${text.toJsString()}\")")
    }

    fun addErrorMessage(title: String, message: String) {
        view.executeJs("__fan_addErrorMessage(\"${title.toJsString()}\", \"${message.toJsString()}\")")
    }

    // ── Streaming ────────────────────────────────────────

    fun startAssistantStream(): String {
        val id = "stream-${System.currentTimeMillis()}"
        view.executeJs("""
            window.__fan_currentStreamId = "$id";
            __fan_startAssistantStream();
        """.trimIndent())
        return id
    }

    fun updateAssistantStream(elementId: String, content: String) {
        val sanitized = FanHtmlResources.sanitizeHtml(content)
        val renderedHtml = renderer.render(parser.parse(sanitized))
        view.executeJs("__fan_updateAssistantStream(\"${elementId.toJsString()}\", \"${renderedHtml.toJsString()}\")")
    }

    fun endAssistantStream(elementId: String) {
        view.executeJs("__fan_endAssistantStream(\"${elementId.toJsString()}\")")
    }

    // ── Thinking ─────────────────────────────────────────

    fun showThinkingIndicator(id: String) {
        view.executeJs("__fan_createReasoningBlock(\"${id.toJsString()}\")")
    }

    fun updateThinkingContent(id: String, text: String) {
        view.executeJs("__fan_updateReasoningContent(\"${id.toJsString()}\", \"${text.toJsString()}\")")
    }

    fun completeThinking(id: String) {
        view.executeJs("__fan_completeReasoning(\"${id.toJsString()}\")")
    }

    // ── Tool Calls ───────────────────────────────────────

    fun addToolCallBlock(
        id: String,
        toolName: String,
        status: String = "pending",
        icon: String = "🔧",
        summary: String = "",
        args: String = ""
    ) {
        view.executeJs("""
            __fan_addToolCallBlock(
                "${id.toJsString()}",
                "${toolName.toJsString()}",
                "$status",
                "${icon.toJsString()}",
                "${summary.toJsString()}"
            );
        """.trimIndent())
    }

    fun updateToolCallStatus(id: String, status: String) {
        view.executeJs("__fan_updateToolCallStatus(\"${id.toJsString()}\", \"$status\")")
    }

    fun updateToolCallResult(id: String, resultHtml: String) {
        view.executeJs("__fan_updateToolCallResult(\"${id.toJsString()}\", \"${resultHtml.toJsString()}\")")
    }

    // ── Clarification ────────────────────────────────────

    fun addClarificationBlock(
        id: String,
        question: String,
        options: List<ClarificationOption>
    ) {
        val optionsJson = options.map { opt ->
            """{"value":"${opt.value.toJsString()}","label":"${opt.label.toJsString()}","desc":"${opt.description.toJsString()}"}"""
        }.joinToString(",", "[", "]")

        view.executeJs("""
            __fan_addClarificationButtons(
                "${id.toJsString()}",
                "${question.toJsString()}",
                $optionsJson
            );
        """.trimIndent())
    }

    fun removeClarificationBlock(id: String) {
        view.executeJs("__fan_removeClarificationButtons(\"${id.toJsString()}\")")
    }

    // ── Footer ───────────────────────────────────────────

    fun updateFooter(data: FooterData) {
        val json = """{
            "cwd": "${data.cwd.toJsString()}",
            "branch": "${data.branch.toJsString()}",
            "sessionName": "${data.sessionName.toJsString()}",
            "statsUp": "${data.statsUp.toJsString()}",
            "statsDown": "${data.statsDown.toJsString()}",
            "statsRead": "${data.statsRead.toJsString()}",
            "cost": "${data.cost.toJsString()}",
            "contextUsed": "${data.contextUsed.toJsString()}",
            "contextMax": "${data.contextMax.toJsString()}",
            "modelName": "${data.modelName.toJsString()}",
            "temperature": "${data.temperature.toJsString()}"
        }"""
        view.executeJs("__fan_updateFooter($json)")
    }

    // ── UI ────────────────────────────────────────────────

    fun scrollToBottom() {
        view.executeJs("__fan_scrollToBottom()")
    }

    fun clearMessages() {
        view.executeJs("__fan_clear()")
    }

    fun setBody(html: String) {
        view.executeJs("__fan_setBody(\"${html.toJsString()}\")")
    }
}
