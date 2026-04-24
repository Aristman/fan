package fan.idea.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import javax.swing.JButton
import fan.idea.FanPluginManager
import fan.idea.api.SessionSummary
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
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
    private val plugin get() = project.getService(FanPluginManager::class.java).fanPlugin
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

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

    // State
    private val sessions = mutableMapOf<String, SessionSummary>()

    init {
        // Top: Search bar
        val topPanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(5, 8)
            add(searchBar, BorderLayout.CENTER)
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

        // Observe sessions from plugin
        scope.launch {
            plugin.sessions.collect { sessionList ->
                withContext(Dispatchers.Main) {
                    updateSessionList(sessionList)
                }
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
        log.info("SessionListPanel.sendMessage() called, text length: ${text.length}")

        messageInput.text = ""
        sendButton.isEnabled = false
        try {
            scope.launch {
                log.info("Coroutine started, calling plugin.sendMessage...")
                val result = plugin.sendMessage(text)
                log.info("sendMessage result: isFailure=${result.isFailure}")
                withContext(Dispatchers.Main) {
                    sendButton.isEnabled = true
                    if (result.isFailure) {
                        log.info("Failed to send message from session list: ${result.exceptionOrNull()?.message}")
                        messageInput.text = text
                    } else {
                        getViewSwitcher()?.showChat()
                    }
                }
            }
        } catch (e: Throwable) {
            log.info("Failed to launch send coroutine: ${e.message}")
            sendButton.isEnabled = true
            messageInput.text = text
        }
    }

    private fun openSession(sessionId: String) {
        scope.launch {
            val result = plugin.switchSession(sessionId)
            withContext(Dispatchers.Main) {
                if (result.isSuccess) {
                    getViewSwitcher()?.showChat()
                }
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
