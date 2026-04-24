package fan.idea.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import javax.swing.JButton
import javax.swing.SwingUtilities
import fan.idea.api.ConnectionStatus
import fan.idea.api.SessionSummary
import fan.idea.core.services.FanConnectionService
import fan.idea.core.services.FanMessageService
import fan.idea.core.services.FanSessionService
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.awt.BorderLayout
import java.awt.Color
import java.awt.CardLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.swing.DefaultListModel
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class SessionListPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(SessionListPanel::class.java)
    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)
    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)
    private val messageService: FanMessageService
        get() = project.getService(FanMessageService::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // UI Components
    private val searchBar = JBTextField().apply { toolTipText = "Search sessions..." }
    private val sessionListModel = DefaultListModel<String>()
    private val sessionList = JBList(sessionListModel)
    private val messageInput = JBTextArea(2, 20).apply {
        lineWrap = true
        wrapStyleWord = true
    }
    private val sendButton = JButton("Send")
    private val emptyLabel = JBLabel("No sessions yet. Type a message to start a new chat.")
    private val statusLabel = JBLabel("").apply {
        foreground = Color.GRAY
        border = JBUI.Borders.empty(2, 8)
    }

    // State
    private val sessions = mutableMapOf<String, SessionSummary>()

    init {
        // Top: Search bar + connection status
        val topPanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(5, 8)
            add(searchBar, BorderLayout.CENTER)
            add(statusLabel, BorderLayout.SOUTH)
        }

        // Center: Session list + empty label
        val centerPanel = JPanel(CardLayout()).apply {
            val scrollPane = JBScrollPane(sessionList)
            add(scrollPane, "sessions")
            emptyLabel.horizontalAlignment = SwingConstants.CENTER
            val emptyPanel = JPanel(BorderLayout()).apply {
                add(emptyLabel, BorderLayout.CENTER)
                border = JBUI.Borders.empty(20)
            }
            add(emptyPanel, "empty")
        }

        // Bottom: Input
        val bottomPanel = JPanel(BorderLayout(0, 4)).apply {
            border = JBUI.Borders.empty(5, 8)
            val inputScroll = JBScrollPane(messageInput)
            add(inputScroll, BorderLayout.CENTER)
            add(sendButton, BorderLayout.EAST)
        }

        add(topPanel, BorderLayout.NORTH)
        add(centerPanel, BorderLayout.CENTER)
        add(bottomPanel, BorderLayout.SOUTH)

        // Send disabled until connected
        sendButton.isEnabled = false
        statusLabel.text = "Connecting to FAN Server..."

        // Observe connection status
        scope.launch {
            connectionService.getConnectionStatus(project).collect { status ->
                SwingUtilities.invokeLater {
                    when (status) {
                        ConnectionStatus.CONNECTED -> {
                            sendButton.isEnabled = true
                            statusLabel.text = "Connected"
                        }
                        ConnectionStatus.CONNECTING,
                        ConnectionStatus.RECONNECTING -> {
                            sendButton.isEnabled = false
                            statusLabel.text = "Connecting to FAN Server..."
                        }
                        ConnectionStatus.DISCONNECTED -> {
                            sendButton.isEnabled = false
                            statusLabel.text = "Disconnected"
                        }
                        ConnectionStatus.ERROR -> {
                            sendButton.isEnabled = false
                            statusLabel.text = "Connection failed"
                        }
                    }
                }
            }
        }

        // Observe sessions from service
        scope.launch {
            sessionService.sessions.collect { sessionList ->
                SwingUtilities.invokeLater { updateSessionList(sessionList) }
            }
        }

        // Double-click → open session
        sessionList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val index = sessionList.selectedIndex
                    if (index >= 0) {
                        val key = sessionListModel.elementAt(index)
                        sessions[key]?.let { openSession(it.id) }
                    }
                }
            }
        })

        // Single click select (visual only — double-click opens)
        sessionList.addListSelectionListener { _ ->
            // Selection highlight handled by JBList automatically
        }

        // Send button → create new session + send
        sendButton.addActionListener { sendMessage() }

        // Enter in input → send (but Shift+Enter = newline)
        messageInput.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    sendMessage()
                }
            }
        })

        // Search filter
        searchBar.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) = filterSessions()
            override fun removeUpdate(e: DocumentEvent?) = filterSessions()
            override fun changedUpdate(e: DocumentEvent?) = filterSessions()
        })
    }

    private fun sendMessage() {
        val text = messageInput.text.trim()
        if (text.isBlank()) return
        log.info("SessionListPanel: sendMessage, text length=${text.length}")
        messageInput.text = ""
        sendButton.isEnabled = false

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                log.info("SessionListPanel: calling messageService.sendMessage...")
                val result = runBlocking { messageService.sendMessage(text) }
                log.info("SessionListPanel: sendMessage result=${result.isSuccess}")
                if (result.isFailure) {
                    log.info("SessionListPanel: error=${result.exceptionOrNull()?.message}")
                    SwingUtilities.invokeLater {
                        messageInput.text = text
                        sendButton.isEnabled = true
                    }
                } else {
                    SwingUtilities.invokeLater {
                        sendButton.isEnabled = true
                        getViewSwitcher()?.showChat()
                    }
                }
            } catch (t: Throwable) {
                log.info("SessionListPanel: exception=${t.message}")
                SwingUtilities.invokeLater {
                    messageInput.text = text
                    sendButton.isEnabled = true
                }
            }
        }
    }

    private fun openSession(sessionId: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val result = runBlocking { sessionService.selectSession(sessionId) }
                if (result.isSuccess) {
                    SwingUtilities.invokeLater {
                        getViewSwitcher()?.showChat()
                    }
                }
            } catch (t: Throwable) {
                log.info("SessionListPanel: openSession error=${t.message}")
            }
        }
    }

    private fun updateSessionList(newSessions: List<SessionSummary>) {
        sessions.clear()
        sessionListModel.clear()

        for (session in newSessions) {
            val displayText = formatSession(session)
            sessions[displayText] = session
            sessionListModel.addElement(displayText)
        }

        // Show/hide empty label
        val centerPanel = getComponent(1) as? JPanel
        val cardLayout = centerPanel?.layout as? CardLayout
        if (centerPanel != null && cardLayout != null) {
            if (newSessions.isEmpty()) {
                cardLayout.show(centerPanel, "empty")
            } else {
                cardLayout.show(centerPanel, "sessions")
            }
        }
    }

    private fun formatSession(session: SessionSummary): String {
        val time = formatRelativeTime(session.updatedAt)
        return "${session.title.ifBlank { "Untitled" }}    $time"
    }

    private fun formatRelativeTime(isoDate: String): String {
        return try {
            val instant = Instant.parse(isoDate)
            val duration = Duration.between(instant, Instant.now())
            when {
                duration.toMinutes() < 1 -> "just now"
                duration.toMinutes() < 60 -> "${duration.toMinutes()}m ago"
                duration.toHours() < 24 -> "${duration.toHours()}h ago"
                duration.toDays() < 7 -> "${duration.toDays()}d ago"
                else -> LocalDateTime.ofInstant(instant, ZoneId.systemDefault())
                    .format(DateTimeFormatter.ofPattern("MMM d"))
            }
        } catch (e: Exception) {
            isoDate
        }
    }

    private fun filterSessions() {
        val query = searchBar.text.trim().lowercase()
        sessionListModel.clear()
        for ((displayText, session) in sessions) {
            if (query.isBlank() || session.title.lowercase().contains(query)) {
                sessionListModel.addElement(displayText)
            }
        }
    }

    private fun getViewSwitcher(): ViewSwitcher? {
        return FanToolWindowFactory.getViewSwitcher(project)
    }

    fun focusInput() {
        messageInput.requestFocusInWindow()
    }

    fun dispose() {
        scope.cancel()
    }
}
