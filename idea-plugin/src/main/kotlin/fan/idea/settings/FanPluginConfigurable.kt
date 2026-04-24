package fan.idea.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings UI for FAN Agent plugin.
 * Accessible via Settings → Tools → FAN Agent.
 */
class FanPluginConfigurable : Configurable {

    private val serverUrlField = JBTextField(30)
    private val authTokenField = JBPasswordField()
    private val authTokenLabel = JBLabel("Auth Token:")
    private val showThinkingCheckBox = JBCheckBox("Show thinking blocks")
    private val contextAutoAttachCheckBox = JBCheckBox("Auto-attach file context to messages")
    private val maxContextLinesField = JBTextField(10)
    private val notifyBudgetCheckBox = JBCheckBox("Budget alert notifications")
    private val notifyConnectionCheckBox = JBCheckBox("Connection lost notifications")
    private val notifyAgentDoneCheckBox = JBCheckBox("Agent done notifications")

    private val mainPanel: JPanel by lazy {
        FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Server URL:"), serverUrlField, 1, false)
            .addLabeledComponent(authTokenLabel, authTokenField, 1, false)
            .addSeparator()
            .addLabeledComponent(JBLabel("Max context lines:"), maxContextLinesField, 1, false)
            .addComponent(showThinkingCheckBox, 1)
            .addComponent(contextAutoAttachCheckBox, 1)
            .addSeparator()
            .addComponent(notifyBudgetCheckBox, 1)
            .addComponent(notifyConnectionCheckBox, 1)
            .addComponent(notifyAgentDoneCheckBox, 1)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    private val settings: FanPluginSettings
        get() = FanPluginSettings.getInstance()

    override fun getDisplayName() = "FAN Agent"

    override fun createComponent(): JComponent {
        // Hide token field for local connections
        updateTokenVisibility()
        return mainPanel
    }

    override fun isModified(): Boolean {
        val s = settings
        val isLocal = s.isLocalConnection
        return serverUrlField.text != s.serverUrl
            || (!isLocal && String(authTokenField.password) != s.authToken)
            || showThinkingCheckBox.isSelected != s.showThinking
            || contextAutoAttachCheckBox.isSelected != s.contextAutoAttach
            || maxContextLinesField.text != s.maxContextLines.toString()
            || notifyBudgetCheckBox.isSelected != s.notifyBudgetAlerts
            || notifyConnectionCheckBox.isSelected != s.notifyConnectionLost
            || notifyAgentDoneCheckBox.isSelected != s.notifyAgentDone
    }

    @Throws(ConfigurationException::class)
    override fun apply() {
        val linesText = maxContextLinesField.text.trim()
        val lines = linesText.toIntOrNull()
            ?: throw ConfigurationException("Max context lines must be a number", "Invalid Input")
        if (lines < 1 || lines > 10000) {
            throw ConfigurationException("Max context lines must be between 1 and 10000", "Invalid Input")
        }

        val url = serverUrlField.text.trim()
        if (url.isBlank()) {
            throw ConfigurationException("Server URL must not be empty", "Invalid Input")
        }

        settings.serverUrl = url
        if (!settings.isLocalConnection) {
            settings.authToken = String(authTokenField.password)
        }
        settings.showThinking = showThinkingCheckBox.isSelected
        settings.contextAutoAttach = contextAutoAttachCheckBox.isSelected
        settings.maxContextLines = lines
        settings.notifyBudgetAlerts = notifyBudgetCheckBox.isSelected
        settings.notifyConnectionLost = notifyConnectionCheckBox.isSelected
        settings.notifyAgentDone = notifyAgentDoneCheckBox.isSelected
    }

    override fun reset() {
        val s = settings
        serverUrlField.text = s.serverUrl
        authTokenField.text = s.authToken
        showThinkingCheckBox.isSelected = s.showThinking
        contextAutoAttachCheckBox.isSelected = s.contextAutoAttach
        maxContextLinesField.text = s.maxContextLines.toString()
        notifyBudgetCheckBox.isSelected = s.notifyBudgetAlerts
        notifyConnectionCheckBox.isSelected = s.notifyConnectionLost
        notifyAgentDoneCheckBox.isSelected = s.notifyAgentDone

        updateTokenVisibility()
    }

    /**
     * Show or hide the Auth Token label and field based on isLocalConnection.
     */
    private fun updateTokenVisibility() {
        val isLocal = settings.isLocalConnection
        authTokenLabel.isVisible = !isLocal
        authTokenField.isVisible = !isLocal
    }
}
