package fan.idea.notifications

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType

/**
 * Access point for the FAN Agent notification group.
 * The group is registered in plugin.xml under id="fan.notifications".
 */
object FanNotificationGroup {
    
    private fun getGroup() = NotificationGroupManager.getInstance()
        .getNotificationGroup("fan.notifications")
    
    /**
     * Show an information notification (blue balloon).
     */
    fun info(title: String, content: String) {
        getGroup().createNotification(title, content, NotificationType.INFORMATION).notify(null)
    }
    
    /**
     * Show a warning notification (yellow balloon).
     */
    fun warning(title: String, content: String) {
        getGroup().createNotification(title, content, NotificationType.WARNING).notify(null)
    }
    
    /**
     * Show an error notification (red balloon).
     */
    fun error(title: String, content: String) {
        getGroup().createNotification(title, content, NotificationType.ERROR).notify(null)
    }
}
