package fan.idea.ui.status

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import fan.idea.api.ConnectionStatus
import fan.idea.core.events.ConnectionListener
import fan.idea.core.services.FanConnectionService
import java.awt.Component

class FanStatusWidget(private val project: Project) : StatusBarWidget {

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private var currentStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED

    private val presentation = object : StatusBarWidget.TextPresentation {
        override fun getText(): String = FanStatusIcons.getStatusText(currentStatus)
        override fun getTooltipText(): String = "FAN Agent: ${currentStatus.name}"
        override fun getAlignment(): Float = Component.CENTER_ALIGNMENT
    }

    init {
        project.messageBus.connect().subscribe(ConnectionListener.TOPIC, object : ConnectionListener {
            override fun onConnectionStateChanged(status: ConnectionStatus) {
                currentStatus = status
            }
        })
    }

    override fun ID(): String = "FAN_ConnectionStatus"

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = presentation

    override fun install(statusBar: StatusBar) {
        // No-op
    }

    override fun dispose() {}
}
