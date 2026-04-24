package fan.idea.ui.chat

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileTypes.FileTypes
import com.intellij.openapi.project.Project
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.impl.EditorImpl
import com.intellij.util.ui.JBUI
import fan.idea.core.services.FanMessageService
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities

class FanInputPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = Logger.getInstance(FanInputPanel::class.java)

    private val messageService: FanMessageService
        get() = project.getService(FanMessageService::class.java)

    private val editor: Editor
    private val sendButton = JButton("Send")
    private val stopButton = JButton("Stop")

    var onSendMessage: ((String) -> Unit)? = null
    var isGenerating = false
        set(value) {
            field = value
            SwingUtilities.invokeLater {
                sendButton.isVisible = !value
                stopButton.isVisible = value
            }
        }

    init {
        val document = EditorFactory.getInstance().createDocument("")
        editor = EditorFactory.getInstance().createEditor(document, project, FileTypes.PLAIN_TEXT, false)
        val editorComponent = editor.component

        (editor as? EditorImpl)?.apply {
            setOneLineMode(false)
            setPreferredSize(Dimension(Integer.MAX_VALUE, 60))
        }

        // Editor panel with border
        val editorPane = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.customLine(JBUI.CurrentTheme.Advertiser.borderColor(), 1)
            add(editorComponent, BorderLayout.CENTER)
        }

        // Button row
        val buttonPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 2)).apply {
            add(stopButton)
            add(sendButton)
        }
        stopButton.isVisible = false

        add(editorPane, BorderLayout.CENTER)
        add(buttonPanel, BorderLayout.EAST)

        // Enter to send, Shift+Enter for newline
        editor.contentComponent.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    doSend()
                }
            }
        })

        sendButton.addActionListener { doSend() }
        stopButton.addActionListener {
            messageService.stopGeneration()
            isGenerating = false
        }
    }

    fun focusInput() {
        editor.contentComponent.requestFocusInWindow()
    }

    private fun doSend() {
        val text = editor.document.text.trim()
        if (text.isBlank()) return

        SwingUtilities.invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                editor.document.setText("")
            }
        }

        onSendMessage?.invoke(text)
    }

    fun getText(): String = editor.document.text.trim()

    fun setText(text: String) {
        SwingUtilities.invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                editor.document.setText(text)
            }
        }
    }

    fun setPlaceholder(@Suppress("UNUSED_PARAMETER") text: String) {
        // Placeholder is managed by the parent via InputPanel placeholder mechanism
        // For now, this is a no-op; can be enhanced later
    }

    fun dispose() {
        EditorFactory.getInstance().releaseEditor(editor)
    }
}
