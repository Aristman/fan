package fan.idea.toolwindow

import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBButton
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import fan.idea.FanPluginManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
import java.awt.GridLayout
import javax.swing.Box
import javax.swing.JPanel
import javax.swing.SwingConstants

class WelcomePanel(private val project: Project) : JPanel(BorderLayout()) {
    private val plugin get() = project.getService(FanPluginManager::class.java).fanPlugin
    private val scope = CoroutineScope(SupervisorJob())

    private val statusLabel = JBLabel("<html><b>FAN Server not found</b></html>")
    private val descriptionLabel = JBLabel("Could not detect a running FAN Server.")
    private val startButton = JBButton("Start FAN Server")
    private val settingsButton = JBButton("Configure Settings")
    private val progressLabel = JBLabel("Starting...")

    init {
        // Center everything with padding
        val centerPanel = JPanel(GridLayout(0, 1, 0, 12))
        centerPanel.border = JBUI.Borders.empty(20)

        val titleLabel = JBLabel("<html><h2>🤖 FAN Agent</h2></html>")
        titleLabel.horizontalAlignment = SwingConstants.CENTER

        statusLabel.horizontalAlignment = SwingConstants.CENTER
        descriptionLabel.horizontalAlignment = SwingConstants.CENTER
        progressLabel.horizontalAlignment = SwingConstants.CENTER

        centerPanel.add(titleLabel)
        centerPanel.add(Box.createVerticalStrut(10))
        centerPanel.add(statusLabel)
        centerPanel.add(descriptionLabel)
        centerPanel.add(Box.createVerticalStrut(10))
        centerPanel.add(startButton)
        centerPanel.add(settingsButton)
        centerPanel.add(progressLabel)

        progressLabel.isVisible = false

        add(centerPanel, BorderLayout.CENTER)

        startButton.addActionListener {
            startButton.isEnabled = false
            progressLabel.isVisible = true
            descriptionLabel.text = "Starting FAN Server..."

            scope.launch {
                val result = plugin.startServerAndConnect()
                withContext(Dispatchers.Main) {
                    if (result.isSuccess) {
                        descriptionLabel.text = "✅ Connected! Loading sessions..."
                        delay(500)
                        getViewSwitcher()?.showSessionList()
                    } else {
                        descriptionLabel.text = "❌ Failed: ${result.exceptionOrNull()?.message}"
                        startButton.isEnabled = true
                        progressLabel.isVisible = false
                    }
                }
            }
        }

        settingsButton.addActionListener {
            ShowSettingsUtil.getInstance().showSettingsDialog(project, "FAN Agent")
        }
    }

    private fun getViewSwitcher(): ViewSwitcher? {
        val toolWindow = ToolWindowManager.getInstance(project)
            .getToolWindow("FAN Agent") ?: return null
        return toolWindow.getUserData(FanToolWindowFactory.VIEW_SWITCHER_KEY)
    }

    fun dispose() {
        scope.cancel()
    }
}
