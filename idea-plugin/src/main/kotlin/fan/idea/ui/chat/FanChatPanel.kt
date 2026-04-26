package fan.idea.ui.chat

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import fan.idea.api.ConnectionStatus
import fan.idea.api.FanEvent
import fan.idea.core.events.ConnectionListener
import fan.idea.core.events.MessageListener
import fan.idea.core.services.FanConnectionService
import fan.idea.ui.chat.agent.FanAgentEventHandler
import fan.idea.ui.chat.agent.FanClarificationHandler
import fan.idea.ui.chat.jcef.JcefFanChatView
import fan.idea.settings.FanPluginSettings
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities

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

    // Agent event handling
    private val agentHandler: FanAgentEventHandler
    private val clarificationHandler: FanClarificationHandler

    @Volatile private var initialized = false

    init {
        docManager = FanHtmlDocumentManager(chatView)
        agentHandler = FanAgentEventHandler(docManager)
        clarificationHandler = FanClarificationHandler(project, docManager)

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

        // Defer HTML loading until the component is visible.
        // JCEF with off-screen rendering disabled requires a native window handle
        // to load and render content. The panel is created before being added
        // to the CardLayout, so loadHTML() would silently fail.
        addComponentListener(object : ComponentAdapter() {
            override fun componentShown(e: ComponentEvent) {
                if (!initialized) {
                    initialized = true
                    loadChatHtml()
                }
            }
        })

        // Subscriptions
        messageBusConnection.subscribe(MessageListener.TOPIC, object : MessageListener {
            override fun onMessageReceived(event: FanEvent) {
                agentHandler.handleEvent(event)
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
                clarificationHandler.handleResponse(blockId, option)
            }
        }
    }

    fun focusInput() {
        // Input is handled by parent panel
    }

    fun setTitle(title: String) {
        titleLabel.text = title
    }

    fun loadSessionMessages(messagesHtml: String) {
        docManager.setBody(messagesHtml)
    }

    fun clearMessages() {
        docManager.clearMessages()
    }

    fun getBackButton(): JButton = backButton

    private fun loadChatHtml() {
        val settings = FanPluginSettings.getInstance()
        val fontSize = settings.chatFontSize
        docManager.loadHtml(fontSize)
        docManager.updateTheme(isDarkTheme())
        log.info("Chat HTML loaded after component shown")
    }

    private fun isDarkTheme(): Boolean {
        return EditorColorsManager.getInstance().isDarkEditor
    }

    fun dispose() {
        messageBusConnection.disconnect()
        chatView.dispose()
    }
}
