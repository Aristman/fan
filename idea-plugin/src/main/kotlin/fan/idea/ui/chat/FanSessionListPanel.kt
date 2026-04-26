package fan.idea.ui.chat

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import fan.idea.api.ConnectionStatus
import fan.idea.api.SessionSummary
import fan.idea.core.events.ConnectionListener
import fan.idea.core.events.SessionListener
import fan.idea.core.services.FanConnectionService
import fan.idea.core.services.FanSessionService
import java.awt.BorderLayout
import java.awt.CardLayout
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
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class FanSessionListPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(FanSessionListPanel::class.java)

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)
    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)

    private val messageBusConnection = project.messageBus.connect()

    private val searchBar = JBTextField().apply { toolTipText = "Search sessions..." }
    private val sessionListModel = DefaultListModel<String>()
    private val sessionList = JBList(sessionListModel)
    private val emptyLabel = JBLabel("No sessions yet. Type a message to start a new chat.")
    private val statusLabel = JBLabel("").apply {
        foreground = java.awt.Color.GRAY
        border = JBUI.Borders.empty(2, 8)
    }

    private val sessions = mutableMapOf<String, SessionSummary>()

    var onSessionSelected: ((String) -> Unit)? = null
    var onNewChatRequested: (() -> Unit)? = null

    init {
        // Top: search + status
        val topPanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(5, 8)
            add(searchBar, BorderLayout.CENTER)
            add(statusLabel, BorderLayout.SOUTH)
        }

        // Center: list or empty
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

        add(topPanel, BorderLayout.NORTH)
        add(centerPanel, BorderLayout.CENTER)

        statusLabel.text = "Connecting to FAN Server..."

        // Subscribe to connection status changes
        messageBusConnection.subscribe(ConnectionListener.TOPIC, object : ConnectionListener {
            override fun onConnectionStateChanged(status: ConnectionStatus) {
                SwingUtilities.invokeLater {
                    statusLabel.text = when (status) {
                        ConnectionStatus.CONNECTED -> "Connected"
                        ConnectionStatus.CONNECTING, ConnectionStatus.RECONNECTING -> "Connecting..."
                        ConnectionStatus.DISCONNECTED -> "Disconnected"
                        ConnectionStatus.ERROR -> "Connection failed"
                    }
                }
            }
        })

        // Subscribe to session list updates
        messageBusConnection.subscribe(SessionListener.TOPIC, object : SessionListener {
            override fun onSessionsUpdated(sessions: List<SessionSummary>) {
                SwingUtilities.invokeLater { updateSessionList(sessions) }
            }
        })

        // Initialize with current sessions (if already loaded)
        val currentSessions = sessionService.sessions.value
        if (currentSessions.isNotEmpty()) {
            updateSessionList(currentSessions)
        }
        // Always sync status with actual connection state, not just when sessions are loaded
        statusLabel.text = when (connectionService.getConnectionStatus(project).value) {
            ConnectionStatus.CONNECTED -> "Connected"
            ConnectionStatus.CONNECTING, ConnectionStatus.RECONNECTING -> "Connecting..."
            ConnectionStatus.DISCONNECTED -> "Disconnected"
            ConnectionStatus.ERROR -> "Connection failed"
        }

        // Double-click → open
        sessionList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val index = sessionList.selectedIndex
                    if (index >= 0) {
                        val key = sessionListModel.elementAt(index)
                        sessions[key]?.let { onSessionSelected?.invoke(it.id) }
                    }
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

    private fun updateSessionList(newSessions: List<SessionSummary>) {
        sessions.clear()
        sessionListModel.clear()

        for (session in newSessions) {
            val displayText = formatSession(session)
            sessions[displayText] = session
            sessionListModel.addElement(displayText)
        }

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

    fun focusInput() {
        searchBar.requestFocusInWindow()
    }

    fun refreshStatus() {
        val currentStatus = connectionService.getConnectionStatus(project).value
        statusLabel.text = when (currentStatus) {
            ConnectionStatus.CONNECTED -> "Connected"
            ConnectionStatus.CONNECTING, ConnectionStatus.RECONNECTING -> "Connecting..."
            ConnectionStatus.DISCONNECTED -> "Disconnected"
            ConnectionStatus.ERROR -> "Connection failed"
        }
        val currentSessions = sessionService.sessions.value
        if (currentSessions.isNotEmpty()) {
            updateSessionList(currentSessions)
        }
    }

    fun dispose() {
        messageBusConnection.disconnect()
    }
}
