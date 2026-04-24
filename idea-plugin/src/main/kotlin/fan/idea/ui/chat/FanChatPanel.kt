package fan.idea.ui.chat

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import fan.idea.api.ConnectionStatus
import fan.idea.api.FanEvent
import fan.idea.core.events.ConnectionListener
import fan.idea.core.events.MessageListener
import fan.idea.core.services.FanConnectionService
import fan.idea.ui.chat.jcef.JcefFanChatView
import fan.idea.settings.FanPluginSettings
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.UIManager

class FanChatPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(FanChatPanel::class.java)

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private val messageBusConnection = project.messageBus.connect()

    private val chatView = JcefFanChatView()
    private val docManager: FanHtmlDocumentManager

    // Header
    private val backButton = JButton("← Sessions")
    private val titleLabel = JBLabel("Chat")

    // Event state
    private var currentStreamId: String? = null
    private var currentThinkingId: String? = null
    private var pendingToolBlocks = mutableMapOf<String, String>() // toolCallId → elementId

    init {
        docManager = FanHtmlDocumentManager(chatView)

        // Header panel
        val headerPanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4, 8)
            val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 5, 0)).apply {
                add(backButton)
                add(titleLabel)
            }
            add(leftPanel, BorderLayout.WEST)
        }

        add(headerPanel, BorderLayout.NORTH)
        add(chatView, BorderLayout.CENTER)

        // Load HTML
        val settings = FanPluginSettings.getInstance()
        val fontSize = settings.chatFontSize
        docManager.loadHtml(fontSize)

        // Apply initial theme
        val isDark = isDarkTheme()
        docManager.updateTheme(isDark)

        // Subscriptions
        messageBusConnection.subscribe(MessageListener.TOPIC, object : MessageListener {
            override fun onMessageReceived(event: FanEvent) {
                handleEvent(event)
            }
            override fun onGeneratingChanged(generating: Boolean) {
                // handled by parent
            }
        })

        messageBusConnection.subscribe(ConnectionListener.TOPIC, object : ConnectionListener {
            override fun onConnectionStateChanged(status: ConnectionStatus) {
                if (status == ConnectionStatus.CONNECTED) {
                    SwingUtilities.invokeLater {
                        val isDark = isDarkTheme()
                        docManager.updateTheme(isDark)
                    }
                }
            }
        })

        // Clarification bridge
        chatView.onClarificationSelected = { result ->
            val parts = result.split("|", limit = 2)
            if (parts.size == 2) {
                val blockId = parts[0]
                val option = parts[1]
                log.info("Clarification: block=$blockId option=$option")
                docManager.removeClarificationBlock(blockId)
                // TODO: Send response via MessageService (Phase 3)
            }
        }
    }

    fun focusInput() {
        // Input is handled by parent panel
    }

    fun setTitle(title: String) {
        titleLabel.text = title
    }

    private fun handleEvent(event: FanEvent) {
        when (event) {
            is FanEvent.AgentStart -> {
                currentStreamId = docManager.startAssistantStream()
            }
            is FanEvent.TextDelta -> {
                currentStreamId?.let { id ->
                    docManager.updateAssistantStream(id, event.delta)
                }
            }
            is FanEvent.TextEnd -> {
                currentStreamId?.let { id ->
                    docManager.endAssistantStream(id)
                }
                currentStreamId = null
            }
            is FanEvent.MessageStart -> {
                val settings = FanPluginSettings.getInstance()
                if (settings.showThinking) {
                    val thinkingId = "thinking-${System.currentTimeMillis()}"
                    currentThinkingId = thinkingId
                    docManager.showThinkingIndicator(thinkingId)
                }
            }
            is FanEvent.ThinkingDelta -> {
                currentThinkingId?.let { id ->
                    docManager.updateThinkingContent(id, event.delta)
                }
            }
            is FanEvent.ThinkingEnd -> {
                currentThinkingId?.let { id ->
                    docManager.completeThinking(id)
                }
                currentThinkingId = null
            }
            is FanEvent.ToolExecutionStart -> {
                val elementId = "tool-${event.toolCallId}"
                pendingToolBlocks[event.toolCallId] = elementId
                val icon = getToolIcon(event.toolName)
                val summary = truncate(event.args.toString(), 80)
                docManager.addToolCallBlock(
                    id = elementId,
                    toolName = event.toolName,
                    status = "pending",
                    icon = icon,
                    summary = summary
                )
            }
            is FanEvent.ToolExecutionEnd -> {
                val elementId = pendingToolBlocks.remove(event.toolCallId)
                if (elementId != null) {
                    val status = if (event.isError) "error" else "success"
                    docManager.updateToolCallStatus(elementId, status)
                    val resultText = event.result ?: ""
                    val truncated = truncate(resultText, 500)
                    docManager.updateToolCallResult(elementId, escapeHtml(truncated))
                }
            }
            is FanEvent.ToolExecutionUpdate -> {
                val elementId = pendingToolBlocks[event.toolCallId]
                if (elementId != null) {
                    val partial = event.partialResult ?: ""
                    docManager.updateToolCallResult(elementId, escapeHtml(truncate(partial, 500)))
                }
            }
            is FanEvent.Error -> {
                docManager.addErrorMessage("Error", event.message)
            }
            is FanEvent.TurnEnd, is FanEvent.AgentEnd -> {
                currentStreamId = null
                currentThinkingId = null
                pendingToolBlocks.clear()
            }
            else -> { /* Connected, TurnStart, MessageEnd — no UI action */ }
        }
    }

    private fun getToolIcon(toolName: String): String {
        return when (toolName) {
            "read" -> "📄"
            "write" -> "✏️"
            "edit" -> "📝"
            "bash" -> "$"
            "grep", "find" -> "🔍"
            else -> "🔧"
        }
    }

    private fun truncate(text: String, maxLen: Int): String {
        return if (text.length > maxLen) text.take(maxLen) + "..." else text
    }

    private fun escapeHtml(text: String): String {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
    }

    fun loadSessionMessages(messagesHtml: String) {
        docManager.setBody(messagesHtml)
    }

    fun clearMessages() {
        docManager.clearMessages()
    }

    fun getBackButton(): JButton = backButton

    private fun isDarkTheme(): Boolean {
        try {
            return UIManager.getBoolean("EditorPane.background") == false ||
                   UIManager.getColor("Panel.background")?.let { bg ->
                       val r = bg.red; val g = bg.green; val b = bg.blue
                       (r * 0.299 + g * 0.587 + b * 0.114) < 128
                   } ?: false
        } catch (e: Exception) {
            return false
        }
    }

    fun dispose() {
        messageBusConnection.disconnect()
        chatView.dispose()
    }
}
