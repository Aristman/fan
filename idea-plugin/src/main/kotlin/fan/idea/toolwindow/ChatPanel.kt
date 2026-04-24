package fan.idea.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import fan.idea.FanPluginManager
import fan.idea.api.FanEvent
import fan.idea.api.SessionMessage
import fan.idea.settings.FanPluginSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Color
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

class ChatPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val plugin get() = project.getService(FanPluginManager::class.java).fanPlugin
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Components
    private val chatScrollPane: JBScrollPane
    private val chatArea: JPanel
    private val inputPanel: InputPanel

    // Message panels
    private val messagePanels = mutableListOf<JPanel>()
    private var currentAssistantPanel: JPanel? = null
    private var currentAssistantLabel: JLabel? = null
    private var currentThinkingPanel: JPanel? = null
    private var currentThinkingLabel: JLabel? = null
    private var currentToolPanel: JPanel? = null
    private var messagesLoaded = false

    // App bar components
    private val backButton = JButton("← Sessions")
    private val titleLabel = JBLabel("")
    private val statusBar = StatusBar()

    init {
        // App bar (top)
        val appBar = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4, 8)
            val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 5, 0)).apply {
                add(backButton)
                add(titleLabel)
            }
            add(leftPanel, BorderLayout.WEST)
            add(statusBar, BorderLayout.EAST)
        }

        // Chat area
        chatArea = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8)
        }
        chatScrollPane = JBScrollPane(chatArea).apply {
            verticalScrollBarPolicy = JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
            horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            border = BorderFactory.createEmptyBorder()
        }

        // Input (bottom)
        inputPanel = InputPanel(project)

        add(appBar, BorderLayout.NORTH)
        add(chatScrollPane, BorderLayout.CENTER)
        add(inputPanel, BorderLayout.SOUTH)

        // Listeners
        backButton.addActionListener {
            plugin.navigateToSessionList()
            getViewSwitcher()?.showSessionList()
        }

        // Observe events
        scope.launch {
            plugin.events.collect { event -> handleEvent(event) }
        }

        // Observe connection status
        scope.launch {
            plugin.connectionStatus.collect { status -> updateConnectionStatus(status) }
        }

        // Observe session changes (for loading history)
        scope.launch {
            plugin.currentSessionId.collect { id ->
                if (id != null && !messagesLoaded) {
                    loadMessages()
                }
            }
        }

        // Observe generating state for stop button
        scope.launch {
            plugin.isGenerating.collect { generating ->
                javax.swing.SwingUtilities.invokeLater {
                    inputPanel.setGenerating(generating)
                }
            }
        }

        // Show user message in chat when sent (from any input)
        scope.launch {
            plugin.lastUserMessage.collect { msg ->
                if (msg != null) {
                    withContextToEdt {
                        val panel = createMessageBubble("user")
                        panel.add(JLabel("<html>${escapeHtml(msg)}</html>"))
                        appendMessagePanel(panel)
                        scrollToBottom()
                    }
                }
            }
        }
    }

    fun focusInput() = inputPanel.focusInput()

    private fun handleEvent(event: FanEvent) {
        withContextToEdt {
            when (event) {
                is FanEvent.Connected -> {
                    loadMessages()
                }
                is FanEvent.AgentStart -> {
                    // Start a new assistant message block
                    currentAssistantPanel = createMessageBubble("assistant")
                    currentAssistantLabel = JLabel("<html></html>")
                    currentAssistantPanel?.add(currentAssistantLabel!!)
                    appendMessagePanel(currentAssistantPanel!!)
                }
                is FanEvent.TextDelta -> {
                    currentAssistantLabel?.let { label ->
                        val currentHtml = extractHtmlBody(label.text)
                        val escaped = escapeHtml(event.delta)
                        label.text = "<html>$currentHtml$escaped</html>"
                        scrollToBottom()
                    }
                }
                is FanEvent.TextEnd -> {
                    currentAssistantPanel = null
                    currentAssistantLabel = null
                }
                is FanEvent.ThinkingDelta -> {
                    currentThinkingLabel?.let { label ->
                        val currentHtml = extractHtmlBody(label.text)
                        val escaped = escapeHtml(event.delta)
                        label.text = "<html>$currentHtml$escaped</html>"
                        scrollToBottom()
                    }
                }
                is FanEvent.ThinkingEnd -> {
                    currentThinkingLabel = null
                    currentThinkingPanel = null
                }
                is FanEvent.ToolExecutionStart -> {
                    currentToolPanel = createToolBlock(event.toolName, event.toolCallId)
                    appendMessagePanel(currentToolPanel!!)
                    scrollToBottom()
                }
                is FanEvent.ToolExecutionEnd -> {
                    currentToolPanel?.let { panel ->
                        val resultLabel = panel.components.find {
                            it is JLabel && it.name == "result"
                        } as? JLabel
                        if (resultLabel != null) {
                            val resultText = if (event.isError) "❌ Error" else "✅ Done"
                            val detail = event.result?.take(100)?.let { " — $it" } ?: ""
                            resultLabel.text = "$resultText$detail"
                        }
                    }
                    currentToolPanel = null
                    scrollToBottom()
                }
                is FanEvent.ToolExecutionUpdate -> {
                    currentToolPanel?.let { panel ->
                        val resultLabel = panel.components.find {
                            it is JLabel && it.name == "result"
                        } as? JLabel
                        if (resultLabel != null) {
                            val partial = event.partialResult?.take(100) ?: ""
                            resultLabel.text = "⏳ $partial..."
                        }
                    }
                }
                is FanEvent.MessageStart -> {
                    val settings = FanPluginSettings.getInstance()
                    if (settings.showThinking) {
                        currentThinkingPanel = createThinkingBlock()
                        appendMessagePanel(currentThinkingPanel!!)
                    }
                    currentThinkingLabel = currentThinkingPanel?.components
                        ?.filterIsInstance<JPanel>()
                        ?.firstOrNull()
                        ?.components?.firstOrNull() as? JLabel
                }
                is FanEvent.TurnEnd, is FanEvent.AgentEnd -> {
                    currentAssistantPanel = null
                    currentAssistantLabel = null
                    currentThinkingPanel = null
                    currentThinkingLabel = null
                    currentToolPanel = null
                    messagesLoaded = false // Allow reload on next switch
                }
                is FanEvent.Error -> {
                    val errorPanel = createMessageBubble("error")
                    val label = JLabel("<html><span style='color:red'>⚠ ${escapeHtml(event.message)}</span></html>")
                    errorPanel.add(label)
                    appendMessagePanel(errorPanel)
                }
                else -> {
                    // FanEvent.TurnStart, FanEvent.MessageEnd — no UI action needed
                }
            }
        }
    }

    private fun withContextToEdt(block: () -> Unit) {
        if (SwingUtilities.isEventDispatchThread()) {
            block()
        } else {
            SwingUtilities.invokeLater { block() }
        }
    }

    private fun loadMessages() {
        messagesLoaded = true
        scope.launch {
            val result = plugin.getSessionMessages()
            if (result.isFailure) return@launch

            withContextToEdt {
                clearMessages()
                val messages = result.getOrThrow()
                for (msg in messages) {
                    when (msg.role) {
                        "user" -> {
                            val panel = createMessageBubble("user")
                            panel.add(JLabel("<html>${escapeHtml(msg.content)}</html>"))
                            appendMessagePanel(panel)
                        }
                        "assistant" -> {
                            val panel = createMessageBubble("assistant")
                            panel.add(JLabel(MessageRenderer.renderSimple(msg.content)))
                            appendMessagePanel(panel)
                        }
                        "tool" -> {
                            val panel = createToolBlock("tool", "")
                            val resultLabel = panel.components.find {
                                it is JLabel && it.name == "result"
                            } as? JLabel
                            resultLabel?.text = "✅ ${msg.content.take(200)}"
                            appendMessagePanel(panel)
                        }
                    }
                }

                // Update title
                plugin.currentSessionId.value?.let { id ->
                    val session = plugin.sessions.value.find { it.id == id }
                    titleLabel.text = session?.title?.ifBlank { null } ?: "Chat"
                }

                scrollToBottom()
            }
        }
    }

    private fun clearMessages() {
        chatArea.removeAll()
        messagePanels.clear()
        chatArea.revalidate()
        chatArea.repaint()
    }

    private fun appendMessagePanel(panel: JPanel) {
        chatArea.add(panel)
        chatArea.add(Box.createVerticalStrut(6))
        chatArea.revalidate()
        chatArea.repaint()
    }

    private fun createMessageBubble(role: String): JPanel {
        val panel = JPanel(BorderLayout())
        panel.border = JBUI.Borders.empty(2, 0)

        when (role) {
            "user" -> {
                panel.background = JBUI.CurrentTheme.ActionButton.hoverBackground()
                panel.border = JBUI.Borders.empty(4, 10)
                panel.isOpaque = true
                panel.alignmentX = Component.RIGHT_ALIGNMENT
            }
            "assistant" -> {
                panel.border = JBUI.Borders.empty(4, 4)
            }
            "error" -> {
                panel.border = JBUI.Borders.customLine(
                    JBUI.CurrentTheme.Advertiser.borderColor(), 1, 1, 1, 1
                )
                panel.isOpaque = true
                panel.background = Color(255, 235, 238)
            }
        }

        return panel
    }

    private fun createThinkingBlock(): JPanel {
        val panel = JPanel(BorderLayout())
        panel.border = JBUI.Borders.customLine(Color.GRAY, 0, 0, 0, 2)
        panel.isOpaque = false

        val toggleButton = JButton("💭 Thinking...").apply {
            isBorderPainted = false
            isOpaque = false
            isContentAreaFilled = false
            horizontalAlignment = SwingConstants.LEFT
        }

        val contentPanel = JPanel(BorderLayout()).apply { isOpaque = false }
        val thinkingLabel = JLabel("<html></html>")
        contentPanel.add(thinkingLabel, BorderLayout.CENTER)

        var expanded = true
        toggleButton.addActionListener {
            expanded = !expanded
            contentPanel.isVisible = expanded
            toggleButton.text = if (expanded) "💭 Thinking..." else "💭 Thinking (collapsed)"
        }

        panel.add(toggleButton, BorderLayout.NORTH)
        panel.add(contentPanel, BorderLayout.CENTER)

        return panel
    }

    private fun createToolBlock(toolName: String, toolCallId: String): JPanel {
        val panel = JPanel(BorderLayout())
        panel.border = JBUI.Borders.empty(2, 8)
        panel.isOpaque = false

        val header = JLabel("🔧 $toolName").apply {
            border = JBUI.Borders.empty(2, 0)
        }
        val resultLabel = JLabel("⏳ Running...").apply {
            name = "result"
            foreground = Color.GRAY
            border = JBUI.Borders.empty(0, 16)
        }

        panel.add(header, BorderLayout.NORTH)
        panel.add(resultLabel, BorderLayout.CENTER)

        return panel
    }

    private fun updateConnectionStatus(status: fan.idea.api.ConnectionStatus) {
        withContextToEdt {
            statusBar.updateStatus(status)
        }
    }

    private fun scrollToBottom() {
        SwingUtilities.invokeLater {
            val scrollBar = chatScrollPane.verticalScrollBar
            scrollBar.value = scrollBar.maximum
        }
    }

    private fun extractHtmlBody(html: String): String {
        // Simple extraction: remove <html> and </html> tags
        return html.removePrefix("<html>").removeSuffix("</html>")
    }

    private fun escapeHtml(text: String): String {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("\n", "<br>")
    }

    private fun getViewSwitcher(): ViewSwitcher? {
        return FanToolWindowFactory.getViewSwitcher(project)
    }

    fun dispose() {
        scope.cancel()
    }
}
