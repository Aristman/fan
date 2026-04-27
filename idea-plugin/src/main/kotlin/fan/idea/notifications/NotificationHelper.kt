package fan.idea.notifications

import com.intellij.openapi.project.Project
import fan.idea.settings.FanPluginSettings

/**
 * Helper methods for showing FAN Agent notifications.
 * Respects user notification preferences from settings.
 */
object NotificationHelper {
    
    fun notifyConnectionLost(project: Project? = null) {
        val settings = FanPluginSettings.getInstance()
        if (!settings.notifyConnectionLost) return
        FanNotificationGroup.warning(
            "FAN Agent",
            "Connection to FAN Server lost. Reconnecting..."
        )
    }
    
    fun notifyConnectionRestored(project: Project? = null) {
        FanNotificationGroup.info(
            "FAN Agent",
            "Reconnected to FAN Server."
        )
    }
    
    fun notifyBudgetAlert(message: String) {
        val settings = FanPluginSettings.getInstance()
        if (!settings.notifyBudgetAlerts) return
        FanNotificationGroup.warning("FAN Agent — Budget", message)
    }
    
    fun notifyAgentDone(project: Project? = null) {
        val settings = FanPluginSettings.getInstance()
        if (!settings.notifyAgentDone) return
        FanNotificationGroup.info("FAN Agent", "Agent finished processing.")
    }
    
    fun notifyError(title: String, message: String) {
        FanNotificationGroup.error(title, message)
    }
}
