package fan.idea.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Persistent settings for FAN Agent plugin.
 * Stored globally (shared across all projects/IDEs).
 *
 * Uses both @State (for persistence) and @Service (for application-level access).
 * This is the correct pattern for IntelliJ Platform 2023.2+.
 */
@State(
    name = "FanPluginSettings",
    storages = [Storage("fan-plugin.xml")]
)
@Service(Service.Level.APP)
class FanPluginSettings : PersistentStateComponent<FanPluginSettings.State> {

    data class State(
        // Connection
        var serverUrl: String = "http://localhost:3456",
        var authToken: String = "",
        var isLocalConnection: Boolean = true,
        var serverPort: Int = 0,  // 0 = not assigned yet

        // Session
        var lastSessionId: String? = null,
        var lastProjectPath: String? = null,

        // Chat UI
        var chatFontSize: Int = 14,

        // UI
        var toolWindowAnchor: String = "right",
        var showThinking: Boolean = true,
        var contextAutoAttach: Boolean = true,
        var maxContextLines: Int = 200,

        // Notifications
        var notifyBudgetAlerts: Boolean = true,
        var notifyModelSwitch: Boolean = true,
        var notifyConnectionLost: Boolean = true,
        var notifyAgentDone: Boolean = false
    )

    companion object {
        fun getInstance(): FanPluginSettings =
            ApplicationManager.getApplication().getService(FanPluginSettings::class.java)
    }

    private var state = State()

    // --- Connection ---
    var serverUrl: String
        get() = state.serverUrl
        set(value) { state.serverUrl = value }

    var authToken: String
        get() = state.authToken
        set(value) { state.authToken = value }

    var isLocalConnection: Boolean
        get() = state.isLocalConnection
        set(value) { state.isLocalConnection = value }

    var serverPort: Int
        get() = state.serverPort
        set(value) { state.serverPort = value }

    // --- Session ---
    var lastSessionId: String?
        get() = state.lastSessionId
        set(value) { state.lastSessionId = value }

    var lastProjectPath: String?
        get() = state.lastProjectPath
        set(value) { state.lastProjectPath = value }

    // --- Chat UI ---
    var chatFontSize: Int
        get() = state.chatFontSize
        set(value) { state.chatFontSize = value }

    // --- UI ---
    var toolWindowAnchor: String
        get() = state.toolWindowAnchor
        set(value) { state.toolWindowAnchor = value }

    var showThinking: Boolean
        get() = state.showThinking
        set(value) { state.showThinking = value }

    var contextAutoAttach: Boolean
        get() = state.contextAutoAttach
        set(value) { state.contextAutoAttach = value }

    var maxContextLines: Int
        get() = state.maxContextLines
        set(value) { state.maxContextLines = value }

    // --- Notifications ---
    var notifyBudgetAlerts: Boolean
        get() = state.notifyBudgetAlerts
        set(value) { state.notifyBudgetAlerts = value }

    var notifyModelSwitch: Boolean
        get() = state.notifyModelSwitch
        set(value) { state.notifyModelSwitch = value }

    var notifyConnectionLost: Boolean
        get() = state.notifyConnectionLost
        set(value) { state.notifyConnectionLost = value }

    var notifyAgentDone: Boolean
        get() = state.notifyAgentDone
        set(value) { state.notifyAgentDone = value }

    // --- PersistentStateComponent ---
    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }
}
