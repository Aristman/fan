package fan.idea.ui.status

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory

class FanStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = "FAN_ConnectionStatus"

    override fun getDisplayName(): String = "FAN Agent Connection"

    override fun createWidget(project: Project): StatusBarWidget {
        return FanStatusWidget(project)
    }

    override fun disposeWidget(widget: StatusBarWidget) {
        widget.dispose()
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}
