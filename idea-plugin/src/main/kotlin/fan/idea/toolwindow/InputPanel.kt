package fan.idea.toolwindow

import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.impl.EditorImpl
import com.intellij.openapi.fileTypes.FileTypes
import com.intellij.openapi.project.Project
import com.intellij.util.ui.JBUI
import javax.swing.JButton
import fan.idea.FanPluginManager
import fan.idea.settings.FanPluginSettings
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.JPanel

class InputPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(InputPanel::class.java)
    private val plugin get() = project.getService(FanPluginManager::class.java).fanPlugin
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val editor: com.intellij.openapi.editor.Editor
    private val editorComponent: java.awt.Component
    private val sendButton = JButton("Send")
    private val stopButton = JButton("Stop")

    var onSendMessage: ((String) -> Unit)? = null

    init {
        // Create EditorTextField for multi-line input
        val document = EditorFactory.getInstance().createDocument("")
        editor = EditorFactory.getInstance().createEditor(
            document, project, FileTypes.PLAIN_TEXT, false
        )
        editorComponent = editor.component

        // Style the editor
        (editor as? EditorImpl)?.apply {
            setOneLineMode(false)
            setPreferredSize(Dimension(Integer.MAX_VALUE, 60))
        }

        val editorPane = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.customLine(JBUI.CurrentTheme.Advertiser.borderColor(), 1)
            add(editorComponent, BorderLayout.CENTER)
        }

        // Button panel
        val buttonPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 2)).apply {
            add(stopButton)
            add(sendButton)
        }
        stopButton.isVisible = false

        add(editorPane, BorderLayout.CENTER)
        add(buttonPanel, BorderLayout.EAST)

        // Send on Ctrl+Enter (Enter = newline)
        editor.contentComponent.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && e.isControlDown) {
                    e.consume()
                    doSend()
                }
            }
        })

        sendButton.addActionListener { doSend() }
        stopButton.addActionListener { plugin.stopGeneration() }
    }

    fun setGenerating(generating: Boolean) {
        sendButton.isVisible = !generating
        stopButton.isVisible = generating
    }

    fun focusInput() {
        editor.contentComponent.requestFocusInWindow()
    }

    private fun doSend() {
        val text = editor.document.text.trim()
        if (text.isBlank()) return
        log.info("doSend() called, text length: ${text.length}")

        editor.document.setText("")

        val settings = FanPluginSettings.getInstance()
        val context = if (settings.contextAutoAttach) {
            extractEditorContext()
        } else null

        sendButton.isEnabled = false
        try {
            scope.launch {
                log.info("Coroutine started, calling plugin.sendMessage...")
                val result = plugin.sendMessage(text, context)
                log.info("sendMessage result: isFailure=${result.isFailure}")
                if (result.isFailure) {
                    val error = result.exceptionOrNull()?.message ?: "Unknown error"
                    log.info("Failed to send message: $error")
                    withContext(Dispatchers.Main) {
                        // Put text back so user can retry
                        editor.document.setText(text)
                    }
                }
                withContext(Dispatchers.Main) {
                    sendButton.isEnabled = true
                }
            }
        } catch (e: Throwable) {
            log.info("Failed to launch send coroutine: ${e.message}")
            sendButton.isEnabled = true
            editor.document.setText(text)
        }
    }

    private fun extractEditorContext(): String? {
        // This will be implemented in Phase 3 (ContextExtractor)
        // For now, return null
        return null
    }

    fun dispose() {
        EditorFactory.getInstance().releaseEditor(editor)
        scope.cancel()
    }
}
