package fan.idea.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import fan.idea.FanPlugin
import fan.idea.api.ConnectionStatus
import fan.idea.core.events.MessageListener
import fan.idea.core.services.FanMessageService
import fan.idea.core.services.FanSessionService
import fan.idea.ui.chat.FanChatPanel
import fan.idea.ui.chat.FanInputPanel
import fan.idea.ui.chat.FanSessionListPanel
import fan.idea.ui.chat.FanSessionNavigator
import kotlinx.coroutines.runBlocking
import java.awt.BorderLayout
import javax.swing.JPanel
import javax.swing.SwingUtilities

class FanToolWindowFactory : ToolWindowFactory {
    private val log = Logger.getInstance(FanToolWindowFactory::class.java)

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val plugin = project.getService(FanPlugin::class.java)
        val messageService = project.getService(FanMessageService::class.java)
        val sessionService = project.getService(FanSessionService::class.java)

        val contentFactory = ContentFactory.getInstance()

        // Create navigator + panels
        val navigator = FanSessionNavigator(project)
        val sessionListPanel = FanSessionListPanel(project)
        val chatPanel = FanChatPanel(project)
        val inputPanel = FanInputPanel(project)

        navigator.addPanel(FanSessionNavigator.View.SESSION_LIST, sessionListPanel)
        navigator.addPanel(FanSessionNavigator.View.CHAT, chatPanel)

        // Root layout: NORTH (header area — empty for now, back button is in chatPanel),
        // CENTER = navigator, SOUTH = input panel
        val rootPanel = JPanel(BorderLayout())
        rootPanel.add(navigator, BorderLayout.CENTER)
        rootPanel.add(inputPanel, BorderLayout.SOUTH)

        val content = contentFactory.createContent(rootPanel, "", false)
        toolWindow.contentManager.addContent(content)

        // Wire: session list double-click → open session → show chat
        sessionListPanel.onSessionSelected = { sessionId ->
            log.info("ToolWindow: session selected: $sessionId")
            ApplicationManager.getApplication().executeOnPooledThread {
                val selectResult = runBlocking { sessionService.selectSession(sessionId) }
                if (selectResult.isSuccess) {
                    // Load existing messages
                    val messagesResult = runBlocking { sessionService.getSessionMessages() }
                    SwingUtilities.invokeLater {
                        if (messagesResult.isSuccess) {
                            chatPanel.loadHistory(messagesResult.getOrThrow())
                        }
                        navigator.showChat()
                        inputPanel.focusInput()
                    }
                }
            }
        }

        // Wire: input send → sendMessage → show chat (if new message from session list view)
        inputPanel.onSendMessage = { text ->
            log.info("ToolWindow: send message, length=${text.length}")
            if (navigator.getCurrentView() == FanSessionNavigator.View.SESSION_LIST) {
                // New message: stay in session list, message service will create session
            }
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val result = runBlocking { messageService.sendMessage(text) }
                    if (result.isSuccess) {
                        SwingUtilities.invokeLater {
                            chatPanel.addUserMessage(text)  // Show user's own message
                            if (navigator.getCurrentView() == FanSessionNavigator.View.SESSION_LIST) {
                                navigator.showChat()
                            }
                            inputPanel.setText("")
                            inputPanel.focusInput()
                        }
                    } else {
                        log.info("ToolWindow: send failed: ${result.exceptionOrNull()?.message}")
                        SwingUtilities.invokeLater {
                            inputPanel.setText(text)
                        }
                    }
                } catch (t: Throwable) {
                    log.info("ToolWindow: send exception: ${t.message}")
                    SwingUtilities.invokeLater {
                        inputPanel.setText(text)
                    }
                }
            }
        }

        // Wire: chat panel back button → show session list
        chatPanel.getBackButton().addActionListener {
            log.info("ToolWindow: back to session list")
            sessionService.navigateToSessionList()
            navigator.showSessionList()
        }

        // Wire: generating state → input panel stop/send buttons
        val messageBusConnection = project.messageBus.connect()
        messageBusConnection.subscribe(MessageListener.TOPIC, object : MessageListener {
            override fun onGeneratingChanged(@Suppress("PARAMETER_NAME_CHANGED_ON_OVERRIDE") generating: Boolean) {
                SwingUtilities.invokeLater {
                    inputPanel.isGenerating = generating
                }
            }
        })

        // Start with session list view
        navigator.showSessionList()

        // Dispose on close
        Disposer.register(toolWindow.disposable) {
            sessionListPanel.dispose()
            chatPanel.dispose()
            inputPanel.dispose()
            messageBusConnection.disconnect()
            plugin.dispose()
        }

        // Auto-connect
        plugin.ensureConnected()
    }
}
