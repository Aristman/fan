package fan.idea.editor

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import fan.idea.toolwindow.FanToolWindowFactory

/**
 * "Ask FAN" editor action.
 * Triggered from right-click context menu or Alt+F hotkey.
 * Opens Tool Window and optionally pre-populates context from selection.
 * 
 * Full implementation in Phase 3. Currently just opens the Tool Window.
 */
class AskFanAction : AnAction("Ask FAN", "Send selected code to FAN Agent", null) {
    
    override fun update(e: AnActionEvent) {
        // Only show when editor is available
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor != null
    }
    
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        
        // Open Tool Window and activate
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("FAN Agent")
        toolWindow?.activate(null)
        
        // Phase 3 will add: extract selection context, populate input field
    }
}
