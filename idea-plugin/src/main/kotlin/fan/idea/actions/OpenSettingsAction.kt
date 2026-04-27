package fan.idea.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project

/**
 * Opens FAN Agent settings (Settings → Tools → FAN Agent).
 */
class OpenSettingsAction : AnAction("FAN Settings", "Open FAN Agent settings", null) {
    
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ShowSettingsUtil.getInstance().showSettingsDialog(project, "FAN Agent")
    }
}
