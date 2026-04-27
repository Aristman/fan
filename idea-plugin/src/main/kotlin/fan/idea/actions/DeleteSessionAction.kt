package fan.idea.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import fan.idea.core.services.FanSessionService
import fan.idea.notifications.FanNotificationGroup
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.swing.JOptionPane

/**
 * Deletes the selected session from FAN Server.
 * Used as a context menu action on session list items.
 */
class DeleteSessionAction(
    private val sessionId: String,
    private val sessionTitle: String,
    private val project: Project
) : AnAction("Delete Session") {
    
    private val scope = CoroutineScope(SupervisorJob())
    private val sessionService: FanSessionService get() = project.getService(FanSessionService::class.java)
    
    override fun actionPerformed(e: AnActionEvent) {
        val confirm = JOptionPane.showConfirmDialog(
            null,
            "Delete session \"$sessionTitle\"?\nThis action cannot be undone.",
            "Delete Session",
            JOptionPane.YES_NO_OPTION,
            JOptionPane.WARNING_MESSAGE
        )
        
        if (confirm != JOptionPane.YES_OPTION) return
        
        scope.launch(Dispatchers.IO) {
            val result = sessionService.deleteSession(sessionId)
            withContext(Dispatchers.Main) {
                if (result.isSuccess) {
                    FanNotificationGroup.info("FAN Agent", "Session deleted.")
                } else {
                    FanNotificationGroup.error(
                        "FAN Agent",
                        "Failed to delete session: ${result.exceptionOrNull()?.message}"
                    )
                }
            }
        }
    }
}
